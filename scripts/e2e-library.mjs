import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

/**
 * End-to-end through the real UI with the document library ON (chat off):
 * the scope dropdown and status line, a library-only search (folder paths,
 * pages, no session search made), "show more" paging, the too-short and
 * punctuation messages, a "Both" search alongside an uploaded session
 * file, the scope surviving a reload, and the drive being disconnected
 * and reconnected -- with nothing reaching /api/chat, /api/title or LM
 * Studio, and no absolute path ever on screen.
 *
 * With the library OFF, the existing `npm run e2e` is the check: it must
 * pass unchanged.
 *
 *   D=/tmp/locus-e2e-library
 *   npm run e2e:library:setup -- $D/data
 *   LOCUS_LIBRARY_ENABLED=true LOCUS_DATA_DIR=$D/data \
 *     LOCUS_PASSCODE=test-pass LOCUS_ENABLE_UPLOADS=true LM_STUDIO_BASE_URL=http://127.0.0.1:1239/v1 \
 *     LOCUS_APP_DIR=$D/app SEARCH_INDEX_PATH=$D/index/search.db UPLOADS_DIR=$D/uploads npx next start -p 3100
 *   E2E_BASE_URL=http://localhost:3100 E2E_PASSCODE=test-pass E2E_DATA_DIR=$D/data E2E_APP_DIR=$D/app npm run e2e:library
 *
 * E2E_CHAT=true runs the chat-on variant instead (the server started with
 * LOCUS_CHAT_ENABLED=true and a real LM Studio): the library card appears
 * above the model's reply.
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PASSCODE = process.env.E2E_PASSCODE;
const DATA_DIR = process.env.E2E_DATA_DIR;
const CHAT = process.env.E2E_CHAT === "true";
const TRIPWIRE_PORT = Number(process.env.E2E_TRIPWIRE_PORT ?? 1239);
const TENDERS_DIR = process.env.TENDERS_DIR ?? path.resolve("data/tenders");
const SESSION_FILE = path.join(TENDERS_DIR, "Annexure_B-2026-09-23-04_16_44.pdf"); // contains "bidder"
const UPLOAD_TIMEOUT_MS = Number(process.env.E2E_UPLOAD_TIMEOUT_MS ?? 15 * 60 * 1000);

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

/** Sends `text`, waits for the reply to finish, returns its text. */
async function sendAndWait(page, text, settle = (t) => !/^Searching/.test(t.trim())) {
  const replies = page.locator("div.w-full.text-left");
  const before = await replies.count();
  await page.locator("textarea").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    ([n, chat]) => {
      const all = document.querySelectorAll("div.w-full.text-left");
      if (all.length <= n) return false;
      const last = all[all.length - 1].innerText.trim();
      if (last.length === 0 || /^Searching/.test(last)) return false;
      return chat ? !document.querySelector('button[aria-label="Stop"]') : true;
    },
    [before, CHAT],
    { timeout: CHAT ? 180000 : 20000 }
  );
  const t = await replies.last().innerText();
  if (!settle(t)) await page.waitForTimeout(500);
  return replies.last().innerText();
}

const SCOPE_LABEL = { "This session": "My uploads", Library: "All sources", Both: "My uploads and all sources" };
const scopeSelect = (page) => page.locator('select[aria-label="Search in"]');
const chooseScope = (page, label) => scopeSelect(page).selectOption({ label: SCOPE_LABEL[label] });
const chosenScope = (page) => scopeSelect(page).locator("option:checked").innerText();

