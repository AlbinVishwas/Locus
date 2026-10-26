/**
 * One-off: creates the two normal accounts for the live link ("omkar" and
 * "demo-user"), prints their generated passwords ONCE, then checks everything
 * through the PUBLIC link (the Vercel redirect) in a real headless Chrome and
 * through direct API calls, and finally deletes the test PDF and test sessions.
 *
 *   LIVE_URL=https://local-chat-one-ivory.vercel.app node --import tsx scripts/live-users-setup.ts
 *
 * Passwords exist only in this process: they are stored as scrypt hashes by
 * the records library, printed once in the credentials block below, and
 * scrubbed from any error text. Needs the live server's .env.local (the admin
 * password is read from it and never printed).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { chromium } from "playwright";
import { writeFixturePdf } from "./indexer/fixtures";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

const LIVE = (process.env.LIVE_URL ?? "https://local-chat-one-ivory.vercel.app").replace(/\/$/, "");
const secrets: string[] = [];
const scrub = (t: string) => secrets.reduce((s, x) => (x ? s.split(x).join("•••") : s), t);

let failures = 0;
function check(step: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${scrub(step)}${detail ? " — " + scrub(detail) : ""}`);
  if (!ok) failures++;
}

async function main() {
  // Imported after loadEnvConfig so the records database path matches the live server's.
  const { getRecordsDb } = await import("../src/lib/records/db");
  const { createUser } = await import("../src/lib/records/users");
  const { generatePasscode } = await import("../src/lib/records/passcodes");
  const db = getRecordsDb();

  const accounts = [
    { username: "omkar", password: generatePasscode(20) },
    { username: "demo-user", password: generatePasscode(20) },
  ];
  for (const a of accounts) {
    secrets.push(a.password);
    await createUser(db, { username: a.username, passcode: a.password, createdBy: "admin" });
  }
  const adminPass = process.env.LOCUS_ADMIN_PASSCODE ?? "";
  secrets.push(adminPass, process.env.LOCUS_PASSCODE ?? "");
  const [omkar, demo] = accounts;
  const hashes = db.prepare("SELECT username, passcode_hash FROM users WHERE username IN ('omkar','demo-user')").all() as Array<{ username: string; passcode_hash: string }>;

  console.log("\n==================== CREDENTIALS (shown once; copy now) ====================");
  console.log(`Link:      ${LIVE}`);
  for (const a of accounts) console.log(`Username:  ${a.username}\nPassword:  ${a.password}\n`);
  console.log("Admin: sign in as \"admin\" with LOCUS_ADMIN_PASSCODE from .env.local (not printed).");
  console.log("=============================================================================\n");

  check("both accounts are stored as scrypt hashes only", hashes.length === 2 && hashes.every((h) => /^scrypt\$/.test(h.passcode_hash) && !h.passcode_hash.includes(omkar.password) && !h.passcode_hash.includes(demo.password)));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "locus-live-check-"));
  const pdf = path.join(work, "mentor-check.pdf");
  await writeFixturePdf(pdf, [{ lines: ["Live check document", "The kestrel clause applies to every delivery."] }], { workDir: work });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const conversations: Array<{ ctx: import("playwright").APIRequestContext; id: string }> = [];
  try {
    // --- omkar -----------------------------------------------------------------------------------
    const omkarCtx = await browser.newContext();
    const page = await omkarCtx.newPage();
    await page.goto(LIVE);
    await page.waitForSelector('input[placeholder="Username"]', { timeout: 60000 });
    const origin = new URL(page.url()).origin;
    check("the public Vercel link lands on the sign-in page of the live tunnel", page.url().endsWith("/login") || page.url().includes("/login"), `${new URL(LIVE).host} → ${new URL(origin).host.replace(/^[^.]+/, "<tunnel>")}`);
    const text = await page.locator("body").innerText();
    check("the sign-in page asks for a username and password (no shared-passcode box)", (await page.locator('input[placeholder="Username"]').count()) === 1 && (await page.locator('input[placeholder="Password"]').count()) === 1 && text.includes("old shared passcode no longer works"));
    check("…and offers no self sign-up (closed)", !text.includes("Create an account"));

    await page.fill('input[placeholder="Username"]', "omkar");
    await page.fill('input[placeholder="Password"]', "definitely-the-wrong-password");
    await page.click('button[type="submit"]');
    await page.locator("text=Wrong username or password").waitFor({ timeout: 20000 });
    check("a wrong password is rejected, with a clear message", page.url().includes("/login"));

    await page.fill('input[placeholder="Password"]', omkar.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${origin}/`, { timeout: 30000 });
    await page.waitForSelector("textarea");
    await page.waitForTimeout(1500);
    const home = await page.locator("body").innerText();
    check("omkar logs in successfully", home.includes("Signed in as omkar"));
    check("…and sees no Sources, Users or Activity links", !/\bSources\b/.test(home) && !home.includes("Activity") && !/\bUsers\b/.test(home));
    check("…but does see Change password", home.includes("Change password"));

    await page.locator('input[type="file"]').setInputFiles(pdf);
    await page.waitForFunction(() => /\d+ pages?\b/.test(document.body.innerText), null, { timeout: 180000 });
    check("omkar uploads a test PDF into his session", true);
    const reply = async (q: string) => {
      const replies = page.locator("div.w-full.text-left");
      const before = await replies.count();
      await page.locator("textarea").fill(q);
      await page.keyboard.press("Enter");
      await page.waitForFunction((n) => {
        const all = document.querySelectorAll("div.w-full.text-left");
        const last = (all[all.length - 1] as HTMLElement | undefined)?.innerText.trim() ?? "";
        return all.length > n && last.length > 0 && !/^Searching/.test(last);
      }, before, { timeout: 30000 });
      await page.waitForTimeout(400);
      return replies.last().innerText();
    };
    const found = await reply("kestrel");
    check("omkar can search it", /Found on 1 page in 1 document/.test(found), found.slice(0, 70).replace(/\n/g, " "));
    const conv = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("chat-conversations:"))!;
      return JSON.parse(localStorage.getItem(key)!)[0].id as string;
    });
    conversations.push({ ctx: omkarCtx.request, id: conv });

    // Change-password page opens (not submitted: the passwords stay as printed).
    await page.goto(`${origin}/account`);
    await page.waitForSelector('input[aria-label="Current password"]');
    check("omkar's Change password page opens (sidebar link → /account)", true);

    // --- demo-user ---------------------------------------------------------------------------------
    const demoCtx = await browser.newContext();
    const dpage = await demoCtx.newPage();
    await dpage.goto(origin + "/login");
    await dpage.fill('input[placeholder="Username"]', "demo-user");
    await dpage.fill('input[placeholder="Password"]', demo.password);
    await dpage.click('button[type="submit"]');
    await dpage.waitForURL(`${origin}/`, { timeout: 30000 });
    await dpage.waitForSelector("textarea");
    check("demo-user logs in successfully", (await dpage.locator("body").innerText()).includes("Signed in as demo-user"));
    await dpage.waitForTimeout(1200);
    const dreplies = dpage.locator("div.w-full.text-left");
    await dpage.locator("textarea").fill("kestrel");
    await dpage.keyboard.press("Enter");
    await dpage.waitForFunction(() => document.querySelectorAll("div.w-full.text-left").length > 0 && document.body.innerText.includes("no documents yet"), null, { timeout: 30000 });
    check("demo-user searching 'kestrel' in his own session finds nothing (no documents of his own)", true, (await dreplies.last().innerText()).slice(0, 60).replace(/\n/g, " "));
    const demoConv = await dpage.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("chat-conversations:"))!;
      return JSON.parse(localStorage.getItem(key)!)[0].id as string;
    });
    conversations.push({ ctx: demoCtx.request, id: demoConv });
    const peek = await demoCtx.request.post(`${origin}/api/session-search`, { data: { conversationId: conv, message: "kestrel" } });
    check("demo-user cannot search omkar's session ('No such session')", peek.status() === 404 && (await peek.text()).includes("No such session"), `HTTP ${peek.status()}`);
    const peekFiles = await demoCtx.request.get(`${origin}/api/uploads?conversationId=${encodeURIComponent(conv)}`);
    check("…and cannot list omkar's files", peekFiles.status() === 404, `HTTP ${peekFiles.status()}`);
    const peekDelete = await demoCtx.request.delete(`${origin}/api/uploads?conversationId=${encodeURIComponent(conv)}`);
    check("…nor delete them", peekDelete.status() === 404, `HTTP ${peekDelete.status()}`);
    const still = await omkarCtx.request.get(`${origin}/api/uploads?conversationId=${encodeURIComponent(conv)}`);
    check("omkar's file is still there after those attempts", still.ok() && JSON.stringify(await still.json()).includes("mentor-check.pdf"));

    // --- no Sources for normal users: the API itself, not just the UI ----------------------------
    const probes: Array<[string, string, object | undefined]> = [
      ["GET", "/api/sources", undefined],
      ["POST", "/api/sources", { kind: "folder", path: "/Volumes" }],
      ["POST", "/api/sources/test", { kind: "folder", path: "/Volumes" }],
      ["GET", "/api/sources/browse", undefined],
      ["PATCH", "/api/sources/x", { action: "pause" }],
      ["DELETE", "/api/sources/x", undefined],
      ["GET", "/api/library/status", undefined],
      ["POST", "/api/library/search", { message: "kestrel" }],
      ["GET", "/api/users", undefined],
      ["GET", "/api/activity", undefined],
    ];
    for (const [who, ctx] of [["omkar", omkarCtx], ["demo-user", demoCtx]] as const) {
      const codes: string[] = [];
      let allRefused = true;
      for (const [method, p, data] of probes) {
        const res = await ctx.request.fetch(`${origin}${p}`, { method, data, headers: data ? { "content-type": "application/json" } : undefined, maxRedirects: 0 });
        codes.push(`${method} ${p}=${res.status()}`);
        if (res.status() !== 403) allRefused = false;
      }
      check(`${who}: every Sources/admin API call is refused (403)`, allRefused, codes.join(", "));
      const pg = await ctx.newPage();
      await pg.goto(`${origin}/sources`);
      await pg.waitForSelector("textarea");
      check(`${who}: opening /sources in the browser just returns to the search page`, new URL(pg.url()).pathname === "/");
      await pg.close();
    }

    // --- the old shared passcode ---------------------------------------------------------------------
    const bare = await fetch(`${origin}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: process.env.LOCUS_PASSCODE }) });
    const bareBody = (await bare.json()) as { error?: string };
    check("the old shared passcode on its own gets a clear message, not a crash", bare.status === 400 && /username and password/i.test(bareBody.error ?? ""), `HTTP ${bare.status}: ${bareBody.error}`);
    const asPassword = await fetch(`${origin}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "omkar", passcode: process.env.LOCUS_PASSCODE }) });
    check("…and does not work as anyone's password", asPassword.status === 401, `HTTP ${asPassword.status}`);
    const oldCookieRes = await fetch(`${origin}/`, { redirect: "manual" });
    check("a visitor with no valid sign-in is sent to the sign-in page", oldCookieRes.status >= 300 && oldCookieRes.status < 400 && (oldCookieRes.headers.get("location") ?? "").includes("/login"), `HTTP ${oldCookieRes.status}`);

    // --- the admin --------------------------------------------------------------------------------
    const adminCtx = await browser.newContext();
    const apage = await adminCtx.newPage();
    await apage.goto(origin + "/login");
    await apage.fill('input[placeholder="Username"]', "admin");
    await apage.fill('input[placeholder="Password"]', adminPass);
    await apage.click('button[type="submit"]');
    await apage.waitForURL(`${origin}/`, { timeout: 30000 });
    await apage.waitForSelector("textarea");
    await apage.waitForTimeout(1200);
    const adminHome = await apage.locator("body").innerText();
    check("admin signs in and sees Sources, Users and Activity in the sidebar", ["Sources", "Users", "Activity"].every((w) => adminHome.includes(w)));
    await apage.goto(`${origin}/sources`);
    await apage.getByRole("heading", { name: "Sources" }).waitFor({ timeout: 20000 });
    await apage.waitForSelector("text=/No sources yet|Up to date|Scanning|Indexing|Paused|Indexer not running/", { timeout: 30000 });
    check("admin sees the Sources page", true, (await apage.locator("main").innerText()).split("\n").slice(0, 3).join(" | "));
    const adminApi = await adminCtx.request.get(`${origin}/api/sources`);
    check("…and the source API answers the admin (200)", adminApi.status() === 200, `HTTP ${adminApi.status()}`);
    const users = (await (await adminCtx.request.get(`${origin}/api/users`)).json()) as { users: Array<{ username: string }> };
    check("the Users list shows admin, omkar and demo-user", ["admin", "omkar", "demo-user"].every((n) => users.users.some((u) => u.username === n)));
    await omkarCtx.request.get(origin); // keep the session warm

    // --- log out ----------------------------------------------------------------------------------------
    await page.goto(origin + "/");
    await page.waitForSelector("textarea");
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL(/\/login/, { timeout: 20000 });
    const after = await omkarCtx.request.get(`${origin}/api/uploads?conversationId=${encodeURIComponent(conv)}`, { maxRedirects: 0 });
    check("log out works: back at the sign-in page, and the old session is refused", page.url().includes("/login") && [401, 307, 302].includes(after.status()), `HTTP ${after.status()}`);
    await page.goto(origin + "/");
    check("…and the home page now redirects to sign-in", page.url().includes("/login"));

    // --- clean up: the test PDF and the test sessions ----------------------------------------------------
    await page.fill('input[placeholder="Username"]', "omkar");
    await page.fill('input[placeholder="Password"]', omkar.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${origin}/`, { timeout: 30000 });
    conversations[0].ctx = omkarCtx.request;
    for (const c of conversations) {
      const del = await c.ctx.delete(`${origin}/api/uploads?conversationId=${encodeURIComponent(c.id)}`);
      check("test session deleted", del.ok(), `HTTP ${del.status()}`);
    }
    const left = db.prepare("SELECT (SELECT count(*) FROM conversation_owners WHERE user_id IN (SELECT id FROM users WHERE username IN ('omkar','demo-user'))) AS sessions, (SELECT count(*) FROM uploads WHERE user_id IN (SELECT id FROM users WHERE username IN ('omkar','demo-user')) AND status = 'ready') AS files").get() as { sessions: number; files: number };
    // An empty session is claimed by whoever opens the app; release those too, so nothing of the checks is left.
    db.prepare("DELETE FROM conversation_owners WHERE user_id IN (SELECT id FROM users WHERE username IN ('omkar','demo-user','admin'))").run();
    check("omkar and demo-user start clean: 0 sessions, 0 files on record", left.sessions === 0 && left.files === 0, JSON.stringify(left));
    const docsLeft = await import("../src/lib/search/indexDb").then(async ({ getIndexDb }) => {
      try {
        return Number(getIndexDb().prepare("SELECT count(*) FROM documents WHERE original_filename = 'mentor-check.pdf'").pluck().get());
      } catch {
        return 0;
      }
    });
    check("the test PDF is gone from the search index", docsLeft === 0, `${docsLeft} left`);
  } finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(scrub(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
