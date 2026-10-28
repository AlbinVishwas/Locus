import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test-only: a small S3-compatible server in this process (a stand-in for MinIO, which needs Docker): path-style
 * ListObjectsV2 with paging, HeadObject, GetObject with Range, an access-key check, and a log of every request, so a
 * test can prove Locus only ever listed, headed and got (never PUT, POST or DELETE).
 */
export interface MockObject {
  body: Buffer;
  mtime: Date;
  etag: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class MockS3 {
  readonly objects = new Map<string, MockObject>();
  readonly requests: Array<{ method: string; url: string }> = [];
  pageSize = 2;
  /** Answer every request with this status (a server having a bad day), or null. */
  failWith: number | null = null;
  /** Hold every response this long (a slow server), in ms. */
  delayMs = 0;
  private server: http.Server;
  constructor(
    readonly bucket = "tenders",
    readonly accessKey = "AKIATESTKEY0000",
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  put(key: string, body: Buffer | string, mtime = new Date()): void {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.objects.set(key, { body: b, mtime, etag: createHash("md5").update(b).digest("hex") });
  }
  delete(key: string): void {
    this.objects.delete(key);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  writes(): number {
    return this.requests.filter((r) => !["GET", "HEAD"].includes(r.method)).length;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requests.push({ method: req.method ?? "", url: req.url ?? "" });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const send = (status: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/xml", ...headers });
      res.end(body);
    };
    const err = (status: number, code: string, message: string) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`);
    if (this.failWith) return err(this.failWith, "InternalError", "the server is having a bad day");
    if (!["GET", "HEAD"].includes(req.method ?? "")) return err(405, "MethodNotAllowed", "read-only test server");
    const auth = String(req.headers.authorization ?? "");
    if (!auth.includes(`Credential=${this.accessKey}/`)) return err(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== this.bucket) return err(404, "NoSuchBucket", "The specified bucket does not exist");
    if (parts.length === 1) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const max = Math.min(Number(url.searchParams.get("max-keys") ?? 1000), this.pageSize);
      const after = url.searchParams.get("continuation-token") ?? "";
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > page.length;
      const items = page
        .map((k) => {
          const o = this.objects.get(k)!;
          return `<Contents><Key>${xml(k)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        })
        .join("");
      return send(
        200,
        `<?xml version="1.0"?><ListBucketResult><Name>${this.bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(page[page.length - 1])}</NextContinuationToken>` : ""}${items}</ListBucketResult>`
      );
    }
    const key = parts.slice(1).join("/");
    const obj = this.objects.get(key);
    if (!obj) return err(404, "NoSuchKey", "The specified key does not exist.");
    const base = { "Content-Type": "application/pdf", ETag: `"${obj.etag}"`, "Last-Modified": obj.mtime.toUTCString(), "Accept-Ranges": "bytes" };
    const range = String(req.headers.range ?? "").match(/^bytes=(\d+)-(\d+)?$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : obj.body.length - 1, obj.body.length - 1);
      res.writeHead(206, { ...base, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${obj.body.length}` });
      return void (req.method === "HEAD" ? res.end() : res.end(obj.body.subarray(start, end + 1)));
    }
    res.writeHead(200, { ...base, "Content-Length": String(obj.body.length) });
    res.end(req.method === "HEAD" ? undefined : obj.body);
  }
}
