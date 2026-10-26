import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startEnv } from "./sources-env.mjs";

/**
 * End to end for LOCUS_USER_SOURCES=true: ordinary accounts add and search
 * their own folders ("My folders"), privately. Runs its own scratch Locus
 * (scripts/sources-env.mjs, port 3211) with the real indexer worker.
 *
 *   npm run build && npm run e2e:user-folders
 */

let failures = 0;
function check(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function signUp(page, base, username, passcode, code) {
  await page.goto(`${base}/login`);
  await page.click('button:has-text("Create an account")');
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder^="Choose a password"]', passcode);
  await page.fill('input[placeholder="Sign-up code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`, { timeout: 15000 });
}

async function ask(page, text) {
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
    { timeout: 30000 }
  );
  await page.waitForTimeout(400);
  return replies.last().innerText();
}

async function main() {
  const env = await startEnv({ port: Number(process.env.E2E_PORT ?? 3211), drive: false, extraEnv: { LOCUS_USER_SOURCES: "true" } });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const { base } = env;
  const shots = process.env.SAVE_SHOTS === "1" ? path.resolve("docs/screenshots") : null;
  try {
    const aliceCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const alice = await aliceCtx.newPage();
    await signUp(alice, base, "alice", "alice password 1", env.signupCode);
    await alice.waitForSelector("textarea");
    await alice.waitForTimeout(1200);
    const home = await alice.locator("body").innerText();
    check("an ordinary account sees 'My folders' in the sidebar", home.includes("My folders"));
    check("…but still no Users or Activity", !home.includes("Activity") && !/\bUsers\b/.test(home));

    await alice.getByRole("link", { name: "My folders" }).click();
    await alice.waitForURL(`${base}/sources`);
    await alice.getByRole("heading", { name: "My folders" }).waitFor();
    await alice.waitForSelector("text=No folders yet");
    const pageText = await alice.locator("body").innerText();
    check("the page is 'My folders', says the folders are private, and has no admin tabs", pageText.includes("searched only by you") && (await alice.locator('nav[aria-label="Admin"]').count()) === 0);

    await alice.click('button:has-text("+ Add folder")');
    const dialog = alice.locator('[role="dialog"][aria-label="Add source"]');
    await dialog.waitFor();
    check("the Add panel offers a folder only (no Database or Google Drive)", (await dialog.getByRole("tab", { name: "Database" }).count()) === 0 || !(await dialog.getByRole("tab", { name: "Database" }).isVisible()));
    await dialog.locator('input[placeholder$="/Tenders"]').fill("/Users");
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/isn't allowed/").waitFor();
    check("a folder outside the allowed location is refused", true);
    await dialog.locator('button:has-text("Browse")').click();
    const picker = alice.locator('[role="dialog"][aria-label="Choose a folder"]');
    await picker.locator('ul[aria-label="Folders"]').waitFor();
    await picker.locator(`button:has-text("${env.roots}")`).first().click();
    await picker.locator('button:has-text("Tenders 2026")').click();
    await picker.locator('button:has-text("Use this folder")').click();
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/Found 8 PDFs/").waitFor();
    if (shots) await alice.screenshot({ path: path.join(shots, "my-folders-add-1440.png") });
    await dialog.locator('button:has-text("Add folder")').click();
    await dialog.waitFor({ state: "detached" });
    await alice.waitForFunction(() => [...document.querySelectorAll('ul[aria-label="Sources"] > li')].some((x) => /Up to date/.test(x.innerText) && x.innerText.includes("8 docs")), null, { timeout: 120000 });
    check("alice's folder is indexed: 'Up to date · 8 docs'", true);
    const aliceSees = await alice.locator("body").innerText();
    check("the storage numbers of the library aren't shown to her", !/Library uses|GB free|100 GB/.test(aliceSees));
    check("she isn't told it was 'added by' anyone (that's for the administrator)", !aliceSees.includes("added by"));
    if (shots) await alice.screenshot({ path: path.join(shots, "my-folders-1440.png") });

    // search
    await alice.goto(base);
    await alice.waitForSelector('select[aria-label="Search in"]');
    await alice.waitForFunction(() => document.querySelector('[data-testid="library-status"]')?.textContent?.includes("8 documents"), null, { timeout: 30000 });
    const options = await alice.locator('select[aria-label="Search in"] option').allInnerTexts();
    check("her dropdown says 'All my folders', her folder, and 'My uploads'", ["All my folders", "Tenders 2026", "My uploads"].every((o) => options.includes(o)), options.join(" | "));
    await alice.selectOption('select[aria-label="Search in"]', { label: "All my folders" });
    const found = await ask(alice, "turbine rotor");
    check("she finds her folder's pages", /found on 8 pages in 8 documents/.test(found), found.slice(0, 90).replace(/\n/g, " "));
    check("…each tagged with her folder, and no absolute path on screen", (await alice.locator('[data-testid="source-chip"]').first().innerText()) === "Tenders 2026" && !found.includes(env.roots));
    if (shots) await alice.screenshot({ path: path.join(shots, "my-folders-search-1440.png") });

    // the same page on a phone
    await alice.setViewportSize({ width: 390, height: 844 });
    await alice.goto(`${base}/sources`);
    await alice.waitForSelector('ul[aria-label="Sources"] > li');
    const sw = await alice.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check("'My folders' has no sideways scroll at 390 px", sw.sw <= sw.cw, `${sw.sw} vs ${sw.cw}`);
    if (shots) await alice.screenshot({ path: path.join(shots, "my-folders-390.png") });
    const aliceList = await (await aliceCtx.request.get(`${base}/api/sources`)).json();
    const aliceSourceId = aliceList.sources[0].id;

    // bob: nothing of alice's
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();
    await signUp(bob, base, "bob", "bob password 22", env.signupCode);
    await bob.waitForSelector('select[aria-label="Search in"]');
    await bob.selectOption('select[aria-label="Search in"]', { label: "All my folders" });
    const bobFound = await ask(bob, "turbine rotor");
    check("bob searching all his folders finds none of alice's pages", bobFound.includes("No matches"), bobFound.slice(0, 80).replace(/\n/g, " "));
    const bobList = await (await bobCtx.request.get(`${base}/api/sources`)).json();
    check("bob's folder list is empty", bobList.sources.length === 0 && bobList.scope === "mine");
    const viaId = await bobCtx.request.post(`${base}/api/library/search`, { data: { message: "turbine rotor", source: aliceSourceId } });
    check("naming alice's folder in a search finds nothing", /"pages":0/.test(await viaId.text()));
    check("bob can't pause alice's folder (404)", (await bobCtx.request.patch(`${base}/api/sources/${aliceSourceId}`, { data: { action: "pause" } })).status() === 404);
    check("…or remove it (404)", (await bobCtx.request.delete(`${base}/api/sources/${aliceSourceId}`)).status() === 404);
    const bobStatus = await (await bobCtx.request.get(`${base}/api/library/status`)).json();
    check("bob's library counts are his own (0 documents), with no storage numbers", bobStatus.documents === 0 && bobStatus.storage === undefined);
    check("bob can't add a database or drive source (403)", (await bobCtx.request.post(`${base}/api/sources`, { data: { kind: "drive", link: env.driveLink } })).status() === 403);
    check("…nor see Users or Activity (403)", (await bobCtx.request.get(`${base}/api/users`)).status() === 403 && (await bobCtx.request.get(`${base}/api/activity`)).status() === 403);

    // the administrator sees whose folder is whose
    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const admin = await adminCtx.newPage();
    await admin.goto(`${base}/login`);
    await admin.fill('input[placeholder="Username"]', "admin");
    await admin.fill('input[placeholder="Password"]', env.adminPasscode);
    await admin.click('button[type="submit"]');
    await admin.waitForURL(`${base}/`);
    await admin.goto(`${base}/sources`);
    await admin.waitForSelector("text=added by alice");
    check("the administrator sees alice's folder, marked 'added by alice'", true);
    await admin.goto(base);
    await admin.waitForSelector('select[aria-label="Search in"]');
    await admin.waitForFunction(() => document.querySelector('[data-testid="library-status"]')?.textContent?.includes("8 documents"), null, { timeout: 30000 });
    await admin.selectOption('select[aria-label="Search in"]', { label: "All sources" });
    const adminFound = await ask(admin, "turbine rotor");
    check("…and can search it (All sources)", /found on 8 pages in 8 documents/.test(adminFound));

    // alice removes her folder: gone from search; the files are untouched
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.goto(`${base}/sources`);
    await alice.getByRole("button", { name: "Actions for Tenders 2026" }).click();
    await alice.getByRole("menuitem", { name: "Remove" }).click();
    await alice.getByRole("alertdialog").locator('button:has-text("Remove")').click();
    await alice.locator('ul[aria-label="Sources"] > li', { hasText: "Tenders 2026" }).waitFor({ state: "detached", timeout: 60000 });
    check("alice removes her folder and it disappears", true);
    check("the original files are untouched", fs.existsSync(path.join(env.roots, "Tenders 2026", "spec-007.pdf")));
  } finally {
    await browser.close();
    await env.stop();
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
