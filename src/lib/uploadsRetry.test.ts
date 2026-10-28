import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFile, type UploadStageEvent } from "./uploadsClient";

function sse(...events: Array<{ type: string; [k: string]: unknown }>): Response {
  const body = events.map((e) => `${e.type === "searchable" ? "event: searchable\n" : ""}data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const file = new File([new Uint8Array([1, 2, 3])], "a.pdf");

describe("uploadFile retries", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  async function run(retries: number, responses: Array<Response | Error>) {
    const calls: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      calls.push(Date.now());
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const events: UploadStageEvent[] = [];
    const done = uploadFile("fld_x", file, (e) => events.push(e), undefined, "Pack/a.pdf", retries).then(
      () => null,
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return { events, calls: calls.length, error: await done };
  }

  it("sends again after a network error and then reports the answer", async () => {
    const r = await run(3, [new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), sse({ type: "ready", docId: 1, pageCount: 2 })]);
    expect(r.calls).toBe(3);
    expect(r.error).toBeNull();
    expect(r.events).toEqual([{ type: "ready", docId: 1, pageCount: 2 }]);
  });

  it("sends again after a temporary error from a proxy (502, 530), not after a refusal (400)", async () => {
    const ok = sse({ type: "ready", docId: 1, pageCount: 1 });
    expect((await run(3, [new Response("bad gateway", { status: 502 }), new Response("", { status: 530 }), ok])).calls).toBe(3);
    const refused = await run(3, [new Response("This file is too big", { status: 400 })]);
    expect(refused.calls).toBe(1);
    expect(refused.events).toEqual([{ type: "error", message: "This file is too big" }]);
  });

  it("sends again when the connection drops before the file is searchable, but not after", async () => {
    const dropped = await run(2, [sse({ type: "stage", stage: "reading" }), sse({ type: "searchable", docId: 1, pageCount: 3, ocrPages: 2 })]);
    expect(dropped.calls).toBe(2);
    expect(dropped.events.map((e) => e.type)).toEqual(["stage", "searchable"]);
    const fine = await run(2, [sse({ type: "searchable", docId: 1, pageCount: 3, ocrPages: 2 })]);
    expect(fine.calls).toBe(1);
  });

  it("gives up after the retries it was allowed, and without retries behaves as before", async () => {
    const out = await run(2, [new TypeError("down"), new TypeError("down"), new TypeError("down")]);
    expect(out.calls).toBe(3);
    expect(out.error).toBeInstanceOf(TypeError);
    const once = await run(0, [new TypeError("down")]);
    expect(once.calls).toBe(1);
    expect(once.error).toBeInstanceOf(TypeError);
  });

  it("waits a little longer before each new attempt", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("down");
    }) as unknown as typeof fetch;
    const p = uploadFile("fld_x", file, () => {}, undefined, "a.pdf", 2).catch(() => {});
    await vi.advanceTimersByTimeAsync(700);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1400);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
    await p;
  });
});
