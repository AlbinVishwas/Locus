import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `npm run share`'s automatic switch to HTTP/2 when cloudflared can't
 * connect over QUIC (UDP blocked), run for real against stand-in binaries
 * the way src/characterization/share.test.ts does. The stand-in cloudflared
 * behaves like the real one on a network that blocks UDP: it prints a URL,
 * then keeps logging failed QUIC dials and never registers -- unless it's
 * started with --protocol http2, when it registers at once.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const SHARE = path.join(ROOT, "scripts/share.ts");
const QUIC_URL = "https://quic-attempt-for-tests.trycloudflare.com";
const HTTP2_URL = "https://http2-fallback-for-tests.trycloudflare.com";

let work: string;
let bin: string;
let record: string;

function fake(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  fs.chmodSync(path.join(bin, name), 0o755);
}

/** `quic`: what the stand-in does without --protocol http2. */
function installFakes(quic: "blocked" | "recovers") {
  const node = process.execPath;
  fake("npm", "exit 0");
  fake(
    "npx",
    `if [ "$1" = "next" ]; then exec "${node}" -e 'require("http").createServer((q,s)=>s.end("ok")).on("error",()=>setInterval(()=>{},1e6)).listen(Number(process.env.PORT))'; fi; exit 0`
  );
  fake("caffeinate", "exec sleep 600");
  const failing = [
    `echo "INF |  ${QUIC_URL}  |" >&2`,
    `sleep 1`,
    `echo "ERR Failed to dial a quic connection error=\\"failed to dial to edge with quic: timeout: no recent network activity\\" connIndex=0" >&2`,
    quic === "recovers"
      ? `sleep 1; echo "INF Registered tunnel connection connIndex=0 protocol=quic" >&2`
      : `sleep 2; echo "ERR Failed to dial a quic connection error=\\"timeout\\" connIndex=0" >&2`,
    `exec sleep 600`,
  ].join("\n");
  fake(
    "cloudflared",
    [
      `echo "$@" >> "${record}/cloudflared.args"`,
      `env | grep '^TUNNEL_' >> "${record}/cloudflared.env"`,
      `case "$*" in`,
      `  *"--protocol http2"*) echo "INF |  ${HTTP2_URL}  |" >&2; echo "INF Registered tunnel connection connIndex=0 protocol=http2" >&2; exec sleep 600 ;;`,
      `esac`,
      failing,
    ].join("\n")
  );
}

function runShare(env: Record<string, string>, until: RegExp, timeoutMs = 45_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, SHARE, "--no-vercel"], {
      cwd: work,
      env: { HOME: work, PATH: `${bin}:/usr/bin:/bin`, SESSION_SECRET: "x", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let output = "";
    let stopping = false;
    const onData = (c: Buffer) => {
      output += c.toString("utf8");
      if (!stopping && until.test(output)) {
        stopping = true;
        child.kill("SIGINT");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.on("error", reject);
  });
}

const shareLines = (o: string) => o.split("\n").filter((l) => l.startsWith("[share]"));
const invocations = () => fs.readFileSync(path.join(record, "cloudflared.args"), "utf8").trim().split("\n");

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "locus-share-fallback-"));
  bin = path.join(work, "bin");
  record = path.join(work, "record");
  fs.mkdirSync(bin);
  fs.mkdirSync(record);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("npm run share: the Sources indexer", () => {
  it("with the library and the admin area set up, generates LOCUS_SECRETS_KEY and starts the worker; with them off it does neither", async () => {
    installFakes("recovers");
    // A stand-in `node` that records how the worker was started and then just stays alive.
    fake("node", `echo "$@" >> "${record}/worker.args"; exec sleep 600`);
    const on = await runShare(
      { LOCUS_USERS_ENABLED: "true", LOCUS_ADMIN_PASSCODE: "admin-passcode", LOCUS_LIBRARY_ENABLED: "true", LOCUS_SIGNUP_CODE: "invite" },
      /administrator signs in as "admin"/
    );
    expect(on).toContain("Generated LOCUS_SECRETS_KEY and saved it to .env.local");
    expect(fs.readFileSync(path.join(work, ".env.local"), "utf8")).toMatch(/^LOCUS_SECRETS_KEY=\S{40,}$/m);
    expect(on).toContain("Starting the indexer worker");
    expect(fs.readFileSync(path.join(record, "worker.args"), "utf8")).toContain("scripts/library-worker.ts");
    expect(on).toContain("sign-up code (LOCUS_SIGNUP_CODE)");
    expect(on).not.toContain("with whoever needs it");
  });

  it("leaves things exactly as they were when users mode and the library are off", async () => {
    installFakes("recovers");
    fake("node", `echo "$@" >> "${record}/worker.args"; exec sleep 600`);
    const off = await runShare({}, /Press Ctrl\+C to stop/);
    expect(off).not.toContain("indexer worker");
    expect(off).not.toContain("LOCUS_SECRETS_KEY");
    expect(fs.existsSync(path.join(record, "worker.args"))).toBe(false);
    expect(off).toContain("Share the link above plus the LOCUS_PASSCODE with whoever needs it.");
  });
});

describe("npm run share: QUIC → HTTP/2 fallback", () => {
  it("switches to HTTP/2 when QUIC keeps failing, prints the new URL, and keeps the app running", async () => {
    installFakes("blocked");
    const output = await runShare({}, new RegExp(`Tunnel URL: ${HTTP2_URL}`));
    expect(shareLines(output)).toEqual([
      "[share] Chat is disabled -- Locus runs as a document search tool. Skipping the LM Studio check.",
      "[share] (Set LOCUS_CHAT_ENABLED=true to turn model replies back on.)",
      "[share] Building…",
      "[share] Starting on port 3000…",
      "[share] App is up.",
      "[share] Starting the tunnel…",
      `[share] Tunnel URL: ${QUIC_URL}`,
      "[share] Share the link above plus the LOCUS_PASSCODE with whoever needs it.",
      "[share] Press Ctrl+C to stop.",
      "[share] The tunnel couldn't connect over QUIC (UDP may be blocked on this network). Switching to HTTP/2…",
      `[share] Tunnel URL: ${HTTP2_URL}`,
      "[share] Stopping…",
    ]);
    // The old tunnel being closed for the switch didn't stop the app.
    expect(output).not.toContain("The tunnel closed. Stopping the app too.");
    expect(invocations()).toEqual(["tunnel --url http://localhost:3000", "tunnel --protocol http2 --url http://localhost:3000"]);
  }, 60_000);

  it("doesn't switch when QUIC recovers and registers within the grace period", async () => {
    installFakes("recovers");
    // Wait past the grace period after the failure, then stop.
    const output = await runShare({}, /a^/, 12_000);
    expect(output).not.toContain("Switching to HTTP/2");
    expect(invocations()).toEqual(["tunnel --url http://localhost:3000"]);
  }, 60_000);

  it("TUNNEL_TRANSPORT_PROTOCOL is a manual override: never switched automatically, passed through to cloudflared", async () => {
    installFakes("blocked");
    const output = await runShare({ TUNNEL_TRANSPORT_PROTOCOL: "quic" }, /a^/, 12_000);
    expect(output).not.toContain("Switching to HTTP/2");
    expect(invocations()).toEqual(["tunnel --url http://localhost:3000"]);
    expect(fs.readFileSync(path.join(record, "cloudflared.env"), "utf8").trim()).toBe("TUNNEL_TRANSPORT_PROTOCOL=quic");
  }, 60_000);
});
