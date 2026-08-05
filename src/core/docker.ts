import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { NodeSSH } from 'node-ssh';
import { exec } from './ssh.js';
import { normalizePortBinding } from './ports.js';
import { shQuote, shJoin, envFlags, toEnvFile } from './sh.js';
import {
  buildDynamicConfig,
  buildRouteConfig,
  adoptRouteFromLabels,
  parseTraefikCmd,
  routeConfigPath,
  stagingConfigPath,
  routerName,
  DYNAMIC_DIR,
  STAGING_DIR,
} from './traefik.js';
import type { ServiceConfig, AccessoryConfig, ProxyConfig } from './config.js';

const DEPLOY_DIR = '/opt/deploy';
// Outside /opt/deploy/<project>: rsync --delete syncs that directory on every
// deploy, so anything living there would be wiped.
const SECRETS_DIR = `${DEPLOY_DIR}/.secrets`;
const TRAEFIK_NETWORK = 'deploy-proxy';
const TRAEFIK_IMAGE = 'traefik:v2.11';
// Throwaway image used to probe the health check from the network, so we don't
// depend on the user's image shipping wget or curl. Pinned by tag: ~4 MB, and
// cached on the server after the first deploy.
const PROBE_IMAGE = 'busybox:1.36';
const LOCKS_DIR = `${DEPLOY_DIR}/.locks`;

// ─── Git SHA ─────────────────────────────────────────────────────────────────

export function getGitSHA(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Could not read the git SHA. Are you inside a git repository?');
  }
}

