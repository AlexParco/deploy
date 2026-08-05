import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseEnvFile } from '../utils/env.js';

// ─── Schema de deploy.yml ───────────────────────────────────────────────────

const envSchema = z.object({
  clear: z.record(z.string()).optional().default({}),
  secret: z.array(z.string()).optional().default([]),
});

/**
 * Named volume in the form "name:/path/in/container", with an optional mode.
 *
 * Host paths are rejected on purpose: the name is prefixed with the service
 * (see buildVolumeFlags), so "/data:/data" would become the volume
 * "myapp-web-/data:/data", which Docker refuses with an opaque error. Better to
 * say so here than to fail on the server.
 */
const NAMED_VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*:\/[^:]*(:(ro|rw))?$/;

export function isNamedVolume(volume: string): boolean {
  return NAMED_VOLUME.test(volume);
}

const volumeSchema = z.string().refine(isNamedVolume, {
  message:
    'Only named volumes are supported, as "name:/path/in/container". A host ' +
    'path such as "/data:/data" is not: the name gets prefixed with the ' +
    'service, which would produce an invalid volume name',
});

/**
 * A number that may arrive as a string.
 *
 * Interpolation now happens after the YAML is parsed, so `port: ${APP_PORT}`
 * reaches the schema as the string "3000" rather than as a number.
 */
const numeric = z.preprocess(
  value => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z.number(),
);

/** Same idea for booleans: `ssl: ${USE_SSL}` arrives as "true" or "false". */
const looseBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform(value => value === 'true'),
]);

const serviceSchema = z.object({
  build: z.string().default('.'),
  dockerfile: z.string().default('Dockerfile'),
  port: numeric,
  domain: z.string(),
  healthcheck: z.string().default('/health'),
  // How long the service may take to answer before the deploy gives up. The
  // default suits an app that starts in seconds; one that runs migrations on
  // boot needs more, and without this the deploy would fail with no way to
  // adjust it.
  startup_timeout: numeric.pipe(z.number().int().positive()).optional().default(60),
  // Persistent volumes for the service (same format as accessories:
  // "name:/path/in/container"). Without one, /data lives in the container's
  // ephemeral layer and is LOST on every redeploy, since the container is
  // recreated each time.
  volumes: z.array(volumeSchema).optional().default([]),
  env: envSchema.optional().default({}),
});

const accessorySchema = z.object({
  image: z.string(),
  port: z.string().optional(),
  volumes: z.array(volumeSchema).optional().default([]),
  env: envSchema.optional().default({}),
});

const serverSchema = z.object({
  host: z.string(),
  user: z.string().default('deploy'),
  port: z.coerce.number().default(22),
  key: z.string().optional(),
});

const proxySchema = z.object({
  ssl: looseBoolean.default(true),
  email: z.string().email(),
});

const safeNameKey = z.string().regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers and hyphens');

const deployConfigSchema = z.object({
  project: safeNameKey,
  server: serverSchema,
  services: z.record(safeNameKey, serviceSchema),
  accessories: z.record(safeNameKey, accessorySchema).optional().default({}),
  proxy: proxySchema,
}).superRefine((config, ctx) => {
  // Services and accessories share a namespace: both are tagged with
  // `deploy.service=<name>` and both derive their container name from it. A
  // clash would make `deploy logs`, `deploy status` and the retirement of old
  // versions pick whichever Docker happened to list first.
  const clashes = Object.keys(config.accessories ?? {})
    .filter(name => name in config.services);

  for (const name of clashes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accessories', name],
      message:
        `'${name}' is also the name of a service. Services and accessories share ` +
        `a namespace, so the names have to be distinct`,
    });
  }
});

export type DeployConfig = z.infer<typeof deployConfigSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;
export type AccessoryConfig = z.infer<typeof accessorySchema>;
export type ProxyConfig = z.infer<typeof proxySchema>;

// ─── Loader ──────────────────────────────────────────────────────────────────

const CONFIG_FILE = 'deploy.yml';
const SECRETS_FILE = '.deploy/secrets';

export function findConfigPath(from?: string): string {
  const dir = from ?? process.cwd();
  const configPath = resolve(dir, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(
      `No ${CONFIG_FILE} found in ${dir}\n` +
      `Run: deploy init`
    );
  }

  return configPath;
}

export function loadConfig(from?: string): DeployConfig {
  const configPath = findConfigPath(from);
  const secretsPath = getSecretsPath(from);
  const raw = readFileSync(configPath, 'utf-8');

  // Parse FIRST, interpolate afterwards. Substituting into the raw text would
  // make the value part of the YAML document: a secret containing ':' breaks
  // parsing with an error pointing at deploy.yml instead of at the secret, and
  // a value containing newlines can inject configuration keys of its own.
  // Interpolating into the already-parsed tree makes a value just a string.
  const parsed = interpolateVars(parseYaml(raw), lookupVar(secretsPath));

  const result = deployConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${CONFIG_FILE}:\n${errors}`);
  }

  return result.data;
}

/** Resolves a name from .deploy/secrets first, then from the environment. */
function lookupVar(secretsPath: string): (name: string) => string {
  const fileVars = parseEnvFile(secretsPath);

  return (name: string) => {
    if (fileVars[name] !== undefined) return fileVars[name];
    if (process.env[name] !== undefined) return process.env[name] as string;
    throw new Error(
      `Variable \${${name}} used in deploy.yml is not defined.\n` +
      `Add it to .deploy/secrets or export it as an environment variable.`
    );
  };
}

/**
 * Replaces `${VAR}` inside every string of the parsed configuration.
 *
 * Only values are interpolated, never keys: a variable is data, and letting it
 * decide the name of a configuration key is exactly the injection this avoids.
 */
export function interpolateVars(node: unknown, lookup: (name: string) => string): unknown {
  if (typeof node === 'string') {
    return node.replace(/\$\{(\w+)}/g, (_match, name: string) => lookup(name));
  }

  if (Array.isArray(node)) {
    return node.map(item => interpolateVars(item, lookup));
  }

  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = interpolateVars(value, lookup);
    }
    return out;
  }

  return node;
}

export function getSecretsPath(from?: string): string {
  const dir = from ?? process.cwd();
  return resolve(dir, SECRETS_FILE);
}

/**
 * Secret names needed for a deploy.
 *
 * `serviceNames` narrows it to the services actually being deployed: asking for
 * the secrets of every service would make `deploy --service api` fail on a
 * machine that only holds the ones that service needs. Accessories are always
 * included, because they are reconciled on every deploy.
 */
export function getAllSecretNames(
  config: DeployConfig,
  serviceNames?: string[],
): string[] {
  const names = new Set<string>();
  const wanted = serviceNames ?? Object.keys(config.services);

  for (const name of wanted) {
    for (const secretName of config.services[name]?.env?.secret ?? []) {
      names.add(secretName);
    }
  }
  for (const acc of Object.values(config.accessories ?? {})) {
    for (const secretName of acc.env?.secret ?? []) names.add(secretName);
  }

  return [...names];
}
