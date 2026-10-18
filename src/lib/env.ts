/**
 * Reads an environment variable under its current name, falling back to a
 * deprecated former name (printing a one-line warning, once per name) so a
 * renamed variable doesn't silently break a `.env.local` someone hasn't
 * updated yet.
 */

const warned = new Set<string>();

export function envWithFallback(name: string, deprecatedName: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined) return current;

  const legacy = process.env[deprecatedName];
  if (legacy !== undefined && !warned.has(deprecatedName)) {
    warned.add(deprecatedName);
    console.warn(`[env] ${deprecatedName} is deprecated; rename it to ${name} in .env.local.`);
  }
  return legacy;
}

/** Test-only: lets a test see its own deprecation warning again. */
export function _resetEnvWarningsForTests(): void {
  warned.clear();
}
