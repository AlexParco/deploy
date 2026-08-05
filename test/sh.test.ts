import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { shQuote, shJoin, envFlags, toEnvFile } from '../dist/core/sh.js';

/** Runs the quoted fragment through a real POSIX shell and returns what it printed. */
function throughShell(quoted: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf-8' });
}

// Values that genuinely show up in passwords and connection strings, plus the
// metacharacters that would turn the command into a different command.
const NASTY = [
  `simple`,
  `with spaces`,
  `single'quote`,
  `two''in a row`,
  `'wrapped'`,
  `$HOME`,
  `${'`'}whoami${'`'}`,
  `$(whoami)`,
  `semi;colon`,
  `pipe|char`,
  `amper&sand`,
  `redirect>ion`,
  `back\\slash`,
  `double"quotes"`,
  `p4ss!w0rd#$%`,
  `postgres://user:p'a$$@host:5432/db?sslmode=require`,
  `*`,
  `~`,
  `!histexp`,
];

test('shQuote: the value survives a real shell untouched', () => {
  for (const value of NASTY) {
    assert.equal(throughShell(shQuote(value)), value, `failed for: ${value}`);
  }
});

test('shQuote: does not trigger command substitution', () => {
  // If quoting were broken, the shell would run whoami and print the username.
  const output = throughShell(shQuote('$(whoami)'));
  assert.equal(output, '$(whoami)');
  assert.doesNotMatch(output, /^[a-z_][a-z0-9_-]*$/i);
});

test('shQuote: neutralizes a command injection attempt', () => {
  const payload = `x'; touch /tmp/deploy-pwned-marker; echo '`;
  const output = throughShell(shQuote(payload));
  assert.equal(output, payload);
});

test('shJoin drops empty fragments', () => {
  assert.equal(shJoin(['docker', '', 'run', null, undefined, '-d']), 'docker run -d');
  assert.equal(shJoin([]), '');
});

test('envFlags quotes key and value together', () => {
  const flags = envFlags({ TOKEN: `a'b` });
  assert.equal(flags, `-e 'TOKEN=a'\\''b'`);
  assert.equal(throughShell(flags.slice('-e '.length)), `TOKEN=a'b`);
});

test('envFlags returns empty with no variables', () => {
  assert.equal(envFlags({}), '');
});

test('toEnvFile does not quote: Docker takes the value literally', () => {
  // Quoting here would put the quotes INSIDE the value the container sees.
  assert.equal(toEnvFile({ A: `it's`, B: `with spaces` }), `A=it's\nB=with spaces\n`);
});

test('toEnvFile rejects newlines instead of silently truncating', () => {
  assert.throws(() => toEnvFile({ KEY: 'line1\nline2' }), /newline/);
});

test('toEnvFile returns empty with no variables', () => {
  assert.equal(toEnvFile({}), '');
});
