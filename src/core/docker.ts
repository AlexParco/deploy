import { execSync } from 'node:child_process';
import type { NodeSSH } from 'node-ssh';
import { exec } from './ssh.js';
import type { ServiceConfig, AccessoryConfig } from './config.js';

const DEPLOY_DIR = '/opt/deploy';
const TRAEFIK_NETWORK = 'deploy-proxy';
const TRAEFIK_IMAGE = 'traefik:v2.11';
const LOCK_FILE = `${DEPLOY_DIR}/.deploy.lock`;

// ─── Git SHA ─────────────────────────────────────────────────────────────────

export function getGitSHA(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No se pudo obtener el git SHA. ¿Estás en un repo git?');
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
  const dockerfile = `${service.build}/${service.dockerfile || 'Dockerfile'}`;

  await exec(ssh, `sudo docker build -t ${image} -f ${dockerfile} ${service.build}`, {
    cwd: buildDir,
  });

  return image;
}

// ─── Servicios ───────────────────────────────────────────────────────────────

export async function deployService(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  service: ServiceConfig,
  image: string,
  envVars: Record<string, string>,
  ssl: boolean,
): Promise<void> {
  const containerName = `${project}-${serviceName}`;
  const oldContainer = `${containerName}-old`;

  await exec(ssh,
    `sudo docker rename ${containerName} ${oldContainer} 2>/dev/null || true`,
  );

  const labels = buildTraefikLabels(containerName, service, ssl);
  const envFlags = buildEnvFlags(envVars);

  await exec(ssh, [
    'sudo docker run -d',
    `--name ${containerName}`,
    `--network ${TRAEFIK_NETWORK}`,
    '--restart unless-stopped',
    labels,
    envFlags,
    image,
  ].join(' '));

  try {
    await waitForHealthy(ssh, containerName, service.port, service.healthcheck);
  } catch (err) {
    // Si el health check falla, limpiar el contenedor nuevo y restaurar el viejo
    await exec(ssh, `sudo docker stop ${containerName} 2>/dev/null || true`);
    await exec(ssh, `sudo docker rm ${containerName} 2>/dev/null || true`);
    await exec(ssh, `sudo docker rename ${oldContainer} ${containerName} 2>/dev/null || true`);
    throw err;
  }

  await exec(ssh, `sudo docker stop ${oldContainer} 2>/dev/null || true`);
  await exec(ssh, `sudo docker rm ${oldContainer} 2>/dev/null || true`);
}

// ─── Accessories ─────────────────────────────────────────────────────────────

export async function deployAccessory(
  ssh: NodeSSH,
  project: string,
  name: string,
  accessory: AccessoryConfig,
  envVars: Record<string, string>,
): Promise<void> {
  const containerName = `${project}-${name}`;

  const exists = await exec(ssh,
    `sudo docker ps -q -f name=^${containerName}$ 2>/dev/null`,
  );
  if (exists) return;

  const envFlags = buildEnvFlags(envVars);
  const volumeFlags = accessory.volumes
    .map(volume => `-v ${containerName}-${volume}`)
    .join(' ');
  const portFlag = accessory.port ? `-p ${accessory.port}` : '';

  await exec(ssh, [
    'sudo docker run -d',
    `--name ${containerName}`,
    `--network ${TRAEFIK_NETWORK}`,
    '--restart unless-stopped',
    portFlag,
    volumeFlags,
    envFlags,
    accessory.image,
  ].join(' '));
}

// ─── Health Check ────────────────────────────────────────────────────────────

