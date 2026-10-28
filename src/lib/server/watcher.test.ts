import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFolderWatcher } from "./watcher";

type Listener = (event: string, name: string | null) => void;
function fakeWatch() {
  let listener: Listener = () => {};
  const closed = vi.fn();
  const watch = ((_dir: string, _o: unknown, l: Listener) => {
    listener = l;
    return { on: () => {}, close: closed } as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch;
  return { watch, fire: (name: string | null) => listener("change", name), closed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("server folder watcher (a hint on top of the timed scan)", () => {
  it("asks for one sync once the folder has been quiet, however many events came", () => {
    const f = fakeWatch();
    const onChange = vi.fn();
    startFolderWatcher("/srv", { onChange, quietMs: 1000, minGapMs: 0, watch: f.watch });
    f.fire("a.pdf");
    f.fire("b.pdf");
    vi.advanceTimersByTime(900);
    f.fire("c.pdf"); // still copying: the quiet period starts over
    vi.advanceTimersByTime(900);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("never asks more often than the minimum gap", () => {
    const f = fakeWatch();
    const onChange = vi.fn();
    let now = 0;
    startFolderWatcher("/srv", { onChange, quietMs: 100, minGapMs: 60_000, watch: f.watch, now: () => now });
    f.fire("a.pdf");
    now = 200;
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    f.fire("b.pdf");
    now = 1000;
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledTimes(1); // too soon: held back
    now = 61_000;
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores changes to files that aren't PDFs", () => {
    const f = fakeWatch();
    const onChange = vi.fn();
    startFolderWatcher("/srv", { onChange, quietMs: 10, minGapMs: 0, watch: f.watch });
    f.fire("notes.txt");
    f.fire("Thumbs.db");
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
    f.fire("new-folder"); // a folder appearing can hold PDFs
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("where watching isn't possible it says so and carries on: the timed scan is the safety net", () => {
    const log = vi.fn();
    const stop = startFolderWatcher("/srv", { onChange: vi.fn(), log, watch: (() => { throw new Error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"); }) as unknown as typeof fs.watch });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed scan still keeps the index up to date"));
    expect(() => stop()).not.toThrow();
  });

  it("stopping closes the watcher and cancels a pending sync request", () => {
    const f = fakeWatch();
    const onChange = vi.fn();
    const stop = startFolderWatcher("/srv", { onChange, quietMs: 1000, minGapMs: 0, watch: f.watch });
    f.fire("a.pdf");
    stop();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
    expect(f.closed).toHaveBeenCalled();
  });
});
