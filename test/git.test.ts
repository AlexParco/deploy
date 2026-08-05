import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getGitSHA, getDirtyFiles } from '../dist/core/docker.js';

/** Creates a repository with one commit and returns its path. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'first');

  return dir;
}

/** Runs fn with the process cwd moved, restoring it afterwards. */
function inside<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

test('the short SHA of HEAD is returned', () => {
  const dir = repo();
  const sha = inside(dir, getGitSHA);
  assert.match(sha, /^[0-9a-f]{7,}$/);
});

test('outside a repository it fails with a usable message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-nogit-'));
  assert.throws(() => inside(dir, getGitSHA), /git repository/);
});

test('a clean tree reports no dirty files', () => {
  const dir = repo();
  assert.deepEqual(inside(dir, getDirtyFiles), []);
});

test('a modified file is reported', () => {
  // This is what decides the warning: rsync uploads the working tree, so the
  // image would carry a SHA that does not match its contents.
  const dir = repo();
  writeFileSync(join(dir, 'README.md'), 'changed\n');
  assert.equal(inside(dir, getDirtyFiles).length, 1);
});

test('an untracked file is reported too', () => {
  // It is uploaded by rsync just the same, so it belongs in the warning.
  const dir = repo();
  writeFileSync(join(dir, 'new-file.txt'), 'x\n');

  const dirty = inside(dir, getDirtyFiles);
  assert.equal(dirty.length, 1);
  assert.match(dirty[0]!, /new-file\.txt/);
});

test('outside a repository dirty files are empty rather than throwing', () => {
  // getGitSHA already fails first with a clear message; this must not add a
  // second, more confusing error on top.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-nogit-'));
  assert.deepEqual(inside(dir, getDirtyFiles), []);
});
