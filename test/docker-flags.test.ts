import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { identityLabels, buildVolumeFlags } from '../dist/core/docker.js';

/**
 * Expands the fragment with a real shell and returns the arguments docker would
 * receive, one per line. If quoting were broken, split arguments or executed
 * commands would show up here.
 */
function shellArgs(fragment: string): string[] {
  const out = execFileSync(
    '/bin/sh',
    ['-c', `for a in ${fragment}; do printf '%s\\n' "$a"; done`],
    { encoding: 'utf-8' },
  );
  return out.split('\n').filter(Boolean);
}

test('identity labels arrive as whole arguments', () => {
  const args = shellArgs(identityLabels('myapp', 'web', 'abc1234', 'service'));
  assert.deepEqual(args, [
    '--label', 'deploy.project=myapp',
    '--label', 'deploy.service=web',
    '--label', 'deploy.sha=abc1234',
    '--label', 'deploy.role=service',
  ]);
});

test('accessories are tagged with their own role', () => {
  const args = shellArgs(identityLabels('myapp', 'db', 'accessory', 'accessory'));
  assert.ok(args.includes('deploy.role=accessory'));
  assert.ok(args.includes('deploy.service=db'));
});

test('a hostile value cannot split into extra arguments', () => {
  const args = shellArgs(identityLabels('myapp', 'web`whoami`; rm -rf /', 'sha', 'service'));
  assert.ok(args.includes('deploy.service=web`whoami`; rm -rf /'));
  // 4 labels x 2 args, not one more: nothing split and nothing ran.
  assert.equal(args.length, 8);
});

test('volumes are prefixed with the service and arrive whole', () => {
  const args = shellArgs(buildVolumeFlags('app-db', ['data:/var/lib/postgresql/data']));
  assert.deepEqual(args, ['-v', 'app-db-data:/var/lib/postgresql/data']);
});

test('the volume prefix carries NO SHA: it must survive a redeploy', () => {
  // If the volume name included the version, every deploy would start with a
  // fresh empty volume and the data would be silently lost.
  const args = shellArgs(buildVolumeFlags('app-web', ['data:/data']));
  assert.deepEqual(args, ['-v', 'app-web-data:/data']);
  assert.ok(!args.some(a => a.includes('abc1234')));
});

test('a volume with spaces is still a single argument', () => {
  const args = shellArgs(buildVolumeFlags('app-web', ['my vol:/path with spaces']));
  assert.deepEqual(args, ['-v', 'app-web-my vol:/path with spaces']);
});

test('with no volumes it leaves no stray fragments', () => {
  assert.equal(buildVolumeFlags('app-web', []), '');
});
