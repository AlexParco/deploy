import { loadConfig, getSecretsPath } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import {
  listServiceImages,
  getDeployedImage,
  selectRollbackTarget,
  buildContainerEnv,
  deployService,
  assertProxyMatches,
  sweepStaleSecrets,
  acquireLock,
  releaseLock,
} from '../core/docker.js';
import { resolveSecrets } from '../utils/env.js';
import { log, spinner } from '../utils/logger.js';

export async function rollback(serviceName: string) {
  const config = loadConfig();

  const service = config.services[serviceName];
  if (!service) {
    log.error(`Service '${serviceName}' not found`);
    log.info(`Available: ${Object.keys(config.services).join(', ')}`);
    process.exit(1);
  }

  const ssh = await connect(config.server);

  try {
    const images = await listServiceImages(ssh, config.project, serviceName);
    // Ask Docker what is actually serving instead of assuming it is the most
    // recent image: after a rollback it no longer is.
    const deployed = await getDeployedImage(ssh, config.project, serviceName);
    const target = selectRollbackTarget(images, deployed);

    if (!target) {
      log.error(`No previous version of '${serviceName}' to roll back to`);
      if (images.length > 0) log.info(`Only version available: ${images[0]}`);
      process.exit(1);
    }

    log.banner(`Rollback: ${serviceName}`);
    log.table([
      ['Current', deployed ? target.from : `${target.from} (unconfirmed)`],
      ['Roll back to', target.to],
    ]);
    if (!deployed) {
      log.warn(
        'No container is running for this service, so the "current" version ' +
        'is a guess. Check with: deploy status',
      );
    }
    console.log();

    // Same check the deploy path makes: writing a route file that the running
    // proxy does not read would report success while traffic never moved.
    const proxyWarnings = await assertProxyMatches(ssh, config.proxy);
    for (const warning of proxyWarnings) log.warn(warning);

    await acquireLock(ssh, config.project);

    try {
      await sweepStaleSecrets(ssh, config.project);
      const secretsPath = getSecretsPath();
      const secretNames = service.env?.secret ?? [];
      const secrets = secretNames.length > 0
        ? resolveSecrets(secretNames, secretsPath)
        : {};

      // The image tag IS the SHA it was built from, and it is what names that
      // version's container.
      const targetSha = target.to.slice(target.to.lastIndexOf(':') + 1);

      const rollbackSpinner = spinner(`Rollback: ${serviceName}...`);
      await deployService(ssh, {
        project: config.project,
        serviceName,
        service,
        image: target.to,
        env: buildContainerEnv(service, secrets),
        ssl: config.proxy.ssl,
        sha: targetSha,
      });
      rollbackSpinner.success(`Rollback: ${serviceName} → ${target.to}`);
    } finally {
      await releaseLock(ssh, config.project);
    }

    log.banner('Rollback complete');
  } finally {
    await disconnect();
  }
}
