import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startEnv } from "./sources-env.mjs";

/**
 * End to end for "Searchable now": a picked folder whose typed PDFs are searchable the moment they
 * are indexed, while the scanned pages of another are still being read. Checks the chip and the
 * "Searchable now · improving N scanned pages" line appear without waiting for the OCR, that a
 * typed file is found meanwhile, that the line gives way to "Ready" and the scanned words become
 * searchable, and that a dropped upload is resent without adding the file twice.
 *
 * Runs its own scratch Locus (scripts/sources-env.mjs, port 3217) with one OCR process, so
 * reading the scanned pages takes long enough to see.
 *
 *   npm run build && npm run e2e:searchable-now
 */

let failures = 0;
const check = (step, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = await startEnv({
    port: Number(process.env.E2E_PORT ?? 3217),
    drive: false,
    worker: false,
    extraEnv: { OCR_CONCURRENCY: "1", OCR_DPI: "500", LOCUS_UPLOAD_PARALLEL: "2", LOCUS_USER_SOURCES: "true" },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const fixtures = path.join(env.dir, "fixtures");
    execFileSync("node", ["--import", "tsx", "scripts/searchable-now-fixtures.ts", fixtures], { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
    const pack = path.join(fixtures, "Mixed");
    const shots = process.env.SHOTS_DIR;
    if (shots) fs.mkdirSync(shots, { recursive: true });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${env.base}/login`);
    await page.click('button:has-text("Create an account")');
    await page.fill('input[placeholder="Username"]', "carol");
    await page.fill('input[placeholder^="Choose a password"]', "carol password 3");
    await page.fill('input[placeholder="Sign-up code"]', env.signupCode);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${env.base}/`, { timeout: 15000 });
    await page.waitForSelector("textarea");
    await page.waitForTimeout(1200);

    const limits = await (await ctx.request.get(`${env.base}/api/folders`)).json();
    check("the server tells the browser how many files to send at once (LOCUS_UPLOAD_PARALLEL=2)", limits.uploadParallel === 2, JSON.stringify(limits));

    // Drop the first upload request on the floor, as a flaky connection would.
    let posts = 0;
    let dropped = false;
    await page.route("**/api/uploads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (!dropped) {
        dropped = true;
        return route.abort("failed");
      }
      return route.continue();
    });

    await page.addInitScript(() => {
      window.__seen = [];
      new MutationObserver(() => {
        const el = document.querySelector('[data-testid="folder-progress"]');
        if (el) window.__seen.push(el.innerText.replace(/\s+/g, " ").trim());
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.reload();
    await page.waitForSelector("textarea");

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose folder" }).click()]);
    const started = Date.now();
    await chooser.setFiles(pack);
    await page.waitForSelector('[data-testid="folder-chip"]', { timeout: 120000 });
    const toChip = (Date.now() - started) / 1000;
    const panel = (await page.locator('[data-testid="folder-progress"]').innerText().catch(() => "")).replace(/\s+/g, " ");
    check("the chip appears while scanned pages are still being read", /Searchable now · improving \d+ scanned pages?/.test(panel), `${toChip.toFixed(1)} s after the pick; "${panel.slice(0, 150)}"`);
    check("…with a progress bar for the scanned pages", (await page.locator('[role="progressbar"][aria-label="Scanned pages being read"]').count()) === 1);
    if (shots) await page.screenshot({ path: path.join(shots, "searchable-now-1440.png") });

    // The count goes down as the pages are read.
    const left = async () => Number(((await page.locator('[data-testid="folder-progress"]').innerText().catch(() => "")).match(/improving (\d+) scanned page/) ?? [])[1] ?? NaN);
    const first = await left();
    await sleep(6000);
    const later = await left();
    check("the number of pages left goes down while the pages are read", later < first, `${first} -> ${later}`);

    // A typed file is found right away.
    const ask = async (text) => {
      const replies = page.locator("div.w-full.text-left");
      const before = await replies.count();
      await page.locator("textarea").fill(text);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (n) => {
          const all = document.querySelectorAll("div.w-full.text-left");
          if (all.length <= n) return false;
          const last = all[all.length - 1].innerText.trim();
          return last.length > 0 && !/^Searching/.test(last);
        },
        before,
        { timeout: 60000 }
      );
      await page.waitForTimeout(400);
      return replies.last().innerText();
    };
    const typed = await ask("TYPED-ALPHA-PHRASE");
    check("meanwhile a typed file is already searchable", /typed-one\.pdf/.test(typed), typed.slice(0, 90).replace(/\n/g, " "));

    // The scanned pages finish, and their words become searchable.
    const scope = await page.evaluate(() => JSON.parse(sessionStorage.getItem("locus.folderScope")));
    let docs = [];
    for (let i = 0; i < 240; i++) {
      docs = (await (await ctx.request.get(`${env.base}/api/uploads?conversationId=${scope.conversationId}`)).json()).documents;
      if (docs.length === 3 && docs.every((d) => d.status === "ready")) break;
      await sleep(1000);
    }
    const total = (Date.now() - started) / 1000;
    check("the scanned pages finish and every file is ready", docs.length === 3 && docs.every((d) => d.status === "ready"), `${total.toFixed(1)} s after the pick`);
    const scanned = await ask("Zircon valve");
    check("…and the scanned pages are searchable", /scans\.pdf/.test(scanned), scanned.slice(0, 90).replace(/\n/g, " "));

    // The dropped upload was sent again, and the file is there once.
    check("a dropped upload was sent again (4 requests for 3 files)", posts === 4, `${posts} requests`);
    check("…and no file was added twice", docs.length === 3, docs.map((d) => `${d.originalFilename}:${d.status}`).join(", "));

    // Phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("no sideways scroll at 390 px", overflow <= 0, `${overflow}px`);
    if (shots) await page.screenshot({ path: path.join(shots, "searchable-now-390.png") });

    await ctx.request.delete(`${env.base}/api/uploads?conversationId=${encodeURIComponent(scope.conversationId)}`);
    await ctx.close();
    await sleep(200);
  } finally {
    await browser.close();
    await env.stop();
  }
  console.log(failures === 0 ? "\nAll searchable-now checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
