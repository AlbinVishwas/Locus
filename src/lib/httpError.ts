/**
 * The text to show for a failed response: the {code, message, action} JSON the API's catalog errors send
 * (src/lib/errors/catalog.ts), or the plain text older routes send.
 */
export async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return res.statusText;
  try {
    const body = JSON.parse(raw) as { code?: string; message?: string; action?: string; detail?: string; error?: string };
    if (typeof body.message === "string") {
      return [body.detail ?? body.message, body.detail ? null : body.action, body.code ? `(${body.code})` : null].filter(Boolean).join(" ");
    }
    if (typeof body.error === "string") return body.error;
  } catch {
    // plain text
  }
  return raw;
}
