# deploy

Deploy Docker apps to any VPS over SSH. No registry, no agents on the server.

> **Status: alpha.** It works, but it has been exercised on very few servers and
> is not published to npm yet. Read [Security](#security) before putting it in
> front of production traffic.

Inspired by [Kamal](https://kamal-deploy.org/), but written in Node.js: no Ruby
dependency and no image registry required.

## How it works

```
Your laptop                          VPS
───────────                          ───
deploy deploy
  │
  ├── Read deploy.yml + .deploy/secrets
  ├── rsync the code to the server
  ├── docker build (on the server)
  ├── Start the new container, UNROUTED
  ├── Health check against the new container ✓
  ├── Rewrite the Traefik route ─────────────▶ New container
  ├── Retire the previous container
  └── Done
```

- **Over SSH** — no agents, no daemons on the server. Just Docker and SSH.
- **No downtime** — the new container gets no traffic until it answers the health
  check. If it never does, the old one keeps serving and the candidate is thrown
  away.
- **Automatic SSL** — Traefik handles Let's Encrypt certificates.
- **One version at a time** — every deploy creates a container tagged with the
  commit SHA, and the route points at exactly one: traffic is never split across
  two different versions.

## Install

Not on npm yet (the name `deploy` belongs to another package), so install from
the repository:

```bash
git clone https://github.com/AlexParco/deploy
cd deploy
pnpm install && pnpm build
npm link          # puts the `deploy` command on your PATH
```

Requirements: Node.js >= 20, `rsync`, SSH access to the VPS, and Docker on the
VPS (`deploy setup` installs it if missing).

## Getting started

```bash
# 1. Initialize the configuration in your project
cd my-project
deploy init

# 2. Edit deploy.yml with your server and services
# 3. Add your secrets to .deploy/secrets

# 4. Prepare the VPS (once)
deploy setup

# 5. Deploy
deploy deploy
```

## Configuration

### deploy.yml

```yaml
project: my-app

server:
  host: ${SERVER_HOST}     # Resolved from .deploy/secrets or the environment
  user: deploy
  port: ${SERVER_PORT}

services:
  web:
    build: .
    dockerfile: Dockerfile
    port: 3000
    domain: myapp.com
    healthcheck: /health
    startup_timeout: 60        # Seconds allowed to become healthy
    volumes:
      - uploads:/app/uploads   # Survives every deploy
    env:
      clear:
        NODE_ENV: production
      secret:
        - DATABASE_URL

accessories:
  db:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
    env:
      secret:
        - POSTGRES_PASSWORD

proxy:
  ssl: true
  email: you@example.com
```

### How services reach each other

Every container shares one Docker network and resolves by name. An accessory is
named `<project>-<name>`, so from `web` the example database is `my-app-db`:

```bash
DATABASE_URL=postgres://user:pass@my-app-db:5432/myapp
```

Publishing the accessory's port is not needed for this.

### Volumes

Services are recreated on every deploy, so **anything written outside a volume
is lost**. Volumes are declared as `name:/path` and are prefixed with the service
(`uploads:/app/uploads` becomes the volume `my-app-web-uploads`). The name
carries no SHA, precisely so it survives recreation.

Only named volumes are supported, not host paths.

### .deploy/secrets

```bash
# Never committed: `deploy init` adds it to .gitignore
SERVER_HOST=143.xx.xx.xx
SERVER_PORT=2222
DATABASE_URL=postgres://user:pass@my-app-db:5432/myapp
POSTGRES_PASSWORD=supersecret
```

Any `${VARIABLE}` in `deploy.yml` is resolved from `.deploy/secrets` first, then
from environment variables.

## Commands

```bash
deploy init                    # Generate deploy.yml and .deploy/secrets
deploy setup                   # Prepare the VPS and apply the proxy settings
deploy deploy                  # Build and deploy every service
deploy deploy --service api    # Deploy a single service
deploy status                  # Running containers
deploy logs <service>          # Stream logs (Ctrl+C to exit)
deploy logs <service> -n 50    # Last 50 lines
deploy rollback <service>      # Go back to the previous version
deploy unlock                  # Release the lock of an interrupted deploy
```

## The deploy, step by step

1. Warn about uncommitted changes (see [Traceability](#traceability)).
2. Acquire the project lock, atomically.
3. `rsync` the project to `/opt/deploy/<project>` on the VPS.
4. `docker build`, tagging the image with the commit SHA.
5. Start container `<project>-<service>-<sha>`, **with no route assigned**.
6. Probe the health check from a throwaway container on the same network.
7. If it answers: rewrite the Traefik route to point at the new container.
8. Retire the containers of previous versions of that service.
9. Clean up old images, keeping the last 3 **per service** and never deleting the
   one in use.
10. Release the lock.

If step 6 fails, step 7 is never reached: the route still points at the previous
container, which never stopped serving, and the broken candidate is removed. The
error includes the container's last log lines.

## Architecture

```
┌──────────┐         ┌──────────────────────────────────────┐
│ laptop   │         │ VPS                                  │
│          │         │                                      │
│  deploy  │──SSH──▶ │  Traefik (:80/:443)                  │
│          │         │    │  reads /opt/deploy/.traefik/     │
│          │         │    │  dynamic/*.yml                   │
│          │         │    ├── myapp.com     → web-<sha>:3000 │
│          │         │    └── api.myapp.com → api-<sha>:3001 │
│          │         │                                      │
│          │         │  Accessories (no public port)        │
│          │         │    └── my-app-db:5432                │
└──────────┘         └──────────────────────────────────────┘
```

Routing lives in YAML files written by the CLI and watched by Traefik, not in
Docker labels. A container's labels are immutable from creation, so with labels
the new container would publish its route before being healthy — there would be
no moment at which to "switch" traffic. As a side effect, Traefik no longer needs
access to the Docker socket.

## The proxy is shared by the whole server

There is one Traefik container per server, shared by every project, but `proxy`
is declared in each project's `deploy.yml`. To keep that from being silently
inconsistent, the two commands have different jobs:

- **`deploy setup` owns Traefik.** It creates or reconfigures it to match the
  `proxy` block of the project you run it from. Since that affects every project
  on the machine, it only ever happens when you ask for it.
- **`deploy deploy` never touches Traefik.** It compares what is running against
  what your project declares. A different `email` is a warning; a different `ssl`
  is an error, because the project would not serve traffic either way.

So if two projects on the same server declare different `proxy.email`, you will
be told, instead of one of them quietly winning.

## Migrating from a label-based setup

Earlier versions routed through Docker labels. A server set up that way needs one
`deploy setup` before anything else:

```bash
cd any-project-on-that-server
deploy setup
```

It carries the existing routes over first — reading the Traefik labels off the
running containers and writing them out as route files — and only then recreates
Traefik. The new proxy therefore starts already serving everything that was up,
still pointing at the containers that were already running. Each project moves
to the new scheme the next time you deploy it.

Two things to know:

- The `proxy` settings applied are those of the project you ran `setup` from. If
  the server hosts projects with different `proxy.email`, pick the canonical one
  and align the others; the rest will warn until you do.
- The containers of the old scheme are not removed automatically: they lack the
  identity labels this version filters by. After deploying a project, its old
  container keeps running unrouted, and you can remove it by name:
  ```bash
  docker rm -f <project>-<service>
  ```
  Worth doing promptly for any service with a volume, so two containers do not
  hold the same data files open.

## Accessories

Infrastructure containers (databases, caches) pulled from a registry instead of
being built.

- If it does not exist, it is created. If it exists but is stopped, it is started.
- If you change the image, the volumes or the secrets in `deploy.yml`, it is
  recreated and you are told. Named volumes are untouched, so the data stays.
- **Ports are not published to the internet.** Declaring `port: "5432:5432"`
  binds it to `127.0.0.1`. To reach it from outside, use an SSH tunnel:
  ```bash
  ssh -L 5432:127.0.0.1:5432 user@server
  ```
  Writing `0.0.0.0:5432:5432` explicitly is honored, but the deploy warns you
  that it is exposed.

## Traceability

Every image is tagged with the short commit SHA. But `rsync` uploads the
**working tree**, not the commit: with uncommitted changes the image carries a
SHA that does not reflect its contents, and rebuilding overwrites the previous
image under the same tag (losing that rollback point). The deploy warns when this
happens.

For the SHA to mean anything, deploy from a clean tree.

## Security

What it does:

- Secrets **never go through the command line**. They are written to a temporary
  file on the server with 0600 permissions from creation (`umask 077`), passed
  with `docker run --env-file`, and deleted afterwards. The contents travel over
  the SSH channel's stdin, never through `argv`.
- Every value that reaches a remote command is shell-escaped. A password
  containing `'`, `$` or `;` cannot break the command or run something else.
- Accessory ports are bound to the loopback unless explicitly requested
  otherwise.
- Traefik does **not** mount the Docker socket (a container with that socket is
  equivalent to root on the host).
- The deploy lock is acquired atomically (`set -C`), per project.
- Project and service names are validated (`a-z`, `0-9`, `-`).

What it does **not** do, and you should know:

- Docker stores environment variables in the container's configuration
  (`/var/lib/docker/containers/<id>/config.v2.json`), readable by root on the
  server. That is inherent to Docker env vars: the above closes the exposure to
  unprivileged users and to the `sudo` log, not to the VPS root.
- Every project shares the `deploy-proxy` network, so a container can reach
  containers of another project on the same server.
- `deploy setup` installs Docker with `curl | sh` from get.docker.com.
- The firewall `setup` configures (ufw) does **not** filter the ports Docker
  publishes, because Docker writes its rules first in the `nat` chain. That is
  why accessories are bound to the loopback instead of trusting the firewall.
- Secrets are stored in cleartext in `.deploy/secrets` on your machine.

## Requirements

**Your machine:** Node.js >= 20, `rsync`, an SSH key for the VPS.
**The VPS:** any Linux with SSH, ports 80 and 443 open, and Docker (installed by
`deploy setup`).

## Development

```bash
pnpm install
pnpm test         # compiles and runs the tests
pnpm typecheck    # type-checks src and test
```

## License

MIT
