#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('deploy')
  .description('Deploy Docker apps to VPS via SSH')
  .version(pkg.version);

// ─── init ────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Generate deploy.yml and .deploy/secrets in the current project')
  .action(async () => {
    const { init } = await import('./commands/init.js');
    await init();
  });

// ─── setup ───────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Prepare the VPS: Docker, firewall, Traefik')
  .action(async () => {
    const { setup } = await import('./commands/setup.js');
    await setup();
  });

// ─── deploy ──────────────────────────────────────────────────────────────────
program
  .command('deploy')
  .description('Build and deploy to the VPS')
  .option('-s, --service <name>', 'Deploy a single service only')
  .action(async (opts) => {
    const { deploy } = await import('./commands/deploy.js');
    await deploy(opts);
  });

// ─── unlock ──────────────────────────────────────────────────────────────────
program
  .command('unlock')
  .description('Release the lock left by an interrupted deploy')
  .action(async () => {
    const { unlock } = await import('./commands/unlock.js');
    await unlock();
  });

// ─── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show the state of the services on the VPS')
  .action(async () => {
    const { status } = await import('./commands/status.js');
    await status();
  });

// ─── logs ────────────────────────────────────────────────────────────────────
program
  .command('logs <service>')
  .description('Stream a service logs')
  .option('-n, --lines <number>', 'Number of lines', '100')
  .action(async (service, opts) => {
    const { logs } = await import('./commands/logs.js');
    await logs(service, opts);
  });

// ─── rollback ────────────────────────────────────────────────────────────────
program
  .command('rollback <service>')
  .description('Roll a service back to its previous version')
  .action(async (service) => {
    const { rollback } = await import('./commands/rollback.js');
    await rollback(service);
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n\x1b[31m✗\x1b[0m ${message}\n`);
  process.exit(1);
});
