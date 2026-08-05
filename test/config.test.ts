import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  interpolateVars,
  isNamedVolume,
  findConfigPath,
  getSecretsPath,
  getAllSecretNames,
} from '../dist/core/config.js';

/** Writes a deploy.yml plus .deploy/secrets into a temp project and returns it. */
function project(configYaml: string, secrets = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  writeFileSync(join(dir, 'deploy.yml'), configYaml);
  mkdirSync(join(dir, '.deploy'));
  writeFileSync(join(dir, '.deploy', 'secrets'), secrets);
  return dir;
}

const BASE = (host = '${SERVER_HOST}') => `
project: myapp
server:
  host: ${host}
  user: deploy
services:
  web:
    build: .
    port: 3000
    domain: example.com
proxy:
  ssl: true
  email: me@example.com
`;

// ─── Interpolation happens after parsing ─────────────────────────────────────

test('a secret containing ":" no longer breaks the YAML', () => {
  // Substituting into the raw text produced "host: a: b", and the parser blamed
  // deploy.yml with a message that never mentioned the secret.
  const dir = project(BASE(), 'SERVER_HOST=pass: with colon\n');
  assert.equal(loadConfig(dir).server.host, 'pass: with colon');
});

test('a value with a "#" is not treated as a YAML comment', () => {
  const dir = project(BASE(), 'SERVER_HOST=host#notacomment\n');
  assert.equal(loadConfig(dir).server.host, 'host#notacomment');
});

test('quotes in a value stay part of the value', () => {
  const dir = project(BASE(), `SERVER_HOST=say "hi"\n`);
  assert.equal(loadConfig(dir).server.host, 'say "hi"');
});

test('a multi-line value CANNOT inject configuration keys', () => {
  // Reproduces the real vector: an env var can hold newlines, and substituting
  // into the raw text let it add keys such as `key:` (the SSH key to use).
  const dir = project(BASE());
  process.env.SERVER_HOST = 'realhost.com\n  key: /tmp/attacker-key';
  try {
    const config = loadConfig(dir);
    assert.equal(config.server.key, undefined, 'no key should have been injected');
    assert.ok(config.server.host.includes('realhost.com'));
  } finally {
    delete process.env.SERVER_HOST;
  }
});

test('the value is used verbatim, newlines included', () => {
  const dir = project(BASE());
  process.env.SERVER_HOST = 'a\nb';
  try {
    assert.equal(loadConfig(dir).server.host, 'a\nb');
  } finally {
    delete process.env.SERVER_HOST;
  }
});

test('a missing variable still fails, naming it', () => {
  const dir = project(BASE());
  assert.throws(() => loadConfig(dir), /\$\{SERVER_HOST\}/);
});

test('.deploy/secrets wins over the environment', () => {
  const dir = project(BASE(), 'SERVER_HOST=from-file\n');
  process.env.SERVER_HOST = 'from-env';
  try {
    assert.equal(loadConfig(dir).server.host, 'from-file');
  } finally {
    delete process.env.SERVER_HOST;
  }
});

test('numbers still work when they arrive interpolated as strings', () => {
  // The parsed value is the string "2222"; the schema has to accept it.
  const dir = project(`
project: myapp
server:
  host: h
  port: \${SSH_PORT}
services:
  web:
    build: .
    port: \${APP_PORT}
    domain: example.com
proxy:
  ssl: \${USE_SSL}
  email: me@example.com
`, 'SSH_PORT=2222\nAPP_PORT=8080\nUSE_SSL=false\n');

  const config = loadConfig(dir);
  assert.equal(config.server.port, 2222);
  assert.equal(config.services.web!.port, 8080);
  assert.equal(config.proxy.ssl, false);
});

