import fs from "node:fs";
import path from "node:path";

/**
 * The folder-pick checks, shared by the local run (scripts/e2e-folder-pick.mjs,
 * a scratch Locus) and the run against the public link (scripts/live-folder-pick-check.ts,
 * throwaway accounts). Drives the real UI in a headless browser: "Choose folder" opens a
 * native folder chooser, the PDFs in it are uploaded and indexed, a chip limits searches
 * to that folder, and nobody else can see it.
 */

export const WIDTHS = [1440, 1024, 768, 390];
const HEIGHT = { 1440: 900, 1024: 800, 768: 900, 390: 844 };
const PHRASE = "LOCUS-CONTROL-PHRASE";

/**
 * Visible interactive and text elements whose boxes overlap. Text is measured by the lines it
 * really occupies (a range over its own text), so an inline word that wraps isn't mistaken
 * for one big box; an element and its own descendants never count against each other.
 */
async function overlaps(page) {
  return page.evaluate(() => {
    const clipTo = (e, r) => {
      for (let p = e.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.display === "none") return null;
        if (ps.overflowX === "visible" && ps.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        r = { left: Math.max(r.left, pr.left), top: Math.max(r.top, pr.top), right: Math.min(r.right, pr.right), bottom: Math.min(r.bottom, pr.bottom) };
      }
      return r.right - r.left > 1 && r.bottom - r.top > 1 ? r : null;
    };
    const shown = (e) => {
      const st = getComputedStyle(e);
      return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
    };
    const items = [];
    for (const e of document.querySelectorAll("button, select, textarea, a[href], input:not(.hidden)")) {
      if (!shown(e) || e.closest("option, optgroup")) continue;
      const b = e.getBoundingClientRect();
      const r = clipTo(e, { left: b.left, top: b.top, right: b.right, bottom: b.bottom });
      if (r) items.push({ e, rects: [r] });
    }
    for (const e of document.querySelectorAll("body *")) {
      if (!shown(e) || e.closest("script, style, option, optgroup, select, textarea")) continue;
      const rects = [];
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) {
          const r = clipTo(e, { left: q.left, top: q.top, right: q.right, bottom: q.bottom });
          if (r) rects.push(r);
        }
      }
      if (rects.length) items.push({ e, rects });
    }
    const name = (e) => (e.getAttribute("aria-label") || e.innerText || e.tagName).replace(/\s+/g, " ").slice(0, 28);
    const bad = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        const hit = a.rects.some((x) => b.rects.some((y) => Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1.5 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1.5));
        if (hit) bad.push(`“${name(a.e)}” × “${name(b.e)}”`);
      }
    }
    return bad;
  });
}

async function openNewSession(page, width) {
  const btn = page.getByRole("button", { name: /New session/ }).or(page.getByRole("link", { name: /New session/ }));
  await page.waitForTimeout(900); // the layout follows the viewport only once the page has hydrated
  const box = await btn.first().boundingBox();
  if (!box || box.x < 0 || box.x + box.width > width) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.waitForTimeout(400);
  }
  await btn.first().click();
  await page.waitForSelector("text=Search your documents");
  // On a phone the sidebar is a drawer over the page; put it away again.
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  if (width < 768 && (await collapse.isVisible())) await collapse.click();
  await page.waitForTimeout(400);
}

/** Deletes (files and index rows included) every session this browser profile knows about. */
async function sweep(page, ctx, origin) {
  const ids = await page.evaluate(() => {
    const out = [];
    for (const k of Object.keys(localStorage)) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (Array.isArray(v)) for (const c of v) if (c && typeof c.id === "string") out.push(c.id);
      } catch {
        // not a session list
      }
    }
    return out;
  });
  for (const id of ids) await ctx.request.delete(`${origin}/api/uploads?conversationId=${encodeURIComponent(id)}`);
}

