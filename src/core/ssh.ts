import { NodeSSH } from 'node-ssh';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
export interface SSHConfig {
  host: string;
  user: string;
  port: number;
  key?: string;
}

let connection: NodeSSH | null = null;

function findSSHKey(explicit?: string): string {
  if (explicit) {
    const abs = resolve(explicit.replace('~', homedir()));
    if (!existsSync(abs)) throw new Error(`SSH key no encontrada: ${abs}`);
    return abs;
  }

  const candidates = ['id_ed25519', 'id_rsa'];
  for (const name of candidates) {
    const keyPath = resolve(homedir(), '.ssh', name);
    if (existsSync(keyPath)) return keyPath;
  }

  throw new Error(
    'No se encontró SSH key. Especifica una en deploy.yml:\n' +
    '  server:\n' +
    '    key: ~/.ssh/mi_llave'
  );
}

export async function connect(config: SSHConfig): Promise<NodeSSH> {
  if (connection?.isConnected()) return connection;

  const ssh = new NodeSSH();

  // Intentar primero con el agente SSH (soporta passphrase)
  // Si falla, intentar con el archivo directamente
  try {
    await ssh.connect({
      host: config.host,
      username: config.user,
      port: config.port,
      agent: process.env.SSH_AUTH_SOCK,
      readyTimeout: 10_000,
    });
  } catch {
    const keyPath = findSSHKey(config.key);
    await ssh.connect({
      host: config.host,
      username: config.user,
      port: config.port,
      privateKeyPath: keyPath,
      readyTimeout: 10_000,
    });
  }

  connection = ssh;
  return ssh;
}

export async function exec(
  ssh: NodeSSH,
  command: string,
  opts?: { cwd?: string; stream?: boolean },
): Promise<string> {
  if (opts?.stream) {
    const result = await ssh.execCommand(command, {
      cwd: opts.cwd,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    return result.stdout;
  }

  const result = await ssh.execCommand(command, { cwd: opts?.cwd });

  if (result.code !== 0 && result.code !== null) {
    throw new Error(`Comando falló (exit ${result.code}): ${command}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

export async function disconnect(): Promise<void> {
  if (connection?.isConnected()) {
    connection.dispose();
    connection = null;
  }
}

export async function rsync(
  config: SSHConfig,
  localDir: string,
  remoteDir: string,
  excludes: string[] = [],
): Promise<void> {
  const { execSync } = await import('node:child_process');

  const excludeFlags = excludes.map(e => `--exclude='${e}'`).join(' ');
  const keyPath = config.key ? findSSHKey(config.key) : null;
  const keyFlag = keyPath ? `-i ${keyPath}` : '';
  const sshFlag = `-e "ssh ${keyFlag} -p ${config.port} -o StrictHostKeyChecking=accept-new"`;

  const cmd = [
    'rsync -azP --delete',
    excludeFlags,
    sshFlag,
    `${localDir}/`,
    `${config.user}@${config.host}:${remoteDir}/`,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe', timeout: 300_000 });
}
