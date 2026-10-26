import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startEnv } from "./sources-env.mjs";

/**
 * Screenshots of the new screens at 1440, 1024, 768 and 390 px wide, saved to
 * docs/screenshots/, and two layout checks on every one of them: no sideways
 * scrolling, and no two sibling controls drawn on top of each other.
 *
 *   npm run build && npm run screenshots:sources
 *
 * Runs against its own throwaway Locus (scripts/sources-env.mjs) with
 * generated documents only -- nothing on screen comes from a client file.
 */

const OUT = path.resolve("docs/screenshots");
const WIDTHS = [1440, 1024, 768, 390];
const HEIGHT = { 1440: 900, 1024: 800, 768: 1000, 390: 844 };
// Keeping every width of every screen would bloat the repo: the extremes for all, the middle ones for the main two.
const KEEP_ALL_WIDTHS = new Set(["sources", "add-folder"]);

let failures = 0;
function check(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

/**
 * Interactive elements that overlap another one (neither containing the other).
 * A control scrolled out of sight inside a scrolling panel doesn't count (its
 * rectangle is clipped by the panel), and a floating menu is allowed to sit
 * over the page by design.
 */
async function overlapping(page, rootSelector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const clipped = (e) => {
      let r = e.getBoundingClientRect();
      r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let p = e.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (st.overflowX === "visible" && st.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        r = { left: Math.max(r.left, pr.left), top: Math.max(r.top, pr.top), right: Math.min(r.right, pr.right), bottom: Math.min(r.bottom, pr.bottom) };
      }
      return r;
    };
    const els = [...root.querySelectorAll("button, input, select, textarea, a[href], [role=tab], [role=menuitem]")]
      .map((e) => ({ e, r: clipped(e), style: getComputedStyle(e) }))
      .filter(({ r, style }) => r.right - r.left > 1 && r.bottom - r.top > 1 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0");
    const bad = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        if (!!a.e.closest("[role=menu]") !== !!b.e.closest("[role=menu]")) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2) bad.push(`${(a.e.getAttribute("aria-label") || a.e.innerText || a.e.tagName).slice(0, 24)} × ${(b.e.getAttribute("aria-label") || b.e.innerText || b.e.tagName).slice(0, 24)}`);
      }
    }
    return bad;
  }, rootSelector);
}

