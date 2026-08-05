import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvFile, resolveSecrets } from '../dist/utils/env.js';

function withEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  const path = join(dir, 'secrets');
  writeFileSync(path, content);
  return path;
}

test('parseEnvFile reads pairs and skips comments and blank lines', () => {
  const path = withEnvFile('# a comment\n\nFOO=bar\nBAZ=qux\n');
  assert.deepEqual(parseEnvFile(path), { FOO: 'bar', BAZ: 'qux' });
});

test('parseEnvFile keeps the = signs inside the value', () => {
  const path = withEnvFile('URL=postgres://u:p@h:5432/db?a=1&b=2\n');
  assert.equal(
    parseEnvFile(path).URL,
    'postgres://u:p@h:5432/db?a=1&b=2',
  );
});

test('parseEnvFile strips surrounding quotes', () => {
  const path = withEnvFile(`A="with spaces"\nB='single'\n`);
  assert.deepEqual(parseEnvFile(path), { A: 'with spaces', B: 'single' });
});

test('parseEnvFile returns empty when the file does not exist', () => {
  assert.deepEqual(parseEnvFile('/does/not/exist/secrets'), {});
});

test('resolveSecrets fails naming the missing ones', () => {
  const path = withEnvFile('PRESENT=1\n');
  assert.throws(
    () => resolveSecrets(['PRESENT', 'MISSING'], path),
    /MISSING/,
  );
});
