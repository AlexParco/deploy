import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { NodeSSH } from 'node-ssh';

import {
  buildImage,
  deployService,
  buildContainerEnv,
  healthRetries,
  PROBE_INTERVAL_MS,
} from '../dist/core/docker.js';
import type { ServiceConfig, AccessoryConfig } from '../dist/core/config.js';

function fakeSSH() {
  const calls: { command: string; stdin?: string }[] = [];
  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push({ command, stdin: options?.stdin });
      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{.Id}}')) {
        return { stdout: 'full-new-id', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    build: '.', dockerfile: 'Dockerfile', port: 3000, domain: 'example.com',
    healthcheck: '/health', startup_timeout: 60, volumes: [], env: { clear: {}, secret: [] },
    ...overrides,
  } as ServiceConfig;
}

/** Splits a command with a real shell to see the arguments docker would get. */
function shellArgs(command: string): string[] {
  return execFileSync(
    '/bin/sh',
    ['-c', `for a in ${command.replace(/^sudo /, '')}; do printf '%s\\n' "$a"; done`],
    { encoding: 'utf-8' },
  ).split('\n').filter(Boolean);
}

// ─── buildImage ──────────────────────────────────────────────────────────────

test('the image is tagged project-service:sha', async () => {
  const { ssh } = fakeSSH();
  const image = await buildImage(ssh, 'myapp', 'web', service(), 'abc1234');
  assert.equal(image, 'myapp-web:abc1234');
});

test('build context and dockerfile are absolute, not relative to a cwd', async () => {
  // node-ssh builds `cd <dir> ; <command>` with a semicolon, so a failed cd
  // would still run the build somewhere else with a baffling error.
  const { ssh, calls } = fakeSSH();
  await buildImage(ssh, 'myapp', 'web', service(), 'abc1234');

  const args = shellArgs(calls[0]!.command);
  assert.ok(args.includes('/opt/deploy/myapp/.'), `context was: ${args.join(' ')}`);
  assert.ok(args.includes('/opt/deploy/myapp/./Dockerfile'));
});

test('a nested build directory resolves under the project', async () => {
  // Exactly the shape flinksmart-web uses for its api service.
  const { ssh, calls } = fakeSSH();
  await buildImage(ssh, 'flinksmart-web', 'api', service({ build: './api' }), 'sha');

  const args = shellArgs(calls[0]!.command);
  assert.ok(args.includes('/opt/deploy/flinksmart-web/./api'));
  assert.ok(args.includes('/opt/deploy/flinksmart-web/./api/Dockerfile'));
});

test('a custom dockerfile name is honored', async () => {
  const { ssh, calls } = fakeSSH();
  await buildImage(ssh, 'myapp', 'web', service({ dockerfile: 'Dockerfile.prod' }), 'sha');
  assert.match(calls[0]!.command, /Dockerfile\.prod/);
});

test('a build path with spaces stays one argument', async () => {
  const { ssh, calls } = fakeSSH();
  await buildImage(ssh, 'myapp', 'web', service({ build: './my app' }), 'sha');

  const args = shellArgs(calls[0]!.command);
  assert.ok(args.includes('/opt/deploy/myapp/./my app'));
});

// ─── deployService wiring ────────────────────────────────────────────────────

const params = (overrides = {}) => ({
  project: 'shalom-api-go', serviceName: 'api', service: service({ port: 8080 }),
  image: 'shalom-api-go-api:sha', env: { clear: {}, secret: {} },
  ssl: true, sha: 'abc1234', health: { maxRetries: 1, intervalMs: 1 },
  ...overrides,
});

test('the volume prefix carries no SHA, so data survives the deploy', async () => {
  // The production case: shalom-api-go keeps a SQLite file in this volume. If
  // the prefix included the SHA, every deploy would mount a brand new empty
  // volume and the database would silently vanish.
  const { ssh, calls } = fakeSSH();
  await deployService(ssh, params({
    service: service({ port: 8080, volumes: ['data:/data'] }),
  }));

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /-v 'shalom-api-go-api-data:\/data'/);
  assert.ok(!run.command.includes('abc1234-data'), 'the volume must not be versioned');
});

test('the container name IS versioned, unlike the volume', async () => {
  const { ssh, calls } = fakeSSH();
  await deployService(ssh, params({
    service: service({ port: 8080, volumes: ['data:/data'] }),
  }));

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /--name 'shalom-api-go-api-abc1234'/);
});

