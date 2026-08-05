import { loadConfig, getSecretsPath, getAllSecretNames } from '../core/config.js';
import type { DeployConfig } from '../core/config.js';
import { connect, exec, disconnect, rsync } from '../core/ssh.js';
import { normalizePortBinding } from '../core/ports.js';
import type { AccessoryAction } from '../core/docker.js';
import {
  getGitSHA,
  getDirtyFiles,
  buildImage,
  buildContainerEnv,
  deployAccessory,
  deployService,
  assertProxyMatches,
  sweepStaleSecrets,
  acquireLock,
  releaseLock,
  cleanupImages,
} from '../core/docker.js';
import { resolveSecrets } from '../utils/env.js';
import { log, spinner } from '../utils/logger.js';

interface DeployOptions {
  service?: string;
}

const ACCESSORY_LABELS: Record<AccessoryAction, string> = {
  created: 'created',
  started: 'started',
  recreated: 'recreated',
  unchanged: 'unchanged',
};

/**
 * Warns about accessories published on every interface.
 *
 * Docker writes its rules ahead of ufw, so a port published on 0.0.0.0 stays
 * reachable from the internet even with the firewall enabled.
 */
function warnPublicPorts(config: DeployConfig): void {
  for (const [name, accessory] of Object.entries(config.accessories ?? {})) {
    if (!accessory.port) continue;
    if (!normalizePortBinding(accessory.port).isPublic) continue;

    log.warn(
      `Accessory '${name}' publishes ${accessory.port} on every interface: it is ` +
      `reachable from the internet, and ufw will not block it because Docker ` +
      `writes its rules first. Use "127.0.0.1:..." unless you want it public.`,
    );
  }
}

export async function deploy(opts: DeployOptions) {
  const config = loadConfig();
  const sha = getGitSHA();
  const secretsPath = getSecretsPath();

  // rsync uploads the working tree, not the commit: with uncommitted changes the
  // image ends up tagged with a SHA that does NOT match its contents, and
  // rebuilding overwrites the previous image under the same tag (losing that
  // rollback point). Warn instead of pretending the tag means something.
  const dirty = getDirtyFiles();
  if (dirty.length > 0) {
    log.warn(
      `${dirty.length} uncommitted file(s). The working tree will be deployed, ` +
      `but the image will be tagged ${sha}, which does not reflect it.`,
    );
  }

  log.banner(`Deploy: ${config.project}@${sha}${dirty.length > 0 ? ' (dirty)' : ''}`);
  log.table([
    ['Project', config.project],
    ['Server', `${config.server.user}@${config.server.host}`],
    ['Commit', sha],
  ]);
  console.log();

  warnPublicPorts(config);

  const servicesToDeploy = opts.service
    ? Object.entries(config.services).filter(([name]) => name === opts.service)
    : Object.entries(config.services);

  if (opts.service && servicesToDeploy.length === 0) {
    throw new Error(
      `Service '${opts.service}' is not defined in deploy.yml.\n` +
      `Available: ${Object.keys(config.services).join(', ')}`,
    );
  }

  // Only what this deploy actually needs, so --service does not demand the
  // secrets of services it is not touching.
  const allSecretNames = getAllSecretNames(config, servicesToDeploy.map(([name]) => name));
  let secrets: Record<string, string> = {};
  if (allSecretNames.length > 0) {
    secrets = resolveSecrets(allSecretNames, secretsPath);
    log.success(`${allSecretNames.length} secret(s) resolved`);
  }

  const ssh = await connect(config.server);
  log.success(`Connected to ${config.server.host}`);

  /** Services whose traffic already points at the new version. */
  const switched: string[] = [];

  await acquireLock(ssh, config.project);

  try {
    // Under the lock, so nothing of this project can be mid-run: clears secret
    // files stranded by deploys that were killed before their cleanup ran.
    await sweepStaleSecrets(ssh, config.project);

    // Deploy never modifies Traefik: it is shared by every project on the
    // server, so reconfiguring it belongs to `deploy setup`. Here we only check
    // that what runs matches what this project declares, and say so if not.
    const traefikSpinner = spinner('Checking Traefik...');
    const proxyWarnings = await assertProxyMatches(ssh, config.proxy);
    traefikSpinner.success('Traefik OK');
    for (const warning of proxyWarnings) log.warn(warning);

    const syncSpinner = spinner('Syncing code...');
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
    syncSpinner.success('Code synced');

    for (const [name, accessory] of Object.entries(config.accessories ?? {})) {
      const accSpinner = spinner(`Accessory: ${name}...`);
      const accEnv = buildContainerEnv(accessory, secrets);
      const action = await deployAccessory(ssh, config.project, name, accessory, accEnv);
      accSpinner.success(`Accessory: ${name} (${ACCESSORY_LABELS[action]})`);

      if (action === 'recreated') {
        log.warn(
          `${name} was recreated because its configuration changed in deploy.yml. ` +
          `Its volumes are kept, but the container restarted.`,
        );
      }
    }

    for (const [name, service] of servicesToDeploy) {
      try {
        const buildSpinner = spinner(`Build: ${name}...`);
        const image = await buildImage(ssh, config.project, name, service, sha);
        buildSpinner.success(`Build: ${name} → ${image}`);

        const svcEnv = buildContainerEnv(service, secrets);

        const deploySpinner = spinner(`Deploy: ${name}...`);
        await deployService(ssh, {
          project: config.project,
          serviceName: name,
          service,
          image,
          env: svcEnv,
          ssl: config.proxy.ssl,
          sha,
        });
        deploySpinner.success(`Deploy: ${name} → ${service.domain}`);
        switched.push(name);
      } catch (err) {
        // Services are deployed one after another, so a failure halfway leaves
        // the project split across two versions. Which ones already switched is
        // the first thing you need to know, and it would otherwise be buried
        // under the error.
        if (switched.length > 0) {
          log.warn(
            `'${name}' failed, but these services are already serving ${sha}: ` +
            `${switched.join(', ')}. The rest are untouched.`,
          );
        }
        throw err;
      }
    }

    const cleanupSpinner = spinner('Cleaning up old images...');
    await cleanupImages(ssh, config.project, Object.keys(config.services));
    cleanupSpinner.success('Cleanup done');

  } finally {
    await releaseLock(ssh, config.project);
    await disconnect();
  }

  console.log();
  log.banner('Deploy complete');
  const proto = config.proxy.ssl ? 'https' : 'http';
  for (const [name, service] of servicesToDeploy) {
    log.success(`${name} → ${proto}://${service.domain}`);
  }
}
