import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRsyncArgs } from '../dist/core/ssh.js';
import type { SSHConfig } from '../dist/core/ssh.js';

const SERVER: SSHConfig = { host: '192.0.2.10', user: 'deploy', port: 2359 };

const args = (excludes: string[] = [], key: string | null = null) =>
  buildRsyncArgs(SERVER, '/local/project', '/opt/deploy/myapp', excludes, key);

test('source and destination end in a slash', () => {
  // Without the trailing slash rsync would nest the directory inside itself.
  const result = args();
  assert.equal(result[result.length - 2], '/local/project/');
  assert.equal(result[result.length - 1], 'deploy@192.0.2.10:/opt/deploy/myapp/');
});

test('the ssh port travels in the -e command', () => {
  const result = args();
  const ssh = result[result.indexOf('-e') + 1]!;
  assert.match(ssh, /-p 2359/);
  assert.match(ssh, /StrictHostKeyChecking=accept-new/);
});

test('an explicit key is quoted inside the ssh command', () => {
  const ssh = args([], "/home/me/.ssh/my key")[args().indexOf('-e') + 1];
  assert.match(ssh!, /-i '\/home\/me\/\.ssh\/my key'/);
});

test('without a key no -i flag is emitted', () => {
  const ssh = args()[args().indexOf('-e') + 1]!;
  assert.ok(!ssh.includes('-i '));
});

test('each exclude is one argument, never shell-split', () => {
  // These reach execFileSync directly, with no shell in between.
  const result = args(['node_modules', '.git', 'my dir', "it's"]);
  assert.ok(result.includes('--exclude=node_modules'));
  assert.ok(result.includes('--exclude=my dir'));
  assert.ok(result.includes("--exclude=it's"));
});

test('an exclude cannot be mistaken for a flag', () => {
  const result = args(['--delete-after']);
  assert.ok(result.includes('--exclude=--delete-after'));
  assert.equal(result.filter(a => a === '--delete').length, 1);
});

test('--delete is present: the remote copy mirrors the local tree', () => {
  assert.ok(args().includes('--delete'));
  assert.ok(args().includes('-az'));
});

test('a path with spaces stays a single argument', () => {
  const result = buildRsyncArgs(SERVER, '/local/my project', '/opt/deploy/x', [], null);
  assert.ok(result.includes('/local/my project/'));
});
