import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseEnvFile(filePath: string): Record<string, string> {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return {};

  const content = readFileSync(abs, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Quitar comillas si las tiene
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

export function resolveSecrets(
  secretNames: string[],
  secretsFile: string,
): Record<string, string> {
  const allSecrets = parseEnvFile(secretsFile);
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of secretNames) {
    if (allSecrets[name] !== undefined) {
      resolved[name] = allSecrets[name];
    } else if (process.env[name] !== undefined) {
      resolved[name] = process.env[name] as string;
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Secretos faltantes: ${missing.join(', ')}\n` +
      `Agrégalos a ${secretsFile} o como variables de entorno.`
    );
  }

  return resolved;
}
