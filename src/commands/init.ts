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
    log.warn('deploy.yml ya existe, no se sobreescribe');
  } else {
    const templatePath = resolve(__dirname, '../../templates/deploy.yml');
    const template = readFileSync(templatePath, 'utf-8');
    writeFileSync(configPath, template);
    log.success('deploy.yml creado');
  }

  // .deploy/secrets
  const secretsDir = resolve(cwd, '.deploy');
  const secretsPath = resolve(secretsDir, 'secrets');
  if (!existsSync(secretsDir)) mkdirSync(secretsDir);

  if (existsSync(secretsPath)) {
    log.warn('.deploy/secrets ya existe, no se sobreescribe');
  } else {
    writeFileSync(secretsPath, '# Secretos de producción (NO commitear)\n# DATABASE_URL=postgres://...\n');
    log.success('.deploy/secrets creado');
  }

  // .gitignore
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignoreEntries = ['.deploy/secrets'];

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const toAdd = gitignoreEntries.filter(e => !content.includes(e));
    if (toAdd.length > 0) {
      appendFileSync(gitignorePath, '\n# deploy\n' + toAdd.join('\n') + '\n');
      log.success('.gitignore actualizado');
    }
  } else {
    writeFileSync(gitignorePath, '# deploy\n' + gitignoreEntries.join('\n') + '\n');
    log.success('.gitignore creado');
  }

  log.banner('Proyecto listo');
  log.info('Edita deploy.yml con tu configuración');
  log.info('Agrega secretos a .deploy/secrets');
  log.info('Luego ejecuta: deploy setup && deploy deploy');
}