/** Modified or untracked files, which reach the server without being committed. */
export function getDirtyFiles(): string[] {
  try {
    const output = execSync('git status --porcelain', { encoding: 'utf-8' });
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Build ───────────────────────────────────────────────────────────────────

export async function buildImage(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  service: ServiceConfig,
  sha: string,
): Promise<string> {
  const image = `${project}-${serviceName}:${sha}`;
  const buildDir = `${DEPLOY_DIR}/${project}`;
  // Absolute paths instead of relying on cwd: node-ssh builds `cd <dir> ; <cmd>`
  // with a semicolon, so if the cd fails the build would still run in a
  // different directory and produce a baffling error.
  const context = `${buildDir}/${service.build}`;
  const dockerfile = `${context}/${service.dockerfile || 'Dockerfile'}`;

  await exec(ssh, shJoin([
    'sudo docker build',
    `-t ${shQuote(image)}`,
    `-f ${shQuote(dockerfile)}`,
    shQuote(context),
  ]));

  return image;
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/**
 * A container's variables, split by sensitivity.
 *
 * `clear` holds what deploy.yml declares under `env.clear`: non-sensitive by the
 * user's explicit decision, passed as `-e` and therefore visible. `secret` holds
 * `env.secret`: passed through an env file and never on the command line. The
 * split mirrors the one deploy.yml already makes, expressed in types.
 */
export interface ContainerEnv {
  clear: Record<string, string>;
  secret: Record<string, string>;
}

/**
 * Splits the variables declared in deploy.yml into visible and secret ones,
 * resolving the latter against the already-loaded secrets.
 */
export function buildContainerEnv(
  target: ServiceConfig | AccessoryConfig,
  secrets: Record<string, string>,
): ContainerEnv {
  const secret: Record<string, string> = {};
  for (const name of target.env?.secret ?? []) {
    const value = secrets[name];
    if (value !== undefined) secret[name] = value;
  }
  return { clear: { ...target.env?.clear }, secret };
}

/**
 * Writes the secrets to a temporary env file on the server, runs `fn` with its
 * path, and removes it no matter what happens.
 *
 * Why not `-e K=V` on the command: a process's command line is readable by any
 * user on the server through `ps aux`, and `sudo` records the full command in
 * the auth log. A secret there ends up on disk and in plain sight. Sent through
 * the SSH channel's stdin, it never passes through argv at any point.
 *
 * What this does NOT prevent: Docker stores the variables in the container's
 * config (`/var/lib/docker/containers/<id>/config.v2.json`), readable by root.
 * That is inherent to Docker env vars; this only closes the exposure to
 * unprivileged users and to the sudo log.
 */
/**
 * Removes secret files left behind by interrupted deploys.
 *
 * withSecretsFile deletes its file in a `finally`, but a process killed outright
 * never runs it. Since container names carry the commit SHA, every interrupted
 * deploy would strand a new file holding live secrets — 0600, but there for
 * good. Called under the project lock, so no in-flight deploy of this project
 * can be using them.
 */
export async function sweepStaleSecrets(ssh: NodeSSH, project: string): Promise<void> {
  await exec(ssh,
    `rm -f ${shQuote(`${SECRETS_DIR}/${project}-`)}*.env 2>/dev/null || true`,
  );
}

export async function withSecretsFile<T>(
  ssh: NodeSSH,
  containerName: string,
  secrets: Record<string, string>,
  fn: (envFileFlag: string) => Promise<T>,
): Promise<T> {
  if (Object.keys(secrets).length === 0) return fn('');

  const path = `${SECRETS_DIR}/${containerName}.env`;
  const quoted = shQuote(path);

  // umask 077 makes the file born as 0600: creating it and chmod-ing afterwards
  // would leave a window where another user could read it. The preceding rm
  // avoids inheriting a previous file's permissions, since `>` truncates but
  // does not change them.
  await exec(ssh, shJoin([
    `umask 077 &&`,
    `mkdir -p ${shQuote(SECRETS_DIR)} &&`,
    `rm -f ${quoted} &&`,
    `cat > ${quoted}`,
  ]), { stdin: toEnvFile(secrets) });

  try {
    return await fn(`--env-file ${quoted}`);
  } finally {
    await exec(ssh, `rm -f ${quoted}`);
  }
}

// ─── Services ────────────────────────────────────────────────────────────────

export interface DeployServiceParams {
  project: string;
  serviceName: string;
  service: ServiceConfig;
  image: string;
  env: ContainerEnv;
  ssl: boolean;
  sha: string;
  health?: HealthCheckOptions;
}

/**
 * Deploys one version of a service and switches traffic over to it.
 *
 * The order is deliberate: the new container starts WITHOUT being routed, we
 * verify that it responds, and only then is Traefik's config rewritten. If the
 * health check fails, the old container keeps serving traffic because its route
 * was never touched — there is nothing to "restore".
 */
export async function deployService(
  ssh: NodeSSH,
  params: DeployServiceParams,
): Promise<void> {
  const { project, serviceName, service, image, env, ssl, sha } = params;
  const containerName = await reserveContainerName(
    ssh,
    `${project}-${serviceName}-${sha}`,
  );

  await withSecretsFile(ssh, containerName, env.secret, (envFileFlag) =>
    exec(ssh, shJoin([
      'sudo docker run -d',
      `--name ${shQuote(containerName)}`,
      `--network ${shQuote(TRAEFIK_NETWORK)}`,
      '--restart unless-stopped',
      identityLabels(project, serviceName, sha, 'service'),
      buildVolumeFlags(`${project}-${serviceName}`, service.volumes),
      envFileFlag,
      envFlags(env.clear),
      shQuote(image),
    ])),
  );

  const health: HealthCheckOptions = {
    ...params.health,
    maxRetries: params.health?.maxRetries ?? healthRetries(service.startup_timeout),
  };

  try {
    await waitForHealthy(ssh, containerName, service.port, service.healthcheck, health);
  } catch (err) {
    // The old one is still routed and serving: only the candidate is discarded.
    await removeContainer(ssh, containerName);
    throw err;
  }

  // Switch-over point: from here on, traffic goes to the new version.
  await switchTraffic(ssh, project, serviceName, service, containerName, ssl);

  // And only then are the previous versions of this service retired.
  await removeOtherVersions(ssh, project, serviceName, containerName);
}

/**
 * Rewrites the service's route so it points at the given container.
 *
 * It writes to a temporary file and then `mv`s it (atomic within the same
 * filesystem) so that Traefik, which watches the directory, never reads a
 * half-written file.
 */
async function switchTraffic(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  service: ServiceConfig,
  containerName: string,
  ssl: boolean,
): Promise<void> {
  const router = routerName(project, serviceName);
  const path = routeConfigPath(router);
  const staged = stagingConfigPath(router);
  const config = buildDynamicConfig(router, service, containerName, ssl);

  await exec(ssh, shJoin([
    `mkdir -p ${shQuote(DYNAMIC_DIR)} ${shQuote(STAGING_DIR)} &&`,
    `cat > ${shQuote(staged)}`,
  ]), { stdin: config });

  // Same filesystem, so the rename is atomic: Traefik never sees a partial file.
  await exec(ssh, `mv ${shQuote(staged)} ${shQuote(path)}`);
}

/**
 * Picks a free name for the candidate container.
 *
 * Redeploying a commit that is already running — a retry, or simply deploying
 * twice — used to collide on the name, and the fix was to remove the existing
 * container first. That meant destroying the container currently serving
 * traffic before its replacement existed: a guaranteed outage, and a permanent
 * one if the health check then failed, since the route pointed at a name with
 * nothing behind it.
 *
 * Now the live container is left strictly alone. A leftover from a failed
 * deploy, which is not serving anything, is cleared out and its name reused.
 */
async function reserveContainerName(ssh: NodeSSH, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;

    const state = (await exec(ssh, shJoin([
      'sudo docker ps -a',
      `--filter ${shQuote(`name=^${candidate}$`)}`,
      `--format ${shQuote('{{.State}}')}`,
    ]))).trim();

    if (!state) return candidate;

    if (state !== 'running') {
      // Debris from an interrupted deploy: no traffic depends on it.
      await removeContainer(ssh, candidate);
      return candidate;
    }
  }

  throw new Error(
    `Could not find a free container name for ${base}: 20 versions of it are ` +
    `already running. Check for leftovers with: docker ps -a`,
  );
}

/** Retires the containers of this service other than the one just promoted. */
async function removeOtherVersions(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  keep: string,
): Promise<void> {
  const ids = await listContainerIds(ssh, project, serviceName);
  if (ids.length === 0) return;

  const keepId = (await exec(ssh,
    `sudo docker inspect -f ${shQuote('{{.Id}}')} ${shQuote(keep)} 2>/dev/null || true`,
  )).trim();

  // Without a reference there is no way to tell the new container from the old
  // ones, and an empty keepId would make EVERY id look stale — including the
  // one traffic was just switched to. Retiring nothing is the safe outcome:
  // stale containers cost memory, removing the live one costs an outage.
  if (!keepId) return;

  // `docker ps -aq` yields short ids and `{{.Id}}` the full one, hence the
  // prefix comparison rather than equality.
  const stale = ids.filter(id => !keepId.startsWith(id) && id !== keepId);
  if (stale.length === 0) return;

  await exec(ssh, `sudo docker rm -f ${stale.map(shQuote).join(' ')} 2>/dev/null || true`);
}

// ─── Accessories ─────────────────────────────────────────────────────────────

/**
 * Fingerprint of an accessory's desired configuration.
 *
 * Used to detect that deploy.yml drifted from what is actually running. It
 * includes the secret VALUES so that rotating a password also counts as a
 * change; being a hash, the value cannot be recovered from the label it is
 * stored in.
 */
export function accessorySpecHash(accessory: AccessoryConfig, env: ContainerEnv): string {
  const canonical = JSON.stringify({
    image: accessory.image,
    port: accessory.port ?? null,
    volumes: [...accessory.volumes].sort(),
    clear: Object.entries(env.clear).sort(),
    secret: Object.entries(env.secret).sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export type AccessoryAction = 'created' | 'started' | 'recreated' | 'unchanged';

/**
 * Ensures the accessory is running with the configuration from deploy.yml.
 *
 * This used to check `docker ps -q` (RUNNING containers only) and return early
 * if it found anything. Two consequences: a stopped accessory made the whole
 * deploy fail with "name already in use", and changing the image or the secrets
 * in deploy.yml had no effect at all, silently.
 */
export async function deployAccessory(
  ssh: NodeSSH,
  project: string,
  name: string,
  accessory: AccessoryConfig,
  env: ContainerEnv,
): Promise<AccessoryAction> {
  const containerName = `${project}-${name}`;
  const spec = accessorySpecHash(accessory, env);

  // -a includes stopped ones: exactly the case that used to break the deploy.
  const existing = (await exec(ssh, shJoin([
    'sudo docker ps -a',
    `--filter ${shQuote(`name=^${containerName}$`)}`,
    `--format ${shQuote('{{.State}}')}`,
  ]))).trim();

  if (existing) {
    const currentSpec = (await exec(ssh, shJoin([
      'sudo docker inspect -f',
      shQuote('{{index .Config.Labels "deploy.spec"}}'),
      `${shQuote(containerName)} 2>/dev/null || true`,
    ]))).trim();

    if (currentSpec === spec) {
      if (existing === 'running') return 'unchanged';
      await exec(ssh, `sudo docker start ${shQuote(containerName)}`);
      return 'started';
    }

    // The configuration changed: an existing container's image and variables
    // cannot be modified, so it has to be recreated. The volumes are named
    // volumes and are left alone, so the data survives.
    await removeContainer(ssh, containerName);
  }

  await withSecretsFile(ssh, containerName, env.secret, (envFileFlag) =>
    exec(ssh, shJoin([
      'sudo docker run -d',
      `--name ${shQuote(containerName)}`,
      `--network ${shQuote(TRAEFIK_NETWORK)}`,
      '--restart unless-stopped',
      buildPortFlag(accessory.port),
      identityLabels(project, name, spec, 'accessory'),
      `--label ${shQuote(`deploy.spec=${spec}`)}`,
      buildVolumeFlags(containerName, accessory.volumes),
      envFileFlag,
      envFlags(env.clear),
      shQuote(accessory.image),
    ])),
  );

  return existing ? 'recreated' : 'created';
}

/** The -p flag, pinned to the loopback unless the user asked for an interface. */
function buildPortFlag(port?: string): string {
  if (!port) return '';
  return `-p ${shQuote(normalizePortBinding(port).spec)}`;
}

// ─── Health check ────────────────────────────────────────────────────────────

/**
 * Builds the command that probes the health endpoint.
 *
 * The probe runs FROM OUTSIDE, in a throwaway container on the same network,
 * rather than through `docker exec` inside the app container. The reason:
 * `docker exec` requires the user's image to ship wget or curl, and the usual
 * production images (distroless, node:slim) ship neither — the probe would
 * always fail, or worse, "pass" because it cannot tell failure apart.
 *
 * The container NAME is used as the host: on a user-defined bridge network
 * Docker resolves it through DNS, so there is no need to look up the IP.
 *
 * busybox's wget exits non-zero when the connection fails or the HTTP status is
 * >= 400, which is exactly the signal we need.
 */
export function buildProbeCommand(
  network: string,
  probeImage: string,
  url: string,
  timeoutSec = 5,
): string {
  return shJoin([
    'sudo docker run --rm',
    `--network ${shQuote(network)}`,
    shQuote(probeImage),
    `wget -q -T ${timeoutSec} -O /dev/null`,
    shQuote(url),
  ]);
}

export interface HealthCheckOptions {
  maxRetries?: number;
  intervalMs?: number;
  probeImage?: string;
  network?: string;
}

/** Seconds between probes. */
export const PROBE_INTERVAL_MS = 2000;

/**
 * How many probes fit in a service's startup budget.
 *
 * Always at least one, so a timeout shorter than the interval still gets a
 * single chance rather than none.
 */
export function healthRetries(
  startupTimeoutSec: number,
  intervalMs = PROBE_INTERVAL_MS,
): number {
  return Math.max(1, Math.ceil((startupTimeoutSec * 1000) / intervalMs));
}

/**
 * Waits until the service responds, or throws.
 *
 * Unlike the previous version, there is NO `|| true` here: if the probe fails,
 * `exec` throws on the exit code and the deploy is genuinely rolled back.
 */
export async function waitForHealthy(
  ssh: NodeSSH,
  containerName: string,
  port: number,
  path: string,
  opts: HealthCheckOptions = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? 30;
  const intervalMs = opts.intervalMs ?? PROBE_INTERVAL_MS;
  const probeImage = opts.probeImage ?? PROBE_IMAGE;
  const network = opts.network ?? TRAEFIK_NETWORK;

  const url = `http://${containerName}:${port}${path}`;
  const probe = buildProbeCommand(network, probeImage, url);
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // If the container already died there is no point exhausting the retries:
    // fail immediately with its logs, which is what the user needs to see.
    const running = await exec(ssh,
      `sudo docker inspect -f ${shQuote('{{.State.Running}}')} ${shQuote(containerName)} 2>/dev/null || true`,
    );
    if (running.trim() === 'false') {
      throw new Error(
        `Container ${containerName} stopped while starting up.\n` +
        await tailLogs(ssh, containerName),
      );
    }

    try {
      await exec(ssh, probe);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) await sleep(intervalMs);
  }

  const waited = Math.round((maxRetries * intervalMs) / 1000);
  throw new Error(
    `Health check failed for ${containerName} after ${maxRetries} attempts (~${waited}s).\n` +
    `Probe: GET ${url}\n` +
    `Last error: ${lastError}\n` +
    await tailLogs(ssh, containerName),
  );
}

/** Last lines from the container, so the error says why it failed. */
async function tailLogs(ssh: NodeSSH, containerName: string, lines = 20): Promise<string> {
  const logs = await exec(ssh,
    `sudo docker logs --tail ${lines} ${shQuote(containerName)} 2>&1 || true`,
  );
  return logs ? `\nLast ${lines} lines of ${containerName}:\n${logs}` : '';
}

// ─── Deploy lock ─────────────────────────────────────────────────────────────

/**
 * Attempts to create a lock file, atomically.
 *
 * `set -C` (noclobber) makes the redirection FAIL if the file already exists.
 * That is a test-and-create in the kernel: reading with `cat` and writing
 * afterwards, as an earlier version did, leaves a gap two concurrent deploys
 * can both slip through and end up holding the lock at once.
 */
async function tryCreateLock(ssh: NodeSSH, lockFile: string, owner: string): Promise<boolean> {
  const now = new Date().toISOString();
  const acquired = await exec(ssh, shJoin([
    `mkdir -p ${shQuote(LOCKS_DIR)} &&`,
    `(set -C; echo ${shQuote(`${owner}|${now}`)} > ${shQuote(lockFile)})`,
    '2>/dev/null && echo ok || true',
  ]));
  return acquired.trim() === 'ok';
}

const PROXY_LOCK = `${LOCKS_DIR}/.proxy.lock`;

/**
 * Runs `fn` holding the server-wide proxy lock.
 *
 * Traefik is one container for the whole machine, so two `deploy setup` runs at
 * once would both remove and recreate it. This lock is deliberately not a
 * project lock: what it guards belongs to the server, not to any one project.
 */
export async function withProxyLock<T>(ssh: NodeSSH, fn: () => Promise<T>): Promise<T> {
  const user = process.env.USER ?? 'unknown';

  if (!await tryCreateLock(ssh, PROXY_LOCK, user)) {
    const held = (await exec(ssh, `cat ${shQuote(PROXY_LOCK)} 2>/dev/null || true`)).trim();
    throw new Error(
      `Another proxy setup is running on this server${held ? ` (${held})` : ''}.\n` +
      `Wait for it to finish. If it was interrupted, remove ${PROXY_LOCK} on the server.`,
    );
  }

  try {
    return await fn();
  } finally {
    await exec(ssh, `rm -f ${shQuote(PROXY_LOCK)}`);
  }
}

export async function acquireLock(ssh: NodeSSH, project: string): Promise<void> {
  const dirExists = await exec(ssh, `test -d ${shQuote(DEPLOY_DIR)} && echo ok || true`);
  if (!dirExists) {
    throw new Error(
      `Directory ${DEPLOY_DIR} does not exist.\n` +
      `Run this first: deploy setup`
    );
  }
  const lockFile = lockPath(project);
  const user = process.env.USER ?? 'unknown';

  if (await tryCreateLock(ssh, lockFile, user)) return;

  // Failing to create the file does not prove someone holds the lock: an
  // unwritable directory fails the same way. Reporting a phantom lock would
  // send you looking for a deploy that never existed.
  const holder = await readLock(ssh, project);
  if (!holder) {
    throw new Error(
      `Could not acquire the deploy lock for '${project}', and no lock is held.\n` +
      `Check that ${LOCKS_DIR} is writable by ${user}.`
    );
  }

  throw new Error(
    `A deploy of '${project}' is already in progress, started by ${holder.user} ` +
    `on ${holder.date}.\n` +
    `If that deploy was interrupted, release the lock with: deploy unlock`
  );
}

export async function releaseLock(ssh: NodeSSH, project: string): Promise<void> {
  await exec(ssh, `rm -f ${shQuote(lockPath(project))}`);
}

/** Returns who holds the lock, or null when it is free. */
export async function readLock(
  ssh: NodeSSH,
  project: string,
): Promise<{ user: string; date: string } | null> {
  const existing = (await exec(ssh,
    `cat ${shQuote(lockPath(project))} 2>/dev/null || true`,
  )).trim();

  if (!existing) return null;

  // Destructuring defaults only fill in for undefined, so an empty or truncated
  // lock file would yield empty strings and a message reading "held by  on ".
  const [user, date] = existing.split('|');
  return { user: user || 'unknown', date: date || 'an unknown date' };
}

/**
 * One lock per project.
 *
 * It used to be a single /opt/deploy/.deploy.lock for the whole server, so
 * deploying one project blocked every other project on that machine.
 */
function lockPath(project: string): string {
  return `${LOCKS_DIR}/${project}.lock`;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Decides which images of a service get deleted.
 *
 * The `keep` most recent ones OF THAT SERVICE are retained. The previous version
 * applied the limit to the whole project (`docker images 'project-*'`), so with
 * two services and keep=3 there was roughly a version and a half per service
 * left, and rollback found no target to go back to.
 *
 * The image in use is never deleted, even when it is old: after a rollback, the
 * version being served is not the most recent one.
 */
export function selectImagesToDelete(
  images: string[],
  keep: number,
  inUse: string | null,
): string[] {
  return images.filter((image, index) => index >= keep && image !== inUse);
}

/** A service's images, newest first. */
export async function listServiceImages(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
): Promise<string[]> {
  const output = await exec(ssh, shJoin([
    'sudo docker images',
    shQuote(`${project}-${serviceName}`),
    `--format ${shQuote('{{.Repository}}:{{.Tag}}')}`,
  ]));
  // docker images already sorts by creation date, descending.
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

export async function cleanupImages(
  ssh: NodeSSH,
  project: string,
  serviceNames: string[],
  keep = 3,
): Promise<void> {
  for (const serviceName of serviceNames) {
    const images = await listServiceImages(ssh, project, serviceName);
    const inUse = await getDeployedImage(ssh, project, serviceName);
    const toDelete = selectImagesToDelete(images, keep, inUse);

    if (toDelete.length > 0) {
      await exec(ssh,
        `sudo docker rmi ${toDelete.map(shQuote).join(' ')} 2>/dev/null || true`,
      );
    }
  }

  // Rebuilds leave dangling <none>:<none> layers that match no name filter and
  // would otherwise pile up indefinitely.
  await exec(ssh, 'sudo docker image prune -f >/dev/null 2>&1 || true');
}

/**
 * The image currently running for a service.
 *
 * Docker is asked directly instead of inferring it from the image list: the
 * previous rollback assumed the most recent image was the deployed one, so two
 * rollbacks in a row went back to the broken version.
 */
export async function getDeployedImage(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
): Promise<string | null> {
  const output = (await exec(ssh, shJoin([
    'sudo docker ps',
    `--filter ${shQuote(`label=deploy.project=${project}`)}`,
    `--filter ${shQuote(`label=deploy.service=${serviceName}`)}`,
    `--format ${shQuote('{{.Image}}')}`,
  ]))).trim();

  return output.split('\n')[0]?.trim() || null;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface StatusTable {
  /** The table as docker rendered it, header included. */
  text: string;
  /** How many containers it lists. */
  count: number;
}

/**
 * Containers of a project, as a table.
 *
 * `--format table` always prints a header row, even with no matches, so the
 * caller cannot tell "nothing running" from "something running" by looking at
 * whether the output is empty. The row count is what answers that.
 */
export async function getStatus(ssh: NodeSSH, project: string): Promise<StatusTable> {
  const text = await exec(ssh, shJoin([
    'sudo docker ps',
    `--filter ${shQuote(`label=deploy.project=${project}`)}`,
    `--format ${shQuote('table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}')}`,
  ]));

  const rows = text.split('\n').filter(line => line.trim().length > 0);
  return { text, count: Math.max(0, rows.length - 1) };
}

/**
 * The container currently serving a service.
 *
 * With SHA-versioned names the container name can no longer be composed, so
 * Docker has to be asked through the identity labels.
 */
export async function findRunningContainer(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
): Promise<string | null> {
  const output = await exec(ssh, shJoin([
    'sudo docker ps',
    `--filter ${shQuote(`label=deploy.project=${project}`)}`,
    `--filter ${shQuote(`label=deploy.service=${serviceName}`)}`,
    `--format ${shQuote('{{.Names}}')}`,
  ]));
  const [name] = output.split('\n').map(line => line.trim()).filter(Boolean);
  return name ?? null;
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export async function streamLogs(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  tailLines = 100,
): Promise<void> {
  const containerName = await findRunningContainer(ssh, project, serviceName);
  if (!containerName) {
    throw new Error(
      `No container is running for '${serviceName}'.\n` +
      `Check the current state with: deploy status`,
    );
  }

  const tail = Number.isFinite(tailLines) ? Math.max(0, Math.trunc(tailLines)) : 100;
  await exec(ssh,
    `sudo docker logs -f --tail ${tail} ${shQuote(containerName)}`,
    { stream: true },
  );
}

// ─── Rollback ────────────────────────────────────────────────────────────────

/**
 * Picks which image to roll back to: the one right before the deployed version.
 *
 * When the deployed version is unknown (for instance, the service is down) it
 * falls back to the second most recent, which is what the previous version did
 * always — and why two rollbacks in a row reinstalled the broken version.
 */
export function selectRollbackTarget(
  images: string[],
  deployed: string | null,
): { from: string; to: string } | null {
  const index = deployed ? images.indexOf(deployed) : -1;
  const currentIndex = index >= 0 ? index : 0;
  const target = images[currentIndex + 1];

  if (!target) return null;
  return { from: images[currentIndex]!, to: target };
}

// ─── Traefik ─────────────────────────────────────────────────────────────────

interface TraefikContainer {
  exists: boolean;
  running: boolean;
  /** Arguments it was started with, empty when they cannot be read. */
  cmd: string;
}

/**
 * Inspects the proxy container.
 *
 * Existence, liveness and arguments are read apart. Inferring existence from a
 * non-empty command line conflates two different states: a container whose
 * arguments cannot be read looked absent, and the next `docker run` then failed
 * on the name already being in use. And a container that exists but is stopped
 * would have compared equal to the desired configuration — reported as "up to
 * date" while every site on the server was down.
 */
async function readTraefik(ssh: NodeSSH): Promise<TraefikContainer> {
  const state = (await exec(ssh, shJoin([
    'sudo docker ps -a',
    `--filter ${shQuote('name=^deploy-traefik$')}`,
    `--format ${shQuote('{{.State}}')}`,
  ]))).trim();

  if (!state) return { exists: false, running: false, cmd: '' };

  const cmd = await exec(ssh, shJoin([
    'sudo docker inspect -f',
    shQuote('{{range .Config.Cmd}}{{println .}}{{end}}'),
    'deploy-traefik 2>/dev/null || true',
  ]));

  return { exists: true, running: state === 'running', cmd };
}

export interface ProxyReconcileResult {
  action: 'created' | 'recreated' | 'unchanged';
  /** Routes carried over from a label-based Traefik. */
  adopted: string[];
  /** Containers whose route could not be read, and are therefore left unrouted. */
  skipped: string[];
}

/**
 * Brings Traefik in line with the given proxy configuration.
 *
 * Only `deploy setup` calls this. Traefik is a single container shared by every
 * project on the server, so recreating it affects all of them: that has to be a
 * deliberate act, not a side effect of deploying one project.
 */
export async function reconcileProxy(
  ssh: NodeSSH,
  proxy: ProxyConfig,
): Promise<ProxyReconcileResult> {
  await exec(ssh,
    `sudo docker network create ${shQuote(TRAEFIK_NETWORK)} 2>/dev/null || true`,
  );
  await exec(ssh, `mkdir -p ${shQuote(DYNAMIC_DIR)}`);

  const traefik = await readTraefik(ssh);
  const current = traefik.exists ? parseTraefikCmd(traefik.cmd) : null;
  const wantedEmail = proxy.ssl ? proxy.email : null;

  // A stopped proxy is never "up to date": it is serving nothing.
  if (
    traefik.running &&
    current?.fileProvider &&
    current.ssl === proxy.ssl &&
    current.email === wantedEmail
  ) {
    return { action: 'unchanged', adopted: [], skipped: [] };
  }

  // Migrating from a label-based Traefik: its routes only exist as labels on
  // running containers, and the new one will not read them. Writing them out
  // first means it starts up already serving everything that was up. Only worth
  // attempting while the old proxy is up, since the labels are read from
  // running containers.
  const migration = traefik.running && current && !current.fileProvider
    ? await adoptLabelRoutes(ssh)
    : { adopted: [], skipped: [] };

  if (traefik.exists) await removeContainer(ssh, 'deploy-traefik');

  // Ports 80 and 443 can only be held by one container, so the old proxy has to
  // go before the new one starts. That leaves a window with no proxy at all: if
  // the start fails, every site on this server is down, and the error has to say
  // so rather than read like any other failed command.
  try {
    await startTraefik(ssh, proxy);
  } catch (err) {
    throw new Error(
      `Traefik could not be started, and the previous one was already removed: ` +
      `every site on this server is currently DOWN.\n` +
      `Fix the cause and run \`deploy setup\` again — the routes are already ` +
      `written, so the proxy will come back serving them.\n\n` +
      (err instanceof Error ? err.message : String(err)),
    );
  }

  return { action: current ? 'recreated' : 'created', ...migration };
}

/**
 * Checks the running Traefik against what this project declares.
 *
 * `deploy` never modifies Traefik, so a mismatch has to be reported instead of
 * silently ignored — which is what used to happen with `proxy.email`.
 * An ssl mismatch throws because the project simply would not serve traffic.
 */
export async function assertProxyMatches(
  ssh: NodeSSH,
  proxy: ProxyConfig,
): Promise<string[]> {
  const traefik = await readTraefik(ssh);

  if (!traefik.exists) {
    throw new Error(
      'Traefik is not running on this server.\n' +
      'Run: deploy setup',
    );
  }

  if (!traefik.running) {
    throw new Error(
      'The Traefik container exists but is stopped, so nothing on this server is\n' +
      'being served. Deploying now would switch a route nobody is listening on.\n' +
      'Bring it back with: deploy setup',
    );
  }

  const current = parseTraefikCmd(traefik.cmd);

  if (!current.fileProvider) {
    throw new Error(
      'This server runs a Traefik from an older version of the CLI, which routes\n' +
      'through Docker labels and would ignore this deploy.\n' +
      'Run `deploy setup` to migrate it: it carries the existing routes over first,\n' +
      'so the projects already running keep serving.',
    );
  }

  if (current.ssl !== proxy.ssl) {
    throw new Error(
      `Traefik is running with ssl=${current.ssl}, but this project declares ` +
      `ssl=${proxy.ssl}.\n` +
      `Traefik is shared by every project on the server, so both cannot hold at ` +
      `once: with ssl=true it redirects all HTTP to HTTPS, and a project on plain ` +
      `HTTP would be redirected to a certificate that does not exist.\n` +
      `Align deploy.yml, or apply this project's setting with: deploy setup`,
    );
  }

  const warnings: string[] = [];

  if (proxy.ssl && current.email !== proxy.email) {
    warnings.push(
      `Traefik is registered with the Let's Encrypt account ${current.email ?? 'none'}, ` +
      `but this project declares ${proxy.email}. Certificate expiry notices go to ` +
      `the former. Apply this project's address with: deploy setup`,
    );
  }

  return warnings;
}

export interface AdoptionResult {
  /** Routes written out, now served by the file provider. */
  adopted: string[];
  /** Containers whose labels could not be read: they end up unrouted. */
  skipped: string[];
}

/**
 * Turns the Traefik labels of running containers into route files.
 *
 * Existing files are left alone: a route already written by this version is
 * newer than any label.
 *
 * A container we cannot read is reported rather than skipped quietly. Silence
 * here would mean a project going dark during the migration with nothing said
 * about it — the single worst outcome this function exists to prevent.
 */
export async function adoptLabelRoutes(ssh: NodeSSH): Promise<AdoptionResult> {
  const names = (await exec(ssh, shJoin([
    'sudo docker ps',
    `--filter ${shQuote('label=traefik.enable=true')}`,
    `--format ${shQuote('{{.Names}}')}`,
  ]))).split('\n').map(line => line.trim()).filter(Boolean);

  const adopted: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const raw = await exec(ssh, shJoin([
      'sudo docker inspect -f',
      shQuote('{{json .Config.Labels}}'),
      `${shQuote(name)} 2>/dev/null || true`,
    ]));

    let labels: unknown;
    try {
      labels = JSON.parse(raw);
    } catch {
      // Empty or malformed output: the container may have gone away between
      // listing and inspecting.
      skipped.push(name);
      continue;
    }

    if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
      skipped.push(name);
      continue;
    }

    const spec = adoptRouteFromLabels(name, labels as Record<string, string>);
    if (!spec) {
      skipped.push(name);
      continue;
    }

    const path = routeConfigPath(spec.router);
    const exists = await exec(ssh, `test -f ${shQuote(path)} && echo yes || true`);
    if (exists.trim() === 'yes') continue;

    await exec(ssh, `cat > ${shQuote(path)}`, { stdin: buildRouteConfig(spec) });
    adopted.push(spec.router);
  }

  return { adopted, skipped };
}

async function startTraefik(ssh: NodeSSH, proxy: ProxyConfig): Promise<void> {
  // With ssl disabled none of the HTTPS machinery is configured. It used to be
  // added unconditionally, so a project on `ssl: false` was published on the
  // `web` entrypoint while that same entrypoint redirected everything to
  // `websecure`, where no certificate had ever been requested: the only setup
  // where the option makes sense was the one where it could not work.
  const tls = proxy.ssl
    ? [
        '--entrypoints.websecure.address=:443',
        '--entrypoints.web.http.redirections.entrypoint.to=websecure',
        '--entrypoints.web.http.redirections.entrypoint.scheme=https',
        '--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web',
        shQuote(`--certificatesresolvers.letsencrypt.acme.email=${proxy.email}`),
        '--certificatesresolvers.letsencrypt.acme.storage=/certs/acme.json',
      ]
    : [];

  await exec(ssh, shJoin([
    'sudo docker run -d',
    '--name deploy-traefik',
    `--network ${shQuote(TRAEFIK_NETWORK)}`,
    '--restart unless-stopped',
    '-p 80:80',
    proxy.ssl ? '-p 443:443' : '',
    // The Docker socket is no longer mounted: without a Docker provider, Traefik
    // has no reason to talk to the daemon. A container with access to that
    // socket is equivalent to root on the host, so dropping it cuts real risk.
    '-v deploy-traefik-certs:/certs',
    `-v ${shQuote(`${DYNAMIC_DIR}:/dynamic:ro`)}`,
    TRAEFIK_IMAGE,
    // Routing comes from files written by the CLI rather than labels, which is
    // what makes an explicit switch-over moment possible (see core/traefik.ts).
    '--providers.file.directory=/dynamic',
    '--providers.file.watch=true',
    '--entrypoints.web.address=:80',
    ...tls,
  ]));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Container identity labels.
 *
 * Containers are identified by labels rather than by name prefix because the
 * prefix is ambiguous: with services `web` and `web-api`, the filter
 * `^project-web-` matches containers of both. A label filter is exact.
 */
export function identityLabels(
  project: string,
  serviceName: string,
  sha: string,
  role: 'service' | 'accessory',
): string {
  return shJoin([
    `--label ${shQuote(`deploy.project=${project}`)}`,
    `--label ${shQuote(`deploy.service=${serviceName}`)}`,
    `--label ${shQuote(`deploy.sha=${sha}`)}`,
    `--label ${shQuote(`deploy.role=${role}`)}`,
  ]);
}

/** IDs of a service's containers, running or not. */
export async function listContainerIds(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
): Promise<string[]> {
  const output = await exec(ssh, shJoin([
    'sudo docker ps -aq',
    `--filter ${shQuote(`label=deploy.project=${project}`)}`,
    `--filter ${shQuote(`label=deploy.service=${serviceName}`)}`,
  ]));
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * Persistent volumes: the name is prefixed with the service, so "data:/data"
 * becomes "-v <service>-data:/data". The prefix carries no SHA precisely so the
 * volume survives the container being recreated on every deploy.
 */
export function buildVolumeFlags(containerName: string, volumes: string[]): string {
  return shJoin(volumes.map(volume => `-v ${shQuote(`${containerName}-${volume}`)}`));
}

async function removeContainer(ssh: NodeSSH, name: string): Promise<void> {
  await exec(ssh, `sudo docker rm -f ${shQuote(name)} 2>/dev/null || true`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
