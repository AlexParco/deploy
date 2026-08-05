import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import type { NodeSSH } from 'node-ssh';

import {
  adoptRouteFromLabels,
  parseTraefikCmd,
  buildRouteConfig,
  routeConfigPath,
  routerName,
} from '../dist/core/traefik.js';
import { reconcileProxy, assertProxyMatches } from '../dist/core/docker.js';

// Command line of a Traefik started by the previous version of the CLI.
const LEGACY_CMD = [
  '--providers.docker=true',
  '--providers.docker.exposedbydefault=false',
  '--entrypoints.web.address=:80',
  '--entrypoints.websecure.address=:443',
  '--entrypoints.web.http.redirections.entrypoint.to=websecure',
  '--certificatesresolvers.letsencrypt.acme.email=first@example.com',
].join('\n');

const CURRENT_CMD = (email: string | null) => [
  '--providers.file.directory=/dynamic',
  '--providers.file.watch=true',
  '--entrypoints.web.address=:80',
  ...(email
    ? [
        '--entrypoints.websecure.address=:443',
        `--certificatesresolvers.letsencrypt.acme.email=${email}`,
      ]
    : []),
].join('\n');

// Labels the old scheme put on a running container.
const legacyLabels = (domain: string, port: string, router: string, ssl = true) => ({
  'traefik.enable': 'true',
  [`traefik.http.routers.${router}.rule`]: `Host(\`${domain}\`)`,
  [`traefik.http.services.${router}.loadbalancer.server.port`]: port,
  ...(ssl
    ? {
        [`traefik.http.routers.${router}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${router}.tls.certresolver`]: 'letsencrypt',
      }
    : { [`traefik.http.routers.${router}.entrypoints`]: 'web' }),
});

// ─── Reading the running Traefik ─────────────────────────────────────────────

test('a legacy Traefik is recognized as not using the file provider', () => {
  const state = parseTraefikCmd(LEGACY_CMD);
  assert.equal(state.fileProvider, false);
  assert.equal(state.ssl, true);
  assert.equal(state.email, 'first@example.com');
});

test('the current Traefik is recognized, email included', () => {
  const state = parseTraefikCmd(CURRENT_CMD('me@example.com'));
  assert.equal(state.fileProvider, true);
  assert.equal(state.ssl, true);
  assert.equal(state.email, 'me@example.com');
});

test('a Traefik without ssl reports no certificate machinery', () => {
  const state = parseTraefikCmd(CURRENT_CMD(null));
  assert.equal(state.ssl, false);
  assert.equal(state.email, null);
});

// ─── Adopting label-based routes ─────────────────────────────────────────────

test('a route is reconstructed from the labels of a running container', () => {
  const spec = adoptRouteFromLabels(
    'flinksmart-web-web',
    legacyLabels('flinksmart.com', '3000', 'flinksmart-web-web'),
  );

  assert.deepEqual(spec, {
    router: 'flinksmart-web-web',
    rule: 'Host(`flinksmart.com`)',
    containerName: 'flinksmart-web-web',
    port: 3000,
    ssl: true,
  });
});

test('the adopted route lands where the next deploy will write', () => {
  // This is what makes the handover seamless: the old router name was the
  // container name, which is exactly what routerName() produces today.
  const spec = adoptRouteFromLabels(
    'flinksmart-web-api',
    legacyLabels('api.flinksmart.com', '3001', 'flinksmart-web-api'),
  )!;

  assert.equal(
    routeConfigPath(spec.router),
    routeConfigPath(routerName('flinksmart-web', 'api')),
  );
});

test('the adopted route keeps serving the container already running', () => {
  const spec = adoptRouteFromLabels(
    'shalom-api-go-api',
    legacyLabels('api.shalom-api-peru.com', '8080', 'shalom-api-go-api'),
  )!;
  const config = parseYaml(buildRouteConfig(spec));

  assert.deepEqual(
    config.http.services['shalom-api-go-api'].loadBalancer.servers,
    [{ url: 'http://shalom-api-go-api:8080' }],
  );
});

test('a container without traefik labels is skipped', () => {
  assert.equal(adoptRouteFromLabels('some-db', {}), null);
  assert.equal(adoptRouteFromLabels('x', { 'traefik.enable': 'false' }), null);
});