async function waitForHealthy(
  ssh: NodeSSH,
  containerName: string,
  port: number,
  path: string,
  maxRetries = 30,
  intervalMs = 2000,
): Promise<void> {
  let lastError = '';

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await exec(ssh,
        `sudo docker exec ${containerName} wget -qO- --spider http://localhost:${port}${path} 2>&1 || true`,
      );
      if (!result.includes('error')) return;
      lastError = result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Health check falló para ${containerName} después de ${maxRetries} intentos.\n` +
    `Último error: ${lastError}`
  );
}

// ─── Deploy Lock ─────────────────────────────────────────────────────────────

export async function acquireLock(ssh: NodeSSH, project: string): Promise<void> {
  await exec(ssh, `sudo mkdir -p ${DEPLOY_DIR}`);
  const existing = await exec(ssh, `cat ${LOCK_FILE} 2>/dev/null || true`);

  if (existing) {
    const parts = existing.split('|');
    const who = parts[0] ?? 'desconocido';
    const when = parts[1] ?? 'fecha desconocida';
    throw new Error(
      `Deploy en progreso por ${who} desde ${when}\n` +
      `Si el deploy anterior falló, ejecuta: deploy deploy --force`
    );
  }

  const user = process.env.USER ?? 'unknown';
  const now = new Date().toISOString();
  await exec(ssh, `echo '${user}|${now}|${project}' > ${LOCK_FILE}`);
}

export async function releaseLock(ssh: NodeSSH): Promise<void> {
  await exec(ssh, `rm -f ${LOCK_FILE}`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function cleanupImages(ssh: NodeSSH, project: string, keep = 3): Promise<void> {
  const output = await exec(ssh,
    `sudo docker images '${project}-*' --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | sort -k2 -r`,
  );

  if (!output) return;

  const lines = output.split('\n').filter(Boolean);
  const toDelete = lines.slice(keep)
    .map(line => line.split(' ')[0])
    .filter(Boolean);

  if (toDelete.length > 0) {
    await exec(ssh, `sudo docker rmi ${toDelete.join(' ')} 2>/dev/null || true`);
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function getStatus(ssh: NodeSSH, project: string): Promise<string> {
  return exec(ssh,
    `sudo docker ps --filter name=^${project}- --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"`,
  );
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export async function streamLogs(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
  tailLines = 100,
): Promise<void> {
  const containerName = `${project}-${serviceName}`;
  await exec(ssh, `sudo docker logs -f --tail ${tailLines} ${containerName}`, { stream: true });
}

// ─── Rollback ────────────────────────────────────────────────────────────────

export async function getPreviousImages(
  ssh: NodeSSH,
  project: string,
  serviceName: string,
): Promise<string[]> {
  const output = await exec(ssh,
    `sudo docker images '${project}-${serviceName}' --format '{{.Repository}}:{{.Tag}}' | head -5`,
  );
  return output.split('\n').filter(Boolean);
}

// ─── Traefik ─────────────────────────────────────────────────────────────────

export async function ensureTraefikRunning(ssh: NodeSSH, email: string): Promise<void> {
  await exec(ssh, `sudo docker network create ${TRAEFIK_NETWORK} 2>/dev/null || true`);

  const running = await exec(ssh, `sudo docker ps -q -f name=^deploy-traefik$ 2>/dev/null`);
  if (running) return;

  await exec(ssh, [
    'sudo docker run -d',
    '--name deploy-traefik',
    `--network ${TRAEFIK_NETWORK}`,
    '--restart unless-stopped',
    '-p 80:80',
    '-p 443:443',
    '-v /var/run/docker.sock:/var/run/docker.sock:ro',
    '-v deploy-traefik-certs:/certs',
    TRAEFIK_IMAGE,
    '--providers.docker=true',
    '--providers.docker.exposedbydefault=false',
    `--providers.docker.network=${TRAEFIK_NETWORK}`,
    '--entrypoints.web.address=:80',
    '--entrypoints.websecure.address=:443',
    '--entrypoints.web.http.redirections.entrypoint.to=websecure',
    '--entrypoints.web.http.redirections.entrypoint.scheme=https',
    '--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web',
    `--certificatesresolvers.letsencrypt.acme.email=${email}`,
    '--certificatesresolvers.letsencrypt.acme.storage=/certs/acme.json',
  ].join(' '));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTraefikLabels(
  containerName: string,
  service: ServiceConfig,
  ssl: boolean,
): string {
  const labels = [
    `traefik.enable=true`,
    `traefik.http.routers.${containerName}.rule=Host(\`${service.domain}\`)`,
    `traefik.http.services.${containerName}.loadbalancer.server.port=${service.port}`,
  ];

  if (ssl) {
    labels.push(
      `traefik.http.routers.${containerName}.entrypoints=websecure`,
      `traefik.http.routers.${containerName}.tls.certresolver=letsencrypt`,
    );
  } else {
    labels.push(`traefik.http.routers.${containerName}.entrypoints=web`);
  }

  return labels.map(label => `--label '${label}'`).join(' ');
}

function buildEnvFlags(envVars: Record<string, string>): string {
  return Object.entries(envVars)
    .map(([key, value]) => `-e '${key}=${value}'`)
    .join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
