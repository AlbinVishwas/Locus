import path from "node:path";
import { chromium } from "playwright";
import { startEnv } from "./sources-env.mjs";

/**
 * End to end through the real UI, with everything on: named accounts and an
 * administrator, the library, the Sources page, the indexer worker, a SQLite
 * database and a (mock) Google Drive folder.
 *
 *   npm run build && npm run e2e:sources
 *
 * It starts its own throwaway Locus (scripts/sources-env.mjs) on port 3210
 * (E2E_PORT), so nothing running on 3000 is touched, and deletes it after.
 * KEEP_ENV=1 keeps the scratch folder for a look.
 */

let failures = 0;
function check(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const READY_TIMEOUT = 120_000;

async function signUp(page, base, username, passcode, code) {
  await page.goto(`${base}/login`);
  await page.click('button:has-text("Create an account")');
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder^="Choose a passcode"]', passcode);
  await page.fill('input[placeholder="Sign-up code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`, { timeout: 15000 });
}

async function signIn(page, base, username, passcode) {
  await page.goto(`${base}/login`);
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[type="password"]', passcode);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`, { timeout: 15000 });
}

/** Sends `text`, waits for the reply to settle, returns its text. */
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

const row = (page, name) => page.locator('ul[aria-label="Sources"] > li', { hasText: name });

async function waitReady(page, name, docs) {
  await page.waitForFunction(
    ([n, d]) => {
      const li = [...document.querySelectorAll('ul[aria-label="Sources"] > li')].find((x) => x.innerText.includes(n));
      return !!li && /Up to date/.test(li.innerText) && li.innerText.includes(`${d} docs`);
    },
    [name, docs],
    { timeout: READY_TIMEOUT }
  );
}

async function main() {
  const env = await startEnv();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const { base } = env;
  try {
    // --- sign-in page -------------------------------------------------------------------
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`${base}/login`);
    await anon.waitForSelector('input[placeholder="Username"]');
    const loginText = await anon.locator("body").innerText();
    check("sign-in asks for a username and passcode", loginText.includes("Sign in to continue"));
    check("sign-in says searches are logged for the administrator", loginText.includes("Searches are logged for the administrator"));
    check("sign-in offers to create an account", loginText.includes("Create an account"));
    check("an anonymous request to a source API is refused", (await anon.request.get(`${base}/api/sources`)).status() === 401);

    // --- two ordinary users ---------------------------------------------------------------
    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    await anon.goto(`${base}/login`);
    await anon.click('button:has-text("Create an account")');
    await anon.fill('input[placeholder="Username"]', "mallory");
    await anon.fill('input[placeholder^="Choose a passcode"]', "a good long passcode");
    await anon.fill('input[placeholder="Sign-up code"]', "wrong-code");
    await anon.click('button[type="submit"]');
    await anon.waitForSelector("text=/code/i");
    check("a wrong sign-up code creates no account", anon.url().includes("/login"));

    await signUp(alice, base, "alice", "alice passcode 1", env.signupCode);
    await alice.waitForSelector("textarea");
    await alice.waitForTimeout(1200);
    const aliceText = await alice.locator("body").innerText();
    check("a normal user has no Sources, Users or Activity links", !/\bSources\b/.test(aliceText) && !aliceText.includes("Activity") && !aliceText.includes("Users"));
    check("a normal user has no scope dropdown", (await alice.locator('select[aria-label="Search in"]').count()) === 0);
    await alice.goto(`${base}/sources`);
    await alice.waitForSelector("textarea");
    check("a normal user who opens /sources is sent back to the search page", alice.url() === `${base}/`, alice.url());
    check("a normal user's source API is refused (403)", (await aliceCtx.request.get(`${base}/api/sources`)).status() === 403);
    check("…and so is the library search", (await aliceCtx.request.post(`${base}/api/library/search`, { data: { message: "indemnity" } })).status() === 403);
    await alice.goto(base);
    await alice.waitForSelector("textarea");
    await alice.locator('input[type="file"]').setInputFiles(path.join(env.roots, "Records", "po-1.pdf"));
    await alice.waitForFunction(() => /\d+ pages?\b/.test(document.body.innerText), null, { timeout: 120000 });
    const own = await ask(alice, "indemnity");
    check("alice finds a phrase in her own upload", /Found on 1 page in 1 document/.test(own), own.slice(0, 80).replace(/\n/g, " "));
    const none = await ask(alice, "turbine rotor");
    check("alice cannot find text that exists only in the library", none.includes("No matches"), none.slice(0, 80).replace(/\n/g, " "));
    const aliceConv = await alice.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("chat-conversations:"));
      return { key, id: JSON.parse(localStorage.getItem(key))[0].id };
    });
    check("her sessions are stored under her own key", /^chat-conversations:\d+$/.test(aliceConv.key ?? ""), aliceConv.key);

    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();
    await signUp(bob, base, "bob", "bob passcode 2", env.signupCode);
    await bob.waitForSelector("textarea");
    const peek = await bobCtx.request.post(`${base}/api/session-search`, { data: { conversationId: aliceConv.id, message: "indemnity" } });
    check("bob cannot search alice's session ('No such session')", peek.status() === 404 && (await peek.text()).includes("No such session"));
    const peekUpload = await bobCtx.request.get(`${base}/api/uploads?conversationId=${encodeURIComponent(aliceConv.id)}`);
    check("…nor list her files", peekUpload.status() === 404);
    const bobSearch = await ask(bob, "indemnity");
    check("bob's own search finds nothing of alice's", bobSearch.includes("no documents yet") || bobSearch.includes("No matches"), bobSearch.slice(0, 80).replace(/\n/g, " "));

    // --- the administrator ----------------------------------------------------------------
    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    await signIn(admin, base, "admin", env.adminPasscode);
    await admin.waitForSelector("textarea");
    await admin.waitForTimeout(1500);
    const adminText = await admin.locator("body").innerText();
    check("the admin sees Sources, Users and Activity in the sidebar", ["Sources", "Users", "Activity"].every((w) => adminText.includes(w)));
    check("the admin sees the scope dropdown, starting at My uploads", (await admin.locator('select[aria-label="Search in"]').inputValue()) === "session");

    await admin.goto(`${base}/sources`);
    await admin.waitForSelector("text=No sources yet");
    check("the Sources page starts empty, with the indexer running", !(await admin.locator("body").innerText()).includes("Indexer not running"));

    // Folder source, using the folder browser.
    await admin.click('button:has-text("+ Add source")');
    const dialog = admin.locator('[role="dialog"][aria-label="Add source"]');
    await dialog.waitFor();
    check("Add source is disabled until a test passes", await dialog.locator('button:has-text("Add source")').isDisabled());
    await dialog.locator('button:has-text("Browse")').click();
    const browser1 = admin.locator('[role="dialog"][aria-label="Choose a folder"]');
    await browser1.waitFor();
    await browser1.locator('ul[aria-label="Folders"]').waitFor();
    const browserText = await browser1.innerText();
    check("the folder browser starts at the allowed location only", browserText.includes(env.roots) && !browserText.includes("/Users/"), browserText.replace(/\n/g, " | ").slice(0, 160));
    await browser1.locator(`button:has-text("${env.roots}")`).first().click();
    await browser1.locator('button:has-text("Tenders 2026")').click();
    await browser1.locator('button:has-text("Use this folder")').click();
    check("choosing a folder fills in the path and a name", (await dialog.locator("input").nth(1).inputValue()).endsWith("Tenders 2026") && (await dialog.locator("input").first().inputValue()) === "Tenders 2026");
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/Found 8 PDFs/").waitFor();
    check("Test says the folder is readable and how many PDFs it holds", true);
    await dialog.locator('button:has-text("Add source")').click();
    await dialog.waitFor({ state: "detached" });
    await waitReady(admin, "Tenders 2026", 8);
    check("the folder source scans, indexes and reaches 'Up to date · 8 docs'", true);

    // A path outside the allowed location is refused with a plain message.
    await admin.click('button:has-text("+ Add source")');
    await dialog.waitFor();
    await dialog.locator('input[placeholder$="/Tenders"]').fill("/Users");
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/isn't allowed/").waitFor();
    check("a folder outside the allowed location is refused", true);

    // Database (SQLite) source.
    await dialog.getByRole("tab", { name: "Database" }).click();
    await dialog.locator("select").first().selectOption("sqlite");
    await dialog.getByLabel("Name", { exact: true }).fill("Purchase records");
    await dialog.getByLabel("Database file").fill(path.join(env.roots, "records.sqlite"));
    await dialog.getByLabel(/^Table/).fill("records");
    await dialog.getByLabel("ID column").fill("rid");
    await dialog.getByLabel("File name column").fill("title");
    await dialog.getByLabel("Modified time column").fill("changed");
    await dialog.getByRole("textbox", { name: "File path column" }).fill("location");
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/Read 4 sample rows/").waitFor();
    check("Test connects to the database and reads sample rows", true);
    await dialog.locator('button:has-text("Add source")').click();
    await dialog.waitFor({ state: "detached" });
    await waitReady(admin, "Purchase records", 4);
    check("the database source reaches 'Up to date · 4 docs'", true);

    // Google Drive source (mock API).
    await admin.click('button:has-text("+ Add source")');
    await dialog.waitFor();
    await dialog.getByRole("tab", { name: "Google Drive" }).click();
    await dialog.getByLabel("Drive folder link").fill("https://example.com/not-drive");
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/doesn't look like a Google Drive folder link/").waitFor();
    check("a link that isn't a Drive folder is refused", true);
    await dialog.getByLabel("Drive folder link").fill(env.driveLink);
    await dialog.locator('button:has-text("Test")').click();
    await dialog.locator("text=/Found the folder/").waitFor();
    check("Test finds the Drive folder and learns its name", (await dialog.getByLabel("Name", { exact: true }).inputValue()) === "BHEL tenders");
    await dialog.locator('button:has-text("Add source")').click();
    await dialog.waitFor({ state: "detached" });
    await waitReady(admin, "BHEL tenders", 2);
    check("the Drive source downloads, indexes and reaches 'Up to date · 2 docs'", true);
    const pageText = await admin.locator("body").innerText();
    check("no password, key or token is on the Sources page", !/e2e-secrets-key|mock-drive-key|apiKey/.test(pageText));

    // --- search by scope --------------------------------------------------------------------
    await admin.goto(base);
    await admin.waitForSelector('select[aria-label="Search in"]');
    await admin.waitForFunction(() => document.querySelector('[data-testid="library-status"]')?.textContent?.includes("14 documents"), null, { timeout: 30000 });
    check("the status line counts every source", true);
    const names = await admin.locator('select[aria-label="Search in"] option').allInnerTexts();
    check("the dropdown lists All sources, each source, My uploads", ["All sources", "Tenders 2026", "Purchase records", "BHEL tenders", "My uploads"].every((n) => names.includes(n)), names.join(" | "));
    await admin.selectOption('select[aria-label="Search in"]', { label: "All sources" });
    const all = await ask(admin, "indemnity");
    const chips = await admin.locator('[data-testid="source-chip"]').allInnerTexts();
    check("an all-sources search finds hits in all three sources, each tagged", ["Tenders 2026", "Purchase records", "BHEL tenders"].every((n) => chips.includes(n)), [...new Set(chips)].join(", "));
    check("…counted across sources (8 + 4 + 1 documents)", /in 13 documents/.test(all), all.slice(0, 120).replace(/\n/g, " "));
    check("…and no absolute path is shown", !all.includes(env.roots) && !all.includes("/tmp"));

    await admin.selectOption('select[aria-label="Search in"]', { label: "Purchase records" });
    const one = await ask(admin, "indemnity");
    const oneChips = new Set(await admin.locator('[data-testid="source-chip"]').last().innerText().then((t) => [t]));
    check("limiting to one source returns only that source", /in 4 documents/.test(one) && oneChips.has("Purchase records"), one.slice(0, 120).replace(/\n/g, " "));
    const wrong = await ask(admin, "turbine rotor");
    check("text from another source isn't found under it", wrong.includes("No matches"), wrong.slice(0, 80).replace(/\n/g, " "));
    await admin.selectOption('select[aria-label="Search in"]', { label: "Tenders 2026" });
    const tenders = await ask(admin, "turbine rotor");
    check("…but is found under its own source", /found on 8 pages in 8 documents/.test(tenders), tenders.slice(0, 120).replace(/\n/g, " "));
    await admin.reload();
    await admin.waitForSelector('select[aria-label="Search in"]');
    check("the chosen source survives a reload", (await admin.locator('select[aria-label="Search in"] option:checked').innerText()) === "Tenders 2026");
    await admin.selectOption('select[aria-label="Search in"]', { label: "All sources" });
    const short = await ask(admin, "ab");
    check("the 3-character minimum still applies", short.includes("at least 3 characters"));

    // --- pause, resume, rescan, remove ------------------------------------------------------
    await admin.goto(`${base}/sources`);
    await admin.waitForSelector('ul[aria-label="Sources"]');
    const menu = (name) => admin.getByRole("button", { name: `Actions for ${name}` });
    await menu("BHEL tenders").click();
    await admin.getByRole("menuitem", { name: "Pause" }).click();
    await admin.waitForFunction(() => [...document.querySelectorAll('ul[aria-label="Sources"] > li')].some((x) => x.innerText.includes("BHEL tenders") && /Paused/.test(x.innerText)), null, { timeout: 15000 });
    check("Pause shows 'Paused'", true);
    await menu("BHEL tenders").click();
    await admin.getByRole("menuitem", { name: "Resume" }).click();
    await waitReady(admin, "BHEL tenders", 2);
    check("Resume brings it back to 'Up to date'", true);
    await menu("BHEL tenders").click();
    await admin.getByRole("menuitem", { name: "Rescan" }).click();
    await waitReady(admin, "BHEL tenders", 2);
    check("Rescan completes and leaves it up to date", true);

    await menu("BHEL tenders").click();
    await admin.getByRole("menuitem", { name: "Remove" }).click();
    const confirm = admin.getByRole("alertdialog");
    await confirm.waitFor();
    check("Remove asks first, and says the original files are not touched", (await confirm.innerText()).includes("original files are not touched"));
    check("…with focus on Cancel", await confirm.locator("[data-cancel]").evaluate((el) => el === document.activeElement));
    await admin.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached" });
    check("Escape cancels", (await row(admin, "BHEL tenders").count()) === 1);
    await menu("BHEL tenders").click();
    await admin.getByRole("menuitem", { name: "Remove" }).click();
    await confirm.locator('button:has-text("Remove")').click();
    await row(admin, "BHEL tenders").waitFor({ state: "detached", timeout: 60000 });
    check("a removed source disappears from the list", true);
    await admin.goto(base);
    await admin.waitForSelector('select[aria-label="Search in"]');
    await admin.waitForFunction(() => document.querySelector('[data-testid="library-status"]')?.textContent?.includes("12 documents"), null, { timeout: 30000 });
    await admin.selectOption('select[aria-label="Search in"]', { label: "All sources" });
    const afterRemove = await ask(admin, "indemnity");
    check("its documents are gone from search (12 documents left)", /in 12 documents/.test(afterRemove) && !afterRemove.includes("BHEL tenders"), afterRemove.slice(0, 120).replace(/\n/g, " "));

    // --- users and activity -----------------------------------------------------------------
    await admin.goto(`${base}/users`);
    await admin.waitForSelector("text=alice");
    const usersText = await admin.locator("body").innerText();
    check("the Users page lists both people and their uploads", usersText.includes("alice") && usersText.includes("bob") && /1 · /.test(usersText));
    await admin.fill('input[placeholder="New username"]', "carol");
    await admin.click('button:has-text("Add user")');
    await admin.waitForSelector("text=won't be shown again");
    const passcode = (await admin.locator("p.font-mono").innerText()).trim();
    check("a new user's passcode is generated and shown once", passcode.length >= 8);
    await admin.click('button:has-text("Done")');
    await admin.reload();
    await admin.waitForSelector("text=carol");
    check("…and not shown again after a reload", !(await admin.locator("body").innerText()).includes(passcode));
    const carolCtx = await browser.newContext();
    const carol = await carolCtx.newPage();
    await signIn(carol, base, "carol", passcode);
    check("the new user can sign in", carol.url() === `${base}/`);
    await admin.locator("tr", { hasText: "alice" }).locator('button:has-text("Uploads")').click();
    await admin.waitForSelector("text=po-1.pdf");
    check("the admin can see what alice uploaded", true);
    await admin.locator("tr", { hasText: "alice" }).locator('button:has-text("Disable")').click();
    await admin.waitForSelector("text=disabled");
    const gone = await aliceCtx.request.post(`${base}/api/session-search`, { data: { conversationId: aliceConv.id, message: "indemnity" } });
    check("disabling alice signs her out at once", gone.status() === 401);

    await admin.goto(`${base}/activity`);
    await admin.waitForSelector("table");
    await admin.waitForTimeout(800);
    const act = await admin.locator("body").innerText();
    check("the Activity page shows alice's searches with their text", act.includes("turbine rotor") && act.includes("alice"));
    check("…bob's refused attempt on her session", act.includes("access denied") && act.includes("bob"));
    check("…source changes by the admin", act.includes("source added") && act.includes("source removed"));
    check("…and the issues strip", act.includes("Last 24 hours"));
    await admin.fill('input[aria-label="User"]', "alice");
    await admin.waitForTimeout(800);
    const filtered = await admin.locator("tbody").innerText();
    check("filtering by user shows only that user", filtered.includes("alice") && !filtered.includes("bob"));
    const csv = await admin.request.get(`${base}/api/activity/export?user=alice`);
    check("the CSV export works", csv.ok() && (await csv.text()).includes("turbine rotor"));
    check("no document text is in the activity log", !(await admin.request.get(`${base}/api/activity?limit=500`).then((r) => r.text())).includes("Seller indemnity applies"));
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
