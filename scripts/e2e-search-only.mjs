import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

/**
 * End-to-end through the real UI with chat turned off (the default --
 * see src/config/features.ts): Locus as a document search tool. Logs in,
 * checks the search-tool wording and that the model-only pieces are gone,
 * sends a message to a session with no files (upload prompt), uploads two
 * tender PDFs, searches (plain, quoted, zero matches, punctuation hint),
 * then deletes the session and confirms its files went with it.
 *
 * Proves nothing reaches the model two ways at once: every request the
 * browser makes is recorded (none may go to /api/chat or /api/title), and
 * this script runs a stand-in "LM Studio" that only counts requests -- the
 * server under test must be pointed at it, and it must end at zero.
 *
 * Needs a server already running, the same way scripts/e2e-smoke.mjs
 * does (that one is the chat-on run). For example:
 *
 *   LOCUS_PASSCODE=test-pass LOCUS_ENABLE_UPLOADS=true \
 *     LM_STUDIO_BASE_URL=http://127.0.0.1:1239/v1 \
 *     SEARCH_INDEX_PATH=/tmp/locus-e2e/index/search.db UPLOADS_DIR=/tmp/locus-e2e/uploads \
 *     npx next start -p 3100
 *   E2E_BASE_URL=http://localhost:3100 E2E_PASSCODE=test-pass npm run e2e
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PASSCODE = process.env.E2E_PASSCODE;
const TRIPWIRE_PORT = Number(process.env.E2E_TRIPWIRE_PORT ?? 1239);
const TENDERS_DIR = process.env.TENDERS_DIR ?? path.resolve("data/tenders");
const FILE_A = path.join(TENDERS_DIR, "26033Terms-2026-09-23-01_20_49.pdf"); // contains "Tiruchirappalli", p.97 among others
const FILE_B = path.join(TENDERS_DIR, "Bidding_docs-2026-09-16-04_46_27.pdf"); // contains "Spectrophotometer"

let failures = 0;
function check(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

function startTripwire() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(500);
    res.end("tripwire");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(TRIPWIRE_PORT, "127.0.0.1", () => resolve({ hits, server }));
  });
}

/** Sends `text` and returns the text of the reply it gets, once finished. */
async function sendAndWait(page, text) {
  const replies = page.locator("div.w-full.text-left");
  const before = await replies.count();
  await page.locator("textarea").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (n) => {
      const all = document.querySelectorAll("div.w-full.text-left");
      if (all.length <= n) return false;
      const last = all[all.length - 1].innerText;
      return last.trim().length > 0 && !/^Searching/.test(last.trim());
    },
    before,
    { timeout: 20000 }
  );
  return replies.last().innerText();
}

