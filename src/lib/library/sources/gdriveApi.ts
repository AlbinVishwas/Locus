import { setTimeout as delay } from "node:timers/promises";

/**
 * A small Google Drive API v3 client for public ("anyone with the link")
 * folders, using an API key (GOOGLE_API_KEY in .env.local). No sign-in, no
 * private folders.
 *
 * Rate limits are handled here, once, for the whole source: a 429, a 5xx, or
 * a 403 whose reason is a rate limit makes every request wait out the same
 * exponential backoff (with jitter, honouring Retry-After), so the limit
 * slows the source down instead of each file hammering it. A daily quota
 * running out is not retried -- it's reported, and the next rescan tries
 * again. Every failure becomes an error with a plain-language message.
 */

export type DriveErrorCode =
  | "no-key"
  | "bad-key"
  | "api-disabled"
  | "not-found"
  | "not-shared"
  | "rate-limited"
  | "daily-limit"
  | "network"
  | "server";

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const DEFAULT_DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * GOOGLE_DRIVE_API_BASE exists so tests can stand in for Google; it is honoured
 * ONLY for a loopback address, so it can never point the server at a real
 * internal host.
 */
export function driveApiBase(env: Record<string, string | undefined> = process.env): string {
  const raw = env.GOOGLE_DRIVE_API_BASE?.trim();
  if (!raw) return DEFAULT_DRIVE_BASE;
  try {
    const u = new URL(raw);
    if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) return raw.replace(/\/$/, "");
  } catch {
    // ignore
  }
  return DEFAULT_DRIVE_BASE;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

export interface DriveApiOptions {
  apiKey: string | undefined;
  base?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxTries?: number;
  /** Requests in flight at once. */
  concurrency?: number;
}

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "quotaExceeded"]);

export class DriveApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxTries: number;
  private blockedUntil = 0;
  private active = 0;
  private waiting: Array<() => void> = [];
  /** How many times a request had to back off (for tests and the status line). */
  backoffs = 0;

  constructor(private readonly o: DriveApiOptions) {
    this.base = o.base ?? driveApiBase();
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }).catch(() => {}));
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
    this.maxTries = o.maxTries ?? 8;
  }

  private async acquire(): Promise<void> {
    const limit = this.o.concurrency ?? 4;
    if (this.active >= limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private url(pathname: string, params: Record<string, string>): string {
    const q = new URLSearchParams({ ...params, key: this.o.apiKey ?? "" });
    return `${this.base}${pathname}?${q.toString()}`;
  }

  /** One request with backoff. Returns the successful Response (body unread). */
  private async request(pathname: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    if (!this.o.apiKey) throw new DriveError("no-key", "Google Drive isn't set up on this server (GOOGLE_API_KEY is missing).");
    await this.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        // Everyone waits out a backoff that any request triggered.
        const wait = this.blockedUntil - this.now();
        if (wait > 0) await this.sleep(wait, signal);
        if (signal?.aborted) throw new DriveError("network", "Cancelled.");

        let res: Response;
        try {
          res = await this.fetchImpl(this.url(pathname, params), { signal });
        } catch (err) {
          if (signal?.aborted) throw new DriveError("network", "Cancelled.");
          if (attempt + 1 >= this.maxTries) {
            throw new DriveError("network", `Couldn't reach Google Drive (${err instanceof Error ? err.message : String(err)}).`);
          }
          this.backoff(attempt, null);
          continue;
        }
        if (res.ok) return res;

        const reason = await errorReason(res);
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && RATE_REASONS.has(reason));
        if (res.status === 403 && reason === "dailyLimitExceeded") {
          throw new DriveError("daily-limit", "Google Drive's daily limit was reached. It will try again at the next rescan.");
        }
        if (retryable) {
          if (attempt + 1 >= this.maxTries) {
            throw new DriveError(
              res.status >= 500 ? "server" : "rate-limited",
              res.status >= 500 ? "Google Drive is having trouble right now. Try again later." : "Google is limiting requests right now; try again in a minute."
            );
          }
          this.backoff(attempt, res.headers.get("retry-after"));
          continue;
        }
        throw classify(res.status, reason);
      }
    } finally {
      this.release();
    }
  }

  /** Closes the gate for a while. The waiting itself happens at the top of the request loop, for every request alike. */
  private backoff(attempt: number, retryAfter: string | null): void {
    this.backoffs++;
    const fromHeader = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
    const exponential = Math.min(300_000, 1000 * 2 ** attempt) + Math.floor(this.random() * 1000);
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(fromHeader, exponential));
  }

  async getFolder(folderId: string, signal?: AbortSignal): Promise<DriveFile> {
    const res = await this.request(`/files/${encodeURIComponent(folderId)}`, { fields: "id,name,mimeType", supportsAllDrives: "true" }, signal);
    const file = (await res.json()) as DriveFile;
    if (file.mimeType !== FOLDER_MIME) throw new DriveError("not-found", "That link is to a file, not a folder.");
    return file;
  }

  /** One page of a folder's children. */
  async listChildren(folderId: string, pageToken?: string, signal?: AbortSignal): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const params: Record<string, string> = {
      q: `'${folderId.replace(/['\\]/g, "")}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      orderBy: "name",
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await this.request("/files", params, signal);
    return (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
  }

  /** The file's bytes, as a stream. */
  async download(fileId: string, signal?: AbortSignal): Promise<Response> {
    return this.request(`/files/${encodeURIComponent(fileId)}`, { alt: "media", supportsAllDrives: "true" }, signal);
  }
}

async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string } };
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  } catch {
    return "";
  }
}

function classify(status: number, reason: string): DriveError {
  if (status === 400 && /key/i.test(reason)) return new DriveError("bad-key", "Google didn't accept GOOGLE_API_KEY. Check the key in .env.local.");
  if (status === 400 && reason === "badRequest") return new DriveError("not-found", "That doesn't look like a valid Google Drive folder.");
  if (status === 403 && (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED")) {
    return new DriveError("api-disabled", "The Google Drive API isn't turned on for this API key (enable it in Google Cloud Console).");
  }
  if (status === 403 && /key|ipRefererBlocked|API_KEY/i.test(reason)) {
    return new DriveError("bad-key", "Google didn't accept GOOGLE_API_KEY. Check the key and its restrictions.");
  }
  if (status === 403 || status === 401) {
    return new DriveError("not-shared", "This folder isn't shared with anyone-with-the-link. Private folders aren't supported yet.");
  }
  if (status === 404) {
    return new DriveError("not-shared", "Google Drive can't find that folder, or it isn't shared with anyone-with-the-link. Private folders aren't supported yet.");
  }
  return new DriveError("server", `Google Drive answered with an error (HTTP ${status}).`);
}
