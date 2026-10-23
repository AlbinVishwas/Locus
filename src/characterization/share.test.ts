import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Characterization (pinned at the pre-library tag): `npm run share`, run
 * for real -- the actual scripts/share.ts -- with stand-ins for the
 * programs it starts (npm, npx, cloudflared, caffeinate) that only record
 * how they were called. Pins what it checks, the order it does things in,
 * and the exact environment the production server is started with. Library
 * settings are new and default off; share must not start passing anything
 * new to the server unless they're set.
 *
 * The stand-in `npx next start` serves a 200 on the port share waits on
 * (or, if something else already holds that port, leaves it to that), and
 * the stand-in cloudflared prints a fixed tunnel URL.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const SHARE = path.join(ROOT, "scripts/share.ts");
const FAKE_URL = "https://fake-tunnel-for-tests.trycloudflare.com";

let work: string;
let bin: string;
let record: string;

function fake(name: string, body: string) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function installFakes({ cloudflared = true } = {}) {
  const node = process.execPath;
  fake("npm", `echo "$@" > "${record}/npm.args"; exit 0`);
  fake(
    "npx",
    [
      `if [ "$1" = "next" ]; then`,
      `  echo "$@" > "${record}/npx.args"`,
      `  env | sort > "${record}/server.env"`,
      `  exec "${node}" -e 'require("http").createServer((q,s)=>s.end("ok")).on("error",()=>setInterval(()=>{},1e6)).listen(Number(process.env.PORT))'`,
      `fi`,
      `echo "$@" >> "${record}/npx-other.args"; exit 0`,
    ].join("\n")
  );
  if (cloudflared) {
    fake("cloudflared", `echo "$@" > "${record}/cloudflared.args"; echo "INF |  ${FAKE_URL}  |" >&2; exec sleep 600`);
  }
  fake("caffeinate", `echo "$@" > "${record}/caffeinate.args"; exec sleep 600`);
}

