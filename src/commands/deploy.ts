import { loadConfig, getSecretsPath, getAllSecretNames } from '../core/config.js';
import type { ServiceConfig, AccessoryConfig } from '../core/config.js';
import { connect, exec, disconnect, rsync } from '../core/ssh.js';
import {
  getGitSHA,
  buildImage,
  deployAccessory,
  deployService,
  ensureTraefikRunning,
  acquireLock,
  releaseLock,
  cleanupImages,
} from '../core/docker.js';
import { resolveSecrets } from '../utils/env.js';
import { log, spinner } from '../utils/logger.js';

interface DeployOptions {
  service?: string;
  force?: boolean;
}

export async function deploy(opts: DeployOptions) {
  const config = loadConfig();
  const sha = getGitSHA();
  const secretsPath = getSecretsPath();

  log.banner(`Deploy: ${config.project}@${sha}`);
  log.table([
    ['Proyecto', config.project],
    ['Servidor', `${config.server.user}@${config.server.host}`],
    ['Commit', sha],
  ]);
  console.log();

  const allSecretNames = getAllSecretNames(config);
  let secrets: Record<string, string> = {};
  if (allSecretNames.length > 0) {
    secrets = resolveSecrets(allSecretNames, secretsPath);
    log.success(`${allSecretNames.length} secretos resueltos`);
  }

  const ssh = await connect(config.server);
  log.success(`Conectado a ${config.server.host}`);

  if (opts.force) {
    await releaseLock(ssh);
  }
  await acquireLock(ssh, config.project);

  try {
    const traefikSpinner = spinner('Verificando Traefik...');
    await ensureTraefikRunning(ssh, config.proxy.email);
    traefikSpinner.success('Traefik OK');

    const syncSpinner = spinner('Sincronizando código...');
    const remoteDir = `/opt/deploy/${config.project}`;
    await exec(ssh, `mkdir -p ${remoteDir}`);
    await rsync(config.server, process.cwd(), remoteDir, [
      'node_modules',
      '.git',
      '.env',
      '.deploy',
      'dist',
      '.astro',
    ]);
    syncSpinner.success('Código sincronizado');

    for (const [name, accessory] of Object.entries(config.accessories ?? {})) {
      const accSpinner = spinner(`Accessory: ${name}...`);
      const accEnv = buildContainerEnv(accessory, secrets);
      await deployAccessory(ssh, config.project, name, accessory, accEnv);
      accSpinner.success(`Accessory: ${name}`);
    }

    const servicesToDeploy = opts.service
      ? Object.entries(config.services).filter(([name]) => name === opts.service)
      : Object.entries(config.services);

    if (opts.service && servicesToDeploy.length === 0) {
      throw new Error(`Servicio '${opts.service}' no encontrado en deploy.yml`);
    }

    for (const [name, service] of servicesToDeploy) {
      const buildSpinner = spinner(`Build: ${name}...`);
      const image = await buildImage(ssh, config.project, name, service, sha);
      buildSpinner.success(`Build: ${name} → ${image}`);

      const svcEnv = buildContainerEnv(service, secrets);

      const deploySpinner = spinner(`Deploy: ${name}...`);
      await deployService(ssh, config.project, name, service, image, svcEnv, config.proxy.ssl);
      deploySpinner.success(`Deploy: ${name} → ${service.domain}`);
    }

    const cleanupSpinner = spinner('Limpiando imágenes antiguas...');
    await cleanupImages(ssh, config.project);
    cleanupSpinner.success('Limpieza completada');

  } finally {
    await releaseLock(ssh);
    await disconnect();
  }

  console.log();
  log.banner('Deploy completado');
  for (const [, service] of Object.entries(config.services)) {
    const proto = config.proxy.ssl ? 'https' : 'http';
    log.success(`${service.domain} → ${proto}://${service.domain}`);
  }
}

function buildContainerEnv(
  serviceOrAccessory: ServiceConfig | AccessoryConfig,
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...serviceOrAccessory.env?.clear };
  for (const secretName of serviceOrAccessory.env?.secret ?? []) {
    if (secrets[secretName]) {
      env[secretName] = secrets[secretName];
    }
  }
  return env;
}
