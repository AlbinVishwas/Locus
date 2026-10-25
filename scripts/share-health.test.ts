import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `npm run share`'s health check, run for real against stand-in binaries
 * (the approach of src/characterization/share.test.ts):
 *
 *   cloudflared  numbered tunnels: the Nth start prints
 *                https://tunnel-N-for-tests.trycloudflare.com and registers
 *   curl         answers like a visitor's request would: 307 from a live
 *                tunnel; "couldn't resolve host" (exit 6) once the test drops
 *                that tunnel's hostname -- what Cloudflare silently did to
 *                real quick tunnels; the permanent link redirects to
 *                whichever tunnel `vercel deploy` last pointed it at
 *   npx          `next start` serves a 200 on the port share waits on;
 *                `vercel deploy` repoints the permanent link
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const SHARE = path.join(ROOT, "scripts/share.ts");
const tunnelUrl = (n: number) => `https://tunnel-${n}-for-tests.trycloudflare.com`;

let work: string;
let bin: string;
let state: string;

function fake(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  fs.chmodSync(path.join(bin, name), 0o755);
}

function installFakes() {
  const node = process.execPath;
  fake("caffeinate", "exec sleep 600");
  fake(
    "npx",
    [
      `if [ "$1" = "next" ]; then echo "$@" >> "${state}/next-start.log"; exec "${node}" -e 'require("http").createServer((q,s)=>s.end("ok")).on("error",()=>setInterval(()=>{},1e6)).listen(Number(process.env.PORT))'; fi`,
      `echo "$@" >> "${state}/vercel.log"`,
      `case "$*" in`,
      `  *"env add LOCUS_URL production --value "*) url=$(echo "$*" | sed 's/.*--value \\([^ ]*\\).*/\\1/'); echo "$url" > "${state}/pending-link" ;;`,
      `  *"deploy --prod"*) cp "${state}/pending-link" "${state}/link" 2>/dev/null ;;`,
      `esac`,
      `exit 0`,
    ].join("\n")
  );
  fake("npm", "exit 0");
  fake(
    "cloudflared",
    [
      `n=$(( $(cat "${state}/tunnels" 2>/dev/null || echo 0) + 1 ))`,
      `echo $n > "${state}/tunnels"`,
      `echo "$@" >> "${state}/cloudflared.args"`,
      `echo "INF |  https://tunnel-$n-for-tests.trycloudflare.com  |" >&2`,
      `echo "INF Registered tunnel connection connIndex=0 protocol=quic" >&2`,
      `exec sleep 600`,
    ].join("\n")
  );
  fake(
    "curl",
    [
      `for last; do :; done`,
      `host=$(echo "$last" | sed 's#https://##; s#/.*##')`,
      `echo "$host" >> "${state}/probes.log"`,
      `if [ "$host" = "local-chat-one-ivory.vercel.app" ]; then`,
      `  if [ -s "${state}/link" ]; then printf "307 %s/" "$(cat "${state}/link")"; else printf "200 "; fi; exit 0`,
      `fi`,
      `if [ -e "${state}/dropped-$host" ]; then exit 6; fi`,
      `printf "307 https://%s/login?next=%%2F" "$host"`,
    ].join("\n")
  );
}

interface Run {
  child: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<string>;
}

