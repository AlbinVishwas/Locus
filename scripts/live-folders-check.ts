/**
 * One-off check of "My folders" on the LIVE public link, using two throwaway
 * accounts that are deleted afterwards (the real accounts' passwords are not used).
 */
import os from "node:os";
import { loadEnvConfig } from "@next/env";
import { chromium } from "playwright";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
const LIVE = "https://local-chat-one-ivory.vercel.app";
let failures = 0;
const check = (s: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${s}${d ? " — " + d : ""}`);
  if (!ok) failures++;
};

async function main() {
  const { getRecordsDb } = await import("../src/lib/records/db");
  const { createUser, removeUser, findUserByName } = await import("../src/lib/records/users");
  const { generatePasscode } = await import("../src/lib/records/passcodes");
  const db = getRecordsDb();
  const names = ["zz-check-a", "zz-check-b"];
  const pw = names.map(() => generatePasscode(20));
  const secrets = [...pw, process.env.LOCUS_ADMIN_PASSCODE ?? ""];
  const scrub = (t: string) => secrets.reduce((s, x) => (x ? s.split(x).join("•••") : s), t);
  for (const [i, n] of names.entries()) await createUser(db, { username: n, passcode: pw[i], createdBy: "admin" });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const login = async (username: string, password: string) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(LIVE);
      await page.waitForSelector('input[placeholder="Username"]', { timeout: 60000 });
      const origin = new URL(page.url()).origin;
      await page.fill('input[placeholder="Username"]', username);
      await page.fill('input[placeholder="Password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${origin}/`, { timeout: 30000 });
      await page.waitForSelector("textarea");
      await page.waitForTimeout(1500);
      return { ctx, page, origin };
    };
    for (const [i, n] of names.entries()) {
      const { ctx, page, origin } = await login(n, pw[i]);
      const home = await page.locator("body").innerText();
      check(`${n}: sidebar shows 'My folders' (and no Users/Activity)`, home.includes("My folders") && !home.includes("Activity") && !/\bUsers\b/.test(home));
      await page.getByRole("link", { name: "My folders" }).click();
      await page.getByRole("heading", { name: "My folders" }).waitFor({ timeout: 20000 });
      await page.waitForSelector("text=No folders yet", { timeout: 20000 });
      check(`${n}: the 'My folders' page opens, empty, with the privacy note`, (await page.locator("body").innerText()).includes("searched only by you"));
      const list = await ctx.request.get(`${origin}/api/sources`);
      const body = (await list.json()) as { scope: string; sources: unknown[]; capBytes: number };
      check(`${n}: /api/sources answers 200, scope 'mine', no library numbers`, list.status() === 200 && body.scope === "mine" && body.sources.length === 0 && body.capBytes === 0);
      const outside = await ctx.request.post(`${origin}/api/sources`, { data: { kind: "folder", path: os.homedir() } });
      check(`${n}: a folder outside the allowed location is refused`, outside.status() === 400 && /isn't allowed/.test(await outside.text()), `HTTP ${outside.status()}`);
      const dbSrc = await ctx.request.post(`${origin}/api/sources`, { data: { kind: "database", name: "x" } });
      check(`${n}: a database source is refused (403)`, dbSrc.status() === 403);
      const codes = await Promise.all(["/api/users", "/api/activity", "/api/search"].map(async (p) => (await ctx.request.fetch(`${origin}${p}`, { method: p === "/api/search" ? "POST" : "GET", data: p === "/api/search" ? { query: "x" } : undefined, maxRedirects: 0 })).status()));
      check(`${n}: Users, Activity and the old library-wide search are still refused`, codes.every((c) => c === 403), codes.join(", "));
      const s = await ctx.request.post(`${origin}/api/library/search`, { data: { message: "anything at all" } });
      const sj = (await s.json()) as { status: string; result?: { counts: { pages: number } } };
      check(`${n}: a folder search works and finds nothing (they have no folders)`, s.status() === 200 && (sj.result?.counts?.pages ?? 0) === 0, `${sj.status}`);
      const ownSession = await ctx.request.get(`${origin}/api/library/status`);
      const stj = (await ownSession.json()) as { documents: number };
      check(`${n}: library counts are theirs (0), not the library's`, ownSession.status() === 200 && stj.documents === 0);
      await ctx.close();
    }
    const admin = await login("admin", process.env.LOCUS_ADMIN_PASSCODE ?? "");
    await admin.page.goto(`${admin.origin}/sources`);
    await admin.page.getByRole("heading", { name: "Sources" }).waitFor({ timeout: 20000 });
    check("the administrator still sees the Sources page", true);
    await admin.ctx.close();
    void scrub;
  } finally {
    await browser.close();
    for (const n of names) {
      const u = findUserByName(db, n);
      if (u) removeUser(db, u.id);
      db.prepare("DELETE FROM activity WHERE username = ?").run(n);
    }
    db.prepare("DELETE FROM conversation_owners WHERE user_id NOT IN (SELECT id FROM users)").run();
    db.prepare("DELETE FROM conversation_owners WHERE user_id IN (SELECT id FROM users WHERE role = 'admin')").run();
    check("the two throwaway accounts are deleted", !findUserByName(db, names[0]) && !findUserByName(db, names[1]));
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