test('interpolateVars only touches values, never keys', () => {
  const lookup = (name: string) => `<${name}>`;
  const result = interpolateVars(
    { '${KEY}': 'a', nested: ['${A}', { b: '${B}' }], n: 3, ok: true },
    lookup,
  ) as Record<string, unknown>;

  assert.ok('${KEY}' in result, 'the key must stay untouched');
  assert.deepEqual(result.nested, ['<A>', { b: '<B>' }]);
  assert.equal(result.n, 3);
  assert.equal(result.ok, true);
});

// ─── Volume validation ───────────────────────────────────────────────────────

test('named volumes are accepted', () => {
  assert.ok(isNamedVolume('data:/var/lib/postgresql/data'));
  assert.ok(isNamedVolume('uploads:/app/uploads'));
  assert.ok(isNamedVolume('cache:/tmp:ro'));
});

test('host paths are rejected', () => {
  // "/data:/data" would become the volume "myapp-web-/data:/data", which Docker
  // refuses with an opaque error on the server.
  assert.ok(!isNamedVolume('/data:/data'));
  assert.ok(!isNamedVolume('./local:/app'));
  assert.ok(!isNamedVolume('~/stuff:/app'));
});

test('malformed volumes are rejected', () => {
  assert.ok(!isNamedVolume('justaname'));
  assert.ok(!isNamedVolume('name:relative/path'));
  assert.ok(!isNamedVolume(''));
});

// ─── Locating the project ────────────────────────────────────────────────────

test('a missing deploy.yml points at deploy init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-empty-'));
  assert.throws(() => findConfigPath(dir), /deploy init/);
});

test('the secrets path sits under the project', () => {
  assert.equal(getSecretsPath('/x/proj'), '/x/proj/.deploy/secrets');
});

// ─── Collecting secret names ─────────────────────────────────────────────────

test('secret names are gathered from services and accessories, deduplicated', () => {
  const config = {
    services: {
      web: { env: { clear: {}, secret: ['DB_URL'] } },
      api: { env: { clear: {}, secret: ['DB_URL', 'API_KEY'] } },
    },
    accessories: { db: { env: { clear: {}, secret: ['DB_PASSWORD'] } } },
  } as never;

  assert.deepEqual(getAllSecretNames(config).sort(), ['API_KEY', 'DB_PASSWORD', 'DB_URL']);
});

test('a project with no secrets yields an empty list', () => {
  const config = { services: { web: { env: { clear: {}, secret: [] } } } } as never;
  assert.deepEqual(getAllSecretNames(config), []);
});

// ─── Schema edges ────────────────────────────────────────────────────────────

test('a service name with uppercase or underscores is rejected', () => {
  // These names end up in container names and Traefik routers.
  const dir = project(`
project: myapp
server:
  host: h
services:
  My_Service:
    build: .
    port: 3000
    domain: example.com
proxy:
  ssl: true
  email: me@example.com
`);
  assert.throws(() => loadConfig(dir), /lowercase/);
});

test('an invalid proxy email is rejected', () => {
  const dir = project(
    BASE().replace('me@example.com', 'not-an-email'),
    'SERVER_HOST=h\n',
  );
  assert.throws(() => loadConfig(dir), /email/i);
});

test('defaults are filled in for the optional fields', () => {
  const dir = project(BASE(), 'SERVER_HOST=h\n');
  const config = loadConfig(dir);

  assert.equal(config.server.port, 22);
  assert.equal(config.services.web!.dockerfile, 'Dockerfile');
  assert.equal(config.services.web!.healthcheck, '/health');
  assert.deepEqual(config.services.web!.volumes, []);
  assert.deepEqual(config.accessories, {});
});

test('accessory volumes are validated too', () => {
  const dir = project(`
project: myapp
server:
  host: h
services:
  web:
    build: .
    port: 3000
    domain: example.com
accessories:
  db:
    image: postgres:16
    volumes:
      - /host/pg:/var/lib/postgresql/data
proxy:
  ssl: true
  email: me@example.com
`);
  assert.throws(() => loadConfig(dir), /named volumes/i);
});

