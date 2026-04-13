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

const serviceSchema = z.object({
  build: z.string().default('.'),
  dockerfile: z.string().default('Dockerfile'),
  port: z.number(),
  domain: z.string(),
  healthcheck: z.string().default('/health'),
  env: envSchema.optional().default({}),
});

const accessorySchema = z.object({
  image: z.string(),
  port: z.string().optional(),
  volumes: z.array(z.string()).optional().default([]),
  env: envSchema.optional().default({}),
});

const serverSchema = z.object({
  host: z.string(),
  user: z.string().default('deploy'),
  port: z.coerce.number().default(22),
  key: z.string().optional(),
});

const proxySchema = z.object({
  ssl: z.boolean().default(true),
  email: z.string().email(),
});

const safeNameKey = z.string().regex(/^[a-z0-9-]+$/, 'Solo letras minúsculas, números y guiones');

const deployConfigSchema = z.object({
  project: safeNameKey,
  server: serverSchema,
  services: z.record(safeNameKey, serviceSchema),
  accessories: z.record(safeNameKey, accessorySchema).optional().default({}),
  proxy: proxySchema,
});

export type DeployConfig = z.infer<typeof deployConfigSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;
export type AccessoryConfig = z.infer<typeof accessorySchema>;

// ─── Loader ──────────────────────────────────────────────────────────────────

const CONFIG_FILE = 'deploy.yml';
const SECRETS_FILE = '.deploy/secrets';

export function findConfigPath(from?: string): string {
  const dir = from ?? process.cwd();
  const configPath = resolve(dir, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(
      `No se encontró ${CONFIG_FILE} en ${dir}\n` +
      `Ejecuta: deploy init`
    );
  }

  return configPath;
}

export function loadConfig(from?: string): DeployConfig {
  const configPath = findConfigPath(from);
  const secretsPath = getSecretsPath(from);
  const raw = readFileSync(configPath, 'utf-8');

  // Resolver ${VAR} desde .deploy/secrets y variables de entorno
  const interpolated = interpolateVars(raw, secretsPath);
  const parsed = parseYaml(interpolated);

  const result = deployConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Error en ${CONFIG_FILE}:\n${errors}`);
  }

  return result.data;
}

function interpolateVars(content: string, secretsPath: string): string {
  const fileVars = parseEnvFile(secretsPath);

  return content.replace(/\$\{(\w+)}/g, (match, name) => {
    // Primero busca en .deploy/secrets, luego en variables de entorno
    if (fileVars[name] !== undefined) return fileVars[name];
    if (process.env[name] !== undefined) return process.env[name] as string;
    throw new Error(
      `Variable \${${name}} en deploy.yml no encontrada.\n` +
      `Agrégala a .deploy/secrets o como variable de entorno.`
    );
  });
}

export function getSecretsPath(from?: string): string {
  const dir = from ?? process.cwd();
  return resolve(dir, SECRETS_FILE);
}

export function getAllSecretNames(config: DeployConfig): string[] {
  const names = new Set<string>();

  for (const svc of Object.values(config.services)) {
    for (const secretName of svc.env?.secret ?? []) names.add(secretName);
  }
  for (const acc of Object.values(config.accessories ?? {})) {
    for (const secretName of acc.env?.secret ?? []) names.add(secretName);
  }

  return [...names];
}
