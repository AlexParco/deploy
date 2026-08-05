import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSSH } from 'node-ssh';

import { deployAccessory, accessorySpecHash } from '../dist/core/docker.js';
import type { AccessoryConfig } from '../dist/core/config.js';
import type { ContainerEnv } from '../dist/core/docker.js';

interface Call { command: string }

/** Simulated server state: which container exists and with what spec. */
interface State {
  state?: 'running' | 'exited';
  spec?: string;
}

function fakeSSH(state: State) {
  const calls: Call[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push({ command });
      if (command.includes('docker ps -a')) {
        return { stdout: state.state ?? '', stderr: '', code: 0, signal: null };
      }
      if (command.includes('deploy.spec')) {
        return { stdout: state.spec ?? '', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

const ACCESSORY = {
  image: 'postgres:16',
  port: '5432:5432',
  volumes: ['data:/var/lib/postgresql/data'],
  env: { clear: {}, secret: [] },
} as AccessoryConfig;

const ENV: ContainerEnv = { clear: {}, secret: { POSTGRES_PASSWORD: 'secret' } };

const ran = (calls: Call[]) => calls.some(c => c.command.includes('docker run -d'));

test('when it does not exist, it is created', async () => {
  const { ssh, calls } = fakeSSH({});
  assert.equal(await deployAccessory(ssh, 'app', 'db', ACCESSORY, ENV), 'created');
  assert.ok(ran(calls));
});

test('a STOPPED accessory is started rather than breaking the deploy', async () => {
  // The previous bug: `docker ps -q` does not see stopped containers, so it
  // tried to create a new one and failed with "name already in use", killing
  // the whole deploy.
  const spec = accessorySpecHash(ACCESSORY, ENV);
  const { ssh, calls } = fakeSSH({ state: 'exited', spec });

  assert.equal(await deployAccessory(ssh, 'app', 'db', ACCESSORY, ENV), 'started');
  assert.ok(calls.some(c => c.command.includes("docker start 'app-db'")));
  assert.ok(!ran(calls), 'it must not try to create it again');
});

test('if it is running and nothing changed, it is left alone', async () => {
  const spec = accessorySpecHash(ACCESSORY, ENV);
  const { ssh, calls } = fakeSSH({ state: 'running', spec });

  assert.equal(await deployAccessory(ssh, 'app', 'db', ACCESSORY, ENV), 'unchanged');
  assert.ok(!ran(calls));
  assert.ok(!calls.some(c => c.command.includes('docker rm')));
});

test('changing the image recreates the container instead of ignoring it', async () => {
  // Before: changing postgres:16 to postgres:17 in deploy.yml did nothing,
  // silently, and the user believed they had upgraded.
  const oldSpec = accessorySpecHash({ ...ACCESSORY, image: 'postgres:16' }, ENV);
  const { ssh, calls } = fakeSSH({ state: 'running', spec: oldSpec });

  const action = await deployAccessory(
    ssh, 'app', 'db', { ...ACCESSORY, image: 'postgres:17' } as AccessoryConfig, ENV,
  );

  assert.equal(action, 'recreated');
  assert.ok(calls.some(c => c.command.includes("docker rm -f 'app-db'")));
  assert.ok(calls.some(c => c.command.includes("'postgres:17'")));
});

test('rotating a secret also counts as a change', async () => {
  const oldSpec = accessorySpecHash(ACCESSORY, ENV);
  const { ssh } = fakeSSH({ state: 'running', spec: oldSpec });

  const action = await deployAccessory(ssh, 'app', 'db', ACCESSORY, {
    clear: {}, secret: { POSTGRES_PASSWORD: 'rotated' },
  });
  assert.equal(action, 'recreated');
});

test('the hash does not let the secret be recovered', async () => {
  const hash = accessorySpecHash(ACCESSORY, ENV);
  assert.ok(!hash.includes('secret'));
  assert.match(hash, /^[0-9a-f]{12}$/);
});

test('the same config yields the same hash regardless of key order', () => {
  const a = accessorySpecHash(ACCESSORY, { clear: { A: '1', B: '2' }, secret: {} });
  const b = accessorySpecHash(ACCESSORY, { clear: { B: '2', A: '1' }, secret: {} });
  assert.equal(a, b, 'reordering should not trigger recreations');
});

test('the port is pinned to the loopback on creation', async () => {
  const { ssh, calls } = fakeSSH({});
  await deployAccessory(ssh, 'app', 'db', ACCESSORY, ENV);

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /-p '127\.0\.0\.1:5432:5432'/);
  assert.ok(!run.command.includes("-p '5432:5432'"));
});

test('data survives recreation: the volume carries no version', async () => {
  const { ssh, calls } = fakeSSH({ state: 'running', spec: 'other' });
  await deployAccessory(ssh, 'app', 'db', ACCESSORY, ENV);

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /-v 'app-db-data:\/var\/lib\/postgresql\/data'/);
});