function startShare(args: string[] = ["--no-vercel"]): Run {
  const child = spawn(process.execPath, [TSX, SHARE, ...args], {
    cwd: work,
    env: { HOME: work, PATH: `${bin}:/usr/bin:/bin`, SESSION_SECRET: "x", SHARE_HEALTH_INTERVAL_SECONDS: "1" } as unknown as NodeJS.ProcessEnv,
  });
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return {
    child,
    output: () => out,
    waitFor: async (pattern, timeoutMs = 40_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(out)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    stop: async () => {
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
      return out;
    },
  };
}

const shareLines = (o: string) => o.split("\n").filter((l) => l.startsWith("[share]"));
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "locus-share-health-"));
  bin = path.join(work, "bin");
  state = path.join(work, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  // share runs `vercel` from ./redirect (the redirect app's folder).
  fs.mkdirSync(path.join(work, "redirect"));
  installFakes();
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("npm run share: health check", () => {
  it("hostname silently dropped: three failed checks, then a new tunnel; the app server is never restarted", async () => {
    const run = startShare();
    await run.waitFor(/Press Ctrl\+C to stop/);
    // A couple of healthy checks first.
    await run.waitFor(/./);
    const deadline = Date.now() + 10_000;
    while (lines(path.join(state, "probes.log")).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    // Cloudflare drops the hostname; cloudflared keeps running and says nothing.
    fs.writeFileSync(path.join(state, `dropped-tunnel-1-for-tests.trycloudflare.com`), "");
    await run.waitFor(new RegExp(`Tunnel URL: ${tunnelUrl(2)}`));
    // And the new one is healthy: more checks go by without another restart.
    const probesAfter = lines(path.join(state, "probes.log")).length;
    while (lines(path.join(state, "probes.log")).length < probesAfter + 3) await new Promise((r) => setTimeout(r, 50));
    const out = await run.stop();

    const health = shareLines(out).filter((l) => l.includes("Health check") || l.includes("Tunnel URL"));
    expect(health).toEqual([
      `[share] Tunnel URL: ${tunnelUrl(1)}`,
      "[share] Health check: the tunnel isn't reachable (couldn't resolve the hostname) -- 1 of 3.",
      "[share] Health check: the tunnel isn't reachable (couldn't resolve the hostname) -- 2 of 3.",
      "[share] Health check: the tunnel isn't reachable (couldn't resolve the hostname) -- 3 of 3.",
      "[share] Health check: replacing the tunnel. The app keeps running.",
      `[share] Tunnel URL: ${tunnelUrl(2)}`,
    ]);
    expect(out).not.toContain("The tunnel closed. Stopping the app too.");
    // Same protocol as before (no QUIC trouble here): no --protocol flag.
    expect(lines(path.join(state, "cloudflared.args"))).toEqual(["tunnel --url http://localhost:3000", "tunnel --url http://localhost:3000"]);
    // The app server was started once and never again.
    expect(lines(path.join(state, "next-start.log"))).toEqual(["next start -p 3000"]);
  }, 90_000);

  it("a single failed check that recovers doesn't restart anything", async () => {
    const run = startShare();
    await run.waitFor(/Press Ctrl\+C to stop/);
    const dropped = path.join(state, `dropped-tunnel-1-for-tests.trycloudflare.com`);
    fs.writeFileSync(dropped, "");
    await run.waitFor(/-- 1 of 3\./);
    fs.rmSync(dropped);
    await run.waitFor(/Health check: the tunnel is reachable again\./);
    const out = await run.stop();
    expect(out).not.toContain("replacing the tunnel");
    expect(lines(path.join(state, "cloudflared.args"))).toHaveLength(1);
  }, 90_000);

  it("permanent link pointing elsewhere (tunnel fine): repoints the link only, keeps the tunnel", async () => {
    // Not --no-vercel: share points the link at tunnel 1 at start-up.
    const run = startShare([]);
    await run.waitFor(/Press Ctrl\+C to stop/);
    await run.waitFor(/./);
    // Something else repoints the link (another machine's share, say).
    fs.writeFileSync(path.join(state, "link"), "https://someone-else.trycloudflare.com");
    await run.waitFor(/Health check: the permanent link isn't pointing here \(points at https:\/\/someone-else\.trycloudflare\.com\/\) -- 3 of 3\./);
    await run.waitFor(/Health check: repointing the permanent link at this tunnel\./);
    // Fixed: further checks find it pointing here, and say nothing more.
    const probesAfter = lines(path.join(state, "probes.log")).length;
    while (lines(path.join(state, "probes.log")).length < probesAfter + 4) await new Promise((r) => setTimeout(r, 50));
    const out = await run.stop();
    expect(out.match(/permanent link isn't pointing here/g), out).toHaveLength(3);
    expect(out).not.toContain("replacing the tunnel");
    expect(lines(path.join(state, "cloudflared.args"))).toHaveLength(1);
    // Deployed at start-up, and once more by the health check.
    expect(lines(path.join(state, "vercel.log")).filter((l) => l.startsWith("--yes vercel deploy"))).toHaveLength(2);
    expect(fs.readFileSync(path.join(state, "link"), "utf8").trim()).toBe(tunnelUrl(1));
    expect(lines(path.join(state, "next-start.log"))).toHaveLength(1);
  }, 90_000);

  it("after an HTTP/2 fallback, a health-check restart stays on HTTP/2", async () => {
    // cloudflared that fails QUIC unless asked for HTTP/2.
    fake(
      "cloudflared",
      [
        `n=$(( $(cat "${state}/tunnels" 2>/dev/null || echo 0) + 1 ))`,
        `echo $n > "${state}/tunnels"`,
        `echo "$@" >> "${state}/cloudflared.args"`,
        `echo "INF |  https://tunnel-$n-for-tests.trycloudflare.com  |" >&2`,
        `case "$*" in *"--protocol http2"*) echo "INF Registered tunnel connection protocol=http2" >&2; exec sleep 600 ;; esac`,
        `sleep 1; echo "ERR Failed to dial a quic connection error=timeout" >&2`,
        `exec sleep 600`,
      ].join("\n")
    );
    const run = startShare();
    await run.waitFor(new RegExp(`Tunnel URL: ${tunnelUrl(2)}`));
    fs.writeFileSync(path.join(state, `dropped-tunnel-2-for-tests.trycloudflare.com`), "");
    await run.waitFor(new RegExp(`Tunnel URL: ${tunnelUrl(3)}`));
    await run.stop();
    expect(lines(path.join(state, "cloudflared.args"))).toEqual([
      "tunnel --url http://localhost:3000",
      "tunnel --protocol http2 --url http://localhost:3000",
      "tunnel --protocol http2 --url http://localhost:3000",
    ]);
  }, 90_000);
});
