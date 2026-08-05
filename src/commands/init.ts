import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function init() {
  const cwd = process.cwd();

  // deploy.yml
  const configPath = resolve(cwd, 'deploy.yml');
  if (existsSync(configPath)) {
    log.warn('deploy.yml already exists, leaving it alone');
  } else {
    const templatePath = resolve(__dirname, '../../templates/deploy.yml');
    const template = readFileSync(templatePath, 'utf-8');
    writeFileSync(configPath, template);
    log.success('deploy.yml created');
  }

  // .deploy/secrets
  const secretsDir = resolve(cwd, '.deploy');
  const secretsPath = resolve(secretsDir, 'secrets');
  if (!existsSync(secretsDir)) mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  if (existsSync(secretsPath)) {
    log.warn('.deploy/secrets already exists, leaving it alone');
  } else {
    // 0600: the default would be 0644, readable by any user on the machine.
    writeFileSync(
      secretsPath,
      '# Production secrets (DO NOT commit)\n# DATABASE_URL=postgres://...\n',
      { mode: 0o600 },
    );
    log.success('.deploy/secrets created (readable only by you)');
  }

  // .gitignore
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignoreEntries = ['.deploy/secrets'];

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const toAdd = gitignoreEntries.filter(e => !content.includes(e));
    if (toAdd.length > 0) {
      appendFileSync(gitignorePath, '\n# deploy\n' + toAdd.join('\n') + '\n');
      log.success('.gitignore updated');
    }
  } else {
    writeFileSync(gitignorePath, '# deploy\n' + gitignoreEntries.join('\n') + '\n');
    log.success('.gitignore created');
  }

  log.banner('Project ready');
  log.info('Edit deploy.yml with your configuration');
  log.info('Add your secrets to .deploy/secrets');
  log.info('Then run: deploy setup && deploy deploy');
}
