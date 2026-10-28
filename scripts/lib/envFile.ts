/**
 * Reading and writing .env.local without disturbing it: keys we don't touch, comments and order stay as they are.
 * Values are quoted so what is written is exactly what @next/env (dotenv + dotenv-expand) reads back, including
 * Windows paths (backslashes), UNC paths, passwords with # or $ and quotes.
 */

export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value; // plain: safe unquoted
  // "$" would be expanded by dotenv-expand, so it is escaped. Inside single quotes and backticks dotenv leaves
  // everything else (backslashes included) alone, which is what Windows paths need.
  const escaped = value.replace(/\$/g, "\\$");
  if (!escaped.includes("'")) return `'${escaped}'`;
  if (!escaped.includes("`")) return `\`${escaped}\``;
  throw new Error("That value has single quotes, double quotes and backticks together, which a .env file can't hold. Remove one kind.");
}

const keyLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

export function hasEnvKey(text: string, key: string): boolean {
  return text.split(/\r?\n/).some((l) => keyLine(key).test(l));
}

/** Sets key=value: replaces the first line that sets it (and drops later duplicates), or appends. */
export function setEnvValue(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let done = false;
  for (const l of lines) {
    if (keyLine(key).test(l)) {
      if (!done) out.push(`${key}=${quoteEnvValue(value)}`);
      done = true;
      continue;
    }
    out.push(l);
  }
  if (!done) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${quoteEnvValue(value)}`, "");
  }
  return out.join("\n");
}

export function removeEnvKey(text: string, key: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !keyLine(key).test(l))
    .join("\n");
}

/** Drops lines whose value is a placeholder from .env.example (<like-this>): an unset setting, not a real value. */
export function dropPlaceholders(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*[A-Z0-9_]+\s*=\s*<[^>]*>\s*$/.test(l))
    .join("\n");
}
