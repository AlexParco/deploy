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
  .description('Genera deploy.yml y .deploy/secrets en el proyecto actual')
  .action(async () => {
    const { init } = await import('./commands/init.js');
    await init();
  });

// ─── setup ───────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Prepara el VPS: Docker, firewall, Traefik')
  .action(async () => {
    const { setup } = await import('./commands/setup.js');
    await setup();
  });

// ─── deploy ──────────────────────────────────────────────────────────────────
program
  .command('deploy')
  .description('Build y deploy al VPS')
  .option('-s, --service <name>', 'Desplegar solo un servicio')
  .option('--force', 'Forzar deploy (ignora lock)')
  .action(async (opts) => {
    const { deploy } = await import('./commands/deploy.js');
    await deploy(opts);
  });

// ─── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Estado de los servicios en el VPS')
  .action(async () => {
    const { status } = await import('./commands/status.js');
    await status();
  });

// ─── logs ────────────────────────────────────────────────────────────────────
program
  .command('logs <service>')
  .description('Ver logs de un servicio')
  .option('-n, --lines <number>', 'Número de líneas', '100')
  .action(async (service, opts) => {
    const { logs } = await import('./commands/logs.js');
    await logs(service, opts);
  });

// ─── rollback ────────────────────────────────────────────────────────────────
program
  .command('rollback <service>')
  .description('Rollback un servicio a la versión anterior')
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
