/**
 * Quoting for commands sent over SSH to a remote POSIX shell.
 *
 * Anything coming from deploy.yml or .deploy/secrets is untrusted input as far
 * as the shell is concerned: users don't write payloads on purpose, but a
 * password containing a single quote, a `$` or a `;` is enough to break the
 * command or to run something other than what was intended — and these commands
 * run under `sudo` on the server. Nothing is interpolated raw.
 */

/**
 * Wraps a value in single quotes for the shell.
 *
 * Inside '...' the shell interprets nothing except the single quote itself,
 * which cannot be escaped: you have to close, insert a literal quote and reopen.
 * `it's` becomes `'it'\''s'`.
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/**
 * Joins command fragments, skipping empty ones so an optional flag that doesn't
 * apply doesn't leave double spaces in the final command.
 */
export function shJoin(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part && part.length > 0).join(' ');
}

/**
 * `-e K=V` flags for `docker run`, with key and value quoted.
 *
 * Note: this leaves values visible in `ps aux` and in the server's sudo log. Use
 * it only for non-sensitive values; secrets go through an env file (see
 * withSecretsFile in docker.ts).
 */
export function envFlags(vars: Record<string, string>): string {
  return shJoin(
    Object.entries(vars).map(([key, value]) => `-e ${shQuote(`${key}=${value}`)}`),
  );
}

/**
 * Serializes variables into the format `docker run --env-file` expects.
 *
 * Docker's env-file parser is NOT a shell: it doesn't interpret quotes or
 * escapes, and takes the whole line after the first `=` as a literal value. That
 * is why nothing is quoted here — quoting would put the quotes inside the value.
 *
 * A value containing a newline cannot be represented in this format, so it is
 * rejected rather than silently truncated.
 */
export function toEnvFile(vars: Record<string, string>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    if (value.includes('\n')) {
      throw new Error(
        `The value of ${key} contains a newline, which cannot be passed through ` +
        `a Docker env file. Encode it (base64, for example) and decode it inside ` +
        `the container.`,
      );
    }
    lines.push(`${key}=${value}`);
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
