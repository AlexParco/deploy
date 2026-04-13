# deploy

Deploy Docker apps to any VPS via SSH. Zero downtime, zero complexity.

Inspired by [Kamal](https://kamal-deploy.org/) — but built with Node.js, no Ruby dependency, no Docker registry required.

## How it works

```
Your laptop                          VPS
──────────                          ────
deploy deploy
  │
  ├── Read deploy.yml + secrets
  ├── rsync code to server
  ├── docker build (on server)
  ├── Start new container
  ├── Health check passes ✓
  ├── Traefik routes traffic ──────▶ New container
  ├── Stop old container
  └── Done
```

- **SSH-based** — no agents, no daemons on the server. Just Docker and SSH.
- **Zero downtime** — new container starts and passes health check before traffic switches.
- **Auto SSL** — Traefik handles Let's Encrypt certificates automatically.
- **Git SHA tags** — every deploy is tagged with the commit hash for traceability.

## Install

```bash
npm install -g deploy
```

Requires: Node.js >= 20, Docker on the VPS, SSH access.

## Quick start

```bash
# 1. Initialize config in your project
cd my-project
deploy init

# 2. Edit deploy.yml with your server and services
# 3. Add secrets to .deploy/secrets

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
  host: ${SERVER_HOST}     # Resolved from .deploy/secrets or env vars
  user: deploy
  port: ${SERVER_PORT}

services:
  web:
    build: .
    dockerfile: Dockerfile
    port: 3000
    domain: myapp.com
    healthcheck: /health
    env:
      clear:
        NODE_ENV: production
      secret:
        - DATABASE_URL

  api:
    build: ./api
    dockerfile: Dockerfile
    port: 3001
    domain: api.myapp.com
    healthcheck: /api/health
    env:
      clear:
        NODE_ENV: production
      secret:
        - DATABASE_URL
        - API_KEY

accessories:
  db:
    image: postgres:16
    port: "5432:5432"
    volumes:
      - data:/var/lib/postgresql/data
    env:
      secret:
        - POSTGRES_PASSWORD

proxy:
  ssl: true
  email: you@example.com
```

### .deploy/secrets

```bash
# Not committed to git
SERVER_HOST=143.xx.xx.xx
SERVER_PORT=2222
DATABASE_URL=postgres://user:pass@db:5432/myapp
API_KEY=sk_live_xxxxx
POSTGRES_PASSWORD=supersecret
```

### Variable interpolation

Any `${VARIABLE}` in `deploy.yml` is resolved from `.deploy/secrets` first, then from environment variables:

```yaml
server:
  host: ${SERVER_HOST}    # Resolved at runtime, not stored in git
```

## Commands

```bash
deploy init                    # Generate deploy.yml and .deploy/secrets
deploy setup                   # Prepare VPS: Docker, firewall, Traefik
deploy deploy                  # Build and deploy all services
deploy deploy --service api    # Deploy only one service
deploy deploy --force          # Ignore deploy lock
deploy status                  # Show running containers
deploy logs <service>          # Stream logs (Ctrl+C to exit)
deploy logs <service> -n 50    # Last 50 lines
deploy rollback <service>      # Rollback to previous version
```

## Deploy flow

```
1. Read deploy.yml + .deploy/secrets
2. Acquire deploy lock (prevents concurrent deploys)
3. rsync project to /opt/deploy/<project> on the VPS
4. docker build with git SHA tag
5. Start new container with Traefik labels
6. Wait for health check to pass
7. Traefik routes traffic to new container
8. Stop and remove old container
9. Clean up old images (keeps last 3)
10. Release deploy lock
```

## Architecture

```
┌──────────┐         ┌─────────────────────────────────┐
│ laptop   │         │ VPS                              │
│          │         │                                  │
│  deploy  │──SSH──▶ │  Traefik (:80/:443)             │
│          │         │    ├── myapp.com → web:3000      │
│          │         │    └── api.myapp.com → api:3001  │
│          │         │                                  │
│          │         │  Accessories                     │
│          │         │    └── postgres:5432             │
└──────────┘         └─────────────────────────────────┘
```

- **Traefik** — reverse proxy with automatic SSL (Let's Encrypt)
- **Services** — your app containers, built from Dockerfiles
- **Accessories** — infrastructure containers (databases, caches), pulled from registries

## Requirements

### Your machine
- Node.js >= 20
- SSH key access to the VPS
- rsync

### VPS
- Any Linux server with SSH
- Docker (installed by `deploy setup`)
- Ports 80 and 443 open

## Security

- Secrets are stored in `.deploy/secrets` (gitignored, never committed)
- Secrets are injected as Docker env vars at deploy time — not stored on disk on the server
- SSH key authentication only (password auth should be disabled)
- All Docker commands run via `sudo` on the server
- Project and service names are validated (`a-z`, `0-9`, `-` only)

## License

MIT
