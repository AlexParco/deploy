import { loadConfig } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { streamLogs } from '../core/docker.js';
import { log } from '../utils/logger.js';

interface LogsOptions {
  lines: string;
}

export async function logs(serviceName: string, opts: LogsOptions) {
  const config = loadConfig();

  // Validar que el servicio existe
  const allNames = [
    ...Object.keys(config.services),
    ...Object.keys(config.accessories ?? {}),
  ];

  if (!allNames.includes(serviceName)) {
    log.error(`Servicio '${serviceName}' no encontrado`);
    log.info(`Disponibles: ${allNames.join(', ')}`);
    process.exit(1);
  }

  const ssh = await connect(config.server);

  log.dim(`Logs de ${config.project}-${serviceName} (Ctrl+C para salir)`);
  console.log();

  try {
    await streamLogs(ssh, config.project, serviceName, parseInt(opts.lines, 10));
  } catch {
    // Ctrl+C u otra interrupción
  } finally {
    await disconnect();
  }
}