async function main() {
  if (!PASSCODE) {
    console.error("Set E2E_PASSCODE to the passcode the running server expects.");
    process.exit(1);
  }

  const tripwire = await startTripwire();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (req) => requests.push(new URL(req.url()).pathname));

  await page.goto(BASE);
  await page.waitForURL(/\/login/);
  await page.fill('input[type="password"]', PASSCODE);
  await page.click('button[type="submit"]');
  await page.waitForURL(BASE + "/", { timeout: 10000 });
  check("login succeeds", page.url() === BASE + "/");

  // Start from a clean slate: one fresh session, nothing in localStorage.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("textarea");
  await page.waitForTimeout(1500); // let /api/config and /api/storage settle

  const empty = await page.locator("body").innerText();
  const placeholder = await page.locator("textarea").getAttribute("placeholder");
  check('empty state heading is "Search your documents"', empty.includes("Search your documents"));
  check(
    "composer placeholder is the search one",
    placeholder === "Type a word or phrase to find it in your files",
    placeholder ?? ""
  );
  check(
    'chips are "Upload documents" and "Find a phrase", with no "Read a link"',
    empty.includes("Upload documents") && /Find a phrase(?! in files)/.test(empty) && !empty.includes("Read a link")
  );
  check('no "<model> · running locally" pill', !empty.includes("running locally"));
  check('sidebar has "New session" and a "Sessions" list', empty.includes("New session") && /sessions/i.test(empty));
  check('no chat wording ("New chat", "Recent")', !empty.includes("New chat") && !/\bRecent\b/i.test(empty));

  // A message before any file is uploaded: the upload prompt, not a search.
  const noFiles = await sendAndWait(page, "Tiruchirappalli");
  check("with no files yet, a message gets the upload prompt", noFiles.includes("This session has no documents yet"));
  check("…and no results card", !noFiles.includes("Found on") && !noFiles.includes("No matches"));
  check('untitled header fallback is never "New chat"', !(await page.locator("body").innerText()).includes("New chat"));

  await page.locator('input[type="file"]').setInputFiles([FILE_A, FILE_B]);
  await page.waitForFunction(
    () => (document.body.innerText.match(/\d+ pages?\b/g) ?? []).length >= 2,
    null,
    { timeout: 180000 }
  );
  check("both files finish uploading (Uploading → Reading → … → page count)", true);

  const plain = await sendAndWait(page, "Tiruchirappalli");
  const showMore = page.locator('button:has-text("Show")').last();
  if (await showMore.isVisible().catch(() => false)) await showMore.click();
  const plainAfter = await page.locator("body").innerText();
  check(
    "a plain message is searched as exact text: results card with the file and Page 97",
    plain.includes("Found on") && plainAfter.includes("26033Terms") && plainAfter.includes("Page 97")
  );
  check("no Thinking stage on a search turn", !plainAfter.includes("Thinking") && !plainAfter.includes("Thought for"));

  const quoted = await sendAndWait(page, 'where does it say "Spectrophotometer"?');
  check(
    "a quoted phrase searches just the quote",
    quoted.includes("Found on") && quoted.includes("Bidding_docs-2026-09-16")
  );

  const none = await sendAndWait(page, "zqxjvbw nonexistent phrase");
  check('zero matches still shows a card saying "No matches in your files"', none.includes("No matches in your files"));

  const punct = await sendAndWait(page, "Tiruchirappalli%");
  check(
    "exact miss that loose mode finds offers the punctuation hint",
    punct.includes("No matches in your files") && punct.includes("without exact punctuation")
  );

  // Delete this session from the sidebar; its files must go with it.
  const conversationId = await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem("chat-conversations") ?? "[]");
    return all.find((c) => c.messages.length > 0)?.id ?? null;
  });
  const filesBefore = await page.evaluate(
    async (id) => (await (await fetch(`/api/uploads?conversationId=${encodeURIComponent(id)}`)).json()).documents.length,
    conversationId
  );
  const row = page.locator("nav .group").first();
  await row.hover();
  await row.locator('button[aria-label="Delete session"]').click();
  const confirmText = await page.locator("nav").innerText();
  await page.locator('nav button:has-text("Delete")').click();
  await page.waitForTimeout(1500);
  const filesAfter = await page.evaluate(
    async (id) => (await (await fetch(`/api/uploads?conversationId=${encodeURIComponent(id)}`)).json()).documents.length,
    conversationId
  );
  check("delete asks about the session and its files", confirmText.includes("Delete this session"));
  check("deleting a session deletes its files", filesBefore === 2 && filesAfter === 0, `${filesBefore} → ${filesAfter}`);

  await browser.close();

  const modelCalls = requests.filter((p) => p.startsWith("/api/chat") || p.startsWith("/api/title"));
  check("the browser never called /api/chat or /api/title", modelCalls.length === 0, modelCalls.join(", "));
  check(
    "the server never reached LM Studio (tripwire saw 0 requests)",
    tripwire.hits.length === 0,
    tripwire.hits.join(", ")
  );
  check("searches went to /api/session-search", requests.filter((p) => p === "/api/session-search").length === 5);
  tripwire.server.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error("e2e-search-only.mjs crashed:", err);
  process.exit(1);
});
