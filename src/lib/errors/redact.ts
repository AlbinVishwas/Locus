/**
 * Keeps secrets out of logs and messages. Anything that looks like a credential is replaced, and so is the
 * literal value of every secret setting in the environment, whatever it looks like.
 */

const SECRET_ENV = ["LOCUS_SERVER_S3_ACCESS_KEY", "LOCUS_SERVER_S3_SECRET_KEY", "SESSION_SECRET", "LOCUS_SECRETS_KEY", "LOCUS_ADMIN_PASSCODE", "LOCUS_PASSCODE", "GOOGLE_API_KEY"];

export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(AKIA|ASIA)[0-9A-Z]{12,}/g, "[redacted]")
    .replace(/(secret|password|passcode|token|api[_-]?key|authorization)(["'\s]*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/X-Amz-(Signature|Credential|Security-Token)=[^&\s]+/gi, "X-Amz-$1=[redacted]");
}

/** What goes to the server log for an error: the message and the code, secrets removed. Never sent to a browser. */
export function logError(scope: string, err: unknown, extra?: Record<string, unknown>): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack.split("\n").slice(1, 6).join("\n")}` : "";
  console.error(redact(`[${scope}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}${stack}`));
}
