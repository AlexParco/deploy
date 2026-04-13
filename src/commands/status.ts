import { loadConfig } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { getStatus } from '../core/docker.js';
import { log } from '../utils/logger.js';

export async function status() {
  const config = loadConfig();

  log.banner(`Status: ${config.project}`);

  const ssh = await connect(config.server);
  const output = await getStatus(ssh, config.project);

  if (output) {
    console.log(output);
  } else {
    log.warn('No hay contenedores corriendo');
  }

  await disconnect();
}
