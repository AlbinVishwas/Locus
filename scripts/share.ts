import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { isChatEnabled } from "../src/config/features";

/**
 * `npm run share`: everything needed to hand someone a working, public
 * link to this laptop's Locus -- checks, build, start, tunnel -- in one
 * command. See docs/sharing.md for what the person on the other end
 * needs and what to do when the printed URL changes.
 *
 * Deliberately a plain script, not a Next.js route: it needs to run
 * `next build`/`next start` as child processes and manage long-lived
 * ones (cloudflared, caffeinate) for as long as the terminal stays open,
 * none of which belongs inside a request handler.
 */

const PORT = 3000;
const LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const READY_TIMEOUT_MS = 30_000;
const NO_VERCEL = process.argv.includes("--no-vercel");
const VERCEL_REDIRECT_DIR = path.resolve("redirect");
const VERCEL_PUBLIC_URL = "https://local-chat-one-ivory.vercel.app";

function log(message: string): void {
  console.log(`[share] ${message}`);
}

function fail(message: string): never {
  console.error(`[share] ${message}`);
  process.exit(1);
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Also returns the model list, so a missing configured model can name what IS loaded. */
async function checkLmStudio(): Promise<{ ids: string[] }> {
  let res: Response;
  try {
    res = await fetch(`${LM_STUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    fail(
      `Could not reach LM Studio at ${LM_STUDIO_BASE_URL} (${err instanceof Error ? err.message : err}).\n` +
        `       Start LM Studio, load a model, and start its local server, then try again.`
    );
  }
  if (!res.ok) {
    fail(`LM Studio at ${LM_STUDIO_BASE_URL} answered with HTTP ${res.status}.`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const ids = body.data?.map((m) => m.id) ?? [];
  if (ids.length === 0) {
    fail(`LM Studio is reachable but has no model loaded. Load one in LM Studio, then try again.`);
  }
  return { ids };
}

interface LmsLoadedModel {
  identifier: string;
  modelKey: string;
  sizeBytes: number;
  lastUsedTime: number;
}

/**
 * Warns (never fails -- this isn't this app's state to fix outright) when
 * the configured model is loaded more than once. LM Studio appends `:2`,
 * `:3`, etc. to a model's identifier when a request's load parameters
 * (e.g. context length) don't match an already-loaded instance exactly,
 * rather than reusing it -- each extra copy holds its own full set of
 * weights in memory for no benefit here, since every request this app
 * makes asks for the same LM_STUDIO_MODEL with the same parameters.
 */
function warnAboutDuplicateModelInstances(configuredModel: string): void {
  if (!commandExists("lms")) return; // optional: the CLI, not the server, provides this
  let loaded: LmsLoadedModel[];
  try {
    loaded = JSON.parse(execFileSync("lms", ["ps", "--json"], { encoding: "utf8" }));
  } catch {
    return; // best-effort; a parse/exec failure here shouldn't block sharing
  }

  const copies = loaded.filter((m) => m.modelKey === configuredModel);
  if (copies.length <= 1) return;

  const keep = copies.reduce((a, b) => (a.lastUsedTime > b.lastUsedTime ? a : b));
  const totalMB = (copies.reduce((sum, m) => sum + m.sizeBytes, 0) / (1024 * 1024)).toFixed(0);
  log(
    `Warning: ${configuredModel} is loaded ${copies.length} times (${totalMB} MB total), wasting memory. ` +
      `Keeping the most recently used copy (${keep.identifier}); unload the others with:`
  );
  for (const m of copies) {
    if (m.identifier !== keep.identifier) log(`         lms unload "${m.identifier}"`);
  }
}

function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
        resolve();
        return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        reject(new Error(`The app didn't come up on port ${port} within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

const ENV_LOCAL_PATH = path.resolve(".env.local");

/**
 * A shared production server needs one SESSION_SECRET value that every
 * runtime (the Edge proxy, the Node API routes) uses -- without it, each
 * generates its own fallback and every login fails (see src/lib/auth.ts).
 * Rather than fail here, generate one and persist it to .env.local the
 * first time `npm run share` runs without one, so sharing the app stays a
 * single command: this only ever needs to happen once per machine.
 */
function ensureSessionSecret(): string {
  const existing = process.env.SESSION_SECRET;
  if (existing && existing.length > 0) return existing;

  let contents = "";
  try {
    contents = fs.readFileSync(ENV_LOCAL_PATH, "utf8");
  } catch {
    // No .env.local yet -- fine, one is created below.
  }

  const match = contents.match(/^SESSION_SECRET=(.*)$/m);
  if (match && match[1].trim().length > 0) return match[1].trim();

  const generated = crypto.randomUUID() + crypto.randomUUID();
  const line = `SESSION_SECRET=${generated}`;
  if (match) {
    // An empty `SESSION_SECRET=` line already exists -- replace it in place
    // rather than appending a second, conflicting one.
    contents = contents.replace(/^SESSION_SECRET=.*$/m, line);
  } else {
    contents = contents.length > 0 && !contents.endsWith("\n") ? `${contents}\n${line}\n` : `${contents}${line}\n`;
  }
  fs.writeFileSync(ENV_LOCAL_PATH, contents);
  log("Generated SESSION_SECRET and saved it to .env.local (sessions will now survive a restart).");
  return generated;
}

/**
 * Points the already-deployed redirect/ app (the permanent, public
 * local-chat-one-ivory.vercel.app link) at this run's tunnel URL, so
 * sharing stays a single command even though the tunnel URL changes
 * every time. Best-effort: a failure here never stops Locus itself --
 * the tunnel link printed below always works on its own.
 */
function updateVercelRedirect(tunnelUrl: string): void {
  if (NO_VERCEL) return;
  log("Updating the public redirect link…");
  try {
    try {
      execFileSync("npx", ["--yes", "vercel", "env", "rm", "LOCUS_URL", "production", "--yes"], {
        cwd: VERCEL_REDIRECT_DIR,
        stdio: "ignore",
      });
    } catch {
      // Fine if LOCUS_URL didn't exist yet (first run).
    }
    execFileSync(
      "npx",
      ["--yes", "vercel", "env", "add", "LOCUS_URL", "production", "--value", tunnelUrl, "--yes"],
      { cwd: VERCEL_REDIRECT_DIR, stdio: "ignore" }
    );
    execFileSync("npx", ["--yes", "vercel", "deploy", "--prod", "--yes"], {
      cwd: VERCEL_REDIRECT_DIR,
      stdio: "ignore",
    });
    log(`Share this: ${VERCEL_PUBLIC_URL}`);
  } catch (err) {
    log(
      `Could not update the Vercel redirect (${err instanceof Error ? err.message : err}). ` +
        `Use the tunnel link below instead -- re-run "npm run share" once Vercel is reachable to fix the public link.`
    );
  }
}

const CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const QUIC_FAILURE_PATTERN = /Failed to dial a quic connection|QUIC connection failed/;
const REGISTERED_PATTERN = /Registered tunnel connection/;
/**
 * After cloudflared reports a failed QUIC (UDP) connection, how long to give
 * it to register a connection anyway before switching to HTTP/2 (TCP).
 * Some networks block UDP to Cloudflare outright -- the tunnel then never
 * connects (or, mid-run, drops and never comes back) while cloudflared keeps
 * retrying QUIC.
 */
const QUIC_FALLBACK_GRACE_MS = 6000;

/**
 * Health check: a quick tunnel can stop working with nothing in
 * cloudflared's output -- Cloudflare drops its hostname, the process keeps
 * running, and the link just shows "offline". So every
 * SHARE_HEALTH_INTERVAL_SECONDS (default 60) share fetches its own public
 * tunnel URL, and the permanent link, the way a visitor would. After
 * HEALTH_FAILURES_BEFORE_ACTION failures in a row it replaces the tunnel
 * (only the tunnel: the app server keeps running throughout) and repoints
 * the permanent link; if only the permanent link is wrong, it just
 * repoints that.
 */
const HEALTH_INTERVAL_MS = Math.max(1, Number(process.env.SHARE_HEALTH_INTERVAL_SECONDS || 60)) * 1000;
const HEALTH_FAILURES_BEFORE_ACTION = 3;

const CURL_ERRORS: Record<number, string> = {
  6: "couldn't resolve the hostname",
  7: "couldn't connect",
  28: "timed out",
  35: "TLS handshake failed",
  52: "empty reply",
  56: "connection reset",
};

interface Probe {
  /** HTTP status, or 0 if no response at all. */
  status: number;
  location: string;
  detail: string;
}

/** One request to `url`, through curl, the way a visitor's browser would make it (no redirects followed). */
function probe(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "--max-time", "10", url],
      { timeout: 15_000 },
      (err, stdout) => {
        const [code, location = ""] = String(stdout ?? "").trim().split(" ");
        const status = Number(code) || 0;
        if (err && status === 0) {
          const exit = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1;
          resolve({ status: 0, location: "", detail: CURL_ERRORS[exit] ?? `curl exit ${exit}` });
          return;
        }
        resolve({ status, location, detail: `HTTP ${status}` });
      }
    );
  });
}

