/**
 * One-off check of "Choose folder" on the LIVE public link, using two throwaway
 * accounts that are deleted afterwards (the real accounts' passwords are not used).
 * Generated test folders only; every upload and session the accounts made is deleted.
 *
 *   node --import tsx scripts/live-folder-pick-check.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { chromium } from "playwright";
import { runFolderPickChecks } from "./e2e-folder-pick-lib.mjs";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
const LIVE = process.env.LIVE_URL ?? "https://local-chat-one-ivory.vercel.app";

async function main() {
  const { getRecordsDb } = await import("../src/lib/records/db");
  const { createUser, removeUser, findUserByName } = await import("../src/lib/records/users");
  const { generatePasscode } = await import("../src/lib/records/passcodes");
  const db = getRecordsDb();
  const names = ["zz-pick-a", "zz-pick-b"];
  const pw = names.map(() => generatePasscode(20));
  for (const [i, n] of names.entries()) await createUser(db, { username: n, passcode: pw[i], createdBy: "admin" });
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "locus-live-pick-"));
  execFileSync("node", ["--import", "tsx", "scripts/folder-pick-fixtures.ts", fixtures], { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let failures = 1;
  try {
    const login = async (i: number) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(LIVE);
      await page.waitForSelector('input[placeholder="Username"]', { timeout: 60000 });
      const origin = new URL(page.url()).origin;
      await page.fill('input[placeholder="Username"]', names[i]);
      await page.fill('input[placeholder="Password"]', pw[i]);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${origin}/`, { timeout: 30000 });
      await page.waitForSelector("textarea");
      await page.waitForTimeout(1500);
      return { ctx, page, origin };
    };
    failures = await runFolderPickChecks({ fixtures, expectLimits: false, loginA: () => login(0), loginB: () => login(1) });
  } finally {
    await browser.close();
    fs.rmSync(fixtures, { recursive: true, force: true });
    // Whatever the run left behind (a crashed run included): every session the two accounts own goes, files and index rows with it.
    const { deleteConversationUploads } = await import("../src/lib/uploads/pipeline");
    for (const n of names) {
      const u = findUserByName(db, n);
      if (!u) continue;
      const ids = db.prepare("SELECT conversation_id FROM conversation_owners WHERE user_id = ?").pluck().all(u.id) as string[];
      for (const id of ids) await deleteConversationUploads(id);
    }
    for (const n of names) {
      const u = findUserByName(db, n);
      if (u) removeUser(db, u.id);
      db.prepare("DELETE FROM activity WHERE username = ?").run(n);
    }
    db.prepare("DELETE FROM conversation_owners WHERE user_id NOT IN (SELECT id FROM users)").run();
    const left = db.prepare("SELECT count(*) FROM users WHERE username IN (?, ?)").pluck().get(...names);
    console.log(`${left === 0 ? "PASS" : "FAIL"}  the two throwaway accounts are deleted`);
    const idx = new (await import("better-sqlite3")).default((await import("../src/lib/search/indexDb")).indexPath(), { readonly: true });
    const docs = idx.prepare("SELECT count(*) FROM documents WHERE conversation_id LIKE 'fld_%' OR original_filename IN ('control.pdf','tender-a.pdf','tender-b-scanned.pdf','Annex/annex-c.pdf')").pluck().get();
    console.log(`${docs === 0 ? "PASS" : "FAIL"}  no test documents are left in the live index (${docs} found)`);
    idx.close();
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
