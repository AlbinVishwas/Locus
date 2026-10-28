import { spawnSync } from "node:child_process";

/**
 * Whether the command-line tools Locus relies on are installed, and the exact install command for each system.
 * No shell is involved (spawnSync with an argument list), so it behaves the same on macOS, Windows and Linux.
 */

export type Platform = "mac" | "windows" | "linux";

export function platformName(p: NodeJS.Platform = process.platform): Platform {
  return p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux";
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.error) return { ok: false, out: "" };
    // Poppler prints its version to stderr; tesseract --list-langs prints to stdout (older builds: stderr).
    return { ok: r.status === 0, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  } catch {
    return { ok: false, out: "" };
  }
}

export interface ToolReport {
  poppler: { ok: boolean; missing: string[] };
  tesseract: { ok: boolean; languages: string[]; hasEnglish: boolean; hasHindi: boolean };
}

export function checkTools(): ToolReport {
  const missing = ["pdftotext", "pdftoppm", "pdfinfo", "pdfimages"].filter((t) => !run(t, ["-v"]).ok);
  const t = run("tesseract", ["--list-langs"]);
  const languages = t.ok
    ? t.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("List of") && !l.includes(" "))
    : [];
  return {
    poppler: { ok: missing.length === 0, missing },
    tesseract: { ok: t.ok, languages, hasEnglish: languages.includes("eng"), hasHindi: languages.includes("hin") },
  };
}

/** The same check, remembered for a minute: the Server page asks often. */
let cached: { at: number; report: ToolReport } | null = null;
export function checkToolsCached(maxAgeMs = 60_000): ToolReport {
  if (!cached || Date.now() - cached.at > maxAgeMs) cached = { at: Date.now(), report: checkTools() };
  return cached.report;
}

export const INSTALL: Record<"node" | "poppler" | "tesseract" | "hindi" | "cloudflared", Record<Platform, string>> = {
  node: {
    mac: "brew install node@22   (or: nvm install 22)",
    windows: "winget install OpenJS.NodeJS.LTS   (or: choco install nodejs-lts)",
    linux: "nvm install 22   (or the NodeSource packages: https://github.com/nodesource/distributions)",
  },
  poppler: {
    mac: "brew install poppler",
    windows: "winget install oschwartz10612.Poppler   (or: choco install poppler)  -- then reopen the terminal so it is on PATH",
    linux: "sudo apt install poppler-utils",
  },
  tesseract: {
    mac: "brew install tesseract tesseract-lang",
    windows: "winget install UB-Mannheim.TesseractOCR   (or: choco install tesseract)  -- then reopen the terminal so it is on PATH",
    linux: "sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin",
  },
  hindi: {
    mac: "brew install tesseract-lang",
    windows: "download hin.traineddata from https://github.com/tesseract-ocr/tessdata_fast into Tesseract's tessdata folder (e.g. C:\\Program Files\\Tesseract-OCR\\tessdata)",
    linux: "sudo apt install tesseract-ocr-hin",
  },
  cloudflared: {
    mac: "brew install cloudflared",
    windows: "winget install Cloudflare.cloudflared",
    linux: "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  },
};
