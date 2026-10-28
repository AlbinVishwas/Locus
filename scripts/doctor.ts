/**
 * npm run doctor: checks this computer is ready to run Locus, and for every problem prints the exact command that
 * fixes it on macOS, Windows and Ubuntu. Exit code 1 if something that stops Locus is wrong; warnings (OCR missing,
 * a low disk) don't fail it. Works the same on every system: no shell commands, only argument lists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import Database from "better-sqlite3";
import { defaultDataDir } from "../src/lib/library/config";
import { loadServerConfig, ServerConfigError, describeServer } from "../src/lib/server/config";
import { createConnector } from "../src/lib/server/connector";
import { diskInfo, mbOrGb, reserveBytes } from "../src/lib/server/disk";
import { checkTools, INSTALL, platformName, type Platform } from "../src/lib/server/tools";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

type Level = "ok" | "warn" | "fail";
interface Result {
  level: Level;
  name: string;
  detail: string;
  fix?: Partial<Record<Platform, string>> | string;
}
const results: Result[] = [];
const add = (level: Level, name: string, detail: string, fix?: Result["fix"]) => results.push({ level, name, detail, fix });

function readNvmrc(): number {
  try {
    return Number(fs.readFileSync(path.join(process.cwd(), ".nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0]);
  } catch {
    return 22;
  }
}

async function main() {
  // 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  const want = readNvmrc();
  if (major >= want) add("ok", "Node.js", `${process.version} (needs ${want} or newer)`);
  else add("fail", "Node.js", `${process.version} is too old; Locus needs ${want} or newer`, INSTALL.node);

  // 2. poppler, tesseract
  const tools = checkTools();
  if (tools.poppler.ok) add("ok", "poppler (pdftotext, pdftoppm, pdfinfo, pdfimages)", "installed");
  else add("fail", "poppler", `missing: ${tools.poppler.missing.join(", ")}. Without it PDFs can't be read.`, INSTALL.poppler);
  if (!tools.tesseract.ok) {
    add("warn", "tesseract (OCR)", "not installed. Locus still runs and reads PDFs that have a text layer; scanned pages are skipped until it's installed.", INSTALL.tesseract);
  } else {
    if (tools.tesseract.hasEnglish) add("ok", "tesseract English data", "installed");
    else add("warn", "tesseract English data", "missing 'eng': scanned pages can't be read", INSTALL.tesseract);
    if (tools.tesseract.hasHindi) add("ok", "tesseract Hindi data", "installed");
    else add("warn", "tesseract Hindi data", "missing 'hin': Hindi scanned pages will be read badly", INSTALL.hindi);
  }

  // 3. SQLite with the trigram index
  try {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram case_sensitive 1')");
    db.prepare("INSERT INTO t (x) VALUES (?)").run("search works");
    const hit = db.prepare("SELECT count(*) FROM t WHERE t MATCH ?").pluck().get('"arch wo"');
    db.close();
    if (hit === 1) add("ok", "SQLite full-text index (better-sqlite3, FTS5 trigram)", "works");
    else add("fail", "SQLite full-text index", "the trigram search returned the wrong answer", "Run: npm rebuild better-sqlite3");
  } catch (err) {
    add("fail", "SQLite full-text index (better-sqlite3)", `can't load: ${err instanceof Error ? err.message : err}`, "Run: npm rebuild better-sqlite3   (it normally installs a prebuilt file for macOS, Windows and Linux)");
  }

  // 4. Settings
  const envFile = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envFile)) add("fail", ".env.local", "not found", "Run: npm run setup");
  else {
    add("ok", ".env.local", "found");
    if (!process.env.SESSION_SECRET) add("fail", "SESSION_SECRET", "not set", "Run: npm run setup");
    if (process.env.LOCUS_USERS_ENABLED === "true" && !process.env.LOCUS_ADMIN_PASSCODE && !process.env.LOCUS_ADMIN_PASSCODE_HASH) add("fail", "Admin password", "accounts are on but there is no admin password", "Run: npm run setup");
  }

  // 5. Data folder: writable, with room
  const dataDir = process.env.LOCUS_DATA_DIR ? path.resolve(process.env.LOCUS_DATA_DIR) : defaultDataDir();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.locus-write-test-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    add("ok", "Index folder is writable", dataDir);
  } catch (err) {
    add("fail", "Index folder", `can't write to ${dataDir}: ${err instanceof Error ? err.message : err}`, "Choose another folder: set LOCUS_DATA_DIR in .env.local to a folder you can write to");
  }
  try {
    const d = diskInfo(dataDir);
    const reserve = reserveBytes();
    if (d.freeBytes - reserve > 0) add("ok", "Free disk space", `${mbOrGb(d.freeBytes)} free on the disk holding the index (${mbOrGb(reserve)} is always kept in reserve)`);
    else add("fail", "Free disk space", `only ${mbOrGb(d.freeBytes)} free, and ${mbOrGb(reserve)} is kept in reserve (LOCUS_MIN_FREE_GB)`, "Free up space, or set LOCUS_DATA_DIR to a folder on a disk with more room");
  } catch (err) {
    add("warn", "Free disk space", `couldn't be measured: ${err instanceof Error ? err.message : err}`);
  }

  // 6. The storage server
  try {
    const cfg = loadServerConfig();
    if (cfg.type === "none") add("warn", "Storage server", "none connected (LOCUS_SERVER_TYPE=none). Uploads and My folders still work.", "Run: npm run setup   to connect one");
    else {
      const connector = createConnector(cfg);
      try {
        const t = await connector.test(AbortSignal.timeout(20_000));
        if (t.ok) add("ok", "Storage server", `${describeServer(cfg)}: ${t.message}`);
        else add("fail", "Storage server", `${describeServer(cfg)}: ${t.message}${t.code ? ` (${t.code})` : ""}`, "Check the server is on and reachable, and the LOCUS_SERVER_* settings in .env.local");
      } finally {
        await connector.close();
      }
    }
  } catch (err) {
    if (err instanceof ServerConfigError) add("fail", "Storage server settings", err.message, "Run: npm run setup, or fix LOCUS_SERVER_* in .env.local (see .env.example)");
    else throw err;
  }

  // Print
  const plat = platformName();
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  console.log(`\nLocus doctor — ${os.type()} ${os.release()} (${os.arch()}), Node ${process.version}\n`);
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.name}: ${r.detail}`);
    if (r.level !== "ok" && r.fix) {
      if (typeof r.fix === "string") console.log(`    fix: ${r.fix}`);
      else {
        const mine = r.fix[plat];
        console.log(`    fix (${plat === "mac" ? "macOS" : plat === "windows" ? "Windows" : "Linux"}): ${mine}`);
        for (const p of ["mac", "windows", "linux"] as Platform[]) if (p !== plat && r.fix[p]) console.log(`    ${p === "mac" ? "macOS" : p === "windows" ? "Windows" : "Ubuntu"}: ${r.fix[p]}`);
      }
    }
  }
  const failed = results.filter((r) => r.level === "fail").length;
  const warned = results.filter((r) => r.level === "warn").length;
  console.log(`\n${failed === 0 ? "Ready." : `${failed} problem${failed === 1 ? "" : "s"} to fix.`}${warned ? ` ${warned} warning${warned === 1 ? "" : "s"}.` : ""}`);
  console.log(`Index folder: ${dataDir}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
