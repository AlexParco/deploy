import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSSH } from 'node-ssh';

import { withSecretsFile, sweepStaleSecrets } from '../dist/core/docker.js';

interface Call {
  command: string;
  stdin?: string;
}

/**
 * NodeSSH double that records what it receives. `exec` only ever calls
 * execCommand, so this is enough to inspect exactly what is sent to the server.
 */
function fakeSSH(): { ssh: NodeSSH; calls: Call[] } {
  const calls: Call[] = [];
  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push({ command, stdin: options?.stdin });
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

const SECRETS = {
  DATABASE_URL: 'postgres://user:sup3rs3cr3t@db:5432/app',
  API_KEY: 'sk_live_abc123',
};

test('no secret value ever appears in a command', async () => {
  const { ssh, calls } = fakeSSH();

  await withSecretsFile(ssh, 'app-web', SECRETS, async (flag) => {
    // Mimics the docker run the real caller performs.
    calls.push({ command: `sudo docker run -d ${flag} image` });
  });

  for (const { command } of calls) {
    for (const value of Object.values(SECRETS)) {
      assert.ok(
        !command.includes(value),
        `a secret leaked into the command: ${command}`,
      );
    }
  }
});

test('secrets travel over stdin, not argv', async () => {
  const { ssh, calls } = fakeSSH();
  await withSecretsFile(ssh, 'app-web', SECRETS, async () => {});

  const write = calls.find(c => c.stdin !== undefined);
  assert.ok(write, 'no call used stdin');
  assert.equal(
    write.stdin,
    'DATABASE_URL=postgres://user:sup3rs3cr3t@db:5432/app\nAPI_KEY=sk_live_abc123\n',
  );
});

test('the file is born under umask 077, with no open-permission window', async () => {
  const { ssh, calls } = fakeSSH();
  await withSecretsFile(ssh, 'app-web', SECRETS, async () => {});

  const write = calls.find(c => c.stdin !== undefined);
  assert.match(write!.command, /umask 077/);
  // rm before writing: `>` truncates but inherits the previous permissions.
  assert.match(write!.command, /rm -f .*\.env/);
  assert.ok(
    write!.command.indexOf('rm -f') < write!.command.indexOf('cat >'),
    'the rm must come before the cat',
  );
});

test('the env file is removed when done', async () => {
  const { ssh, calls } = fakeSSH();
  await withSecretsFile(ssh, 'app-web', SECRETS, async () => {});

  const last = calls[calls.length - 1]!;
  assert.match(last.command, /^rm -f '\/opt\/deploy\/\.secrets\/app-web\.env'$/);
});

test('the env file is removed even if the docker run fails', async () => {
  const { ssh, calls } = fakeSSH();

  await assert.rejects(
    withSecretsFile(ssh, 'app-web', SECRETS, async () => {
      throw new Error('docker run failed');
    }),
    /docker run failed/,
  );

  const last = calls[calls.length - 1]!;
  assert.match(last.command, /^rm -f /);
});

test('it lives outside the directory rsync --delete syncs', async () => {
  const { ssh, calls } = fakeSSH();
  let received = '';
  await withSecretsFile(ssh, 'myapp-web', SECRETS, async (flag) => { received = flag; });

  // /opt/deploy/<project> is wiped and rewritten by rsync on every deploy.
  assert.match(received, /\/opt\/deploy\/\.secrets\//);
  assert.ok(!received.includes('/opt/deploy/myapp/'));
  assert.ok(calls.some(c => c.command.includes('mkdir -p')));
});

test('with no secrets it writes no file and passes no --env-file', async () => {
  const { ssh, calls } = fakeSSH();
  let received = 'unset';
  await withSecretsFile(ssh, 'app-web', {}, async (flag) => { received = flag; });

  assert.equal(received, '');
  assert.equal(calls.length, 0, 'it should not touch the server at all');
});

test('stranded secret files are swept before a deploy', async () => {
  // withSecretsFile removes its file in a finally, but a killed process never
  // runs it. Container names carry the SHA, so every interrupted deploy would
  // strand another file holding live secrets.
  const { ssh, calls } = fakeSSH();
  await sweepStaleSecrets(ssh, 'myapp');

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /rm -f '\/opt\/deploy\/\.secrets\/myapp-'\*\.env/);
});

test('the sweep is scoped to one project', async () => {
  const { ssh, calls } = fakeSSH();
  await sweepStaleSecrets(ssh, 'myapp');

  assert.ok(!calls[0]!.command.includes("'/opt/deploy/.secrets/'*"), 'must not wipe every project');
});