test('clear variables go as -e and secrets do not', async () => {
  const { ssh, calls } = fakeSSH();
  await deployService(ssh, params({
    env: { clear: { NODE_ENV: 'production' }, secret: { API_KEY: 'sk_live_xyz' } },
  }));

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /-e 'NODE_ENV=production'/);
  assert.ok(!run.command.includes('sk_live_xyz'), 'the secret must not reach argv');
  assert.match(run.command, /--env-file/);
});

test('the health probe targets the new container, not the service name', async () => {
  const { ssh, calls } = fakeSSH();
  await deployService(ssh, params());

  const probe = calls.find(c => c.command.includes('docker run --rm'))!;
  assert.match(probe.command, /http:\/\/shalom-api-go-api-abc1234:8080\/health/);
});

test('nothing is retired when the new container cannot be identified', async () => {
  // If the inspect that identifies the new container returns nothing, every id
  // would look stale — including the one traffic was just switched to.
  const calls: { command: string }[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push({ command });
      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{.Id}}')) {
        return { stdout: '', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker ps -aq')) {
        return { stdout: 'aaa111\nbbb222', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await deployService(ssh, params());

  assert.ok(
    !calls.some(c => c.command.includes("docker rm -f 'aaa111'")),
    'must not remove containers it cannot tell apart',
  );
});

test('short ids from ps match the full id from inspect', async () => {
  // `docker ps -aq` prints short ids while `{{.Id}}` prints the full one.
  const calls: { command: string }[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push({ command });
      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{.Id}}')) {
        return { stdout: 'abcdef123456789extra', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker ps -aq')) {
        return { stdout: 'abcdef123456\nold999', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await deployService(ssh, params());

  const removal = calls.find(c => c.command.includes('docker rm -f') && c.command.includes('old999'));
  assert.ok(removal, 'the old container should be retired');
  assert.ok(!removal!.command.includes('abcdef123456'), 'the new one must survive');
});

// ─── buildContainerEnv ───────────────────────────────────────────────────────

test('buildContainerEnv splits declared variables by sensitivity', () => {
  const target = {
    env: { clear: { NODE_ENV: 'production' }, secret: ['API_KEY', 'DB_URL'] },
  } as unknown as ServiceConfig;

  const env = buildContainerEnv(target, { API_KEY: 'k', DB_URL: 'u', UNUSED: 'x' });

  assert.deepEqual(env.clear, { NODE_ENV: 'production' });
  assert.deepEqual(env.secret, { API_KEY: 'k', DB_URL: 'u' });
});

test('buildContainerEnv omits secrets that were not resolved', () => {
  const target = { env: { clear: {}, secret: ['MISSING'] } } as unknown as AccessoryConfig;
  assert.deepEqual(buildContainerEnv(target, {}).secret, {});
});

test('buildContainerEnv copies clear values instead of aliasing the config', () => {
  const target = { env: { clear: { A: '1' }, secret: [] } } as unknown as ServiceConfig;
  const env = buildContainerEnv(target, {});
  env.clear.B = '2';
  assert.deepEqual(target.env!.clear, { A: '1' }, 'the config must not be mutated');
});

// ─── Startup timeout ─────────────────────────────────────────────────────────

test('the startup budget decides how many probes are attempted', () => {
  // Without this, a service that boots slowly — migrations on start, say —
  // failed the deploy at 60s with no way to adjust it.
  assert.equal(healthRetries(60), 30);
  assert.equal(healthRetries(10), 5);
  assert.equal(healthRetries(300), 150);
});

test('a budget shorter than one interval still gets one attempt', () => {
  assert.equal(healthRetries(1), 1);
  assert.equal(healthRetries(0.001), 1);
});

test('the default matches the documented minute', () => {
  assert.equal(healthRetries(60) * PROBE_INTERVAL_MS, 60_000);
});

test('an explicit retry count wins over the budget', async () => {
  const probes: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker run --rm')) {
        probes.push(command);
        return { stdout: '', stderr: '', code: 1, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await assert.rejects(deployService(ssh, params({
    service: service({ startup_timeout: 600 }),
    health: { maxRetries: 2, intervalMs: 1 },
  })));

  assert.equal(probes.length, 2);
});
