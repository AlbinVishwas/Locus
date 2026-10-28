import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config";
import { MockS3 } from "./testing/mockS3";
import { S3Connector } from "./s3Connector";
import { ConnectorError, type RemoteFile } from "./types";

let s3: MockS3;
let endpoint: string;
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function connector(overrides: Record<string, string> = {}, options = { maxAttempts: 2, requestTimeoutMs: 2000 }) {
  const cfg = loadServerConfig({
    LOCUS_SERVER_TYPE: "s3",
    LOCUS_SERVER_S3_ENDPOINT: endpoint,
    LOCUS_SERVER_S3_BUCKET: "tenders",
    LOCUS_SERVER_S3_ACCESS_KEY: s3.accessKey,
    LOCUS_SERVER_S3_SECRET_KEY: SECRET,
    ...overrides,
  });
  if (cfg.type !== "s3") throw new Error("expected s3");
  return new S3Connector(cfg, options);
}

async function list(c: S3Connector): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  for await (const f of c.list(new AbortController().signal)) out.push(f);
  return out;
}

beforeEach(async () => {
  s3 = new MockS3();
  endpoint = await s3.start();
  s3.put("a.pdf", "%PDF-1.4 a");
  s3.put("tenders/2025/b.pdf", "%PDF-1.4 bb");
  s3.put("tenders/c.pdf", "%PDF-1.4 ccc");
  s3.put("tenders/readme.txt", "hello");
  s3.put("tenders/", ""); // a "folder" placeholder object
});
afterEach(async () => {
  await s3.stop();
});

describe("s3 connector (against an in-process S3-compatible server)", () => {
  it("lists every object across pages with size, last-modified and etag; skips folder placeholders", async () => {
    s3.pageSize = 2;
    const files = await list(connector());
    expect(files.map((f) => f.path)).toEqual(["a.pdf", "tenders/2025/b.pdf", "tenders/c.pdf", "tenders/readme.txt"]);
    expect(files[0]).toMatchObject({ size: 10, etag: s3.objects.get("a.pdf")!.etag });
    expect(Date.parse(files[0].modifiedAt)).toBeGreaterThan(0);
    expect(s3.requests.filter((r) => r.url.includes("list-type=2")).length).toBeGreaterThanOrEqual(3); // paged
  });

  it("a prefix narrows the listing and is stripped from the paths", async () => {
    const files = await list(connector({ LOCUS_SERVER_S3_PREFIX: "tenders" }));
    expect(files.map((f) => f.path)).toEqual(["2025/b.pdf", "c.pdf", "readme.txt"]);
    expect((await connector({ LOCUS_SERVER_S3_PREFIX: "tenders" }).stat("2025/b.pdf"))?.size).toBe(11);
  });

  it("stat gives size and etag, and null for a missing object", async () => {
    const c = connector();
    expect(await c.stat("tenders/c.pdf")).toMatchObject({ size: 12, etag: s3.objects.get("tenders/c.pdf")!.etag });
    expect(await c.stat("nope.pdf")).toBeNull();
  });

  it("streams an object, whole or a range", async () => {
    const c = connector();
    const read = async (range?: { start: number; end: number }) => {
      const chunks: Buffer[] = [];
      for await (const ch of await c.read("tenders/2025/b.pdf", undefined, range)) chunks.push(ch as Buffer);
      return Buffer.concat(chunks).toString();
    };
    expect(await read()).toBe("%PDF-1.4 bb");
    expect(await read({ start: 1, end: 3 })).toBe("PDF");
  });

  it("only ever lists, heads and gets: nothing is written, moved or deleted on the server", async () => {
    const c = connector();
    await list(c);
    await c.stat("a.pdf");
    for await (const _ of await c.read("a.pdf")) void _;
    await c.test();
    expect(s3.requests.length).toBeGreaterThan(3);
    expect(s3.writes()).toBe(0);
    expect([...new Set(s3.requests.map((r) => r.method))].sort()).toEqual(["GET", "HEAD"]);
    expect(s3.objects.size).toBe(5);
  });

  it("test connection: ok with a first look at the bucket", async () => {
    s3.pageSize = 1000;
    expect(await connector().test()).toMatchObject({ ok: true, details: { pdfsSeen: 3 } });
  });

  describe("failures are explained, with a catalog code, and never leak the keys", () => {
    const leaks = (text: string) => text.includes(SECRET) || text.includes(s3.accessKey);

    it("wrong access key -> refused login (LOCUS-SERVER-002)", async () => {
      const c = connector({ LOCUS_SERVER_S3_ACCESS_KEY: "AKIAWRONGWRONG000" });
      const r = await c.test();
      expect(r).toMatchObject({ ok: false, code: "LOCUS-SERVER-002" });
      expect(leaks(r.message)).toBe(false);
      await expect(list(c)).rejects.toMatchObject({ failure: "auth" });
    });

    it("a bucket that doesn't exist -> settings problem (LOCUS-SERVER-003)", async () => {
      expect(await connector({ LOCUS_SERVER_S3_BUCKET: "nope" }).test()).toMatchObject({ ok: false, code: "LOCUS-SERVER-003" });
    });

    it("a server that isn't there -> unreachable (LOCUS-SERVER-001)", async () => {
      const c = connector({ LOCUS_SERVER_S3_ENDPOINT: "http://127.0.0.1:1" });
      const r = await c.test();
      expect(r).toMatchObject({ ok: false, code: "LOCUS-SERVER-001" });
      expect(leaks(r.message)).toBe(false);
    });

    it("a server that answers errors is retried, then reported without the raw details", async () => {
      s3.failWith = 500;
      const r = await connector().test();
      expect(r.ok).toBe(false);
      expect(leaks(r.message)).toBe(false);
      expect(s3.requests.length).toBeGreaterThanOrEqual(2); // retried
    });

    it("a server too slow to answer -> times out instead of hanging", async () => {
      s3.delayMs = 800;
      const started = Date.now();
      const r = await connector({}, { maxAttempts: 1, requestTimeoutMs: 150 }).test();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(r).toMatchObject({ ok: false, code: "LOCUS-SERVER-005" });
    });

    it("a missing object is a not-found error", async () => {
      await expect(connector().read("gone.pdf")).rejects.toMatchObject({ failure: "not-found" });
    });

    it("paths that could escape the prefix are refused", async () => {
      const c = connector({ LOCUS_SERVER_S3_PREFIX: "tenders" });
      await expect(c.read("../a.pdf")).rejects.toBeInstanceOf(ConnectorError);
      await expect(c.stat("/a.pdf")).rejects.toBeInstanceOf(ConnectorError);
    });
  });

  it("the label shown to people never contains the keys", () => {
    const c = connector({ LOCUS_SERVER_S3_PREFIX: "tenders" });
    expect(c.label).toBe(`s3 bucket tenders/tenders/ on ${endpoint.replace("http://", "")}`);
    expect(c.label).not.toContain(SECRET);
    expect(c.label).not.toContain(s3.accessKey);
  });
});