test('labels missing the port are skipped rather than adopted broken', () => {
  assert.equal(
    adoptRouteFromLabels('x', {
      'traefik.enable': 'true',
      'traefik.http.routers.x.rule': 'Host(`a.com`)',
    }),
    null,
  );
});

test('a route without tls is adopted as non-ssl', () => {
  const spec = adoptRouteFromLabels('x', legacyLabels('a.com', '80', 'x', false))!;
  assert.equal(spec.ssl, false);
});

// ─── Migrating a real server ─────────────────────────────────────────────────

/** Mirrors the production VPS: legacy Traefik plus five label-routed services. */
function legacyServer() {
  const containers: Record<string, Record<string, string>> = {
    'crm-wsp-landing-web': legacyLabels('crm.flinksmart.com', '80', 'crm-wsp-landing-web'),
    'flinksmart-web-web': legacyLabels('flinksmart.com', '3000', 'flinksmart-web-web'),
    'flinksmart-web-api': legacyLabels('api.flinksmart.com', '3001', 'flinksmart-web-api'),
    'shalom-api-go-api': legacyLabels('api.shalom-api-peru.com', '8080', 'shalom-api-go-api'),
    'shaloom-api-astro-web': legacyLabels('shalom-api-peru.com', '3000', 'shaloom-api-astro-web'),
  };

  const written: Record<string, string> = {};
  const calls: string[] = [];

  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push(command);

      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'running', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{range .Config.Cmd}}')) {
        return { stdout: LEGACY_CMD, stderr: '', code: 0, signal: null };
      }
      if (command.includes('label=traefik.enable=true')) {
        return { stdout: Object.keys(containers).join('\n'), stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{json .Config.Labels}}')) {
        const name = Object.keys(containers).find(n => command.includes(`'${n}'`));
        return { stdout: JSON.stringify(containers[name!]), stderr: '', code: 0, signal: null };
      }
      if (command.startsWith('test -f')) {
        const path = /test -f '([^']+)'/.exec(command)?.[1];
        return {
          stdout: path && written[path] ? 'yes' : '',
          stderr: '', code: 0, signal: null,
        };
      }
      if (command.startsWith('cat >')) {
        const path = /cat > '([^']+)'/.exec(command)?.[1];
        if (path) written[path] = options?.stdin ?? '';
        return { stdout: '', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  return { ssh, written, calls };
}

const PROXY = { ssl: true, email: 'somos@flinksmart.com' };

test('migrating carries over every route before recreating Traefik', async () => {
  const { ssh, written, calls } = legacyServer();
  const result = await reconcileProxy(ssh, PROXY);

  assert.equal(result.action, 'recreated');
  assert.equal(result.adopted.length, 5, 'all five routes must be carried over');
  assert.equal(Object.keys(written).length, 5);

  // The order is what keeps production up: routes exist before the old Traefik
  // goes away, so the new one starts already serving them.
  const writeIndexes = calls
    .map((command, index) => (command.startsWith('cat >') ? index : -1))
    .filter(index => index >= 0);
  const lastWrite = writeIndexes[writeIndexes.length - 1]!;
  const removal = calls.findIndex(c => c.includes("docker rm -f 'deploy-traefik'"));
  const start = calls.findIndex(c => c.includes('--name deploy-traefik'));

  assert.ok(lastWrite < removal, 'routes must be written before removing Traefik');
  assert.ok(removal < start, 'the new Traefik starts after the old one is gone');
});

test('the carried-over routes still point at the old containers', async () => {
  const { ssh, written } = legacyServer();
  await reconcileProxy(ssh, PROXY);

  const config = parseYaml(written['/opt/deploy/.traefik/dynamic/flinksmart-web-web.yml']!);
  assert.deepEqual(
    config.http.services['flinksmart-web-web'].loadBalancer.servers,
    [{ url: 'http://flinksmart-web-web:3000' }],
  );
});

test('a route already written by this version is not overwritten', async () => {
  const { ssh, written } = legacyServer();
  const path = '/opt/deploy/.traefik/dynamic/flinksmart-web-web.yml';
  written[path] = 'already migrated';

  const result = await reconcileProxy(ssh, PROXY);

  assert.equal(written[path], 'already migrated');
  assert.ok(!result.adopted.includes('flinksmart-web-web'));
  assert.equal(result.adopted.length, 4);
});

