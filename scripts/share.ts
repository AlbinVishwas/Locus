import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/**
 * `npm run share`: everything needed to hand someone a working, public
 * link to this laptop's Assay -- checks, build, start, tunnel -- in one
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

const CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function startTunnel(port: number): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);
    let settled = false;
    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
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
  if (!commandExists("cloudflared")) {
    fail("cloudflared is not installed. Install it with: brew install cloudflared");
  }

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

  log("Building…");
  const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
  const buildExit = await new Promise<number>((resolve) => build.on("exit", (code) => resolve(code ?? 1)));
  if (buildExit !== 0) fail(`Build failed (exit ${buildExit}).`);

  log(`Starting on port ${PORT}…`);
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    ASSAY_ENABLE_UPLOADS: "true",
    LOCAL_CHAT_ENABLE_URL_CONTEXT: "true",
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
  let tunnel: { process: ChildProcess; url: string };
  try {
    tunnel = await startTunnel(PORT);
  } catch (err) {
    cleanup(undefined, caffeinate);
    fail(err instanceof Error ? err.message : String(err));
  }

  console.log("");
  console.log(`[share] Public URL: ${tunnel.url}`);
  console.log(`[share] Share that link plus the ASSAY_PASSCODE with whoever needs it.`);
  console.log(`[share] Press Ctrl+C to stop.`);
  console.log("");

  const onSignal = () => {
    cleanup(tunnel.process, caffeinate);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  server.on("exit", () => cleanup(tunnel.process, caffeinate));
  tunnel.process.on("exit", () => {
    log("The tunnel closed. Stopping the app too.");
    cleanup(undefined, caffeinate);
    process.exit(1);
  });
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
