import path from "node:path";
import { chromium } from "playwright";

/**
 * End-to-end through the real UI, in a real (headless) browser: log in,
 * upload two tender PDFs into a conversation, wait for both to finish
 * indexing, search for a phrase from each, confirm a fresh conversation
 * with no uploads stays silent about search entirely, and confirm an
 * ordinary chat message still works.
 *
 * Needs a server already running with uploads enabled and a known
 * passcode -- this script doesn't start one, the same way verify-index.ts
 * doesn't build an index. For example:
 *
 *   LOCUS_PASSCODE=test-pass LOCUS_ENABLE_UPLOADS=true npm run dev
 *   E2E_PASSCODE=test-pass npm run e2e
 *
 * Point it at a different index/uploads dir (SEARCH_INDEX_PATH,
 * UPLOADS_DIR when starting the server above) if you don't want this
 * touching the main one -- it uploads real content into whichever index
 * the server you started is using.
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PASSCODE = process.env.E2E_PASSCODE;
const TENDERS_DIR = process.env.TENDERS_DIR ?? path.resolve("data/tenders");
const FILE_A = path.join(TENDERS_DIR, "26033Terms-2026-09-23-01_20_49.pdf"); // contains "Tiruchirappalli", p.97 among others
const FILE_B = path.join(TENDERS_DIR, "Bidding_docs-2026-09-16-04_46_27.pdf"); // contains "Spectrophotometer"

let failures = 0;
function check(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function waitForText(page, text, timeoutMs = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: timeoutMs });
}

async function main() {
  if (!PASSCODE) {
    console.error("Set E2E_PASSCODE to the passcode the running server expects.");
    process.exit(1);
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  await page.goto(BASE);
  await page.waitForURL(/\/login/);
  check("unauthenticated visit redirects to /login", page.url().includes("/login"));

  await page.fill('input[type="password"]', PASSCODE);
  await page.click('button[type="submit"]');
  await page.waitForURL(BASE + "/", { timeout: 10000 });
  check("login succeeds and lands on the chat page", page.url() === BASE + "/");

  // Two tender PDFs into this (fresh) conversation. Files don't expire by
  // default any more -- a ready file's chip shows its page count instead
  // (e.g. "264 pages"), which is what marks it done here. This runs
  // before any search, so "pages" text on the page can only come from
  // these two chips.
  await page.locator('input[type="file"]').setInputFiles([FILE_A, FILE_B]);
  await page.waitForFunction(
    () => (document.body.innerText.match(/\d+ pages?/g) ?? []).length >= 2,
    null,
    { timeout: 180000 }
  );
  check("both uploaded files reach Ready (show a page count)", true);

  const textarea = page.locator("textarea");

  // A phrase only on page 97 of the first file (and a few others --
  // confirms the collapsed "show more" reveals it, not just the first
  // few hits).
  await textarea.fill("Tiruchirappalli");
  await page.keyboard.press("Enter");
  await waitForText(page, "pages in"); // the card itself, not the attachment chip's filename
  const showMore = page.locator('button:has-text("Show")').first();
  if (await showMore.isVisible().catch(() => false)) await showMore.click();
  await waitForText(page, "Page 97", 10000).catch(() => {});
  const firstSearchText = await page.locator("body").innerText();
  check(
    'search for a phrase in file A finds it, including a page past the initial 3 shown',
    firstSearchText.includes("26033Terms") && firstSearchText.includes("Page 97")
  );

  // A phrase from the other file.
  await textarea.fill("Spectrophotometer");
  await page.keyboard.press("Enter");
  await waitForText(page, "pages in");
  const secondSearchText = await page.locator("body").innerText();
  check("search for a phrase in file B finds it", secondSearchText.includes("Bidding_docs-2026-09-16"));

  // A brand new conversation has no uploads -- document search doesn't
  // run at all for it, so there's no card and no "nothing found" line
  // either; it's silent, exactly like ordinary chat always was.
  await page.click('button:has-text("New chat")');
  await page.waitForTimeout(500);
  await textarea.fill("Tiruchirappalli");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  const newConvText = await page.locator("body").innerText();
  check(
    "a conversation with no uploads shows no search card or result line at all",
    !newConvText.includes("pages in") && !newConvText.includes("No page in this conversation")
  );

  // An ordinary message still works, with no search card.
  await textarea.fill("hello");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const plainMessageText = await page.locator("body").innerText();
  check(
    "a normal chat message in a conversation with no files shows no search card",
    !plainMessageText.slice(plainMessageText.lastIndexOf("hello")).includes("pages in")
  );

  await browser.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error("e2e-smoke.mjs crashed:", err);
  process.exit(1);
});
