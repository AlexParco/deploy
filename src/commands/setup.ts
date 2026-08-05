import { loadConfig } from '../core/config.js';
import { connect, exec, disconnect } from '../core/ssh.js';
import { reconcileProxy, withProxyLock } from '../core/docker.js';
import type { ProxyReconcileResult } from '../core/docker.js';
import { log, spinner } from '../utils/logger.js';

const PROXY_ACTIONS: Record<ProxyReconcileResult['action'], string> = {
  created: 'started',
  recreated: 'reconfigured',
  unchanged: 'already up to date',
};

export async function setup() {
  const config = loadConfig();

  log.banner(`Setup: ${config.server.host}`);

  let ssh = await connect(config.server);
  log.success(`Connected to ${config.server.user}@${config.server.host}`);

  const dockerSpinner = spinner('Checking Docker...');
  // Presence and usability are checked apart. Treating any failure of
  // `sudo docker ps` as "not installed" would run the install script on a
  // machine that already has Docker — sudo asking for a password looks exactly
  // the same — and that can upgrade the engine and restart every container on
  // the box, production included.
  const installed = await exec(ssh, 'command -v docker >/dev/null 2>&1 && echo yes || true');

  if (installed.trim() !== 'yes') {
    dockerSpinner.update('Installing Docker...');
    await exec(ssh, 'curl -fsSL https://get.docker.com | sudo sh');
    await exec(ssh, `sudo usermod -aG docker ${config.server.user}`);
    dockerSpinner.success('Docker installed');

    await disconnect();
    ssh = await connect(config.server);
  } else {
    try {
      await exec(ssh, 'sudo docker ps >/dev/null 2>&1');
      dockerSpinner.success('Docker present and usable');
    } catch {
      dockerSpinner.fail('Docker is installed but cannot be used');
      throw new Error(
        `Docker is installed on ${config.server.host}, but \`sudo docker ps\` failed.\n` +
        `Usually that means ${config.server.user} needs a password for sudo, or the\n` +
        `daemon is not running. It was NOT reinstalled: doing so could restart every\n` +
        `container on this server.`,
      );
    }
  }

  const dirSpinner = spinner('Creating directories...');
  await exec(ssh, 'sudo mkdir -p /opt/deploy && sudo chown $(whoami):$(whoami) /opt/deploy');
  dirSpinner.success('Directory /opt/deploy ready');

  const firewallSpinner = spinner('Configuring firewall...');
  const hasUfw = await exec(ssh, 'command -v ufw >/dev/null 2>&1 && echo yes || true');

  if (hasUfw.trim() !== 'yes') {
    firewallSpinner.success('Firewall: ufw not installed, skipping');
  } else {
    const sshPort = config.server.port;
    try {
      // The SSH port is allowed before enabling, or this would lock you out.
      await exec(ssh, `sudo ufw allow ${sshPort}/tcp`);
      await exec(ssh, 'sudo ufw allow 80/tcp');
      await exec(ssh, 'sudo ufw allow 443/tcp');
      await exec(ssh, 'echo "y" | sudo ufw enable 2>/dev/null || true');
      firewallSpinner.success(`Firewall configured (${sshPort}, 80, 443)`);
    } catch (err) {
      // Reporting this as "skipped" would read as a clean decision when it is
      // really a failure, and firewall rules are not something to be vague about.
      firewallSpinner.fail('Firewall: ufw is installed but could not be configured');
      log.warn(err instanceof Error ? err.message : String(err));
      log.info(`Check the rules yourself: sudo ufw status`);
    }
  }

  const traefikSpinner = spinner('Configuring Traefik...');
  // Held across the whole reconciliation: Traefik belongs to the server, and two
  // concurrent setups would both tear it down and bring it back.
  const proxy = await withProxyLock(ssh, () => reconcileProxy(ssh, config.proxy));
  traefikSpinner.success(
    config.proxy.ssl
      ? `Traefik ${PROXY_ACTIONS[proxy.action]} with automatic SSL (${config.proxy.email})`
      : `Traefik ${PROXY_ACTIONS[proxy.action]} on plain HTTP (ssl: false)`,
  );

  if (proxy.adopted.length > 0) {
    log.success(
      `${proxy.adopted.length} existing route(s) carried over: ${proxy.adopted.join(', ')}`,
    );
    log.info(
      'They still point at the containers already running, so those projects keep ' +
      'serving. Each one moves to the new scheme the next time you deploy it.',
    );
  } else if (proxy.action === 'recreated') {
    log.warn(
      'Traefik was recreated. It is shared by every project on this server, so any ' +
      'route not present in the routes directory is down until you deploy that ' +
      'project. Check with: deploy status',
    );
  }

  if (proxy.skipped.length > 0) {
    log.error(
      `Could not read the route of ${proxy.skipped.length} container(s): ` +
      `${proxy.skipped.join(', ')}`,
    );
    log.warn('They are NOT being routed. Deploy those projects, or check them by hand.');
  }

  await disconnect();

  log.banner('VPS ready');
  log.info('Now run: deploy deploy');
}
