import { loadConfig } from '../core/config.js';
import { connect, disconnect } from '../core/ssh.js';
import { readLock, releaseLock } from '../core/docker.js';
import { log } from '../utils/logger.js';

/**
 * Releases the project's deploy lock.
 *
 * It exists because an interrupted deploy (dropped SSH, Ctrl+C, laptop asleep)
 * leaves the lock in place, and without this the only way out was to SSH in and
 * delete the file by hand — exactly when a rollback is probably needed.
 */
export async function unlock() {
  const config = loadConfig();
  const ssh = await connect(config.server);

  try {
    const holder = await readLock(ssh, config.project);

    if (!holder) {
      log.info(`No lock is held on '${config.project}'`);
      return;
    }

    log.warn(`Lock on '${config.project}' held by ${holder.user} since ${holder.date}`);
    await releaseLock(ssh, config.project);
    log.success('Lock released');
    log.info('Check the real state before deploying: deploy status');
  } finally {
    await disconnect();
  }
}
