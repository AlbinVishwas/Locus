/**
 * The error catalog: every problem a person can run into, in one place. Each entry has a stable code (quote it
 * when asking for help), a short title, a plain-English message and what to do about it. Pages, banners and API
 * responses all read from here, so the wording is the same everywhere. Messages never contain secrets, paths of
 * other people's files or stack traces; full details go to the server log only (see redact in ./redact.ts).
 */

export type ErrorCode =
  | "LOCUS-AUTH-001"
  | "LOCUS-AUTH-002"
  | "LOCUS-NOTFOUND-001"
  | "LOCUS-SERVER-001"
  | "LOCUS-SERVER-002"
  | "LOCUS-SERVER-003"
  | "LOCUS-SERVER-004"
  | "LOCUS-SERVER-005"
  | "LOCUS-DISK-001"
  | "LOCUS-DISK-002"
  | "LOCUS-DISK-003"
  | "LOCUS-INDEX-001"
  | "LOCUS-INDEX-002"
  | "LOCUS-UPLOAD-001"
  | "LOCUS-UPLOAD-002"
  | "LOCUS-TOOL-001"
  | "LOCUS-TOOL-002"
  | "LOCUS-APP-001"
  | "LOCUS-APP-002";

export interface CatalogEntry {
  title: string;
  /** What happened, in plain English. */
  message: string;
  /** What the person can do. */
  action: string;
  /** The HTTP status an API answers with. */
  status: number;
}

export const ERRORS: Record<ErrorCode, CatalogEntry> = {
  "LOCUS-AUTH-001": {
    title: "Please sign in",
    message: "You need to sign in to use this page.",
    action: "Sign in, then try again.",
    status: 401,
  },
  "LOCUS-AUTH-002": {
    title: "No access",
    message: "Your account doesn't have access to this.",
    action: "Ask the administrator if you need it.",
    status: 403,
  },
  "LOCUS-NOTFOUND-001": {
    title: "Page not found",
    message: "That page or file doesn't exist, or it was moved.",
    action: "Go back to search and try again.",
    status: 404,
  },
  "LOCUS-SERVER-001": {
    title: "Can't reach the storage server",
    message: "Locus couldn't connect to the storage server. Search still works on everything already indexed.",
    action: "Check that the server is on and reachable from this computer (VPN, network share mounted, correct address), then press Test connection on the Server page.",
    status: 503,
  },
  "LOCUS-SERVER-002": {
    title: "The storage server refused the login",
    message: "The server answered, but it didn't accept the access key and secret (or the account has no read access).",
    action: "Check LOCUS_SERVER_S3_ACCESS_KEY and LOCUS_SERVER_S3_SECRET_KEY in .env.local, and that the account can read the bucket. Then restart Locus.",
    status: 503,
  },
  "LOCUS-SERVER-003": {
    title: "The storage server isn't set up correctly",
    message: "The server settings in .env.local are missing or don't make sense.",
    action: "Run `npm run setup` again, or fix the LOCUS_SERVER_* settings in .env.local (see .env.example), then restart Locus.",
    status: 503,
  },
  "LOCUS-SERVER-004": {
    title: "That file is no longer on the server",
    message: "The file was moved, renamed or deleted on the storage server after it was indexed.",
    action: "Press Rescan now on the Server page to bring the index up to date.",
    status: 404,
  },
  "LOCUS-SERVER-005": {
    title: "The storage server is too slow to answer",
    message: "The server didn't answer in time. Locus will retry on its own.",
    action: "If it keeps happening, check the network connection to the server.",
    status: 504,
  },
  "LOCUS-DISK-001": {
    title: "Not enough disk space to build the index",
    message: "The index for everything on the server won't fit on this computer's disk.",
    action: "Free up space, choose a disk with more room by setting LOCUS_DATA_DIR, or index fewer folders (set LOCUS_SERVER_PATH or LOCUS_SERVER_S3_PREFIX to a smaller folder).",
    status: 507,
  },
  "LOCUS-DISK-002": {
    title: "Indexing paused: low disk space",
    message: "The disk is almost full, so indexing paused. Everything already indexed is still searchable, and indexing resumes by itself when there is room.",
    action: "Free up disk space, or point LOCUS_DATA_DIR at a disk with more room.",
    status: 507,
  },
  "LOCUS-DISK-003": {
    title: "Not enough disk space for this upload",
    message: "There isn't enough free disk space to take this upload safely.",
    action: "Free up disk space on this computer, or upload less.",
    status: 507,
  },
  "LOCUS-INDEX-001": {
    title: "The index is still being built",
    message: "Locus is still reading the server's PDFs. You can search what's done so far; results will grow as it continues.",
    action: "Check progress on the Server page.",
    status: 503,
  },
  "LOCUS-INDEX-002": {
    title: "Nothing is indexed yet",
    message: "There is no search index yet.",
    action: "Connect a storage server on the Server page (or upload files), then wait for the first files to be indexed.",
    status: 503,
  },
  "LOCUS-UPLOAD-001": {
    title: "Upload limit reached",
    message: "This upload would go over your account's upload limit.",
    action: "Remove some of your files first, or ask the administrator to raise the limit.",
    status: 507,
  },
  "LOCUS-UPLOAD-002": {
    title: "Storage is full",
    message: "The total storage limit for uploads and the index has been reached.",
    action: "Remove old files or conversations, or ask the administrator to raise STORAGE_CAP_BYTES.",
    status: 507,
  },
  "LOCUS-TOOL-001": {
    title: "OCR isn't installed",
    message: "tesseract isn't installed, so scanned pages are skipped. PDFs with a text layer work normally.",
    action: "Install tesseract with English and Hindi data (run `npm run doctor` for the exact command), then restart Locus.",
    status: 200,
  },
  "LOCUS-TOOL-002": {
    title: "PDF tools are missing",
    message: "poppler (pdftotext, pdftoppm) isn't installed, so PDFs can't be read.",
    action: "Install poppler (run `npm run doctor` for the exact command), then restart Locus.",
    status: 503,
  },
  "LOCUS-APP-001": {
    title: "Something went wrong",
    message: "Locus hit an unexpected problem. It has been logged on the server.",
    action: "Try again. If it keeps happening, quote the reference below to the administrator.",
    status: 500,
  },
  "LOCUS-APP-002": {
    title: "Locus is under maintenance",
    message: "Locus is being updated or restarted and will be back shortly.",
    action: "Try again in a few minutes.",
    status: 503,
  },
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERRORS, code);
}

/** The JSON body an API route answers with: a code and a message, never a stack trace. */
export function errorBody(code: ErrorCode, detail?: string): { code: ErrorCode; message: string; action: string; detail?: string } {
  const e = ERRORS[code];
  return { code, message: e.message, action: e.action, ...(detail ? { detail } : {}) };
}

export function errorResponse(code: ErrorCode, detail?: string, headers?: HeadersInit): Response {
  return Response.json(errorBody(code, detail), { status: ERRORS[code].status, headers: { "Cache-Control": "no-store", ...(headers as Record<string, string> | undefined) } });
}

/** A message with its code in front, for places that only have a string (a source's error line). */
export function withCode(code: ErrorCode, detail?: string): string {
  return `${code}: ${ERRORS[code].title}.${detail ? ` ${detail}` : ""}`;
}

/** Finds a catalog code at the start of a message made with withCode. */
export function codeOf(message: string | null | undefined): ErrorCode | null {
  const m = message?.match(/^(LOCUS-[A-Z]+-\d{3}):/);
  return m && isErrorCode(m[1]) ? m[1] : null;
}
