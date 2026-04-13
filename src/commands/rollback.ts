import { loadConfig, getSecretsPath } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { getPreviousImages, deployService, acquireLock, releaseLock } from '../core/docker.js';
import { resolveSecrets } from '../utils/env.js';
import { log, spinner } from '../utils/logger.js';

export async function rollback(serviceName: string) {
  const config = loadConfig();

  const service = config.services[serviceName];
  if (!service) {
    log.error(`Servicio '${serviceName}' no encontrado`);
    log.info(`Disponibles: ${Object.keys(config.services).join(', ')}`);
    process.exit(1);
  }

  const ssh = await connect(config.server);

  const images = await getPreviousImages(ssh, config.project, serviceName);

  if (images.length < 2) {
    log.error('No hay versión anterior para rollback');
    await disconnect();
    process.exit(1);
  }

  const currentImage = images[0];
  const previousImage = images[1];

  log.banner(`Rollback: ${serviceName}`);
  log.table([
    ['Actual', currentImage],
    ['Rollback a', previousImage],
  ]);
  console.log();

  await acquireLock(ssh, config.project);

  try {
    const secretsPath = getSecretsPath();
    const secretNames = service.env?.secret ?? [];
    const secrets = secretNames.length > 0
      ? resolveSecrets(secretNames, secretsPath)
      : {};

    const svcEnv: Record<string, string> = { ...service.env?.clear };
    for (const secretName of secretNames) {
      if (secrets[secretName]) {
        svcEnv[secretName] = secrets[secretName];
      }
    }

    const rollbackSpinner = spinner(`Rollback: ${serviceName}...`);
    await deployService(
      ssh, config.project, serviceName, service,
      previousImage, svcEnv, config.proxy.ssl,
    );
    rollbackSpinner.success(`Rollback: ${serviceName} → ${previousImage}`);

  } finally {
    await releaseLock(ssh);
    await disconnect();
  }

  log.banner('Rollback completado');
}
