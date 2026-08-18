import { NodeSSH } from 'node-ssh';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { shQuote, shJoin } from './sh.js';

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
    if (!existsSync(abs)) throw new Error(`SSH key not found: ${abs}`);
    return abs;
  }

  const candidates = ['id_ed25519', 'id_rsa'];
  for (const name of candidates) {
    const keyPath = resolve(homedir(), '.ssh', name);
    if (existsSync(keyPath)) return keyPath;
  }

  throw new Error(
    'No SSH key found. Point to one in deploy.yml:\n' +
    '  server:\n' +
    '    key: ~/.ssh/my_key'
  );
}

export async function connect(config: SSHConfig): Promise<NodeSSH> {
  if (connection?.isConnected()) return connection;

  const ssh = new NodeSSH();

  // El handshake desde un runner de CI a un VPS puede ser LENTO —segundos, no
  // milisegundos, por latencia/pérdida en el camino—, y el openssh lo completa
  // igual. El default anterior de 10s cortaba justo esos casos: el deploy moría
  // con "Timed out while waiting for handshake" en Actions aunque `ssh` a mano
  // desde el mismo runner conectara bien. 30s tolera el handshake lento sin
  // colgar de más un deploy interactivo cuando el server no responde.
  const readyTimeout = 30_000;

  // El agente sólo aporta si EXISTE (dev con ssh-agent, para keys con passphrase).
  // En CI no hay `SSH_AUTH_SOCK`, y probarlo igual —con `agent: undefined`— es un
  // handshake entero sin método de auth que gasta el presupuesto antes de llegar
  // a la key. Si no hay agente, se va derecho a la key.
  if (process.env.SSH_AUTH_SOCK) {
    try {
      await ssh.connect({
        host: config.host,
        username: config.user,
        port: config.port,
        agent: process.env.SSH_AUTH_SOCK,
        readyTimeout,
      });
      connection = ssh;
      return ssh;
    } catch {
      // El agente no resolvió (sin la key cargada, o el server la rechazó): se
      // cae a leer el archivo de key directamente, abajo.
    }
  }

  const keyPath = findSSHKey(config.key);
  await ssh.connect({
    host: config.host,
    username: config.user,
    port: config.port,
    privateKeyPath: keyPath,
    readyTimeout,
  });

  connection = ssh;
  return ssh;
}

export async function exec(
  ssh: NodeSSH,
  command: string,
  opts?: { cwd?: string; stream?: boolean; stdin?: string },
): Promise<string> {
  if (opts?.stream) {
    const result = await ssh.execCommand(command, {
      cwd: opts.cwd,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    return result.stdout;
  }

  // stdin travels over the SSH channel, not through argv: this is how secrets
  // reach the server without showing up in `ps` or in the sudo log.
  const result = await ssh.execCommand(command, { cwd: opts?.cwd, stdin: opts?.stdin });

  if (result.code !== 0 && result.code !== null) {
    throw new Error(`Command failed (exit ${result.code}): ${command}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

export async function disconnect(): Promise<void> {
  if (connection?.isConnected()) {
    connection.dispose();
    connection = null;
  }
}

/**
 * Builds the argument list for rsync.
 *
 * Separate from running it so the arguments can be asserted on: this is the one
 * place where a path or an exclude could be mistaken for a flag.
 *
 * The arguments go to execFileSync without a shell, so they reach the process
 * verbatim — an exclude or a path containing spaces or quotes cannot turn into
 * another command. Only sshCommand needs quoting, because rsync hands that one
 * to a shell of its own.
 */
export function buildRsyncArgs(
  config: SSHConfig,
  localDir: string,
  remoteDir: string,
  excludes: string[],
  keyPath: string | null,
): string[] {
  const sshCommand = shJoin([
    'ssh',
    keyPath ? `-i ${shQuote(keyPath)}` : '',
    `-p ${config.port}`,
    '-o StrictHostKeyChecking=accept-new',
  ]);

  return [
    '-az',
    '--delete',
    ...excludes.map(exclude => `--exclude=${exclude}`),
    '-e', sshCommand,
    `${localDir}/`,
    `${config.user}@${config.host}:${remoteDir}/`,
  ];
}

export async function rsync(
  config: SSHConfig,
  localDir: string,
  remoteDir: string,
  excludes: string[] = [],
): Promise<void> {
  const { execFileSync } = await import('node:child_process');

  const keyPath = config.key ? findSSHKey(config.key) : null;
  const args = buildRsyncArgs(config, localDir, remoteDir, excludes, keyPath);

  try {
    execFileSync('rsync', args, { stdio: 'pipe', timeout: 300_000 });
  } catch (err) {
    // execSync/execFileSync throw an error with a useless message ("Command
    // failed"); rsync's actual reason is in stderr.
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`rsync failed${stderr ? `:\n${stderr}` : ''}`);
  }
}