test('a pattern that is not a variable is left alone', () => {
  // Only ${WORD} is a variable; anything else is literal text.
  const lookup = () => 'REPLACED';
  const result = interpolateVars(
    { a: '${A-B}', b: '$NOTBRACED', c: '${}', d: 'plain' },
    lookup,
  ) as Record<string, string>;

  assert.deepEqual(result, { a: '${A-B}', b: '$NOTBRACED', c: '${}', d: 'plain' });
});

test('the same variable can appear more than once', () => {
  const result = interpolateVars('${A}-${A}', (name) => name.toLowerCase());
  assert.equal(result, 'a-a');
});

test('a host path fails at load time, not on the server', () => {
  const dir = project(`
project: myapp
server:
  host: h
services:
  web:
    build: .
    port: 3000
    domain: example.com
    volumes:
      - /host/path:/data
proxy:
  ssl: true
  email: me@example.com
`);
  assert.throws(() => loadConfig(dir), /named volumes/i);
});

test('secret names can be narrowed to the services being deployed', () => {
  // `deploy --service api` must not demand the secrets of `web`.
  const config = {
    services: {
      web: { env: { clear: {}, secret: ['WEB_ONLY'] } },
      api: { env: { clear: {}, secret: ['API_ONLY'] } },
    },
    accessories: { db: { env: { clear: {}, secret: ['DB_PASSWORD'] } } },
  } as never;

  assert.deepEqual(getAllSecretNames(config, ['api']).sort(), ['API_ONLY', 'DB_PASSWORD']);
});

test('accessories are always included, since they reconcile every deploy', () => {
  const config = {
    services: { web: { env: { clear: {}, secret: [] } } },
    accessories: { db: { env: { clear: {}, secret: ['DB_PASSWORD'] } } },
  } as never;

  assert.deepEqual(getAllSecretNames(config, []), ['DB_PASSWORD']);
});

test('an unknown service name contributes nothing rather than throwing', () => {
  const config = { services: { web: { env: { clear: {}, secret: ['A'] } } } } as never;
  assert.deepEqual(getAllSecretNames(config, ['nope']), []);
});

test('a service and an accessory cannot share a name', () => {
  // Both are labelled deploy.service=<name> and both derive their container
  // name from it, so a clash makes lookups pick whichever Docker lists first.
  const dir = project(`
project: myapp
server:
  host: h
services:
  db:
    build: .
    port: 3000
    domain: example.com
accessories:
  db:
    image: postgres:16
proxy:
  ssl: true
  email: me@example.com
`);
  assert.throws(() => loadConfig(dir), /also the name of a service/);
});

test('distinct names are accepted', () => {
  const dir = project(`
project: myapp
server:
  host: h
services:
  web:
    build: .
    port: 3000
    domain: example.com
accessories:
  db:
    image: postgres:16
proxy:
  ssl: true
  email: me@example.com
`);
  const config = loadConfig(dir);
  assert.deepEqual(Object.keys(config.services), ['web']);
  assert.deepEqual(Object.keys(config.accessories), ['db']);
});

test('startup_timeout defaults to 60 seconds', () => {
  const dir = project(BASE(), 'SERVER_HOST=h\n');
  assert.equal(loadConfig(dir).services.web!.startup_timeout, 60);
});

test('startup_timeout accepts an interpolated value', () => {
  const dir = project(
    BASE().replace('    domain: example.com', '    domain: example.com\n    startup_timeout: ${BOOT}'),
    'SERVER_HOST=h\nBOOT=300\n',
  );
  assert.equal(loadConfig(dir).services.web!.startup_timeout, 300);
});

test('a non-positive startup_timeout is rejected', () => {
  const dir = project(
    BASE().replace('    domain: example.com', '    domain: example.com\n    startup_timeout: 0'),
    'SERVER_HOST=h\n',
  );
  assert.throws(() => loadConfig(dir), /startup_timeout/);
});
