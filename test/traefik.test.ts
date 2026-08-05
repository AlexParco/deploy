import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';

import { buildDynamicConfig, routerName, dynamicConfigPath } from '../dist/core/traefik.js';
import type { ServiceConfig } from '../dist/core/config.js';

function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    build: '.',
    dockerfile: 'Dockerfile',
    port: 3000,
    domain: 'example.com',
    healthcheck: '/health',
    startup_timeout: 60,
    volumes: [],
    env: { clear: {}, secret: [] },
    ...overrides,
  } as ServiceConfig;
}

test('the route points at the specific versioned container', () => {
  const config = parseYaml(
    buildDynamicConfig('app-web', service(), 'app-web-abc1234', true),
  );
  assert.deepEqual(
    config.http.services['app-web'].loadBalancer.servers,
    [{ url: 'http://app-web-abc1234:3000' }],
  );
});

test('there is exactly one server: traffic is never split across versions', () => {
  // The previous bug: old and new declared the same router through labels and
  // Traefik ended up load balancing between two different versions of the app.
  const config = parseYaml(
    buildDynamicConfig('app-web', service(), 'app-web-abc1234', true),
  );
  assert.equal(config.http.services['app-web'].loadBalancer.servers.length, 1);
});

test('with ssl it uses websecure and the cert resolver', () => {
  const config = parseYaml(buildDynamicConfig('app-web', service(), 'app-web-sha', true));
  const router = config.http.routers['app-web'];
  assert.deepEqual(router.entryPoints, ['websecure']);
  assert.deepEqual(router.tls, { certResolver: 'letsencrypt' });
});

test('without ssl it uses web and requests no certificate', () => {
  const config = parseYaml(buildDynamicConfig('app-web', service(), 'app-web-sha', false));
  const router = config.http.routers['app-web'];
  assert.deepEqual(router.entryPoints, ['web']);
  assert.equal(router.tls, undefined);
});

test('the Host rule uses the configured domain', () => {
  const config = parseYaml(
    buildDynamicConfig('app-web', service({ domain: 'api.mydomain.com' }), 'c', true),
  );
  assert.equal(config.http.routers['app-web'].rule, 'Host(`api.mydomain.com`)');
});

test('a domain with quotes or newlines breaks neither the YAML nor injects keys', () => {
  const hostile = 'a.com`\nhttp:\n  routers:\n    pirate:\n      rule: "x"';
  const yaml = buildDynamicConfig('app-web', service({ domain: hostile }), 'c', true);
  const config = parseYaml(yaml);

  // There is still exactly one router, and it is ours.
  assert.deepEqual(Object.keys(config.http.routers), ['app-web']);
  assert.equal(config.http.routers.pirate, undefined);
  assert.ok(config.http.routers['app-web'].rule.includes(hostile));
});

test('the router is named per service, not per version', () => {
  // If the router name carried the SHA, every deploy would leave an orphaned
  // router per version behind in Traefik's configuration.
  assert.equal(routerName('myapp', 'web'), 'myapp-web');
  assert.ok(!routerName('myapp', 'web').includes('sha'));
});

test('each service writes its own config file', () => {
  assert.equal(dynamicConfigPath('myapp', 'web'), '/opt/deploy/.traefik/dynamic/myapp-web.yml');
  assert.notEqual(dynamicConfigPath('myapp', 'web'), dynamicConfigPath('myapp', 'api'));
});

test('the routes file lives outside what rsync --delete wipes', () => {
  const path = dynamicConfigPath('myapp', 'web');
  assert.ok(!path.startsWith('/opt/deploy/myapp/'));
});