function startTunnel(
  port: number,
  extraArgs: string[] = [],
  onLine?: (text: string) => void
): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", ...extraArgs, "--url", `http://localhost:${port}`]);
    let settled = false;
    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      onLine?.(text);
      const match = text.match(CLOUDFLARE_URL_PATTERN);
      if (match && !settled) {
        settled = true;
        resolve({ process: proc, url: match[0] });
      }
    };
    // cloudflared prints its URL to stderr, not stdout.
    proc.stdout.on("data", onOutput);
    proc.stderr.on("data", onOutput);
    proc.on("error", (err) => {
      if (!settled) reject(err);
    });
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`cloudflared exited with code ${code} before printing a URL`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error("cloudflared didn't print a URL within 20s"));
    }, 20_000);
  });
}

async function main() {
  // The same .env files `next start` reads, loaded here too, so a
  // LOCUS_CHAT_ENABLED in .env.local means the same thing to this script
  // as it does to the server it starts.
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const chatEnabled = isChatEnabled();

  if (!commandExists("cloudflared")) {
    fail("cloudflared is not installed. Install it with: brew install cloudflared");
  }

  if (chatEnabled) {
    log("Checking LM Studio…");
    const { ids } = await checkLmStudio();
    const configuredModel = process.env.LM_STUDIO_MODEL;
    if (configuredModel && !ids.includes(configuredModel)) {
      log(
        `Warning: LM_STUDIO_MODEL=${configuredModel} is not among the loaded models (${ids.join(", ")}). ` +
          `Chat will fail until the right one is loaded, but continuing -- OCR, search, and uploads don't need it.`
      );
    } else {
      log(`LM Studio is up, model loaded: ${configuredModel ?? ids[0]}`);
    }
    warnAboutDuplicateModelInstances(configuredModel ?? ids[0]);
  } else {
    // Nothing in search-only mode talks to LM Studio, so whether it's
    // running doesn't matter.
    log("Chat is disabled -- Locus runs as a document search tool. Skipping the LM Studio check.");
    log("(Set LOCUS_CHAT_ENABLED=true to turn model replies back on.)");
  }

  const sessionSecret = ensureSessionSecret();

  log("Building…");
  const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
  const buildExit = await new Promise<number>((resolve) => build.on("exit", (code) => resolve(code ?? 1)));
  if (buildExit !== 0) fail(`Build failed (exit ${buildExit}).`);

  log(`Starting on port ${PORT}…`);
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    LOCUS_ENABLE_UPLOADS: "true",
    // URL reading only ever feeds the model, so it's on only with chat.
    LOCAL_CHAT_ENABLE_URL_CONTEXT: chatEnabled ? "true" : "false",
    SESSION_SECRET: sessionSecret,
    // This machine is the one being shared, so LM Studio is always local
    // to it -- never through a second tunnel, whatever .env.local has.
    LM_STUDIO_BASE_URL,
  };
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "inherit",
    env: serverEnv,
  });

  const cleanup = (() => {
    let done = false;
    return (tunnelProc?: ChildProcess, caffeinateProc?: ChildProcess) => {
      if (done) return;
      done = true;
      log("Stopping…");
      tunnelProc?.kill();
      caffeinateProc?.kill();
      server.kill();
    };
  })();

  try {
    await waitForServer(PORT, READY_TIMEOUT_MS);
  } catch (err) {
    cleanup();
    fail(err instanceof Error ? err.message : String(err));
  }
  log("App is up.");

  // `-w <pid>`: caffeinate exits on its own once the server does, so there's
  // one less process this script has to remember to kill by hand.
  const caffeinate = spawn("caffeinate", ["-i", "-w", String(server.pid)]);

  log("Starting the tunnel…");
  // TUNNEL_TRANSPORT_PROTOCOL (cloudflared reads it itself) is the manual
  // override: when it's set, the protocol is left exactly as chosen.
  const protocolOverride = process.env.TUNNEL_TRANSPORT_PROTOCOL;
  const autoFallback = protocolOverride === undefined || protocolOverride === "";
  let onHttp2 = false;
  let quicTimer: NodeJS.Timeout | null = null;
  let switching = false;
  let tunnelReady = false;
  const watchQuic = (text: string) => {
    // cloudflared keeps retrying QUIC and logging each failure, so one seen
    // before the tunnel is ready is simply picked up again after.
    if (!autoFallback || onHttp2 || switching || !tunnelReady) return;
    if (REGISTERED_PATTERN.test(text) && quicTimer) {
      clearTimeout(quicTimer);
      quicTimer = null;
    }
    if (QUIC_FAILURE_PATTERN.test(text) && !quicTimer) {
      quicTimer = setTimeout(() => {
        log("The tunnel couldn't connect over QUIC (UDP may be blocked on this network). Switching to HTTP/2…");
        void replaceTunnel(true);
      }, QUIC_FALLBACK_GRACE_MS);
    }
  };

  let tunnel: { process: ChildProcess; url: string };
  try {
    tunnel = await startTunnel(PORT, [], watchQuic);
    tunnelReady = true;
  } catch (err) {
    cleanup(undefined, caffeinate);
    fail(err instanceof Error ? err.message : String(err));
  }

  console.log("");
  console.log(`[share] Tunnel URL: ${tunnel.url}`);
  updateVercelRedirect(tunnel.url);
  console.log(`[share] Share the link above plus the LOCUS_PASSCODE with whoever needs it.`);
  console.log(`[share] Press Ctrl+C to stop.`);
  console.log("");

  // Only the current tunnel closing on its own stops the app; one share
  // retired on purpose (the HTTP/2 switch, a health-check restart) doesn't.
  const watchExit = (proc: ChildProcess) => {
    proc.on("exit", () => {
      if (proc !== tunnel.process || switching) return;
      log("The tunnel closed. Stopping the app too.");
      cleanup(undefined, caffeinate);
      process.exit(1);
    });
  };

  /**
   * A new tunnel in place of the current one -- over HTTP/2, or as before
   * (still watching QUIC, so the automatic switch applies to it too). The
   * app server isn't touched; the permanent link is repointed.
   */
  async function replaceTunnel(http2: boolean): Promise<void> {
    if (switching) return;
    switching = true;
    if (quicTimer) clearTimeout(quicTimer);
    quicTimer = null;
    tunnelReady = false;
    tunnel.process.kill();
    try {
      tunnel = await startTunnel(PORT, http2 ? ["--protocol", "http2"] : [], watchQuic);
    } catch (err) {
      log(`The new tunnel didn't start (${err instanceof Error ? err.message : err}). Stopping.`);
      cleanup(undefined, caffeinate);
      process.exit(1);
    }
    onHttp2 = http2;
    tunnelReady = true;
    switching = false;
    tunnelFailures = 0;
    linkFailures = 0;
    watchExit(tunnel.process);
    console.log(`[share] Tunnel URL: ${tunnel.url}`);
    updateVercelRedirect(tunnel.url);
  }

  let tunnelFailures = 0;
  let linkFailures = 0;
  let checking = false;
  const healthCheck = async () => {
    if (switching || checking) return;
    checking = true;
    try {
      const url = tunnel.url;
      const t = await probe(url);
      // The app answers (a redirect to /login, normally); Cloudflare's own
      // "tunnel not found / origin unreachable" pages are 5xx (530 and co.).
      const tunnelOk = t.status >= 200 && t.status < 500;
      if (switching || url !== tunnel.url) return;
      if (!tunnelOk) {
        tunnelFailures++;
        log(`Health check: the tunnel isn't reachable (${t.detail}) -- ${tunnelFailures} of ${HEALTH_FAILURES_BEFORE_ACTION}.`);
        if (tunnelFailures >= HEALTH_FAILURES_BEFORE_ACTION) {
          log("Health check: replacing the tunnel. The app keeps running.");
          await replaceTunnel(onHttp2);
        }
        return;
      }
      if (tunnelFailures > 0) log("Health check: the tunnel is reachable again.");
      tunnelFailures = 0;

      if (NO_VERCEL) return;
      const v = await probe(VERCEL_PUBLIC_URL);
      const linkOk = v.status >= 300 && v.status < 400 && v.location.startsWith(tunnel.url);
      if (switching || url !== tunnel.url) return;
      if (!linkOk) {
        linkFailures++;
        const what = v.status === 0 ? v.detail : v.location ? `points at ${v.location}` : `${v.detail}, not a redirect to this tunnel`;
        log(`Health check: the permanent link isn't pointing here (${what}) -- ${linkFailures} of ${HEALTH_FAILURES_BEFORE_ACTION}.`);
        if (linkFailures >= HEALTH_FAILURES_BEFORE_ACTION) {
          linkFailures = 0;
          log("Health check: repointing the permanent link at this tunnel.");
          updateVercelRedirect(tunnel.url);
        }
        return;
      }
      if (linkFailures > 0) log("Health check: the permanent link points here again.");
      linkFailures = 0;
    } finally {
      checking = false;
    }
  };
  setInterval(() => void healthCheck(), HEALTH_INTERVAL_MS);

  const onSignal = () => {
    cleanup(tunnel.process, caffeinate);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  server.on("exit", () => cleanup(tunnel.process, caffeinate));
  watchExit(tunnel.process);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
