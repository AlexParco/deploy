import { loadConfig } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { streamLogs } from '../core/docker.js';
import { log } from '../utils/logger.js';

interface LogsOptions {
  lines: string;
}

export async function logs(serviceName: string, opts: LogsOptions) {
  const config = loadConfig();

  // Make sure the service exists
  const allNames = [
    ...Object.keys(config.services),
    ...Object.keys(config.accessories ?? {}),
  ];

  if (!allNames.includes(serviceName)) {
    log.error(`Service '${serviceName}' not found`);
    log.info(`Available: ${allNames.join(', ')}`);
    process.exit(1);
  }

  const lines = Number.parseInt(opts.lines, 10);
  if (!Number.isFinite(lines) || lines < 0) {
    throw new Error(`--lines expects a non-negative number, got '${opts.lines}'`);
  }

  const ssh = await connect(config.server);

  log.dim(`Logs for ${config.project}/${serviceName} (Ctrl+C to exit)`);
  console.log();

  // No catch here: this used to swallow every error, so a dropped connection or
  // a service with no running container printed nothing at all and exited 0.
  // Ctrl+C terminates the process through SIGINT, it does not surface here.
  try {
    await streamLogs(ssh, config.project, serviceName, lines);
  } finally {
    await disconnect();
  }
}
