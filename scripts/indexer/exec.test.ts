import { afterEach, describe, expect, it, vi } from "vitest";

/** Lowering a tool's priority uses nice(1), which exists on macOS and Linux but not on Windows, where the tool just runs. */

const calls: Array<{ file: string; args: string[] }> = [];
vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], _o: unknown, cb: (e: null, out: Buffer, err: Buffer) => void) => {
    calls.push({ file, args });
    cb(null, Buffer.from("ok"), Buffer.alloc(0));
  },
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  calls.length = 0;
});
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p });

describe("run() with a lowered priority", () => {
  it("wraps the tool in nice on macOS and Linux", async () => {
    const { run } = await import("./exec");
    for (const p of ["darwin", "linux"]) {
      setPlatform(p);
      await run("tesseract", ["a.pgm", "stdout"], { timeoutMs: 1000, niceness: 10 });
    }
    expect(calls).toEqual([
      { file: "nice", args: ["-n", "10", "tesseract", "a.pgm", "stdout"] },
      { file: "nice", args: ["-n", "10", "tesseract", "a.pgm", "stdout"] },
    ]);
  });

  it("runs the tool itself on Windows, where there is no nice", async () => {
    const { run } = await import("./exec");
    setPlatform("win32");
    await run("tesseract", ["a.pgm", "stdout"], { timeoutMs: 1000, niceness: 10 });
    expect(calls).toEqual([{ file: "tesseract", args: ["a.pgm", "stdout"] }]);
  });

  it("without a lowered priority nothing is wrapped anywhere", async () => {
    const { run } = await import("./exec");
    for (const p of ["darwin", "win32", "linux"]) {
      setPlatform(p);
      await run("pdftotext", ["x.pdf", "-"], { timeoutMs: 1000 });
    }
    expect(calls.every((c) => c.file === "pdftotext")).toBe(true);
  });
});