// ─── Drift detection ─────────────────────────────────────────────────────────

function serverRunning(cmd: string | null, state = 'running') {
  const ssh = {
    execCommand: async (command: string) => {
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: cmd === null ? '' : state, stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{range .Config.Cmd}}')) {
        return { stdout: cmd ?? '', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return ssh;
}

test('deploy refuses to run against a legacy Traefik, pointing at setup', async () => {
  await assert.rejects(
    assertProxyMatches(serverRunning(LEGACY_CMD), PROXY),
    /deploy setup/,
  );
});

test('deploy fails when Traefik is not running at all', async () => {
  await assert.rejects(assertProxyMatches(serverRunning(null), PROXY), /deploy setup/);
});

test('a mismatched email warns instead of failing', async () => {
  // The real case on the production VPS: two projects declare
  // somos@flinksmart.com and two declare alexander.parco@somosari.com, but only
  // one is registered with Let's Encrypt.
  const warnings = await assertProxyMatches(
    serverRunning(CURRENT_CMD('alexander.parco@somosari.com')),
    { ssl: true, email: 'somos@flinksmart.com' },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /alexander\.parco@somosari\.com/);
  assert.match(warnings[0]!, /somos@flinksmart\.com/);
  assert.match(warnings[0]!, /deploy setup/);
});

test('a matching email produces no warning', async () => {
  const warnings = await assertProxyMatches(
    serverRunning(CURRENT_CMD('somos@flinksmart.com')),
    PROXY,
  );
  assert.deepEqual(warnings, []);
});

test('an ssl mismatch fails, because the project would not serve traffic', async () => {
  await assert.rejects(
    assertProxyMatches(serverRunning(CURRENT_CMD('me@example.com')), {
      ssl: false, email: 'me@example.com',
    }),
    /both cannot hold at once/,
  );
});

test('with ssl disabled the email is not compared', async () => {
  const warnings = await assertProxyMatches(serverRunning(CURRENT_CMD(null)), {
    ssl: false, email: 'whatever@example.com',
  });
  assert.deepEqual(warnings, []);
});

test('reconciling an already matching Traefik changes nothing', async () => {
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'running', stderr: '', code: 0, signal: null };
      }
      return {
        stdout: command.includes('{{range .Config.Cmd}}')
          ? CURRENT_CMD('somos@flinksmart.com') : '',
        stderr: '', code: 0, signal: null,
      };
    },
  } as unknown as NodeSSH;

  const result = await reconcileProxy(ssh, PROXY);

  assert.equal(result.action, 'unchanged');
  assert.ok(!calls.some(c => c.includes("docker rm -f 'deploy-traefik'")));
});

test('changing the email does recreate Traefik — it used to be a silent no-op', async () => {
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'running', stderr: '', code: 0, signal: null };
      }
      return {
        stdout: command.includes('{{range .Config.Cmd}}')
          ? CURRENT_CMD('old@example.com') : '',
        stderr: '', code: 0, signal: null,
      };
    },
  } as unknown as NodeSSH;

  const result = await reconcileProxy(ssh, { ssl: true, email: 'new@example.com' });

  assert.equal(result.action, 'recreated');
  assert.ok(calls.some(c => c.includes('acme.email=new@example.com')));
});

// ─── ssl: false ──────────────────────────────────────────────────────────────

test('with ssl disabled Traefik gets no HTTPS redirect', async () => {
  // The old bug: the redirect was added unconditionally, so a service published
  // on the `web` entrypoint got bounced to `websecure`, where no certificate
  // had ever been requested.
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await reconcileProxy(ssh, { ssl: false, email: 'me@example.com' });

  const run = calls.find(c => c.includes('--name deploy-traefik'))!;
  assert.ok(!run.includes('redirections'), 'must not redirect to HTTPS');
  assert.ok(!run.includes('certificatesresolvers'), 'must not request certificates');
  assert.ok(!run.includes('-p 443:443'), 'must not publish 443');
  assert.match(run, /--entrypoints\.web\.address=:80/);
});

test('with ssl enabled the redirect and the resolver are configured', async () => {
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await reconcileProxy(ssh, PROXY);

  const run = calls.find(c => c.includes('--name deploy-traefik'))!;
  assert.match(run, /redirections\.entrypoint\.to=websecure/);
  assert.match(run, /acme\.email=somos@flinksmart\.com/);
  assert.match(run, /-p 443:443/);
});

