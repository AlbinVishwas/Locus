import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDataDir } from "@/lib/library/config";
import { _resetLibraryDbForTests, libraryDataDir } from "@/lib/library/db";
import { buildLibraryIndex } from "@/lib/library/testing/libraryIndex";
import type { LibrarySearchResponse, LibraryStatus } from "@/lib/libraryClient";
import { POST as search } from "./search/route";
import { GET as status } from "./status/route";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-library-routes-"));
  process.env.LOCUS_LIBRARY_ENABLED = "true";
  process.env.LOCUS_DATA_DIR = dir;
  process.env.LOCUS_APP_DIR = path.join(dir, "..", `app-${path.basename(dir)}`);
});

afterEach(() => {
  _resetLibraryDbForTests();
  delete process.env.LOCUS_LIBRARY_ENABLED;
  delete process.env.LOCUS_DATA_DIR;
  fs.rmSync(process.env.LOCUS_APP_DIR!, { recursive: true, force: true });
  delete process.env.LOCUS_APP_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What the indexer records at start-up: where the library lives and whether that's an external drive. */
function noteLocation(external: boolean) {
  fs.mkdirSync(process.env.LOCUS_APP_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.LOCUS_APP_DIR!, "library-location.json"),
    JSON.stringify({ dataDir: dir, external, volumeName: null, volumeUuid: null, at: "x" })
  );
}

async function post(body: unknown): Promise<{ status: number; json: LibrarySearchResponse | null; text: string }> {
  const res = await search(new Request("http://localhost/api/library/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: res.status === 200 ? JSON.parse(text) : null, text };
}

async function getStatus(): Promise<{ code: number; body: LibraryStatus | null }> {
  const res = await status();
  return { code: res.status, body: res.status === 200 ? await res.json() : null };
}

const sample = () =>
  buildLibraryIndex(dir, [
    { key: "Tenders/2026/notice.pdf", pages: [{ layer: "the ocelot clause" }, { layer: "nothing" }] },
    { key: "Tenders/2025/old.pdf", pages: [{ layer: "an ocelot again" }] },
  ]);

describe("library routes", () => {
  it("answer 404 when the library is off (the default), as if they didn't exist", async () => {
    delete process.env.LOCUS_LIBRARY_ENABLED;
    sample();
    expect((await post({ message: "ocelot" })).status).toBe(404);
    expect((await getStatus()).code).toBe(404);
  });

  it("search: finds pages and returns this exact shape", async () => {
    sample();
    const { json } = await post({ message: "ocelot" });
    if (json?.status !== "ok") throw new Error("expected ok");
    expect({ ...json.result, tookMs: "<ms>" }).toMatchSnapshot();
  });

  it("search: quoted text in the message is what's searched", async () => {
    sample();
    const { json } = await post({ message: 'is there "ocelot clause" here?' });
    if (json?.status !== "ok") throw new Error("expected ok");
    expect(json.result.query).toBe("ocelot clause");
    expect(json.result.hits.map((h) => h.displayName)).toEqual(["Tenders/2026/notice.pdf"]);
  });

  it("search: 'show more' continues from a cursor", async () => {
    buildLibraryIndex(dir, [{ key: "big.pdf", pages: Array.from({ length: 120 }, () => ({ layer: "ocelot" })) }]);
    const first = await post({ message: "ocelot" });
    if (first.json?.status !== "ok") throw new Error("expected ok");
    expect(first.json.result.hits).toHaveLength(50);
    expect(first.json.result.counts).toEqual({ pages: 120, documents: 1, complete: true });
    const pages = first.json.result.hits.map((h) => h.pageNo);
    let cursor = first.json.result.nextCursor;
    while (cursor !== null) {
      const next = await post({ query: "ocelot", mode: "exact", cursor });
      if (next.json?.status !== "ok") throw new Error("expected ok");
      pages.push(...next.json.result.hits.map((h) => h.pageNo));
      cursor = next.json.result.nextCursor;
    }
    expect(pages).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it("never sends an absolute path to the browser", async () => {
    sample();
    const { text } = await post({ message: "ocelot" });
    expect(text).not.toContain(dir);
    expect(text).not.toContain(os.tmpdir());
    const st = await status();
    expect(await st.text()).not.toContain(dir);
  });

  it("status: counts documents, pages, indexing and failures; connected", async () => {
    sample();
    expect((await getStatus()).body).toEqual({ connected: true, documents: 2, pagesIndexed: 3, indexing: 0, failed: 0 });
  });

  it("external drive not connected (marker gone): search and status say so instead of failing; back when it returns", async () => {
    sample();
    noteLocation(true);
    expect((await post({ message: "ocelot" })).json?.status).toBe("ok");
    const marker = path.join(dir, ".locus-data-dir");
    fs.renameSync(marker, `${marker}.away`);
    expect((await post({ message: "ocelot" })).json).toEqual({ status: "disconnected" });
    expect((await getStatus()).body).toMatchObject({ connected: false });
    fs.renameSync(`${marker}.away`, marker);
    expect((await post({ message: "ocelot" })).json?.status).toBe("ok");
    expect((await getStatus()).body).toMatchObject({ connected: true, documents: 2 });
  });

  it("a library on this Mac's own disk has no drive to unplug: a missing marker just means nothing is indexed yet", async () => {
    sample();
    noteLocation(false);
    fs.rmSync(path.join(dir, ".locus-data-dir"));
    expect((await post({ message: "ocelot" })).json).toEqual({ status: "empty" });
    expect((await getStatus()).body).toEqual({ connected: true, documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 });
  });

  it("with LOCUS_DATA_DIR unset, the app looks in the default folder inside the project", () => {
    delete process.env.LOCUS_DATA_DIR;
    expect(libraryDataDir()).toBe(defaultDataDir());
    process.env.LOCUS_DATA_DIR = "/somewhere/else";
    expect(libraryDataDir()).toBe("/somewhere/else");
  });

  it("empty (index folder exists, nothing indexed yet) is its own answer", async () => {
    fs.writeFileSync(path.join(dir, ".locus-data-dir"), "{}");
    expect((await post({ message: "ocelot" })).json).toEqual({ status: "empty" });
    expect((await getStatus()).body).toEqual({ connected: true, documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 });
  });

  it("too-short queries get their own answer", async () => {
    sample();
    expect((await post({ message: "oc" })).json).toEqual({ status: "too-short", query: "oc" });
  });

  it("rejects bad input with a 400", async () => {
    sample();
    for (const body of [{ message: "  " }, { query: "x", mode: "fuzzy", cursor: 0 }, { query: "ocelot", mode: "exact", cursor: -1 }, { query: "ocelot", mode: "exact", cursor: 1.5 }, { message: "x".repeat(20_001) }]) {
      expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});
