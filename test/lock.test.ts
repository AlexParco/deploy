import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSSH } from 'node-ssh';

import { acquireLock, releaseLock, readLock, withProxyLock } from '../dist/core/docker.js';

interface Call { command: string }

/** `free` simulates whether the lock file could be created (noclobber allows it). */
function fakeSSH(opts: { dirExists?: boolean; free?: boolean; contents?: string } = {}) {
  const { dirExists = true, free = true, contents = '' } = opts;
  const calls: Call[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push({ command });
      if (command.includes('test -d')) {
        return { stdout: dirExists ? 'ok' : '', stderr: '', code: 0, signal: null };
      }
      if (command.includes('set -C')) {
        return { stdout: free ? 'ok' : '', stderr: '', code: 0, signal: null };
      }
      if (command.startsWith('cat ')) {
        return { stdout: contents, stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

test('the lock is per project, not global to the server', () => {
  // There used to be a single /opt/deploy/.deploy.lock: deploying one project
  // blocked the deploys of every other project on the same machine.
  const { ssh, calls } = fakeSSH();
  return acquireLock(ssh, 'myapp').then(() => {
    const create = calls.find(c => c.command.includes('set -C'))!;
    assert.match(create.command, /\.locks\/myapp\.lock/);
    assert.ok(!create.command.includes('/opt/deploy/.deploy.lock'));
  });
});

test('acquisition is atomic: it uses noclobber, not cat followed by echo', async () => {
  const { ssh, calls } = fakeSSH();
  await acquireLock(ssh, 'myapp');

  const create = calls.find(c => c.command.includes('set -C'));
  assert.ok(create, 'it must use set -C (noclobber)');
  // It must not read before writing: that gap is what allowed two winners.
  const readsFirst = calls.findIndex(c => c.command.startsWith('cat '));
  const writes = calls.findIndex(c => c.command.includes('set -C'));
  assert.ok(readsFirst === -1 || readsFirst > writes, 'must not read before trying to create');
});

test('when the lock is taken it fails and says how to get out', async () => {
  const { ssh } = fakeSSH({ free: false, contents: 'ana|2026-08-04T10:00:00Z|myapp' });

  await assert.rejects(
    acquireLock(ssh, 'myapp'),
    (err: Error) => {
      assert.match(err.message, /deploy of 'myapp' is already in progress/);
      assert.match(err.message, /ana/);
      assert.match(err.message, /deploy unlock/);
      return true;
    },
  );
});

test('without a prior setup the error says to run it', async () => {
  const { ssh } = fakeSSH({ dirExists: false });
  await assert.rejects(acquireLock(ssh, 'myapp'), /deploy setup/);
});

test('releasing removes only that project lock', async () => {
  const { ssh, calls } = fakeSSH();
  await releaseLock(ssh, 'myapp');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /^rm -f '\/opt\/deploy\/\.locks\/myapp\.lock'$/);
});

test('readLock returns who holds it', async () => {
  const { ssh } = fakeSSH({ contents: 'ana|2026-08-04T10:00:00Z|myapp\n' });
  assert.deepEqual(await readLock(ssh, 'myapp'), {
    user: 'ana',
    date: '2026-08-04T10:00:00Z',
  });
});

test('readLock returns null when it is free', async () => {
  const { ssh } = fakeSSH({ contents: '' });
  assert.equal(await readLock(ssh, 'myapp'), null);
});

test('an unwritable directory is not reported as a lock held by someone', async () => {
  // Failing to create the file does not prove someone holds the lock. Saying
  // otherwise sends you hunting for a deploy that never existed.
  const { ssh } = fakeSSH({ free: false, contents: '' });

  await assert.rejects(
    acquireLock(ssh, 'myapp'),
    (err: Error) => {
      assert.match(err.message, /no lock is held/);
      assert.match(err.message, /writable/);
      assert.ok(!err.message.includes('already in progress'));
      return true;
    },
  );
});

test('a truncated lock file still yields a readable message', async () => {
  // Destructuring defaults only apply to undefined, so empty fields used to
  // render as "held by  on ".
  const { ssh } = fakeSSH({ contents: '|' });
  assert.deepEqual(await readLock(ssh, 'myapp'), {
    user: 'unknown',
    date: 'an unknown date',
  });
});

test('the proxy lock is server-wide, not per project', async () => {
  // Traefik is one container for the whole machine, so two setups at once would
  // both tear it down and bring it back.
  const { ssh, calls } = fakeSSH();
  await withProxyLock(ssh, async () => {});

  const create = calls.find(c => c.command.includes('set -C'))!;
  assert.match(create.command, /\.locks\/\.proxy\.lock/);
  assert.ok(!create.command.includes('myapp'), 'must not be tied to a project');
});

test('a held proxy lock blocks a second setup', async () => {
  const { ssh } = fakeSSH({ free: false, contents: 'ana|2026-08-04T10:00:00Z' });
  await assert.rejects(
    withProxyLock(ssh, async () => { throw new Error('should never run'); }),
    /Another proxy setup is running/,
  );
});

test('the proxy lock is released even when the work throws', async () => {
  const { ssh, calls } = fakeSSH();

  await assert.rejects(
    withProxyLock(ssh, async () => { throw new Error('traefik exploded'); }),
    /traefik exploded/,
  );

  const last = calls[calls.length - 1]!;
  assert.match(last.command, /^rm -f '.*\.proxy\.lock'$/);
});
