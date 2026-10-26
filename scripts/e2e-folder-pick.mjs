import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { runFolderPickChecks } from "./e2e-folder-pick-lib.mjs";
import { startEnv } from "./sources-env.mjs";

/**
 * End to end for "Choose folder": pick a folder on the user's own device, its PDFs are
 * uploaded and indexed, a chip limits searches to it, and it stays private to the account.
 * Runs its own scratch Locus (scripts/sources-env.mjs, port 3216) with small limits so the
 * "too many files" and "too big" messages can be seen.
 *
 *   npm run build && npm run e2e:folder-pick
 */

async function signUp(browser, base, username, password, code) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.click('button:has-text("Create an account")');
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder^="Choose a password"]', password);
  await page.fill('input[placeholder="Sign-up code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`, { timeout: 15000 });
  await page.waitForSelector("textarea");
  await page.waitForTimeout(1200);
  return { ctx, page, origin: base };
}

async function main() {
  const env = await startEnv({
    port: Number(process.env.E2E_PORT ?? 3216),
    drive: false,
    worker: false,
    extraEnv: { MAX_FOLDER_FILES: "4", MAX_UPLOAD_FILE_BYTES: "500000", LOCUS_USER_SOURCES: "true" },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let failures = 1;
  try {
    const fixtures = path.join(env.dir, "folder-fixtures");
    execFileSync("node", ["--import", "tsx", "scripts/folder-pick-fixtures.ts", fixtures], { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
    const shotsDir = process.env.SAVE_SHOTS === "1" ? path.resolve("docs/screenshots") : process.env.SHOTS_DIR;
    if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
    failures = await runFolderPickChecks({
      fixtures,
      shotsDir,
      loginA: () => signUp(browser, env.base, "alice", "alice password 1", env.signupCode),
      loginB: () => signUp(browser, env.base, "bob", "bob password 22", env.signupCode),
    });
  } finally {
    await browser.close();
    await env.stop();
  }
  console.log(failures === 0 ? "\nAll folder-pick checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
