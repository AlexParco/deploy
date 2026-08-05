import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { NodeSSH } from 'node-ssh';

import { buildProbeCommand, waitForHealthy } from '../dist/core/docker.js';

interface Reply { stdout?: string; code?: number }

/**
 * NodeSSH double that answers based on the command it receives. `reply` decides
 * what the probe returns; everything else answers empty and successful.
 */
function fakeSSH(reply: (command: string) => Reply) {
  const commands: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      commands.push(command);
      const { stdout = '', code = 0 } = reply(command);
      return { stdout, stderr: code === 0 ? '' : 'probe failed', code, signal: null };
    },
  } as unknown as NodeSSH;
  return { ssh, commands };
}

const isProbe = (cmd: string) => cmd.includes('docker run --rm');
const FAST = { maxRetries: 3, intervalMs: 1 };

test('the probe does not use docker exec inside the user image', () => {
  const cmd = buildProbeCommand('deploy-proxy', 'busybox:1.36', 'http://app-web:3000/health');
  assert.ok(!cmd.includes('docker exec'));
  assert.match(cmd, /docker run --rm/);
  assert.match(cmd, /--network 'deploy-proxy'/);
});

test('the probe targets the container by name, not localhost', () => {
  const cmd = buildProbeCommand('deploy-proxy', 'busybox:1.36', 'http://app-web:3000/health');
  assert.match(cmd, /'http:\/\/app-web:3000\/health'/);
  assert.ok(!cmd.includes('localhost'));
});

test('the probe carries no "|| true": the exit code must propagate', () => {
  const cmd = buildProbeCommand('deploy-proxy', 'busybox:1.36', 'http://app-web:3000/health');
  assert.ok(!cmd.includes('|| true'));
});

test('a hostile url cannot split into extra arguments', () => {
  const cmd = buildProbeCommand('deploy-proxy', 'busybox:1.36', 'http://a:1/; id; echo ');
  const args = execFileSync('/bin/sh', ['-c', `for a in ${cmd.replace(/^sudo /, '')}; do printf '%s\\n' "$a"; done`], { encoding: 'utf-8' })
    .split('\n').filter(Boolean);
  assert.ok(args.includes('http://a:1/; id; echo '), 'the url must arrive whole');
  assert.ok(!args.includes('id'), 'no injected argument should appear');
});

test('passes when the probe exits 0', async () => {
  const { ssh, commands } = fakeSSH(() => ({ code: 0 }));
  await waitForHealthy(ssh, 'app-web', 3000, '/health', FAST);
  assert.equal(commands.filter(isProbe).length, 1, 'should probe exactly once');
});

test('FAILS when the probe always errors — the original bug', async () => {
  // This used to pass silently: wget -q printed nothing, the empty result did
  // not contain "error", and the deploy carried on with a broken container.
  const { ssh } = fakeSSH((cmd) => (isProbe(cmd) ? { code: 1 } : { code: 0 }));
  await assert.rejects(
    waitForHealthy(ssh, 'app-web', 3000, '/health', FAST),
    /Health check failed/,
  );
});

test('empty probe output does not count as success', async () => {
  // The precise failure of the previous version: empty stdout read as healthy.
  const { ssh } = fakeSSH((cmd) => (isProbe(cmd) ? { stdout: '', code: 1 } : { code: 0 }));
  await assert.rejects(waitForHealthy(ssh, 'app-web', 3000, '/health', FAST), /Health check failed/);
});

test('"wget: not found" does not count as success either', async () => {
  // With docker exec against an image without wget, the output was
  // "wget: not found", which contains no "error" substring and so passed.
  const { ssh } = fakeSSH((cmd) =>
    isProbe(cmd) ? { stdout: 'wget: not found', code: 127 } : { code: 0 });
  await assert.rejects(waitForHealthy(ssh, 'app-web', 3000, '/health', FAST), /Health check failed/);
});

test('retries until exhausted and then fails', async () => {
  const { ssh, commands } = fakeSSH((cmd) => (isProbe(cmd) ? { code: 1 } : { code: 0 }));
  await assert.rejects(waitForHealthy(ssh, 'app-web', 3000, '/health', FAST));
  assert.equal(commands.filter(isProbe).length, 3);
});

test('passes if it recovers on a later retry', async () => {
  let attempts = 0;
  const { ssh } = fakeSSH((cmd) => {
    if (!isProbe(cmd)) return { code: 0 };
    attempts += 1;
    return { code: attempts < 3 ? 1 : 0 };
  });
  await waitForHealthy(ssh, 'app-web', 3000, '/health', FAST);
  assert.equal(attempts, 3);
});

test('if the container died it fails at once, without exhausting retries', async () => {
  const { ssh, commands } = fakeSSH((cmd) => {
    if (cmd.includes('inspect')) return { stdout: 'false\n', code: 0 };
    if (cmd.includes('docker logs')) return { stdout: 'Error: cannot bind port', code: 0 };
    return { code: 1 };
  });

  await assert.rejects(
    waitForHealthy(ssh, 'app-web', 3000, '/health', { maxRetries: 30, intervalMs: 1 }),
    /stopped while starting up/,
  );
  assert.equal(commands.filter(isProbe).length, 0, 'should not have probed at all');
});

test('the error includes container logs so it can be diagnosed', async () => {
  const { ssh } = fakeSSH((cmd) => {
    if (cmd.includes('docker logs')) return { stdout: 'FATAL: no such database', code: 0 };
    if (isProbe(cmd)) return { code: 1 };
    return { code: 0 };
  });

  await assert.rejects(
    waitForHealthy(ssh, 'app-web', 3000, '/health', FAST),
    /FATAL: no such database/,
  );
});
