import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePortBinding } from '../dist/core/ports.js';

test('a mapping without an interface is pinned to the loopback', () => {
  // This was the README's and the template's case: "5432:5432" left Postgres
  // reachable from the internet, with ufw enabled and unable to stop it.
  assert.deepEqual(normalizePortBinding('5432:5432'), {
    spec: '127.0.0.1:5432:5432',
    isPublic: false,
  });
});

test('the template case (mongo) is no longer public', () => {
  assert.equal(normalizePortBinding('27017:27017').spec, '127.0.0.1:27017:27017');
  assert.equal(normalizePortBinding('27017:27017').isPublic, false);
});

test('an interface the user already chose is respected', () => {
  assert.deepEqual(normalizePortBinding('127.0.0.1:5432:5432'), {
    spec: '127.0.0.1:5432:5432',
    isPublic: false,
  });
  assert.deepEqual(normalizePortBinding('10.0.0.5:5432:5432'), {
    spec: '10.0.0.5:5432:5432',
    isPublic: false,
  });
});

test('exposing on purpose is allowed but flagged as public', () => {
  const binding = normalizePortBinding('0.0.0.0:5432:5432');
  assert.equal(binding.spec, '0.0.0.0:5432:5432');
  assert.equal(binding.isPublic, true, 'so the user can be warned');
});

test('a container-only port is not published on every interface either', () => {
  // A bare `-p 5432` makes Docker pick a random host port and publish it on
  // 0.0.0.0. Pin it to the loopback as well.
  assert.deepEqual(normalizePortBinding('5432'), {
    spec: '127.0.0.1::5432',
    isPublic: false,
  });
});

test('the protocol is preserved', () => {
  assert.equal(normalizePortBinding('53:53/udp').spec, '127.0.0.1:53:53/udp');
  assert.equal(normalizePortBinding('5432:5432/tcp').spec, '127.0.0.1:5432:5432/tcp');
});

test('surrounding whitespace is tolerated', () => {
  assert.equal(normalizePortBinding('  5432:5432  ').spec, '127.0.0.1:5432:5432');
});

test('an empty mapping is rejected rather than producing a broken flag', () => {
  assert.throws(() => normalizePortBinding('   '), /empty/);
});