export async function runFolderPickChecks({ fixtures, loginA, loginB, shotsDir = /** @type {string | undefined} */ (undefined), expectLimits = true, log = console.log, newCheck = /** @type {((step: string, ok: boolean, detail?: string) => void) | undefined} */ (undefined) }) {
  let failures = 0;
  const check = newCheck ?? ((step, ok, detail = "") => {
    log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
  });
  const pack = path.join(fixtures, "Tender Pack");
  const sessions = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ask = async (page, text) => {
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

  const snap = async (page, name, width) => {
    await page.waitForTimeout(300);
    const sw = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    check(`${name} @${width}: no sideways scroll`, sw.s <= sw.c, `${sw.s} vs ${sw.c}`);
    const bad = await overlaps(page);
    check(`${name} @${width}: no overlapping controls or text`, bad.length === 0, bad.slice(0, 3).join("; "));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `folder-${name}-${width}.png`) });
  };

  // ---------------------------------------------------------------- alice
  const a = await loginA();
  const page = a.page;
  // When this file is loaded through tsx, esbuild wraps inner functions in a __name() helper that the page doesn't have.
  await a.ctx.addInitScript("window.__name = (f) => f;");
  const uploadPosts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/uploads") uploadPosts.push(r.url());
  });
  await page.addInitScript(() => {
    window.__seen = new Set();
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="folder-progress"]');
      if (el) for (const l of el.innerText.split("\n")) window.__seen.add(l.trim());
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.reload();
  await page.waitForSelector("textarea");

  // the pill
  const pill = page.getByRole("button", { name: "Choose folder" });
  check("the empty state has a 'Choose folder' button", await pill.isVisible());
  check("the pill is a button with no dropdown inside it", (await pill.locator("select").count()) === 0);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pill.click()]);
  check("clicking it opens a file chooser", true);
  const dirAttr = await (await chooser.element()).evaluate((el) => ({ wk: el.webkitdirectory, multiple: el.multiple }));
  check("…which is a folder chooser (webkitdirectory, multiple)", dirAttr.wk === true && dirAttr.multiple === true && chooser.isMultiple());
  const popups = await page.locator('[role="listbox"], [role="menu"]').filter({ visible: true }).count();
  check("no dropdown or menu appears", popups === 0);

  // control: a PDF outside the folder, through the ordinary attach button
  await page.locator('input[type="file"]').first().setInputFiles(path.join(fixtures, "outside", "control.pdf"));
  await page.waitForSelector("text=control.pdf");
  await page.waitForFunction(() => /control\.pdf\s*1 page/.test(document.body.innerText), null, { timeout: 60000 });
  check("control PDF (outside the folder) uploaded to the normal session", true);

  // pick the folder
  uploadPosts.length = 0;
  await chooser.setFiles(pack);
  await page.waitForSelector("text=Found 3 PDFs (2 other files skipped)", { timeout: 30000 });
  check("message: 'Found 3 PDFs (2 other files skipped)'", true);
  await page.waitForSelector('[data-testid="folder-chip"]', { timeout: 180000 });
  const chipText = (await page.locator('[data-testid="folder-chip"]').innerText()).replace(/\s+/g, " ").trim();
  check("the chip shows the folder name and file count", /Searching: Tender Pack · 3 files/.test(chipText), chipText);
  const seen = await page.evaluate(() => [...window.__seen].join(" | "));
  check("progress went Uploading/Reading → Scanning page N of M → Ready", /(Uploading|Reading)/.test(seen) && /Scanning page \d+ of \d+/.test(seen) && /Ready/.test(seen), seen.slice(0, 220));
  check("exactly 3 files were uploaded (the .txt and .jpg were not)", uploadPosts.length === 3, `${uploadPosts.length} requests`);
  const scope = await page.evaluate(() => JSON.parse(sessionStorage.getItem("locus.folderScope")));

  // searches with the chip on
  const inFolder = await ask(page, PHRASE);
  check("chip on: the phrase is found in the folder's PDF", /tender-a\.pdf/.test(inFolder), inFolder.slice(0, 100).replace(/\n/g, " "));
  check("…and NOT in the outside upload", !/control\.pdf/.test(inFolder));
  const sub = await ask(page, "ANNEX-UNIQUE-WORDS");
  check("results show the file's path inside the folder (Annex/annex-c.pdf)", /Annex\/annex-c\.pdf/.test(sub), sub.slice(0, 100).replace(/\n/g, " "));
  const scanned = await ask(page, "gasket");
  check("a scanned page in the folder is searchable (OCR)", /tender-b-scanned\.pdf/.test(scanned), scanned.slice(0, 100).replace(/\n/g, " "));
  const hitsOutsideOnly = await ask(page, "unrelated document");
  check("chip on: a word only in the outside upload finds nothing", /No matches/i.test(hitsOutsideOnly), hitsOutsideOnly.slice(0, 80).replace(/\n/g, " "));

  // another account
  const b = await loginB();
  const bobSearch = await ask(b.page, PHRASE);
  check("a second account searching the same phrase finds nothing", !/tender-a\.pdf|control\.pdf/.test(bobSearch), bobSearch.slice(0, 100).replace(/\n/g, " "));
  const viaId = await b.ctx.request.post(`${b.origin}/api/session-search`, { data: { conversationId: scope.conversationId, message: PHRASE } });
  check("…and can't search alice's folder by its id (404)", viaId.status() === 404, `HTTP ${viaId.status()}`);
  const viaUploads = await b.ctx.request.get(`${b.origin}/api/uploads?conversationId=${scope.conversationId}`);
  check("…nor list its files (404)", viaUploads.status() === 404, `HTTP ${viaUploads.status()}`);
  const bobPick = await b.page.getByRole("button", { name: "Choose folder" });
  const [bobChooser] = await Promise.all([b.page.waitForEvent("filechooser"), bobPick.click()]);
  await bobChooser.setFiles(pack);
  await b.page.waitForSelector('[data-testid="folder-chip"]', { timeout: 180000 });
  const bobScope = await b.page.evaluate(() => JSON.parse(sessionStorage.getItem("locus.folderScope")));
  check("picking the same folder name as another account gives a separate, private index", bobScope.conversationId !== scope.conversationId);
  await b.ctx.request.delete(`${b.origin}/api/uploads?conversationId=${encodeURIComponent(bobScope.conversationId)}`);
  await sweep(b.page, b.ctx, b.origin);
  await b.ctx.close();

  // × returns to normal search
  await page.getByRole("button", { name: "Stop searching this folder" }).click();
  check("× removes the chip", (await page.locator('[data-testid="folder-chip"]').count()) === 0);
  const normal = await ask(page, PHRASE);
  check("after ×: search finds the outside copy", /control\.pdf/.test(normal), normal.slice(0, 100).replace(/\n/g, " "));
  check("…and not the folder's copy", !/tender-a\.pdf/.test(normal));

  // re-pick the same folder
  uploadPosts.length = 0;
  const [again] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose folder" }).click()]);
  await again.setFiles(pack);
  await page.waitForSelector("text=0 uploaded, 3 already indexed", { timeout: 60000 });
  await page.waitForSelector('[data-testid="folder-chip"]');
  check("re-picking the same folder uploads 0 files (3 already indexed)", uploadPosts.length === 0, `${uploadPosts.length} upload requests`);
  sessions.push(scope.conversationId);

  // limits, in words
  if (expectLimits) {
    const [c1] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose folder" }).click()]);
    await c1.setFiles(path.join(fixtures, "Crowded"));
    await page.waitForSelector('[data-testid="folder-error"]', { timeout: 30000 });
    const many = await page.locator('[data-testid="folder-error"]').innerText();
    check("too many files: a clear message with the limit and the library-folder suggestion", /Found 5 PDFs/.test(many) && /at most 4/.test(many) && /library folder/.test(many), many.slice(0, 160));
    const [c2] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose folder" }).click()]);
    await c2.setFiles(path.join(fixtures, "Oversize"));
    await page.waitForSelector('[data-testid="folder-error"]:has-text("limit for one file")', { timeout: 30000 });
    const big = await page.locator('[data-testid="folder-error"]').innerText();
    check("a file over the size limit: a clear message, nothing uploaded", /limit for one file/.test(big) && /library folder/.test(big), big.slice(0, 160));
    const chipStill = (await page.locator('[data-testid="folder-chip"]').innerText()).replace(/\s+/g, " ");
    check("a refused pick leaves the current chip alone", /Tender Pack/.test(chipStill), chipStill);
    const [c3] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose folder" }).click()]);
    await c3.setFiles(path.join(fixtures, "outside"));
    await page.waitForSelector('[data-testid="folder-chip"]:has-text("outside")', { timeout: 120000 });
    check("a different folder replaces the chip", /Searching: outside · 1 file\b/.test((await page.locator('[data-testid="folder-chip"]').innerText()).replace(/\s+/g, " ")));
    const outsideScope = await page.evaluate(() => JSON.parse(sessionStorage.getItem("locus.folderScope")));
    sessions.push(outsideScope.conversationId);
  }

  // layout at four widths: empty, progress, picked, results
  for (const width of WIDTHS) {
    const ctxPage = await a.ctx.newPage();
    await ctxPage.setViewportSize({ width, height: HEIGHT[width] });
    await ctxPage.goto(a.origin);
    await ctxPage.waitForSelector("textarea");
    // The empty state is a new session; at phone width the sidebar is a drawer, so go there through the URL-less route: the app opens the last session, so ask for a fresh one.
    await ctxPage.evaluate(() => sessionStorage.removeItem("locus.folderScope"));
    await openNewSession(ctxPage, width);
    await ctxPage.waitForTimeout(1200);
    await snap(ctxPage, "empty", width);
    const folderName = `Progress ${width}`;
    const copy = path.join(fixtures, "copies", folderName);
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(pack, copy, { recursive: true });
    // Slow the uploads a little so the progress state is on screen long enough to look at.
    await ctxPage.route("**/api/uploads", async (route) => {
      await sleep(1200);
      await route.continue();
    });
    const [ch] = await Promise.all([ctxPage.waitForEvent("filechooser"), ctxPage.getByRole("button", { name: "Choose folder" }).click()]);
    await ch.setFiles(copy);
    await ctxPage.waitForSelector('[data-testid="folder-progress"]:has-text("of 3 uploaded")', { timeout: 30000 });
    await snap(ctxPage, "progress", width);
    await ctxPage.waitForSelector('[data-testid="folder-chip"]', { timeout: 180000 });
    await ctxPage.unroute("**/api/uploads");
    await snap(ctxPage, "picked", width);
    const sc = await ctxPage.evaluate(() => JSON.parse(sessionStorage.getItem("locus.folderScope")));
    sessions.push(sc.conversationId);
    await ask(ctxPage, "tender");
    await snap(ctxPage, "results", width);
    await ctxPage.close();
  }

  // clean up: every folder session and every ordinary session these accounts made go with their files
  for (const id of sessions.filter((x) => typeof x === "string")) await a.ctx.request.delete(`${a.origin}/api/uploads?conversationId=${encodeURIComponent(id)}`);
  const home = await a.ctx.newPage();
  await home.goto(a.origin);
  await home.waitForSelector("textarea");
  await sweep(home, a.ctx, a.origin);
  await a.ctx.close();
  return failures;
}
