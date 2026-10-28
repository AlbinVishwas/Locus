/**
 * npm start: Locus in production mode on this computer. Starts the web app (next start) and, when a storage
 * server or the library is set up, the indexer worker that reads the server and keeps the index up to date; stops
 * both together on Ctrl+C. No tunnel and no Vercel link: that is the optional `npm run share`.
 *
 * Build first: npm run build (npm start says so if you haven't). Settings come from .env.local.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { isLibraryEnabled } from "../src/lib/library/config";
import { adminEnabled } from "../src/lib/users/mode";

function fail(message: string): never {
  console.error(`[locus] ${message}`);
  process.exit(1);
}
const log = (m: string) => console.log(`[locus] ${m}`);

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

if (!fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) fail("There is no production build yet. Run: npm run build   (then npm start)");
if (!process.env.SESSION_SECRET) fail("SESSION_SECRET isn't set in .env.local. Run: npm run setup");

const port = process.env.PORT || "3000";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  PORT: port,
  // Uploads are allowed on a computer you run yourself (the production default is off for a public deployment).
  LOCUS_ENABLE_UPLOADS: process.env.LOCUS_ENABLE_UPLOADS ?? "true",
};

// next is started through node, not npx or a shell, so it works the same on Windows.
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const children: ChildProcess[] = [];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  log("Stopping…");
  for (const c of children) c.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const server = spawn(process.execPath, [nextBin, "start", "-p", port], { stdio: "inherit", env });
children.push(server);
server.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
});

if (isLibraryEnabled() && adminEnabled()) {
  log("Starting the indexer (it reads the storage server and keeps the index up to date)…");
  // LOCUS_WORKER_PARENT_PID: the worker stops by itself if this process is killed without getting to stop it.
  const worker = spawn(process.execPath, ["--import", "tsx", path.join("scripts", "library-worker.ts")], { stdio: "inherit", env: { ...env, TSX_DISABLE_CACHE: "1", LOCUS_WORKER_PARENT_PID: String(process.pid) } });
  children.push(worker);
  worker.on("exit", (code, signal) => {
    if (!stopping) log(`The indexer stopped (${signal ?? `exit ${code}`}). Searching still works; restart Locus to start it again.`);
  });
} else {
  log("The indexer isn't started: set LOCUS_LIBRARY_ENABLED=true, LOCUS_USERS_ENABLED=true and an admin password (npm run setup).");
}
log(`Open http://localhost:${port}`);