// ─── Adoption failures are reported, never silent ────────────────────────────

/** Legacy server where inspecting one container yields unusable output. */
function serverWithBadContainer(badOutput: string) {
  const names = ['good-web', 'bad-web'];
  const ssh = {
    execCommand: async (command: string) => {
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'running', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{range .Config.Cmd}}')) {
        return { stdout: LEGACY_CMD, stderr: '', code: 0, signal: null };
      }
      if (command.includes('label=traefik.enable=true')) {
        return { stdout: names.join('\n'), stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{json .Config.Labels}}')) {
        return {
          stdout: command.includes("'bad-web'")
            ? badOutput
            : JSON.stringify(legacyLabels('good.com', '3000', 'good-web')),
          stderr: '', code: 0, signal: null,
        };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;
  return ssh;
}

test('a container that vanished mid-migration is reported, not skipped quietly', async () => {
  // Silence here means a project goes dark with nothing said about it.
  const result = await reconcileProxy(serverWithBadContainer(''), PROXY);

  assert.deepEqual(result.adopted, ['good-web']);
  assert.deepEqual(result.skipped, ['bad-web']);
});

test('null labels do not crash the migration', async () => {
  // `{{json .Config.Labels}}` prints null for a container with no labels;
  // reading a property off it would throw and abort the whole setup.
  const result = await reconcileProxy(serverWithBadContainer('null'), PROXY);

  assert.deepEqual(result.adopted, ['good-web']);
  assert.deepEqual(result.skipped, ['bad-web']);
});

test('labels that do not describe a route are reported as skipped', async () => {
  const partial = JSON.stringify({
    'traefik.enable': 'true',
    'traefik.http.routers.bad-web.rule': 'Host(`bad.com`)',
  });
  const result = await reconcileProxy(serverWithBadContainer(partial), PROXY);

  assert.deepEqual(result.skipped, ['bad-web'], 'a route without a port is unusable');
});

test('a clean migration reports nothing skipped', async () => {
  const { ssh } = legacyServer();
  const result = await reconcileProxy(ssh, PROXY);
  assert.deepEqual(result.skipped, []);
});

// ─── Proxy container states ──────────────────────────────────────────────────

test('a stopped Traefik is never reported as up to date', async () => {
  // It exists and its arguments match, but it is serving nothing. Calling that
  // "unchanged" would leave every site on the server down with a green message.
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'exited', stderr: '', code: 0, signal: null };
      }
      if (command.includes('{{range .Config.Cmd}}')) {
        return { stdout: CURRENT_CMD('somos@flinksmart.com'), stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  const result = await reconcileProxy(ssh, PROXY);

  assert.equal(result.action, 'recreated');
  assert.ok(calls.some(c => c.includes("docker rm -f 'deploy-traefik'")));
});

test('deploy refuses to run against a stopped Traefik', async () => {
  await assert.rejects(
    assertProxyMatches(serverRunning(CURRENT_CMD('somos@flinksmart.com'), 'exited'), PROXY),
    /exists but is stopped/,
  );
});

test('a container whose arguments cannot be read is still removed first', async () => {
  // Inferring existence from a readable command line made this container look
  // absent, and `docker run` then failed on the name already being in use.
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      if (command.includes('name=^deploy-traefik$')) {
        return { stdout: 'running', stderr: '', code: 0, signal: null };
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  await reconcileProxy(ssh, PROXY);

  const removal = calls.findIndex(c => c.includes("docker rm -f 'deploy-traefik'"));
  const start = calls.findIndex(c => c.includes('--name deploy-traefik'));
  assert.ok(removal >= 0, 'the existing container must be removed');
  assert.ok(removal < start, 'and removed before the new one starts');
});

test('a server with no Traefik at all just creates one', async () => {
  const calls: string[] = [];
  const ssh = {
    execCommand: async (command: string) => {
      calls.push(command);
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  } as unknown as NodeSSH;

  const result = await reconcileProxy(ssh, PROXY);

  assert.equal(result.action, 'created');
  assert.ok(!calls.some(c => c.includes("docker rm -f 'deploy-traefik'")));
});
