import { loadConfig } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { getStatus } from '../core/docker.js';
import { log } from '../utils/logger.js';

export async function status() {
  const config = loadConfig();

  log.banner(`Status: ${config.project}`);

  const ssh = await connect(config.server);

  try {
    const status = await getStatus(ssh, config.project);

    if (status.count > 0) {
      console.log(status.text);
    } else {
      log.warn(`No containers running for '${config.project}'`);
      log.info('If you deployed with an older version, they carry no identity labels yet.');
    }
  } finally {
    await disconnect();
  }
}
