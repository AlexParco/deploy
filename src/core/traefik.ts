import { stringify as stringifyYaml } from 'yaml';
import type { ServiceConfig } from './config.js';

/** Host directory that Traefik watches as its file provider. */
export const DYNAMIC_DIR = '/opt/deploy/.traefik/dynamic';

/**
 * Staging directory for routes being written.
 *
 * Deliberately OUTSIDE the watched directory: a half-written file there would
 * be at the mercy of whichever extensions Traefik decides to load, and a `.tmp`
 * left behind by an interrupted deploy could linger as a second definition of
 * a router. Same filesystem as DYNAMIC_DIR, so the move into place is atomic.
 */
export const STAGING_DIR = '/opt/deploy/.traefik/staging';

/** Everything a route needs, regardless of where it was read from. */
export interface RouteSpec {
  router: string;
  rule: string;
  containerName: string;
  port: number;
  ssl: boolean;
}

/**
 * Builds the routing configuration of one service for Traefik's file provider.
 *
 * Why a file instead of Docker labels: a container's labels are immutable from
 * the moment it is created, so a new container would publish its route as soon
 * as it starts — before passing the health check. On top of that, with router
 * names derived from the service, the old and the new container declared the
 * SAME router and Traefik ended up splitting traffic between two versions.
 *
 * With the file provider, routing is data we rewrite when we choose: there is a
 * concrete switch-over moment, and it happens after the health check.
 *
 * Serialized with the YAML library rather than string concatenation: a domain
 * containing quotes or newlines cannot break the file or inject extra keys.
 */
export function buildRouteConfig(spec: RouteSpec): string {
  const router: Record<string, unknown> = {
    rule: spec.rule,
    service: spec.router,
    entryPoints: [spec.ssl ? 'websecure' : 'web'],
  };

  if (spec.ssl) router.tls = { certResolver: 'letsencrypt' };

  return stringifyYaml({
    http: {
      routers: { [spec.router]: router },
      services: {
        [spec.router]: {
          loadBalancer: {
            // Traefik reaches the container through the user-defined bridge
            // network's DNS, so the name is enough — no need to look up the IP.
            servers: [{ url: `http://${spec.containerName}:${spec.port}` }],
          },
        },
      },
    },
  });
}

export function buildDynamicConfig(
  router: string,
  service: ServiceConfig,
  containerName: string,
  ssl: boolean,
): string {
  return buildRouteConfig({
    router,
    rule: `Host(\`${service.domain}\`)`,
    containerName,
    port: service.port,
    ssl,
  });
}

/** Router and file name for a service. Unique per service, not per version. */
export function routerName(project: string, serviceName: string): string {
  return `${project}-${serviceName}`;
}

export function dynamicConfigPath(project: string, serviceName: string): string {
  return `${DYNAMIC_DIR}/${routerName(project, serviceName)}.yml`;
}

export function routeConfigPath(router: string): string {
  return `${DYNAMIC_DIR}/${router}.yml`;
}

export function stagingConfigPath(router: string): string {
  return `${STAGING_DIR}/${router}.yml`;
}

// ─── Adopting label-based routes ─────────────────────────────────────────────

/**
 * Reconstructs a route from the Traefik labels of an already running container.
 *
 * Needed to migrate a server that was set up by an older version of this CLI,
 * where routing lived in Docker labels. Recreating Traefik with the file
 * provider on such a server would leave it with zero routes and take every
 * project down at once; adopting the existing labels first keeps them serving.
 *
 * The old router name was the container name, `<project>-<service>`, which is
 * exactly what routerName() produces today. So the adopted file lands on the
 * same path the next deploy of that project will write, and the handover is
 * seamless: the deploy simply overwrites it, pointing at the new container.
 */
export function adoptRouteFromLabels(
  containerName: string,
  labels: Record<string, string>,
): RouteSpec | null {
  if (labels['traefik.enable'] !== 'true') return null;

  const router = findLabelGroup(labels, /^traefik\.http\.routers\.(.+)\.rule$/);
  if (!router) return null;

  const rule = labels[`traefik.http.routers.${router}.rule`];
  if (!rule) return null;

  const service = findLabelGroup(
    labels,
    /^traefik\.http\.services\.(.+)\.loadbalancer\.server\.port$/,
  );
  const rawPort = service
    ? labels[`traefik.http.services.${service}.loadbalancer.server.port`]
    : undefined;
  const port = Number(rawPort);
  if (!Number.isFinite(port) || port <= 0) return null;

  // TLS is what tells the two schemes apart; the entrypoint label agrees.
  const ssl = labels[`traefik.http.routers.${router}.tls.certresolver`] !== undefined
    || labels[`traefik.http.routers.${router}.entrypoints`] === 'websecure';

  return { router, rule, containerName, port, ssl };
}

function findLabelGroup(labels: Record<string, string>, pattern: RegExp): string | null {
  for (const key of Object.keys(labels)) {
    const match = pattern.exec(key);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ─── Reading the running Traefik ─────────────────────────────────────────────

export interface ProxyState {
  /** true when it routes from files, i.e. it was created by this version. */
  fileProvider: boolean;
  ssl: boolean;
  email: string | null;
}

/**
 * Reads the proxy settings out of the running Traefik's command line.
 *
 * Traefik is a single container shared by every project on the server, while
 * `proxy` is declared per project in deploy.yml. Comparing what runs against
 * what a project declares is what turns a silent mismatch into a visible one.
 */
export function parseTraefikCmd(cmd: string): ProxyState {
  const emailMatch = /--certificatesresolvers\.letsencrypt\.acme\.email=(\S+)/.exec(cmd);

  return {
    fileProvider: cmd.includes('--providers.file.directory'),
    ssl: cmd.includes('--certificatesresolvers.letsencrypt.acme'),
    email: emailMatch?.[1] ?? null,
  };
}
