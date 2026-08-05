import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeSSH } from 'node-ssh';

import { deployService } from '../dist/core/docker.js';
import type { ServiceConfig } from '../dist/core/config.js';

interface Call { command: string; stdin?: string }

/**
 * NodeSSH double. `probeOk` decides whether the health check passes; every other
 * command succeeds, except the state inspect which reports "running".
 */
function fakeSSH(probeOk: boolean) {
  const calls: Call[] = [];
  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push({ command, stdin: options?.stdin });

      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker run --rm')) {
        return { stdout: '', stderr: '', code: probeOk ? 0 : 1, signal: null };
      }
      if (command.includes('{{.Id}}')) {
        return { stdout: 'new-id', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker ps -aq')) {
        return { stdout: 'old-id\nnew-id', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

const SERVICE = {
  build: '.', dockerfile: 'Dockerfile', port: 3000, domain: 'example.com',
  healthcheck: '/health', startup_timeout: 60, volumes: [], env: { clear: {}, secret: [] },
} as ServiceConfig;

function params(overrides = {}) {
  return {
    project: 'myapp', serviceName: 'web', service: SERVICE,
    image: 'myapp-web:abc1234', env: { clear: {}, secret: {} },
    ssl: true, sha: 'abc1234',
    health: { maxRetries: 2, intervalMs: 1 },
    ...overrides,
  };
}

const indexOf = (calls: Call[], needle: string) =>
  calls.findIndex(c => c.command.includes(needle));

test('the container starts with a SHA-versioned name', async () => {
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const run = calls.find(c => c.command.includes('docker run -d'));
  assert.ok(run, 'the container was never started');
  assert.match(run.command, /--name 'myapp-web-abc1234'/);
});

test('the new container carries NO routing labels', async () => {
  // Labels are immutable: if the container were born with its route, it would
  // be taking traffic before passing the health check.
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.ok(!run.command.includes('traefik.'), 'must not declare routes via labels');
});

test('the order is: start → verify → switch → retire the old one', async () => {
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const start = indexOf(calls, 'docker run -d');
  const probe = indexOf(calls, 'docker run --rm');
  const switchOver = indexOf(calls, 'mv ');
  // Matched by id rather than plain 'docker rm -f': the first rm is the
  // same-SHA pre-cleanup, not the retirement of the previous version.
  const retire = indexOf(calls, "'old-id'");

  assert.ok(start >= 0 && probe >= 0 && switchOver >= 0, 'missing steps');
  assert.ok(retire >= 0, 'the previous version was never retired');
  assert.ok(start < probe, 'the probe must come after starting');
  assert.ok(probe < switchOver, 'the switch must come AFTER the health check');
  assert.ok(switchOver < retire, 'the old one is retired after switching');
});

test('when the health check fails traffic is NOT switched', async () => {
  // The crux: the old container stays routed and serving. This was the
  // underlying flaw, since the new one used to publish its route on startup.
  const { ssh, calls } = fakeSSH(false);

  await assert.rejects(deployService(ssh, params()), /Health check failed/);

  assert.equal(indexOf(calls, 'mv '), -1, 'must not rewrite the route');
  assert.ok(
    !calls.some(c => c.command.includes('cat >') && c.stdin?.includes('loadBalancer')),
    'must not write any routing configuration',
  );
});

test('when the health check fails the candidate container is discarded', async () => {
  const { ssh, calls } = fakeSSH(false);
  await assert.rejects(deployService(ssh, params()));

  assert.ok(
    calls.some(c => c.command.includes("docker rm -f 'myapp-web-abc1234'")),
    'the broken candidate must be cleaned up',
  );
});

test('routing config is staged outside the watched directory, then moved in', async () => {
  // Traefik watches the routes directory. Staging inside it would leave a
  // half-written file, and any `.tmp` left by an interrupted deploy, at the
  // mercy of whichever extensions Traefik decides to load.
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const write = calls.find(c => c.stdin?.includes('loadBalancer'));
  assert.ok(write, 'the routing config was never written');
  assert.match(write.command, /cat > '\/opt\/deploy\/\.traefik\/staging\/myapp-web\.yml'/);
  assert.ok(
    !write.command.includes("cat > '/opt/deploy/.traefik/dynamic/"),
    'must not write into the watched directory',
  );

  const mv = calls.find(c => c.command.startsWith('mv '))!;
  assert.match(
    mv.command,
    /mv '\/opt\/deploy\/\.traefik\/staging\/myapp-web\.yml' '\/opt\/deploy\/\.traefik\/dynamic\/myapp-web\.yml'/,
  );
});

test('both directories are created before staging', async () => {
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const write = calls.find(c => c.stdin?.includes('loadBalancer'))!;
  assert.match(write.command, /mkdir -p .*dynamic.* .*staging.*/);
});

test('the written config points at the container just validated', async () => {
  const { ssh, calls } = fakeSSH(true);
  await deployService(ssh, params());

  const write = calls.find(c => c.stdin?.includes('loadBalancer'))!;
  assert.match(write.stdin!, /http:\/\/myapp-web-abc1234:3000/);
});

/** Like fakeSSH, but reports a state for the container name being probed. */
function fakeSSHWithExisting(states: Record<string, string>) {
  const calls: Call[] = [];
  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push({ command, stdin: options?.stdin });

      if (command.includes('docker ps -a') && command.includes('{{.State}}')) {
        const name = Object.keys(states).find(n => command.includes(`name=^${n}$`));
        return { stdout: name ? states[name]! : '', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{.State.Running}}')) {
        return { stdout: 'true', stderr: '', code: 0, signal: null };
      }
      if (command.includes('docker run --rm')) {
        return { stdout: '', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{.Id}}')) {
        return { stdout: 'new-id', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, calls };
}

test('redeploying the same SHA does NOT touch the container serving traffic', async () => {
  // Removing it first — which is what this used to do — destroys the live
  // container before its replacement exists: a guaranteed outage, and a
  // permanent one if the health check then fails.
  const { ssh, calls } = fakeSSHWithExisting({ 'myapp-web-abc1234': 'running' });
  await deployService(ssh, params());

  assert.ok(
    !calls.some(c => c.command.includes("docker rm -f 'myapp-web-abc1234'")),
    'the live container must survive until traffic has moved',
  );

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /--name 'myapp-web-abc1234-2'/);
});

test('the candidate is health checked under its own name', async () => {
  const { ssh, calls } = fakeSSHWithExisting({ 'myapp-web-abc1234': 'running' });
  await deployService(ssh, params());

  const probe = calls.find(c => c.command.includes('docker run --rm'))!;
  assert.match(probe.command, /http:\/\/myapp-web-abc1234-2:3000\/health/);
});

test('the route ends up pointing at the candidate that passed', async () => {
  const { ssh, calls } = fakeSSHWithExisting({ 'myapp-web-abc1234': 'running' });
  await deployService(ssh, params());

  const write = calls.find(c => c.stdin?.includes('loadBalancer'))!;
  assert.match(write.stdin!, /http:\/\/myapp-web-abc1234-2:3000/);
});

test('debris from a failed deploy is cleared and its name reused', async () => {
  // A stopped container serves nothing, so there is no reason to leave it
  // around or to burn a new name on its account.
  const { ssh, calls } = fakeSSHWithExisting({ 'myapp-web-abc1234': 'exited' });
  await deployService(ssh, params());

  assert.ok(calls.some(c => c.command.includes("docker rm -f 'myapp-web-abc1234'")));

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /--name 'myapp-web-abc1234'/);
  assert.ok(!run.command.includes('abc1234-2'), 'the freed name should be reused');
});

test('a free name is used as is', async () => {
  const { ssh, calls } = fakeSSHWithExisting({});
  await deployService(ssh, params());

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /--name 'myapp-web-abc1234'/);
});

test('successive live versions keep taking the next free name', async () => {
  const { ssh, calls } = fakeSSHWithExisting({
    'myapp-web-abc1234': 'running',
    'myapp-web-abc1234-2': 'running',
  });
  await deployService(ssh, params());

  const run = calls.find(c => c.command.includes('docker run -d'))!;
  assert.match(run.command, /--name 'myapp-web-abc1234-3'/);
});
