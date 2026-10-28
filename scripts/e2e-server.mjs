/**
 * End-to-end check of a RUNNING Locus connected to a storage server folder, through its real HTTP API:
 *
 *   BASE_URL=http://localhost:3100 ADMIN_PASSWORD=... SERVER_DIR=/path/to/server/folder node scripts/e2e-server.mjs
 *
 * SERVER_DIR must hold the PDFs Locus is connected to (LOCUS_SERVER_PATH) and a manifest.json from
 * `npm run gen:test-pdfs`. It checks sign-in, the Server page's data, the first index (time to first searchable file
 * and to a full index), search accuracy and latency against the planted markers, opening an original PDF (bytes
 * compared with the file on the server), privacy (not signed in, other account), sync after add / change / delete,
 * failures listed, the manifest and the error pages. Prints PASS / FAIL per check and exits 1 on any failure.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const PASSWORD = process.env.ADMIN_PASSWORD;
const SERVER_DIR = process.env.SERVER_DIR;
if (!PASSWORD || !SERVER_DIR) {
  console.error("usage: BASE_URL=... ADMIN_PASSWORD=... SERVER_DIR=... node scripts/e2e-server.mjs");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "manifest.json"), "utf8"));
const files = manifest.files.filter((f) => f.marker);
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

let cookie = "";
async function api(url, { method = "GET", body, headers = {}, auth = true } = {}) {
  return fetch(BASE + url, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth && cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const status = async () => (await api("/api/server")).json();
async function until(fn, timeoutMs, everyMs = 300) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}
async function search(word) {
  const t = performance.now();
  const res = await api("/api/library/search", { method: "POST", body: { message: word } });
  const ms = performance.now() - t;
  const j = await res.json();
  return { ms, hits: j.result?.hits ?? [], tookMs: j.result?.tookMs ?? null };
}

// 1. Sign in
const login = await api("/api/login", { method: "POST", body: { username: "admin", passcode: PASSWORD }, auth: false });
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
check("admin signs in", login.status === 200 && cookie.startsWith("locus_session="));
check("not signed in: /api/server is refused", (await api("/api/server", { auth: false })).status === 401);

// 2. Server page data and connection test
const s0 = await status();
check("Server page data: a server is configured", s0.configured === true && ["folder", "s3"].includes(s0.type), s0.label);
const test = await (await api("/api/server/test", { method: "POST", body: {} })).json();
check("Test connection succeeds", test.ok === true, test.message);
check("no secrets in the status JSON", !/secret|AKIA/i.test(JSON.stringify(s0)));

// 3. First index: time to first searchable file, then to a full index
const t0 = Date.now();
const expected = files.length;
const first = await until(async () => ((await status()).index.documents > 0 ? true : null), 120_000, 100);
const firstMs = Date.now() - t0;
check("first file becomes searchable", Boolean(first), `${(firstMs / 1000).toFixed(1)} s after the check started`);
let sawProgress = false;
const full = await until(async () => {
  const s = await status();
  if (s.index.pending > 0 || s.sync.scanning) sawProgress = true;
  return s.index.documents >= expected && s.index.pending === 0 ? s : null;
}, 600_000, 500);
const fullMs = Date.now() - t0;
check("everything is indexed", Boolean(full), `${full?.index.documents ?? "?"} of ${expected} files, ${(fullMs / 1000).toFixed(1)} s after the check started`);
const s1 = await status();
check("progress, sync time and disk numbers are shown", s1.sync.lastSyncedAt !== null && s1.space?.freeBytes > 0 && s1.index.pagesIndexed > 0, `last synced ${s1.sync.lastSyncedAt}`);
const corrupt = manifest.files.filter((f) => f.kind === "corrupt");
check("the corrupt file is listed with a reason and didn't stop the job", corrupt.every((c) => s1.failures.some((f) => f.file === c.path && f.message)), `${s1.failures.length} listed`);

// 4. Search: accuracy and latency
const sample = [...files.filter((f) => f.kind === "text").slice(0, 40), ...files.filter((f) => f.kind !== "text")];
let wrong = 0;
const latencies = [];
const tooks = [];
for (const f of sample) {
  const r = await search(f.marker);
  latencies.push(r.ms);
  if (r.tookMs !== null) tooks.push(r.tookMs);
  const ok = r.hits.length >= 1 && r.hits.some((h) => h.displayName === f.path && h.pageNo === f.markerPage);
  if (!ok) {
    wrong++;
    console.log(`  miss: ${f.marker} expected ${f.path} p${f.markerPage}, got ${JSON.stringify(r.hits.slice(0, 3).map((h) => [h.displayName, h.pageNo]))}`);
  }
}
check(`search finds every planted marker on the right file and page (${sample.length} searches)`, wrong === 0, `${wrong} wrong`);
check("search is fast", quantile(latencies, 0.5) < 100, `round trip p50 ${quantile(latencies, 0.5).toFixed(1)} ms, p95 ${quantile(latencies, 0.95).toFixed(1)} ms; index lookup p50 ${tooks.length ? quantile(tooks, 0.5).toFixed(1) : "?"} ms`);
const none = await search("zzzzqqqqnothinghere");
check("a word that isn't there finds nothing", none.hits.length === 0);

// 5. Open the original PDF
const target = files.find((f) => f.kind === "text");
const hit = (await search(target.marker)).hits[0];
const opened = await api(`/api/library/file?doc=${hit.docId}`);
const bytes = Buffer.from(await opened.arrayBuffer());
const onDisk = fs.readFileSync(path.join(SERVER_DIR, target.path));
check("open original: 200, application/pdf, identical bytes to the server's file", opened.status === 200 && opened.headers.get("content-type") === "application/pdf" && sha(bytes) === sha(onDisk));
const part = await api(`/api/library/file?doc=${hit.docId}`, { headers: { range: "bytes=0-4" } });
check("open original: a byte range works (what PDF viewers use)", part.status === 206 && Buffer.from(await part.arrayBuffer()).toString() === "%PDF-");
check("open original: refused when not signed in", (await api(`/api/library/file?doc=${hit.docId}`, { auth: false })).status === 401);
check("open original: an unknown document is a clean 404", (await api("/api/library/file?doc=99999999")).status === 404);

// 6. Sync: add, change, delete on the server, then "Rescan now"
const { PDFDocument, StandardFonts } = await import("pdf-lib");
async function makePdf(marker) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  for (let i = 0; i < 20; i++) page.drawText(`Filler line ${i} of a freshly written test page with enough text to count`, { x: 40, y: 800 - i * 18, size: 11, font });
  page.drawText(`Reference ${marker} applies here`, { x: 40, y: 400, size: 11, font });
  return Buffer.from(await doc.save());
}
const longAgo = new Date(Date.now() - 600_000); // not "still being copied"
const put = async (file, marker) => {
  fs.writeFileSync(file, await makePdf(marker));
  fs.utimesSync(file, longAgo, longAgo);
};
const textFiles = files.filter((f) => f.kind === "text");
const added = path.join(SERVER_DIR, "added-later.pdf");
const changed = textFiles[2];
const changedPath = path.join(SERVER_DIR, changed.path);
const changedOriginal = fs.readFileSync(changedPath);
const victim = textFiles[1];
const victimPath = path.join(SERVER_DIR, victim.path);
const victimBytes = fs.readFileSync(victimPath);
await put(added, "addedlatermarkerqq");
await put(changedPath, "changedmarkerqq");
fs.rmSync(victimPath);
const rescan = await api("/api/server/rescan", { method: "POST", body: {} });
check("Rescan now is accepted", rescan.status === 200);
const synced = await until(async () => {
  const s = await status();
  const done = s.index.pending === 0 && !s.sync.scanning && (await search("changedmarkerqq")).hits.length > 0 && (await search(victim.marker)).hits.length === 0;
  return done ? s : null;
}, 180_000, 500);
check("the sync finishes", Boolean(synced));
check("a file deleted on the server leaves the index", (await search(victim.marker)).hits.length === 0);
check("a file added on the server is found after the sync", (await search("addedlatermarkerqq")).hits.some((h) => h.displayName === "added-later.pdf" && h.pageNo === 1));
check("a file changed on the server is re-read: new text found, old text gone", (await search("changedmarkerqq")).hits.some((h) => h.displayName === changed.path) && (await search(changed.marker)).hits.length === 0);
check("the 'last synced' time moved", (await status()).sync.lastSyncedAt > s1.sync.lastSyncedAt);
// Put the server folder back exactly as it was.
fs.writeFileSync(victimPath, victimBytes);
fs.writeFileSync(changedPath, changedOriginal);
fs.rmSync(added);

// 7. Manifest, icons and error pages
const man = await api("/manifest.webmanifest", { auth: false });
const manJson = man.status === 200 ? await man.json() : {};
check("web-app manifest is public and valid", man.status === 200 && manJson.name === "Locus" && manJson.icons?.length >= 3 && manJson.display === "standalone");
check("icons are public", (await api("/icons/icon-192.png", { auth: false })).status === 200 && (await api("/favicon.ico", { auth: false })).status === 200);
const nf = await api("/no-such-page-here");
const nfText = await nf.text();
check("a missing page shows the branded 404", nf.status === 404 && nfText.includes("Page not found") && nfText.includes("LOCUS-NOTFOUND-001"));
const prob = await api("/problem/locus-disk-001", { auth: false });
check("a problem page renders from the catalog (no sign-in needed)", prob.status === 200 && (await prob.text()).includes("Not enough disk space"));
const serverPage = await api("/server");
check("the Server page loads", serverPage.status === 200 && (await serverPage.text()).includes("Server"));
const apiErr = await api("/api/library/file?doc=abc");
const apiErrJson = await apiErr.json();
check("API errors are {code, message} JSON, no stack trace", apiErrJson.code === "LOCUS-NOTFOUND-001" && typeof apiErrJson.message === "string" && !/\bat .*\(.*:\d+:\d+\)/.test(JSON.stringify(apiErrJson)));

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED:\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
