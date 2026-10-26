import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Google Drive v3 API: just the three calls Locus makes
 * (files.get for a folder, files.list for a folder's children, files.get with
 * alt=media for a file's bytes), over a tree the test describes, on a loopback
 * port. Can misbehave on cue (rate limits, a private folder, a bad key, a
 * daily limit, a corrupted download) so the client's handling can be tested.
 */

export interface MockFile {
  id: string;
  name: string;
  /** Default application/pdf; use FOLDER_MIME for folders. */
  mimeType?: string;
  parent: string | null;
  content?: Buffer;
  modifiedTime?: string;
  /** Force this md5 in the listing (to simulate a corrupted download). */
  md5Override?: string;
}

export interface MockDrive {
  base: string;
  port: number;
  files: MockFile[];
  /** Every request path (without the key), in order. */
  requests: string[];
  apiKey: string;
  /** The next `count` requests fail with this status/reason (optionally with Retry-After seconds). */
  failNext(count: number, status: number, reason: string, retryAfter?: number): void;
  /** Make the root folder look private (404) or forbidden (403). */
  makePrivate(status?: 403 | 404): void;
  close(): Promise<void>;
}

const FOLDER = "application/vnd.google-apps.folder";
export const md5Of = (b: Buffer) => createHash("md5").update(b).digest("hex");

export async function startMockDrive(files: MockFile[], options: { apiKey?: string; pageSize?: number } = {}): Promise<MockDrive> {
  const apiKey = options.apiKey ?? "test-key";
  const failures: Array<{ status: number; reason: string; retryAfter?: number }> = [];
  let privateStatus: 403 | 404 | null = null;
  const requests: string[] = [];

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res: http.ServerResponse, status: number, reason: string, headers: Record<string, string> = {}) =>
    send(res, status, { error: { code: status, message: reason, errors: [{ reason }] } }, headers);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = url.searchParams.get("key");
    requests.push(`${req.method} ${url.pathname}${url.searchParams.get("alt") ? "?alt=" + url.searchParams.get("alt") : ""}`);
    if (key !== apiKey) return error(res, 400, "keyInvalid");
    const next = failures.shift();
    if (next) return error(res, next.status, next.reason, next.retryAfter !== undefined ? { "retry-after": String(next.retryAfter) } : {});

    const m = url.pathname.match(/^\/files\/([^/]+)$/);
    if (m) {
      const f = files.find((x) => x.id === decodeURIComponent(m[1]));
      if (!f || (privateStatus && f.parent === null)) return error(res, privateStatus ?? 404, privateStatus === 403 ? "forbidden" : "notFound");
      if (url.searchParams.get("alt") === "media") {
        const body = f.content ?? Buffer.alloc(0);
        res.writeHead(200, { "content-type": f.mimeType ?? "application/pdf", "content-length": String(body.length) });
        res.end(body);
        return;
      }
      return send(res, 200, { id: f.id, name: f.name, mimeType: f.mimeType ?? "application/pdf" });
    }
    if (url.pathname === "/files") {
      const q = url.searchParams.get("q") ?? "";
      const parent = q.match(/^'([^']+)' in parents/)?.[1];
      if (parent && privateStatus && files.find((x) => x.id === parent)?.parent === null) return error(res, privateStatus, "notFound");
      const children = files.filter((x) => x.parent === parent).sort((a, b) => a.name.localeCompare(b.name));
      const size = options.pageSize ?? Number(url.searchParams.get("pageSize") ?? 1000);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const page = children.slice(offset, offset + size);
      return send(res, 200, {
        files: page.map((x) => ({
          id: x.id,
          name: x.name,
          mimeType: x.mimeType ?? "application/pdf",
          ...(x.mimeType === FOLDER || !x.content ? {} : { size: String(x.content.length), md5Checksum: x.md5Override ?? md5Of(x.content) }),
          modifiedTime: x.modifiedTime ?? "2026-01-01T00:00:00.000Z",
        })),
        ...(offset + size < children.length ? { nextPageToken: String(offset + size) } : {}),
      });
    }
    error(res, 404, "notFound");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    files,
    requests,
    apiKey,
    failNext: (count, status, reason, retryAfter) => {
      for (let i = 0; i < count; i++) failures.push({ status, reason, retryAfter });
    },
    makePrivate: (status = 404) => {
      privateStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
