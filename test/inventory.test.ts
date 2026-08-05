import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSSH } from 'node-ssh';

import {
  findRunningContainer,
  getDeployedImage,
  listContainerIds,
  listServiceImages,
  getStatus,
  cleanupImages,
  streamLogs,
} from '../dist/core/docker.js';

/** Answers a fixed stdout to every command, recording what was asked. */
function fakeSSH(reply: (command: string) => string) {
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      return { stdout: reply(command), stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

// ─── Identifying containers ──────────────────────────────────────────────────

test('containers are found by label, not by name prefix', async () => {
  // The prefix is ambiguous: with services `web` and `web-api`, a filter on
  // `^project-web-` matches containers of both.
  const { ssh, calls } = fakeSSH(() => 'myapp-web-abc1234');
  await findRunningContainer(ssh, 'myapp', 'web');

  assert.match(calls[0]!, /label=deploy\.project=myapp/);
  assert.match(calls[0]!, /label=deploy\.service=web/);
  assert.ok(!calls[0]!.includes('name=^'), 'must not filter by name prefix');
});

test('findRunningContainer returns null when nothing is running', async () => {
  const { ssh } = fakeSSH(() => '');
  assert.equal(await findRunningContainer(ssh, 'myapp', 'web'), null);
});

test('findRunningContainer trims whitespace from docker output', async () => {
  const { ssh } = fakeSSH(() => '  myapp-web-abc1234  \n');
  assert.equal(await findRunningContainer(ssh, 'myapp', 'web'), 'myapp-web-abc1234');
});

test('getDeployedImage returns null when the service is down', async () => {
  // Rollback relies on this to know its "current" version is a guess.
  const { ssh } = fakeSSH(() => '');
  assert.equal(await getDeployedImage(ssh, 'myapp', 'web'), null);
});

test('getDeployedImage returns the running image', async () => {
  const { ssh } = fakeSSH(() => 'myapp-web:abc1234\n');
  assert.equal(await getDeployedImage(ssh, 'myapp', 'web'), 'myapp-web:abc1234');
});

test('listContainerIds drops blank lines', async () => {
  const { ssh } = fakeSSH(() => 'aaa\n\nbbb\n  \n');
  assert.deepEqual(await listContainerIds(ssh, 'myapp', 'web'), ['aaa', 'bbb']);
});

test('listServiceImages scopes the query to one service', async () => {
  const { ssh, calls } = fakeSSH(() => 'myapp-web:v2\nmyapp-web:v1');
  const images = await listServiceImages(ssh, 'myapp', 'web');

  assert.deepEqual(images, ['myapp-web:v2', 'myapp-web:v1']);
  assert.match(calls[0]!, /'myapp-web'/);
  assert.ok(!calls[0]!.includes("'myapp-*'"), 'must not span the whole project');
});

test('getStatus lists by project label', async () => {
  const { ssh, calls } = fakeSSH(() => 'NAMES\tSTATUS');
  await getStatus(ssh, 'myapp');
  assert.match(calls[0]!, /label=deploy\.project=myapp/);
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

test('cleanup keeps the last 3 images of each service separately', async () => {
  const images: Record<string, string[]> = {
    web: ['web:v5', 'web:v4', 'web:v3', 'web:v2', 'web:v1'],
    api: ['api:v5', 'api:v4', 'api:v3', 'api:v2', 'api:v1'],
  };

  const { ssh, calls } = fakeSSH((command) => {
    if (command.includes('docker images')) {
      const service = command.includes("'myapp-web'") ? 'web' : 'api';
      return images[service]!.join('\n');
    }
    if (command.includes('docker ps')) return `${command.includes('=web') ? 'web' : 'api'}:v5`;
    return '';
  });

  await cleanupImages(ssh, 'myapp', ['web', 'api']);

  const removals = calls.filter(c => c.includes('docker rmi'));
  assert.equal(removals.length, 2, 'one removal per service');
  assert.match(removals[0]!, /'web:v2' 'web:v1'/);
  assert.match(removals[1]!, /'api:v2' 'api:v1'/);
});

test('cleanup never deletes the image currently in use', async () => {
  // After a rollback the serving version is not the most recent one.
  const { ssh, calls } = fakeSSH((command) => {
    if (command.includes('docker images')) return ['v5', 'v4', 'v3', 'v2', 'v1'].join('\n');
    if (command.includes('docker ps')) return 'v1';
    return '';
  });

  await cleanupImages(ssh, 'myapp', ['web']);

  const removal = calls.find(c => c.includes('docker rmi'))!;
  assert.ok(!removal.includes("'v1'"), 'the in-use image must survive');
  assert.match(removal, /'v2'/);
});

test('cleanup removes nothing when there are few images', async () => {
  const { ssh, calls } = fakeSSH((command) =>
    command.includes('docker images') ? 'v2\nv1' : 'v2');

  await cleanupImages(ssh, 'myapp', ['web']);
  assert.ok(!calls.some(c => c.includes('docker rmi')));
});

test('cleanup prunes dangling layers left by rebuilds', async () => {
  const { ssh, calls } = fakeSSH(() => '');
  await cleanupImages(ssh, 'myapp', ['web']);
  assert.ok(calls.some(c => c.includes('docker image prune -f')));
});

// ─── Logs ────────────────────────────────────────────────────────────────────

test('streaming logs fails clearly when no container is running', async () => {
  // This used to be swallowed by a bare catch: it printed nothing and exited 0.
  const { ssh } = fakeSSH(() => '');
  await assert.rejects(
    streamLogs(ssh, 'myapp', 'web'),
    /No container is running for 'web'/,
  );
});

test('logs are streamed from the container found by label', async () => {
  const { ssh, calls } = fakeSSH((command) =>
    command.includes('--format') ? 'myapp-web-abc1234' : '');

  await streamLogs(ssh, 'myapp', 'web', 50);

  const logs = calls.find(c => c.includes('docker logs'))!;
  assert.match(logs, /--tail 50 'myapp-web-abc1234'/);
});

test('a non-numeric tail falls back instead of producing a broken flag', async () => {
  const { ssh, calls } = fakeSSH((command) =>
    command.includes('--format') ? 'myapp-web-abc1234' : '');

  await streamLogs(ssh, 'myapp', 'web', Number.NaN);

  const logs = calls.find(c => c.includes('docker logs'))!;
  assert.match(logs, /--tail 100 /);
});

// ─── Status table ────────────────────────────────────────────────────────────

test('an empty project is detected despite the table header', async () => {
  // `--format table` always prints a header, so a non-empty output does not
  // mean there are containers. The row count is what tells them apart.
  const { ssh } = fakeSSH(() => 'NAMES     STATUS    IMAGE     PORTS');
  const status = await getStatus(ssh, 'myapp');

  assert.equal(status.count, 0);
});

test('rows are counted without the header', async () => {
  const { ssh } = fakeSSH(() =>
    ['NAMES\tSTATUS\tIMAGE\tPORTS',
     'myapp-web-abc\tUp 2 minutes\tmyapp-web:abc\t',
     'myapp-api-abc\tUp 2 minutes\tmyapp-api:abc\t'].join('\n'));

  const status = await getStatus(ssh, 'myapp');
  assert.equal(status.count, 2);
  assert.match(status.text, /myapp-web-abc/);
});

test('a completely empty output counts as zero, not minus one', async () => {
  const { ssh } = fakeSSH(() => '');
  assert.equal((await getStatus(ssh, 'myapp')).count, 0);
});
