/**
 * Validates an uploaded file before it touches disk or the extractor.
 * Checked in this order because each is cheaper than the next: size first
 * (free, from the buffer length), then the magic bytes (read 5 bytes),
 * never the extension or declared content-type -- a renamed .exe is still
 * a PDF or it isn't, regardless of what it's called.
 */

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export type UploadValidationResult = { ok: true } | { ok: false; error: string };

export function validateUploadBytes(bytes: Buffer, maxBytes: number): UploadValidationResult {
  if (bytes.length === 0) {
    return { ok: false, error: "The file is empty" };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      error: `The file is ${formatBytes(bytes.length)}, over the ${formatBytes(maxBytes)} limit`,
    };
  }
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, error: "Not a PDF file (its content doesn't start with a PDF header)" };
  }
  return { ok: true };
}

/**
 * A safe display name, independent of validateUploadBytes: the original
 * filename is shown in the UI and stored in the database, but never used
 * to build a filesystem path (storage.ts is content-addressed instead), so
 * this only needs to keep it short and strip control characters -- not
 * defend against traversal, since it's never a path.
 */
export function sanitizeOriginalFilename(name: string): string {
  const stripped = name.replace(/[\u0000-\u001f]/g, "").trim();
  const base = stripped.length > 0 ? stripped : "document.pdf";
  return base.length > 200 ? base.slice(0, 200) : base;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