/** Runs share until it prints `until` (or exits), then stops it with SIGINT. */
function runShare(env: Record<string, string>, until: RegExp, timeoutMs = 45_000) {
  return new Promise<{ output: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, SHARE, "--no-vercel"], {
      cwd: work,
      env: { HOME: work, PATH: `${bin}:/usr/bin:/bin`, ...env },
    });
    let output = "";
    let stopping = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!stopping && until.test(output)) {
        stopping = true;
        child.kill("SIGINT");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`share didn't reach ${until} in time. Output:\n${output}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });
  });
}

function readEnvFile(file: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      })
  );
}

const shareLines = (output: string) => output.split("\n").filter((l) => l.startsWith("[share]"));

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-share-"));
  bin = path.join(work, "bin");
  record = path.join(work, "record");
  fs.mkdirSync(bin);
  fs.mkdirSync(record);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("characterization: npm run share", () => {
  it("chat off: skips LM Studio, builds, starts the server with exactly this env, tunnels, keeps the Mac awake", async () => {
    installFakes();
    const { output } = await runShare({ SESSION_SECRET: "pinned-secret" }, /Press Ctrl\+C to stop/);

    expect(shareLines(output)).toEqual([
      "[share] Chat is disabled -- Locus runs as a document search tool. Skipping the LM Studio check.",
      "[share] (Set LOCUS_CHAT_ENABLED=true to turn model replies back on.)",
      "[share] Building…",
      "[share] Starting on port 3000…",
      "[share] App is up.",
      "[share] Starting the tunnel…",
      `[share] Tunnel URL: ${FAKE_URL}`,
      "[share] Share the link above plus the LOCUS_PASSCODE with whoever needs it.",
      "[share] Press Ctrl+C to stop.",
      // The SIGINT this test sends: Ctrl+C stops the tunnel, caffeinate and server.
      "[share] Stopping…",
    ]);

    expect(fs.readFileSync(path.join(record, "npm.args"), "utf8").trim()).toBe("run build");
    expect(fs.readFileSync(path.join(record, "npx.args"), "utf8").trim()).toBe("next start -p 3000");
    expect(fs.readFileSync(path.join(record, "cloudflared.args"), "utf8").trim()).toBe(
      "tunnel --url http://localhost:3000"
    );
    expect(fs.readFileSync(path.join(record, "caffeinate.args"), "utf8").trim()).toMatch(/^-i -w \d+$/);
    // --no-vercel: the redirect app is never touched.
    expect(fs.existsSync(path.join(record, "npx-other.args"))).toBe(false);

    // Everything share sets on the server, on top of what it inherited.
    const env = readEnvFile(path.join(record, "server.env"));
    const set = Object.fromEntries(
      ["NODE_ENV", "PORT", "LOCUS_ENABLE_UPLOADS", "LOCAL_CHAT_ENABLE_URL_CONTEXT", "SESSION_SECRET", "LM_STUDIO_BASE_URL"].map(
        (k) => [k, env[k]]
      )
    );
    expect(set).toEqual({
      NODE_ENV: "production",
      PORT: "3000",
      LOCUS_ENABLE_UPLOADS: "true",
      LOCAL_CHAT_ENABLE_URL_CONTEXT: "false",
      SESSION_SECRET: "pinned-secret",
      LM_STUDIO_BASE_URL: "http://localhost:1234/v1",
    });
    // Nothing library-related, or anything else new, is passed by default.
    expect(Object.keys(env).filter((k) => /LIBRARY|LOCUS_DATA_DIR|SEARCH_SCOPE/.test(k))).toEqual([]);
  }, 60_000);

  it("generates a SESSION_SECRET into .env.local the first time one is missing", async () => {
    installFakes();
    const { output } = await runShare({}, /Press Ctrl\+C to stop/);
    expect(output).toContain(
      "[share] Generated SESSION_SECRET and saved it to .env.local (sessions will now survive a restart)."
    );
    const saved = fs.readFileSync(path.join(work, ".env.local"), "utf8");
    expect(saved).toMatch(/^SESSION_SECRET=[0-9a-f-]{72}\n$/);
    const env = readEnvFile(path.join(record, "server.env"));
    expect(`SESSION_SECRET=${env.SESSION_SECRET}\n`).toBe(saved);
  }, 60_000);

  it("refuses to start without cloudflared, with the install hint", async () => {
    installFakes({ cloudflared: false });
    // PATH without /usr/bin: `which` itself is then missing too, which share
    // treats the same as cloudflared missing.
    const child = spawn(process.execPath, [TSX, SHARE, "--no-vercel"], {
      cwd: work,
      env: { HOME: work, PATH: bin, SESSION_SECRET: "x" },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(output.trim()).toBe("[share] cloudflared is not installed. Install it with: brew install cloudflared");
    expect(fs.existsSync(path.join(record, "npm.args"))).toBe(false);
  }, 60_000);

  it("chat on: checks LM Studio before building", async () => {
    installFakes();
    // Whether LM Studio happens to be running on this machine decides what
    // comes next; either way the check comes first and nothing is built
    // before it.
    const { output } = await runShare(
      { SESSION_SECRET: "x", LOCUS_CHAT_ENABLED: "true" },
      /Press Ctrl\+C to stop|Could not reach LM Studio/
    );
    const lines = shareLines(output);
    expect(lines[0]).toBe("[share] Checking LM Studio…");
    expect(output).not.toContain("Skipping the LM Studio check");
    if (output.includes("Could not reach LM Studio")) {
      expect(output).toContain("[share] Could not reach LM Studio at http://localhost:1234/v1");
      expect(fs.existsSync(path.join(record, "npm.args"))).toBe(false);
    } else {
      const env = readEnvFile(path.join(record, "server.env"));
      expect(env.LOCAL_CHAT_ENABLE_URL_CONTEXT).toBe("true");
    }
  }, 60_000);
});