async function main() {
  if (!PASSCODE || (!DATA_DIR && !CHAT)) {
    console.error("Set E2E_PASSCODE and E2E_DATA_DIR (the server's LOCUS_DATA_DIR).");
    process.exit(1);
  }
  const tripwire = CHAT ? null : await startTripwire();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (req) => requests.push(new URL(req.url()).pathname));

  await page.goto(BASE);
  await page.waitForURL(/\/login/);
  await page.fill('input[type="password"]', PASSCODE);
  await page.click('button[type="submit"]');
  await page.waitForURL(BASE + "/", { timeout: 10000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("textarea");
  await page.waitForFunction(() => /Library: \d|Library drive|Library not set up/.test(document.body.innerText), null, { timeout: 15000 });

  // --- the controls ---
  const labels = await scopeSelect(page).locator("option").allInnerTexts();
  check("scope dropdown offers All sources, My uploads, and both together", ["All sources", "My uploads", "My uploads and all sources"].every((l) => labels.includes(l)), labels.join(", "));
  check("starts on the configured default (My uploads)", (await chosenScope(page)) === "My uploads");
  const status = await page.locator('[data-testid="library-status"]').innerText();
  check(
    "status line: documents, pages indexed, still indexing, not indexed, drive connected",
    /^Library: 3 documents · [\d,]+ pages indexed · 0 still indexing · 0 not indexed · drive connected$/.test(status),
    status
  );

  if (CHAT) {
    await chooseScope(page, "Library");
    const reply = await sendAndWait(page, "Spectrophotometer");
    const card = await page.locator('[data-testid="library-card"]').last().innerText().catch(() => "");
    check("chat on: the library card appears for the turn", card.includes("Bidding_docs-2026-09-16") && card.includes("Page"), card.slice(0, 120));
    const cardBox = await page.locator('[data-testid="library-card"]').last().boundingBox();
    check("chat on: and the model still replies (below the card)", reply.replace(card, "").trim().length > 0 && cardBox !== null);
    await browser.close();
    finish(requests, null);
    return;
  }

  // --- library only ---
  await chooseScope(page, "Library");
  const sessionCallsBefore = requests.filter((p) => p === "/api/session-search").length;
  const lib = await sendAndWait(page, "Tiruchirappalli");
  check(
    "Library scope: results card with the folder-relative path and a page",
    lib.includes("Library") && lib.includes("Tenders/2026/Trichy/26033Terms-2026-09-23-01_20_49.pdf") && /Page \d+/.test(lib),
    lib.slice(0, 160)
  );
  check("…and no session search was made for that turn", requests.filter((p) => p === "/api/session-search").length === sessionCallsBefore);
  check("…and no 'upload documents' prompt (the session isn't being searched)", !lib.includes("This session has no documents yet"));

  const short = await sendAndWait(page, "ab");
  check("a query under 3 characters gets the too-short message", short.includes("Type at least 3 characters"));

  // "show more": a common word has far more than 50 pages.
  await sendAndWait(page, "the");
  const cardLoc = page.locator('[data-testid="library-card"]').last();
  const pagesBefore = await cardLoc.locator("li").count();
  const headline = await cardLoc.innerText();
  await cardLoc.locator('button:has-text("Show")').click();
  await page.waitForFunction((n) => {
    const cards = document.querySelectorAll('[data-testid="library-card"]');
    return cards[cards.length - 1].querySelectorAll("li").length > n;
  }, pagesBefore, { timeout: 15000 });
  const pagesAfter = await cardLoc.locator("li").count();
  check("first window is 50 pages, with a count of the total", pagesBefore === 50 && /found on [\d,]+ pages in 3 documents/.test(headline), `${pagesBefore}; ${headline.split("\n")[0]}`);
  check("'show more' loads the next window (50 → 100)", pagesAfter === 100, String(pagesAfter));

  const punct = await sendAndWait(page, "Tiruchirappalli%");
  check("exact miss: 'No matches in the library' with the punctuation hint", punct.includes("No matches in the library") && punct.includes("without exact punctuation"));
  await page.locator('button:has-text("without exact punctuation")').last().click();
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('[data-testid="library-card"]');
    return cards.length > 0 && cards[cards.length - 1].innerText.includes("Loose match");
  }, null, { timeout: 15000 });
  check("…and clicking it shows the loose matches", true);

  // --- both: an uploaded session file and the library ---
  await page.locator('input[type="file"]').setInputFiles([SESSION_FILE]);
  await page.waitForFunction(() => /\b3 pages\b/.test(document.body.innerText), null, { timeout: UPLOAD_TIMEOUT_MS });
  await chooseScope(page, "Both");
  const both = await sendAndWait(page, "bidder");
  check("Both scope: the session card (Annexure_B) and the library card", both.includes("Found on") && both.includes("Annexure_B") && both.includes("Library · found on"), both.slice(0, 200));

  await page.reload();
  await page.waitForSelector("textarea");
  check("the chosen scope survives a reload", (await chosenScope(page)) === "My uploads and all sources");

  // --- the drive goes away, then comes back ---
  // The library normally lives on the Mac's own disk, where a missing marker just means "nothing indexed yet".
  // "Drive not connected" is for a library on a drive that can be unplugged, which the indexer notes in the
  // app's folder; the server for this run is started with LOCUS_APP_DIR=$E2E_APP_DIR so the note can be made here.
  const APP_DIR = process.env.E2E_APP_DIR;
  if (!APP_DIR) {
    console.error("Set E2E_APP_DIR to the LOCUS_APP_DIR the server was started with (see the usage at the top).");
    process.exit(1);
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  const locationNote = path.join(APP_DIR, "library-location.json");
  fs.writeFileSync(locationNote, JSON.stringify({ dataDir: DATA_DIR, external: true, volumeName: "e2e-drive", volumeUuid: "E2E", at: new Date().toISOString() }));
  const marker = path.join(DATA_DIR, ".locus-data-dir");
  fs.renameSync(marker, `${marker}.away`);
  try {
    const gone = await sendAndWait(page, "Tiruchirappalli");
    check("drive disconnected: the library card says 'Library drive not connected'", gone.includes("Library drive not connected"));
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes("Library drive not connected"), null, { timeout: 15000 });
    check("…and so does the status line", (await page.locator('[data-testid="library-status"]').innerText()) === "Library drive not connected");
  } finally {
    fs.renameSync(`${marker}.away`, marker);
    fs.rmSync(locationNote, { force: true });
  }
  const back = await sendAndWait(page, "Spectrophotometer");
  check("drive back: library results again, no restart needed", back.includes("Bidding_docs-2026-09-16-04_46_27.pdf"));

  const body = await page.locator("body").innerText();
  check("no absolute path on screen (data dir or library folder)", !body.includes(DATA_DIR) && !body.includes("/source/"));

  await browser.close();
  finish(requests, tripwire);
}

function finish(requests, tripwire) {
  if (tripwire) {
    const modelCalls = requests.filter((p) => p.startsWith("/api/chat") || p.startsWith("/api/title"));
    check("the browser never called /api/chat or /api/title", modelCalls.length === 0, modelCalls.join(", "));
    check("the server never reached LM Studio (tripwire saw 0 requests)", tripwire.hits.length === 0, tripwire.hits.join(", "));
    check("library searches went to /api/library/search", requests.filter((p) => p === "/api/library/search").length >= 8);
    tripwire.server.close();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error("e2e-library.mjs crashed:", err);
  process.exit(1);
});