async function snap(page, name, width, rootSelector = "body") {
  await page.waitForTimeout(350);
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`${name} @${width}: no sideways scroll`, scroll.sw <= scroll.cw, `${scroll.sw} vs ${scroll.cw}`);
  const over = await overlapping(page, rootSelector);
  check(`${name} @${width}: no overlapping controls`, over.length === 0, over.slice(0, 3).join("; "));
  if (KEEP_ALL_WIDTHS.has(name) || width === 1440 || width === 390) {
    await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`) });
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await startEnv();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // sign-in page, signed out
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await anon.newPage();

    await page.goto(`${env.base}/login`);
    await page.fill('input[placeholder="Username"]', "admin");
    await page.fill('input[type="password"]', env.adminPasscode);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${env.base}/`);

    // Three ready sources, added through the API (the UI path is covered by e2e:sources).
    const add = (body) => ctx.request.post(`${env.base}/api/sources`, { data: body });
    await add({ kind: "folder", name: "Tenders 2026", path: path.join(env.roots, "Tenders 2026") });
    await add({
      kind: "database", name: "Purchase records", dialect: "sqlite", file: path.join(env.roots, "records.sqlite"), table: "records",
      columns: { id: "rid", filename: "title", modified: "changed", content: "location" }, content: "file_path",
    });
    await add({ kind: "drive", name: "Shared drive: BHEL tenders", link: env.driveLink });
    await page.goto(`${env.base}/sources`);
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Sources"] > li').length === 3 && [...document.querySelectorAll('ul[aria-label="Sources"] > li')].every((li) => /Up to date/.test(li.innerText)), null, { timeout: 180000 });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT[width] });

      await login.setViewportSize({ width, height: HEIGHT[width] });
      await login.goto(`${env.base}/login`);
      await login.waitForSelector('input[placeholder="Username"]');
      await snap(login, "login", width);

      await page.goto(`${env.base}/sources`);
      await page.waitForSelector('ul[aria-label="Sources"] > li');
      await snap(page, "sources", width);

      // The ⋯ menu, open.
      await page.getByRole("button", { name: "Actions for Tenders 2026" }).click();
      await page.getByRole("menu").waitFor();
      await snap(page, "sources-menu", width);
      await page.keyboard.press("Escape");

      // Add source: each tab.
      await page.click('button:has-text("+ Add source")');
      const dialog = page.locator('[role="dialog"][aria-label="Add source"]');
      await dialog.waitFor();
      await dialog.getByLabel("Name", { exact: true }).fill("Tenders 2026 (copy)");
      await dialog.locator('input[placeholder$="/Tenders"]').fill(path.join(env.roots, "Tenders 2026"));
      await dialog.locator('button:has-text("Test")').click();
      await dialog.locator("text=/Found 8 PDFs/").waitFor();
      await snap(page, "add-folder", width, '[role="dialog"]');

      await dialog.locator('button:has-text("Browse")').click();
      const picker = page.locator('[role="dialog"][aria-label="Choose a folder"]');
      await picker.waitFor();
      await picker.locator('button:has-text("Tenders 2026")').waitFor();
      await picker.locator('button:has-text("Tenders 2026")').click();
      await picker.locator('button:has-text("Mumbai")').waitFor();
      await snap(page, "folder-browser", width, '[role="dialog"][aria-label="Choose a folder"]');
      await picker.locator('button:has-text("Cancel")').click();

      await dialog.getByRole("tab", { name: "Database" }).click();
      await dialog.locator("select").first().selectOption("postgres");
      await snap(page, "add-database", width, '[role="dialog"]');
      await dialog.locator("select").first().selectOption("sqlite");
      await dialog.getByLabel("Name", { exact: true }).fill("Purchase records (copy)");
      await dialog.getByLabel("Database file").fill(path.join(env.roots, "records.sqlite"));
      await dialog.getByLabel(/^Table/).fill("records");
      await dialog.getByLabel("ID column").fill("rid");
      await dialog.getByLabel("File name column").fill("title");
      await dialog.getByLabel("Modified time column").fill("changed");
      await dialog.getByRole("textbox", { name: "File path column" }).fill("location");
      await dialog.locator('button:has-text("Test")').click();
      await dialog.locator("text=/Read 4 sample rows/").waitFor();
      await snap(page, "add-database-tested", width, '[role="dialog"]');

      await dialog.getByRole("tab", { name: "Google Drive" }).click();
      await dialog.getByLabel("Drive folder link").fill(env.driveLink);
      await dialog.locator('button:has-text("Test")').click();
      await dialog.locator("text=/Found the folder/").waitFor();
      await snap(page, "add-drive", width, '[role="dialog"]');
      await page.keyboard.press("Escape");
      page.once("dialog", (d) => d.accept());
      await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

      // Remove confirmation.
      await page.goto(`${env.base}/sources`);
      await page.getByRole("button", { name: "Actions for Purchase records" }).click();
      await page.getByRole("menuitem", { name: "Remove" }).click();
      await page.getByRole("alertdialog").waitFor();
      await snap(page, "remove-confirm", width, '[role="alertdialog"]');
      await page.keyboard.press("Escape");

      // The search page with the scope dropdown "open" (a native list can't be photographed, so show it as a list box).
      await page.goto(env.base);
      await page.waitForSelector('select[aria-label="Search in"]');
      await page.waitForFunction(() => /\d+ documents/.test(document.querySelector('[data-testid="library-status"]')?.textContent ?? ""), null, { timeout: 30000 });
      await page.selectOption('select[aria-label="Search in"]', { label: "All sources" });
      await page.locator("textarea").fill("indemnity");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="library-card"]');
      await snap(page, "search-results", width);
      await page.locator('select[aria-label="Search in"]').evaluate((el) => {
        el.size = el.options.length + 1;
        el.style.position = "relative";
        el.style.zIndex = "5";
        el.style.borderRadius = "12px";
      });
      await snap(page, "scope-dropdown-open", width, "main, body");
      await page.locator('select[aria-label="Search in"]').evaluate((el) => {
        el.size = 0;
        el.removeAttribute("size");
      });

      await page.goto(`${env.base}/users`);
      await page.waitForSelector("table");
      await snap(page, "users", width);
      await page.goto(`${env.base}/activity`);
      await page.waitForSelector("table");
      await snap(page, "activity", width);
    }
  } finally {
    await browser.close();
    await env.stop();
  }
  console.log(failures === 0 ? "\nAll layout checks passed." : `\n${failures} layout check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
