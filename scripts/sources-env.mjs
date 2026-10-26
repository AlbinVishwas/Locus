import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway Locus for the Sources checks: users mode with an admin, the
 * library on, a scratch data folder, an allowed location holding generated
 * fixtures, a mock Google Drive, the production server (`next start`; build
 * first) and the real indexer worker -- all on loopback, all deleted on stop.
 *
 *   const env = await startEnv();   // { base, dir, roots, adminPasscode, signupCode, stop() }
 */

export const ADMIN_PASSCODE = "e2e-admin-passcode";
export const SIGNUP_CODE = "e2e-signup-code";
export const DRIVE_LINK = "https://drive.google.com/drive/folders/1MockDriveFolderIdForLocusTests?usp=sharing";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsx = ["--import", "tsx"];

function logTo(file, child) {
  const out = fs.createWriteStream(file);
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
}

export async function startEnv({ port = Number(process.env.E2E_PORT ?? 3210), worker = true, drive = true, extraEnv = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-sources-env-")));
  const children = [];
  const stop = async () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await sleep(1500);
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (process.env.KEEP_ENV !== "1") fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`(kept ${dir})`);
  };

  try {
    execFileSync("node", [...tsx, "scripts/sources-env-setup.ts", dir], { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
    const roots = path.join(dir, "roots");

    const env = {
      ...process.env,
      TSX_DISABLE_CACHE: "1",
      PORT: String(port),
      LOCUS_USERS_ENABLED: "true",
      LOCUS_ADMIN_PASSCODE: ADMIN_PASSCODE,
      // Set explicitly: `next start` and the worker also read .env.local, whose values must not leak into this scratch run.
      LOCUS_SIGNUP: "code",
      LOCUS_SIGNUP_CODE: SIGNUP_CODE,
      SESSION_SECRET: "e2e-session-secret-e2e-session-secret-1234",
      LOCUS_SECRETS_KEY: "e2e-secrets-key-e2e-secrets-key-e2e-secrets",
      LOCUS_APP_DB_PATH: path.join(dir, "app", "records.db"),
      LOCUS_LIBRARY_ENABLED: "true",
      LOCUS_DATA_DIR: path.join(dir, "data"),
      LOCUS_ALLOWED_ROOTS: roots,
      LOCUS_ENABLE_UPLOADS: "true",
      SEARCH_INDEX_PATH: path.join(dir, "index", "search.db"),
      OCR_CACHE_PATH: path.join(dir, "index", "ocr-cache.db"),
      UPLOADS_DIR: path.join(dir, "uploads"),
      LM_STUDIO_BASE_URL: "http://127.0.0.1:1/v1",
      LOCUS_CHAT_ENABLED: "false",
      ...extraEnv,
    };
    delete env.LOCUS_PASSCODE;
    delete env.ASSAY_PASSCODE;

    if (drive) {
      const mock = spawn("node", [...tsx, "scripts/mock-drive.ts", path.join(dir, "drive-tree.json")], { env, stdio: ["ignore", "pipe", "inherit"] });
      children.push(mock);
      const line = await new Promise((resolve, reject) => {
        let buf = "";
        mock.stdout.on("data", (d) => {
          buf += d;
          if (buf.includes("\n")) resolve(buf.split("\n")[0]);
        });
        mock.on("exit", () => reject(new Error("mock drive exited")));
        setTimeout(() => reject(new Error("mock drive didn't start")), 30000);
      });
      const { base, apiKey } = JSON.parse(line);
      env.GOOGLE_API_KEY = apiKey;
      env.GOOGLE_DRIVE_API_BASE = base;
    }

    const server = spawn("npx", ["next", "start", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(server);
    logTo(path.join(dir, "server.log"), server);
    const base = `http://localhost:${port}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/login`)).ok) break;
      } catch {
        // not up yet
      }
      if (i > 120) throw new Error(`the server didn't start; see ${path.join(dir, "server.log")}`);
      await sleep(500);
    }

    if (worker) {
      const w = spawn("node", [...tsx, "scripts/library-worker.ts", "--poll", "500"], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(w);
      logTo(path.join(dir, "worker.log"), w);
    }
    return { base, dir, roots, adminPasscode: ADMIN_PASSCODE, signupCode: SIGNUP_CODE, driveLink: DRIVE_LINK, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
