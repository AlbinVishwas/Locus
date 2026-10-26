# Sources — plan (Phase A)

Status: **plan only, for approval** (amended once after review: see
Amendment 1). No feature code exists yet. Restore point: tag `pre-sources`
(commit `d50fd8f`). Builds on the library work in
[library-plan.md](library-plan.md) and [library.md](library.md).

What this adds, in one paragraph: the library moves onto the laptop's own disk
under a **100 GB cap** (plus a 20 GB free-space reserve); an **admin role**
(separate passcode) gets a **Sources page** to add, test, pause, resume,
rescan and remove sources of three kinds — **a folder, a database, a Google
Drive link** — all feeding the Phase 1 pipeline; search gets **one scope
dropdown** (All sources / one source / This session); and a **1M-page benchmark**
checks the index still searches fast at library scale.

Everything new is **off by default.** With `LOCUS_ADMIN_PASSCODE` unset there
is no admin, no Sources page and no source APIs; with `LOCUS_LIBRARY_ENABLED`
unset there is no library at all, as today.

---

## Amendment 1 — user accounts, private uploads, activity database

After review you confirmed the **separate indexer process**, and added two
requirements:

- **User-based access: each user can access only what they upload.**
- **A database of these records and all search activity, which you (the admin)
  can open at any time to check for issues.**

That is a bigger change than the sources work, because today Locus has **no
users**: one shared passcode, and a "session" is only a random id kept in the
browser. **Where this amendment disagrees with the sections below it, this
amendment wins.** It is built *before* the Sources page (it is what "admin"
now means), and it makes Phase B larger: roughly a third more work.

### A. Users mode (off by default)

`LOCUS_USERS_ENABLED=true` switches Locus from "one shared passcode" to
**named users**. It requires `LOCUS_ADMIN_PASSCODE`. With it unset, Locus
behaves exactly as today: shared passcode, no accounts, no activity log; the
characterization tests pin that. Sources and the library work in either mode.

### B. Accounts

- **The admin creates users.** Users page → *Add user* → a username and a
  generated personal passcode (12 characters from an unambiguous alphabet,
  about 60 bits), **shown once** with a copy button. There is no open
  sign-up. The admin can disable, re-enable, reset the passcode of, or remove
  any user. A user can change their own passcode.
- **Sign-in:** the login page asks for **username and passcode**. The admin
  signs in as `admin` with `LOCUS_ADMIN_PASSCODE`. Both are on the same page,
  so admin access works from anywhere you can reach Locus, including through
  the tunnel ("anytime"); `LOCUS_ADMIN_LOCAL_ONLY=true` stays an optional
  switch if you ever want admin only from this laptop.
- **Storage of passcodes:** scrypt (N=16384, r=8, p=1, per-user 16-byte salt),
  compared in constant time. Plain passcodes are never stored or logged.
- **Session:** the same signed cookie as today (`locus_session`, `HttpOnly;
  Secure; SameSite=Lax`, same `SESSION_SECRET`), now carrying
  `{ u: userId, r: role, tv: tokenVersion, exp }`. The proxy (Edge runtime, no
  database) checks the signature and expiry; **every API route also loads the
  user** and rejects a disabled user or a stale `tv`, so disabling a user or
  resetting their passcode **signs them out within seconds**. A token without
  `u` is invalid in users mode.
- **Rate limits:** per caller (5 failures / 5 min, as today) **and per
  username** (5 failures / 5 min locks that username for 5 min), plus the
  global admin ceiling from §4. Every failure is written to the activity log.
- **Admin role:** `r: "admin"` replaces the separate admin cookie of §4 *in
  users mode* (in shared-passcode mode §4's second cookie is unchanged).
  `requireAdmin()` is one function that handles both.

### C. Private uploads (ownership)

- A new table `conversation_owners(conversation_id, user_id)` (in the records
  database, §E) records **who owns each session**. The existing session
  index is **not** touched: ownership lives beside it, keyed by the same
  session id.
- **First use claims it:** the first upload for a new session id claims it for
  the signed-in user (atomic `INSERT OR IGNORE`, then re-read the owner).
  After that, **uploads, the file list, session search, chat and delete all
  check the caller owns that session id**, server-side, in every route that
  takes a `conversationId` (`/api/uploads` POST/GET/DELETE,
  `/api/session-search`, `/api/chat`, `/api/title`). Someone else's session id
  gets **404 "No such session"**: indistinguishable from a session that doesn't
  exist, so ids can't even be probed. Each denial is logged (§F).
- The admin sees **records** (file name, size, pages, who, when, status) and
  activity. The admin **cannot read or search other users' document text** (an
  admin's own uploads work like anyone's).
- **The browser's session list is namespaced per user** (local storage key
  `chat-conversations:<userId>` in users mode; unchanged key otherwise), so a
  second person on the same browser never sees the first one's session titles
  or saved results. Session *lists* remain per browser (a user on a new
  browser starts with an empty list, though their server-side records are
  intact): a limit I'm noting rather than solving now.
- The standalone **`/search` page and `/api/search`** (the old `data/tenders`
  corpus, not anyone's upload) become **admin-only** in users mode.

### D. Who can search the library

Library sources are **admin-managed, not user uploads**, so "only what they
upload" can't apply to them without hiding the library from everyone. My
default: **every signed-in user can search every source** (they see source
names only, never paths or settings), and **each source can be restricted to
chosen users** from the Sources page ("Visible to: everyone / only these
users"). A restricted source is **absent** for everyone else, in the
dropdown, in "All sources", and in direct API calls (checked server-side in
the search route via a `source_access` table; a user with a restricted set
searches those id ranges only). Question 1 below asks you to confirm.

### E. The records database

One SQLite file, **`data/app/records.db`** (project folder, gitignored and
vercelignored under the existing `/data` rules, override with
`LOCUS_APP_DB_PATH`). It is deliberately **not** under `LOCUS_DATA_DIR`: logins
must keep working if the library drive is unplugged, and it is small. WAL;
the app is the main writer, the indexer worker only *appends* activity rows
(busy timeout on both). Tables:

| Table | Holds |
| --- | --- |
| `users` | id, username (unique), role, passcode hash and salt, token version, created, last sign-in, disabled-at |
| `conversation_owners` | session id → user (the privacy boundary of §C), created, last used |
| `uploads` | one row per upload: user, session id, file name, size, sha256, pages, status, uploaded-at, **deleted-at** (history survives deletion) |
| `source_access` | restricted sources → allowed users (§D) |
| `activity` | the log (§F) |

### F. The activity log: "all search activity", and issues

Every row: time, user, role, **event**, **scope** (my uploads / a source / all
sources), **query text**, result **counts** (pages, documents; never the
snippets or document text), time taken, **status** (`ok`, `error`, `denied`,
`refused`), error message, caller address (`cf-connecting-ip`, else the
connection address), short user-agent.

Events logged: sign-in and sign-out, **failed sign-ins**, **every search**
(session, library, paging, loose-mode switches), uploads (started, ready,
failed), upload deletions, **denied access** (a user touching someone else's
session id), source add / test / pause / resume / rescan / remove, user
add / disable / reset / remove, **indexer events** (storage-limit pause,
low-disk pause, source error, a source's drive going away), and server-side
errors from search and upload routes.

- **Query text is stored here** (this overrides the "queries are never
  logged" rule that applied to server *log files*; they stay out of those).
  Queries can quote client documents, so the table is **admin-only**, kept
  **365 days** by default (`LOCUS_ACTIVITY_RETENTION_DAYS`; purged hourly),
  and the login screen says *"Searches are logged for the administrator."*
  `LOCUS_LOG_QUERY_TEXT=false` records everything *except* the query text.
- The log is append-only through the app (there is no edit route); only the
  retention purge deletes.

### G. Admin screens (all admin-only, enforced server-side)

A shared admin header: **Sources · Users · Activity**.

- **Activity** (`/activity`): an **Issues strip** on top (last 24 h: failed
  sign-ins, denied access attempts, search errors, upload failures, indexing
  failures, storage pauses; each count is a link that filters the table), a
  filter bar (user, event, status, date range, text in the query), the table
  (time, user, event, scope, query, results, took, status; 50 per page, newest
  first; the row opens a detail panel), an **Issues only** toggle, **Export
  CSV** (of the current filter), and auto-refresh. At 390 px the table becomes
  stacked cards.
- **Users** (`/users`): username, role, last sign-in, uploads (count and
  size), searches in the last 30 days, status; *Add user*, *Disable/Enable*,
  *Reset passcode*, *Remove* (removing a user also deletes their uploads and
  records after a confirmation that says so; *Disable* keeps everything). An
  *Uploads* link per user lists their upload **records** (not contents).
- **Sources** (§8) additionally shows, per source, *Visible to*.

### H. Files, tests, build order, risks added by this amendment

**New files:** `src/lib/records/{db,users,passcodes,ownership,activity,access}.ts`,
`src/lib/session.ts` (current user for routes), `src/app/api/users/**`,
`src/app/api/activity/{route,export}/route.ts`, `src/app/users/page.tsx`,
`src/app/activity/page.tsx`, `src/components/admin/{AdminHeader,UsersView,ActivityView,IssuesStrip}.tsx`,
`scripts/e2e-users.mjs`.

**Changed (all guarded by users mode, so a no-settings run is identical):**
`src/app/api/login/route.ts` and `src/app/login/page.tsx` (username field,
logging, notice), `src/lib/auth.ts` (token claims, in users mode only),
`src/proxy.ts` (admin pages gate), `src/app/api/{uploads,session-search,chat,title,search}/route.ts`
(an ownership/permission check at the top, `if (usersEnabled())`),
`src/lib/storage.ts` and `ConversationsProvider.tsx` (per-user storage key),
`src/app/api/library/{search,status}/route.ts` (source permissions, activity
logging). **No pre-library test and no characterization test is modified**;
they run with users mode off.

**Tests added:** password hashing and rate limits (per caller, per username,
global); token claims, **disabled user and password reset take effect on the
next request**; **cross-user isolation in every route** (user B gets 404 for
A's session id on uploads GET/POST/DELETE, session search, chat, title; the
denial is logged; A's data unaffected); the admin can read records but a
search by the admin never returns another user's text; restricted-source
visibility (absent from the dropdown, from "All sources", and from direct
calls, for non-members); activity rows written for each event kind with the
right fields, **no document text or snippets in any row**, query text omitted
under `LOCUS_LOG_QUERY_TEXT=false`, retention purge; CSV export escaping
(including formula-injection characters); the Activity/Users screens'
rendering at 4 widths; per-user local storage namespacing. E2E
(`e2e:users`, new): two users upload different PDFs and each can only find
their own; user B cannot reach A's session or the admin pages; the admin sees
both users' searches and uploads in Activity, the failed sign-in and the
denied attempt in the Issues strip, and can disable a user who is then
signed out.

**Build order:** step 5 (admin) becomes *records database → users, sign-in,
sessions → ownership checks in every route → admin role → Users and Activity
screens*, then Sources as already planned.

**Risks added:** (1) **a missed route** would leak a session: mitigated by one
`authorizeConversation()` helper used everywhere and a test that enumerates
every route taking a `conversationId`; (2) **query text is sensitive**, hence
admin-only, retention, and the notice; (3) **a lost admin passcode** locks
admin out (it's in `.env.local`, so recovery is editing a file); (4)
**per-browser session lists** (above); (5) users mode changes the login for
everyone, so it ships **off** and is switched on deliberately.

---

## Amendment 2 — your answers to Amendment 1's questions

**Supersedes Amendment 1 sections B and D where they differ.**

1. **Users can search only what they upload.** Library sources are for the
   admin. So in users mode: normal users get **no** library access of any kind
   (`/api/library/search`, `/api/library/status`, the Sources APIs and the
   scope dropdown all answer 403 for them, server-side) and just search their
   own uploads, as the app does today. The **admin** searches their own
   uploads **and** the library, with the dropdown (*All sources / one source /
   My uploads*). The per-source "visible to chosen users" feature
   (`source_access`) is **dropped**: nothing needs it.
2. **Self-registration.** People create their own account on a sign-up screen
   (username, and a passcode they choose, at least 8 characters, stored with
   scrypt). Because Locus is reachable over a public tunnel, **sign-up is gated
   by a sign-up code** by default: the shared passcode you already use
   (`LOCUS_PASSCODE`, or `LOCUS_SIGNUP_CODE` if set) becomes the code you hand
   to the people you want to let in. `LOCUS_SIGNUP=code` (default) |
   `open` (anyone who finds the link) | `off`. Sign-up is rate-limited (5 per
   hour per address), usernames are unique ignoring case, and you can disable
   or remove any user, or reset their passcode (there is no email, so a
   forgotten passcode means asking you). *Add user* (you create one) stays
   available too. **Open question: code vs fully open (below).**
3. **A per-user upload limit** (`LOCUS_USER_UPLOAD_MB`, default 1,000 MB, users
   mode only) sits under the existing shared 5 GB cap, so one self-registered
   user can't fill everyone's space. Shown on the sidebar's sessions card.
4. **Search text is stored** in the activity log, admin-only, 365 days, with the
   notice on the sign-in screen (as in Amendment 1 §F).

Added tests: sign-up gated by the code, refused when `off`, rate limit, duplicate
and case-variant usernames, weak passcodes; **a normal user gets 403 from every
library and Sources route and sees no dropdown**; the per-user upload limit.

---

## 0. Two facts about this machine that shape the plan

1. **Free space is the real limit, not the cap.** The laptop has **96 GB free
   of 460 GB.** With the 20 GB reserve, indexing stops at about **76 GB** of
   library data, before the 100 GB cap does. The reserve is working as
   intended (it's what stops the laptop filling up), but it means the
   100 GB cap is the binding limit only on a roomier disk. The Sources page
   and terminal say which limit was hit.
2. **A full 50k-document library probably needs 50–65 GB** (projection in §9),
   so on this laptop it would just fit under the reserve, with little room
   for anything else. The inventory and benchmark exist to replace that guess
   with measurements before anything large runs.

---

## 1. Decisions I've made (tell me if you disagree)

| # | Decision | Why |
| --- | --- | --- |
| 1 | **The indexer is its own long-running process** (`npm run library:worker`); `npm run share` starts it automatically **only when** the library is enabled and an admin passcode is set. The app never indexes in-process. | The Next.js server stays read-only on the index (as in Phase 2), one writer for the library index, and an indexing crash can't take the search app down. Buttons on the Sources page work by writing a small *registry* file the worker reads; no process spawning from request handlers. |
| 2 | **"All sources" includes this session's uploads** (two cards, as "Both" does today). "This session" = uploads only. A named source = that source only. | The Phase 1 `UploadSource` exists so uploads can be "one more source". Without this, Phase 2's "Both" would vanish. The old 3-button switch is replaced by the dropdown. |
| 3 | **Sources configured in `.env` (`LOCUS_LIBRARY_DIR`, `LIBRARY_DB_*`) still work for `npm run index:library`** and also appear in the Sources list as read-only rows ("managed in .env"): they can be paused, resumed and rescanned, not edited or removed. | Nothing from Phase 1 breaks, and there's one place that shows everything that's indexed. |
| 4 | **Default `LOCUS_DATA_DIR` is `<project>/data/locus-data`** (not `data/library`, which would give `data/library/library/library.db`). Already gitignored (`/data`) and vercelignored (`/data`). | Same ignore rules cover it; `next.config.ts` already excludes `./data/**` from tracing. |
| 5 | **Default allowed roots are `/Volumes` only** (`LOCUS_ALLOWED_ROOTS` adds more, comma-separated). A folder in your home directory needs one added, e.g. `LOCUS_ALLOWED_ROOTS=/Volumes,/Users/albin/Tenders`. | You asked for `/Volumes` plus folders you add, and it keeps a stolen admin passcode from reading the home directory. |
| 6 | **Admin sign-in is a second step on top of the normal passcode**: an admin must have the normal session *and* the admin cookie. | The proxy and every existing login test stay exactly as they are; admin is purely additive. |
| 7 | **Database sources are table + columns only** (no free-form SQL from the UI); the SELECT is generated with checked, quoted identifiers. A pasted connection string is split into fields. | Free-form SQL typed into a web form is the one place this feature could do real damage; Phase 1's `LIBRARY_DB_QUERY` stays available for `.env` sources. |
| 8 | **Google Drive: PDFs only.** Google Docs/Sheets, shortcuts and non-PDF files are skipped and counted. Public ("anyone with the link") folders only. | Matches "only PDFs are indexed" for every source; private folders need OAuth, which is out of scope ("not supported yet"). |

Open questions for you are at the end (§13). None blocks starting, but 2 and 3
change what I build.

---

## 2. Files

### New

| File | Why |
| --- | --- |
| **Storage** | |
| `src/lib/library/storage/usage.ts` | Real disk usage of everything the library writes (`st_blocks`, not file size), cached, with a cheap fast path |
| `src/lib/library/storage/limits.ts` | Pure decision: ok / paused for cap / paused for reserve, with the message and numbers |
| `src/lib/library/cloudSync.ts` | Detects folders inside cloud-sync locations (path and volume based) |
| **Admin** | |
| `src/lib/admin.ts` | Admin token create/verify (domain-separated from user tokens), admin rate limiter, `requireAdmin(req)` |
| `src/app/api/admin/{login,logout,session}/route.ts` | Admin sign-in/out and "am I admin" |
| `src/app/admin/page.tsx` | Admin sign-in screen |
| **Registry and secrets** | |
| `src/lib/library/sources/registry.ts` | `sources.db`: sources, state, ordinals, commands from the app to the worker |
| `src/lib/library/sources/secrets.ts` | AES-256-GCM sealing of database passwords |
| `src/lib/library/allowedRoots.ts` | Allowed-roots resolution and enforcement |
| **Sources** | |
| `src/lib/library/sources/forms.ts` | Folder / Database / Drive form types and validation; builds `FolderSource` / `DatabaseSource` / `GoogleDriveSource` from a stored config |
| `src/lib/library/sources/db/form.ts` | Form → connection URL + generated SELECT (identifier checks and quoting per dialect); connection-string splitting |
| `src/lib/library/sources/gdriveLink.ts`, `gdriveApi.ts`, `gdrive.ts` | Drive link parsing; API client with backoff; `GoogleDriveSource` |
| `src/lib/library/sources/testSource.ts` | The "Test" operation for each kind |
| **Worker** | |
| `src/lib/library/worker.ts`, `scripts/library-worker.ts` | Reads the registry, reconciles sources, runs the pipeline, writes status |
| **APIs** | |
| `src/app/api/sources/route.ts` | GET list, POST add |
| `src/app/api/sources/[id]/route.ts` | PATCH (rename), DELETE (remove) |
| `src/app/api/sources/[id]/{pause,resume,rescan}/route.ts` | Commands |
| `src/app/api/sources/test/route.ts` | Test before saving |
| `src/app/api/sources/browse/route.ts` | Folder browser listing (folders only) |
| **UI** | |
| `src/app/sources/page.tsx` | Sources page (admin gate) |
| `src/components/sources/{SourcesView,SourceRow,SourceMenu,StatusLine,AddSourcePanel,FolderTab,DatabaseTab,DriveTab,FolderBrowser,ConfirmRemove,SourceIcon}.tsx` | The screens in §8 |
| `src/components/ScopeSelect.tsx` | The search scope dropdown (replaces the 3-button switch) |
| `src/components/StorageCards.tsx` | Library + sessions storage in the sidebar |
| **Scripts** | |
| `scripts/bench-library.ts` | Synthetic 1M-page index and the latency report |
| `scripts/mock-drive.mjs` | A stand-in Google Drive API (for e2e) |
| `scripts/e2e-sources.mjs` | Admin vs normal, folder source + search, DB source, Drive tab |
| `scripts/screenshots-sources.mjs` | Screenshots and layout checks at 1440 / 1024 / 768 / 390 |
| **Docs** | |
| `docs/sources-plan.md` (this file), later updates to `docs/library.md`, `README.md`, `docs/locus-summary.md` | |

### Changed (small, gated)

| File | Change |
| --- | --- |
| `src/lib/library/config.ts` | `LOCUS_LIBRARY_MAX_GB`, `LOCUS_MIN_FREE_GB` (`LIBRARY_MIN_FREE_GB` kept as a deprecated alias), `LOCUS_ALLOWED_ROOTS`, `LOCUS_ADMIN_*`, default `dataDir` |
| `src/lib/library/storage/volume.ts` | Internal disk allowed; network, FAT32, exFAT still refused; disk images allowed with a warning |
| `src/lib/library/storage/guard.ts` | Creates the default data dir (only the default); keeps marker and UUID checks; adds usage and cap checks |
| `src/lib/library/schema.ts`, `store.ts` | Schema v2: source `ordinal` and `name`; document ids allocated inside the source's range (§6); migration |
| `src/lib/library/jobs.ts` | `claimJobs` takes the set of active source ids |
| `src/lib/library/pipeline.ts` | Sources provided per cycle; per-source pause; per-source progress; cap and reserve pauses (generalising the low-space pause); rename-only update when a document's name changed |
| `src/lib/library/query.ts`, `db.ts` | Optional source filter (a rowid range); each hit carries its source name |
| `src/app/api/library/{search,status}/route.ts` | Source filter; status adds sources, usage, worker state |
| `src/lib/auth.ts` | Nothing. (Admin lives in `admin.ts`.) |
| `src/proxy.ts` | Gates `/sources` and `/api/sources/**` on the admin cookie too (defence in depth; routes re-check) |
| `src/components/{Sidebar,Chat,EmptyState,FeaturesProvider,MessageBubble,LibraryBar,LibraryResultCard}.tsx`, `src/app/layout.tsx` | Sources link (admin only), the dropdown, source labels on hits, two storage cards |
| `scripts/share.ts` | Starts the worker (and generates the secrets key) only when library + admin are configured |
| `scripts/index-library.ts` | Uses the new storage limits; otherwise unchanged |
| `.gitignore`, `.vercelignore` | Already cover `/data`; add a check in `verify:no-data-leak` for the default path |
| Phase 1 and 2 tests I wrote | Updated where behaviour deliberately changes (internal disk allowed, 3-button switch → dropdown). **No pre-library test and no characterization test changes.** |

---

## 3. Storage: laptop disk, 100 GB cap, 20 GB reserve

### Where

`LOCUS_DATA_DIR` may be on the internal disk. Unset → `<project>/data/locus-data`,
created on first use. Layout is unchanged from Phase 1
(`library/library.db`, `ocr-cache.db`, `tmp/`, `logs/`, `inventory/`, marker),
plus `library/sources.db` (the registry).

An **explicitly set** `LOCUS_DATA_DIR` must still exist if it's under `/Volumes`
(the ghost-folder problem: an unplugged drive leaves an empty folder on the
internal disk), and is created otherwise. The external-drive option works as
before; the marker's volume UUID is how a drive coming back is recognised.

### What's still refused

Network filesystems (SQLite locking), FAT32 (4 GB file limit), **exFAT**
(unchanged: refused unless `LOCUS_DATA_DIR_ALLOW_EXFAT=true`), read-only
volumes, anything unidentifiable. Newly allowed: the internal disk and the
boot container (the point of this change). A disk image is allowed with a
warning (it's a file-backed volume).

### The cap: what counts and how it's measured

The cap covers **everything the library writes**: `library.db` (+ `-wal`,
`-shm`), `ocr-cache.db`, `sources.db`, `logs/`, `tmp/`, `inventory/`. Not the
session uploads (their own 5 GB cap) and not the source PDFs.

- **Real disk usage** = the sum of `st_blocks × 512` over those files (what
  the disk actually holds, including sparse and preallocated space), not file
  sizes.
- **Two speeds:** a full walk of the library folder every 30 s (a handful of
  files, so cheap), and a fast path before every index write that `stat`s only
  the three big files (`library.db`, `-wal`, `ocr-cache.db`) and adds the last
  walk's remainder.
- **Overshoot is bounded:** `wal_autocheckpoint` and `journal_size_limit`
  (64 MB) stop the WAL ballooning, writes happen in chunks of ≤25 pages, and
  indexing pauses at **cap − 256 MB** rather than at the cap, so the worst
  overshoot is a fraction of that margin.

### The reserve

`statfs` on the data dir's volume: pause when **free space < `LOCUS_MIN_FREE_GB`
(default 20)** even if the cap isn't reached. Checked before every write
batch via the same fast path (statfs is one syscall) and on the 30 s walk.

### When either limit is hit

1. Workers stop claiming jobs; in-flight files stop at their next checkpoint
   (their jobs go back to `pending`; redoing a file replaces whatever partial
   content it left; the OCR cache avoids repeated OCR). Temp files for
   stopped files are deleted as they stop.
2. **Nothing is ever deleted to make room.** Not the index, not the OCR cache,
   not an old source. The only things removed are temp files.
3. The state `paused: storage limit` or `paused: low disk space` is written
   to the worker status. The terminal prints it with current usage (and
   repeats every 5 min while paused); the Sources page shows it per source
   and in a banner; the sidebar storage card shows it.
4. **Search keeps working** on what's indexed (the app only reads).
5. **Resume is automatic** once usage is back under the cap (a source was
   removed, or `LOCUS_LIBRARY_MAX_GB` was raised and the worker restarted) or
   free space is back above the reserve.

Messages (exact wording to be tested):
- `Paused: storage limit. The library uses 99.8 GB of its 100 GB limit. Remove a source, or raise LOCUS_LIBRARY_MAX_GB. Nothing has been deleted.`
- `Paused: low disk space. 18.2 GB free; Locus keeps 20 GB in reserve. Free some space on this Mac; indexing resumes on its own.`

### Cloud-sync folders

A folder is flagged when its real path is under `~/Library/CloudStorage`,
`~/Library/Mobile Documents` (iCloud), or contains a path segment
`Google Drive`, `GoogleDrive`, `OneDrive`, `Dropbox`, `Box`, `pCloud`, `iCloud
Drive`; or when its volume's filesystem is a FUSE/File Provider mount. The
warning appears in the Folder tab's Test result and as a note on the source
row: *"This folder is synced from the cloud. Reading its files can download
them to this Mac. Online-only files are skipped."* Phase 1's `SF_DATALESS`
skip stays: online-only files are never read. (Files a sync client already
downloaded are outside the library cap; they're already on the disk.)

### Storage indicator

The sidebar shows **two** cards when the library is on: *Library* (usage of
100 GB, plus "20 GB reserve · 96 GB free" and a state line when paused) and
*Sessions* (the existing 5 GB card, unchanged). Counts and bytes only, no
paths. Fed by `/api/library/status`; `/api/storage` is untouched.

---

## 4. Admin model

- **Config:** `LOCUS_ADMIN_PASSCODE` in `.env.local`. Unset → admin sign-in
  always fails, the Sources link and page don't exist for anyone, and every
  source API answers 403. Fails closed, like `LOCUS_PASSCODE`.
- **Sign-in:** a user who is already logged in (normal passcode) opens
  *Admin sign-in* (sidebar footer, shown only when an admin passcode is
  configured) and enters the admin passcode at `/admin`. `POST
  /api/admin/login` sets a **second cookie**, `locus_admin`: `HttpOnly;
  Secure; SameSite=Strict; Path=/`.
- **Token:** `{ r: "admin", exp }` signed with HMAC-SHA-256 over a
  **domain-separated** string (`"locus-admin|" + payload`), so a normal
  session token can never verify as an admin one or the reverse. Admin
  sessions are shorter: 8 h (`LOCUS_ADMIN_SESSION_HOURS`). Comparison is
  constant-time (`constantTimeEqual`).
- **Server-side enforcement (not just hidden UI):** every source route starts
  with `requireAdmin(req)`: valid **normal** session **and** valid **admin**
  cookie, else 401/403. State-changing requests also require
  `Content-Type: application/json` and a same-origin `Origin`/`Sec-Fetch-Site`
  header (CSRF defence beyond SameSite). The `/sources` page is gated twice:
  the proxy (Edge, Web Crypto) and the page itself.
- **Rate limiting, stronger than the normal login:** the existing login keys
  on the first `x-forwarded-for` entry, which a client can set itself. The
  admin limiter keys on `cf-connecting-ip` (set by Cloudflare), falling back
  to the **last** `x-forwarded-for` entry, and adds a **global** ceiling: 10
  failures in 15 minutes from anyone locks admin sign-in for 15 minutes, so
  spoofed addresses can't be used to guess forever. Per-caller: 5 per 5
  minutes, as for the normal login. Failures are logged without the
  attempted passcode.
- **Optional hardening (off by default):** `LOCUS_ADMIN_LOCAL_ONLY=true`
  allows admin sign-in only from `localhost` (requests through the tunnel
  carry Cloudflare headers and are refused). Recommended while the app is
  shared publicly. See open question 3.
- **Normal users:** can search (all scopes), see source *names* in the
  dropdown, and see the status line. They get no Sources link, and every
  `/api/sources/**` call fails server-side.

---

## 5. Secrets

What's secret: **database passwords** (and a pasted connection string's
password). The Google API key is *not* stored by Locus: it lives in
`.env.local` as `GOOGLE_API_KEY` and is read from the environment.

- **Where:** the `secrets` table in `LOCUS_DATA_DIR/library/sources.db`.
- **How:** AES-256-GCM. The key is derived (HKDF-SHA-256) from
  `LOCUS_SECRETS_KEY` in `.env.local`; a fresh random 96-bit nonce per
  secret; the source id is the **authenticated data**, so a sealed secret
  copied onto another source fails to open. Stored as
  `version | key-id | nonce | ciphertext | tag`.
- **No key, no secret:** with `LOCUS_SECRETS_KEY` unset, saving a database
  source with a password is refused with "Set LOCUS_SECRETS_KEY in .env.local
  first" (SQLite and Drive sources need no secret). `npm run share` generates
  one into `.env.local` the first time, the way it does for `SESSION_SECRET`,
  but only when the library and admin are configured (so default behaviour
  and its characterization test are unchanged).
- **Never returned to the browser:** the API returns `hasPassword: true`
  and the user/host/port/database, never the password and never a URL that
  contains it. Editing a source: blank password field = keep the stored one.
- **Never logged:** request bodies are never logged on these routes; driver
  and connection errors go through the Phase 1 `redactSecrets`; the source's
  log label is `database postgres://user:***@host/db`. A test greps every API
  response and every captured log line for the test password.
- **Used read-only:** the Phase 1 read-only connection (`default_transaction_read_only`,
  `SESSION TRANSACTION READ ONLY`, SQLite `readonly`); the docs recommend a
  `SELECT`-only database user.
- **If the key is lost or changed:** secrets fail to open (reported per
  source as "Can't read saved password: re-enter it"); nothing else breaks.
- **`sources.db` is on the data volume,** not in the project tree (default
  location is under the already-ignored `/data`).

---

## 6. Sources: how the three kinds work

All three produce `LibrarySource` objects for the **existing Phase 1
pipeline**: the same queue, workers, resume, OCR only on flagged pages,
`eng+hin`, failure log, per-file timeouts, size limit, encrypted-PDF rules.
Nothing in extraction changes.

### Registry and the worker

`sources.db` (written only by the app's admin APIs; read by the worker) holds
each source: `id` (uuid), `ordinal` (1–255, permanent), `kind`, `name`,
non-secret `config` (JSON), `state` (`active | paused | removing`),
`rescan_requested_at`, timestamps. The worker (`library:worker`) polls it every
2 s and reconciles:

- **Add:** a new `active` source is scanned immediately.
- **Pause / Resume:** a state flip; paused sources' jobs aren't claimed
  (`claimJobs` filters on the active set); in-flight files finish or stop at
  a checkpoint.
- **Rescan:** `rescan_requested_at` set → that source is scanned now. Otherwise
  every `LIBRARY_RESCAN_MINUTES` (60) for folder, database and Drive alike.
- **Remove:** state `removing` → the worker deletes that source's documents,
  pages, texts, full-text rows, jobs and failures in batches, then drops the
  registry row and its sealed secret. **Original files and databases are never
  touched.** Then `incremental_vacuum`.
- **Status back to the app:** the worker is the one writer of the library
  index, so it writes per-source progress there (`source_progress`: files
  total from the last scan, files done this pass, state, last scan time, last
  error) and a worker heartbeat. The app reads it. A heartbeat older than 15 s
  shows **"Indexer not running"** on the page, with the command to start it.

### Document ids and the source filter

To make "search one source" cheap without a join or a second index file, each
source gets its own **document-id range**: `docId = ordinal × 2²⁴ + sequence`
(16.7M documents per source, 255 sources, ids stay below 2³², inside the
existing text-id encoding). A source filter is then just
`rowid BETWEEN lo AND hi` on the full-text index, and rowid order is still
source → document → page, so cursor paging is unchanged. Existing Phase 1
indexes become ordinal 0 (a migration, schema v1 → v2). Removing a source
deletes its range.

### Folder

Phase 1's `FolderSource`, unchanged, plus allowed-roots enforcement (§7).

### Database

Phase 1's `DatabaseSource`, driven by the form: **type** (Postgres / MySQL /
SQLite), **host, port, database, user, password** (or a pasted connection
string), **table**, and **column mapping** (id, file name, modified time, and
either file path or file bytes). The SELECT is generated:

```
SELECT "<id>" AS id, "<name>" AS filename, "<modified>" AS modified_at, "<path|bytes>" AS file_path|file_bytes
FROM "<schema>"."<table>"
```

Each identifier is checked against `^[A-Za-z_][A-Za-z0-9_$]*$` (one optional
`schema.` prefix) and quoted per dialect (`"…"` Postgres/SQLite, `` `…` ``
MySQL); anything else is refused. Host: link-local and cloud-metadata
addresses (`169.254.0.0/16`) are refused; databases on private networks are
the point of the feature, so they're allowed. A `file_path` column's values
must resolve **inside the allowed roots** too (§7), or the row is skipped as
`not allowed`: a database row can't point the indexer at `/etc` or the home
directory. SQLite databases are chosen by file path, also inside allowed roots.

### Google Drive

- **Input:** a folder link shared as "anyone with the link". Parsed from
  `drive.google.com/drive/folders/<id>`, `…/u/0/folders/<id>`,
  `…?id=<id>`, with or without `?usp=sharing`. The folder id is all that's stored.
- **API:** Drive API v3 with `GOOGLE_API_KEY` from `.env.local`.
  `files.list` with `q='<folder>' in parents and trashed=false`,
  `fields=nextPageToken, files(id,name,mimeType,size,modifiedTime,md5Checksum)`,
  `pageSize=1000`, `supportsAllDrives=true`. Subfolders (`mimeType =
  application/vnd.google-apps.folder`) are walked depth-first with an explicit
  stack, so memory is bounded by folder count, not file count.
- **Files:** `mimeType = application/pdf` only; Google Docs/Sheets, shortcuts
  and everything else are counted and skipped.
- **Identity and change detection:** key = Drive file id; display name =
  path inside the shared folder (`Sub/File.pdf`); version = `modifiedTime` +
  `md5Checksum` (a PDF's md5 changes when its content does). Unchanged
  version = no download at all. A rename (same id, different name) updates the
  name only: the small pipeline change noted in §2.
- **Download:** `files.get?alt=media` streamed into the temp folder under
  `LOCUS_DATA_DIR`, hashed (sha256) as it streams, size-checked before
  starting (`size` field) and while streaming (`LIBRARY_MAX_FILE_BYTES`), and
  **deleted right after indexing** (`OpenedFile.cleanup`). Counts against the
  cap while it exists; the cap check runs before each download.
- **Rate limits:** HTTP 429, and 403 with `rateLimitExceeded` /
  `userRateLimitExceeded` / `dailyLimitExceeded`: exponential backoff with
  jitter (1 s doubling to 5 min, up to 8 tries), honouring `Retry-After`;
  workers share one request gate so backoff slows the whole source, not one
  file. Daily quota exhausted → the source shows "Paused: Google Drive daily
  limit, retrying later" and retries on the next rescan.
- **Private folder / bad link:** 404 or 403 `notFound`/`forbidden` on the
  root → **"This folder isn't shared with anyone-with-the-link. Private
  folders aren't supported yet."** Missing key → "Google Drive isn't set up
  on this server (GOOGLE_API_KEY)".
- **Warning shown in the tab:** *"Large folders take a long time to download.
  Each PDF is downloaded to this Mac, indexed, then deleted."*
- **Testing hook:** `GOOGLE_DRIVE_API_BASE` overrides the API address, and is
  honoured **only for loopback addresses** (`127.0.0.1`, `localhost`), so it
  can't be pointed at a real internal host.

### The Test button, per tab

| Tab | Test checks | Shows |
| --- | --- | --- |
| Folder | inside allowed roots; exists, is a folder, is readable; cloud-sync check | "Readable · at least 1,240 PDFs found (scan stopped after 5 s)" (a bounded walk) or why not |
| Database | connects (with a short timeout); the columns exist; one read-only `SELECT … LIMIT 5` | 5 sample rows: id, file name, modified time, and for `file_path` whether the file is readable (never file bytes, never secrets) |
| Google Drive | key present; link parses; lists the first pages | "Found 312 files in the first levels (96 PDFs). Large folders take a long time" or the exact reason (not shared / not found / rate limited) |

Every error is in plain language, never a stack trace or a raw driver message
that could contain a secret.

---

## 7. Allowed roots

- **Setting:** `LOCUS_ALLOWED_ROOTS` (comma-separated, absolute). Default
  `/Volumes`. Each root is `realpath`ed at startup; a root of `/` is refused as
  a misconfiguration.
- **Check (`resolveAllowed(path)`)**, used by *every* entry point that takes a
  path: the browse API, Test, Add, Edit, a database `file_path`/SQLite file,
  and the worker at the start of each scan:
  1. reject empty, NUL bytes, relative paths and any `..` segment *before*
     touching the filesystem;
  2. normalise to NFC;
  3. `realpath` it (this follows symlinks, so a symlink inside an allowed root
     that points outside resolves to its real target and fails);
  4. require it to equal an allowed root or be a **descendant by path
     segments** (so `/Volumes-evil` and `/VolumesX` don't match `/Volumes`);
  5. refuse a folder that **contains or lies inside `LOCUS_DATA_DIR`** (it would
     index its own temp files and index).
- **Re-checked at scan time**, not just when the source is added: a folder
  swapped for a symlink later, or a root that stops being allowed, makes the
  source go to `Error: folder is no longer inside an allowed location`.
- **The walk itself** never follows symlinks (Phase 1), so nothing inside a
  source can escape its root.
- **The browser (`/api/sources/browse`)** lists **folders only** (never files,
  never hidden folders), at most 1,000 entries, sorted; with no path it lists
  the allowed roots (and for `/Volumes`, the mounted volumes). Names, no sizes,
  no absolute paths of anything outside the roots. A path outside the roots →
  403, server-side.
- **Never** the browser's own folder picker (`<input webkitdirectory>`), which
  uploads files. The browser is drawn by Locus and only ever sends a path string.

---

## 8. Screens

Tokens (unchanged, from `globals.css`): page `#0A0A0C`, surface `#1A1A1D`,
line `#232327`, text `#F5F5F7`, secondary `#8A8A90`, warm `#F2EFE8`, cream
accent `#E6DCCB`; SF Pro system stack; the existing focus ring (2 px cream).
Same card/chip/button styles as the rest of the app. No new colours (warnings
use the existing `text-warm`/`red-400` already in use).

### 8.1 Admin sign-in (`/admin`)

The login card (same component styling as `/login`), title "Admin sign-in",
one password field, **Continue**, a note "Sources can only be changed by an
admin." Errors inline. On success → `/sources`. Not linked anywhere except the
sidebar's "Admin sign-in" (only when an admin passcode exists).

### 8.2 Sources page (`/sources`, admin only)

```
┌─ header ─────────────────────────────────────────────────────────────┐
│ ◯ Locus   Sources                       [← Back to search] [Sign out] │
├──────────────────────────────────────────────────────────────────────┤
│  Sources                                          [ + Add source ]    │
│  Library uses 38.2 GB of 100 GB · 96 GB free (20 GB kept in reserve)  │
│  ▓▓▓▓▓░░░░░░░░░░░░░░░                                                 │
│  ⚠ Indexer not running. Start it with: npm run library:worker  (if so)│
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 📁  Tenders 2026                                        ⋯    │   │
│  │     /Volumes/Archive/Tenders                                 │   │
│  │     Indexing 42% · 1,204 of 2,880 files                      │   │
│  │     ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  Last scan 12 min ago               │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ 🗄  Purchase records                                    ⋯    │   │
│  │     records · postgres · db.internal                         │   │
│  │     Ready · 12,480 docs · 1.1M pages     Last scan 2 h ago   │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ ☁  Shared drive: BHEL tenders                           ⋯    │   │
│  │     Google Drive · "BHEL tenders"                            │   │
│  │     Paused: storage limit        Last scan 1 day ago         │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Row:** icon (folder / database / cloud), **name**, **location**
  (folder path, `database · type · host`, or Drive folder name; never a
  password, key, or connection string), **status**, last scan time, and a
  **⋯ menu button** (`aria-label="Actions for Tenders 2026"`) with *Pause*
  (or *Resume*), *Rescan*, *Remove*. Menu items are real `<button role="menuitem">`s;
  arrow keys move, Escape closes and returns focus to the ⋯ button.
- **Status line wording:** `Indexing 42% · 1,204 of 2,880 files` ·
  `Scanning… · 8,311 PDFs found so far` · `Ready · 12,480 docs · 1.1M pages` ·
  `Paused` · `Paused: storage limit` · `Paused: low disk space` ·
  `Error: <plain message>` · `Removing…`. Failed/skipped files are a small
  "14 files not indexed" link that opens a list (reason + file name).
- **`.env` sources** get a "managed in .env" note; no Remove.
- **Empty state:** "No sources yet. Add a folder, a database, or a Google
  Drive folder to search it." with the Add button.
- **Polling:** the list refreshes every 3 s while any source is indexing, else 30 s.
- **Phone (390 px):** the header buttons collapse to icons with labels
  (`aria-label`s); each row stacks: icon + name + ⋯ on the first line, location
  (truncated with the full text in `title`) second, status third, progress bar
  full width. No horizontal scroll at any width.

### 8.3 Remove confirmation

A small centred dialog (`role="alertdialog"`, focus on **Cancel**, focus trapped):
*"Remove 'Tenders 2026'? This removes it from search and frees its index
space (about 4.2 GB). The original files are not touched."* **Cancel** /
**Remove** (cream, not red: it's recoverable by adding the source again).
Escape cancels.

### 8.4 Add source panel

A centred panel (max 560 px wide) over a dimmed page; at ≤640 px it becomes a
full-height sheet. `role="dialog" aria-modal="true"`, focus trapped, Escape
closes (asks first if fields are filled), a close button with `aria-label`.

```
┌─ Add source ─────────────────────────────────────────── ✕ ┐
│  [ Folder ]  [ Database ]  [ Google Drive ]                │   ← role="tablist"
│  ──────────                                                │
│  Name        [ Tenders 2026                       ]        │
│  ...tab fields...                                          │
│  ┌ result of Test ──────────────────────────────────────┐  │
│  │ ✓ Readable · at least 1,240 PDFs found                │  │
│  └───────────────────────────────────────────────────────┘ │
│                         [ Test ]   [ Cancel ]  [ Add source ]│
└────────────────────────────────────────────────────────────┘
```

**Add source** is disabled until a Test has passed with the current values
(editing a field clears the result). All inputs have visible `<label>`s,
`autocomplete="off"`, and inline field errors tied with `aria-describedby`.

**a. Folder tab**
- *Name*; *Folder* (path field: paste or type) + **Browse** button.
- One-line note: *"The folder must be on this computer or on a drive connected
  to it."*
- Test → "Readable · at least N PDFs", or the reason: *"That folder isn't in an
  allowed location. Allowed: /Volumes."*, *"Folder not found."*,
  *"Locus can't read that folder (permission denied)."* Plus the cloud-sync
  warning where it applies.

**b. Database tab**
- *Name*; *Type* (select: PostgreSQL / MySQL / SQLite).
- Server types: *Host*, *Port* (defaults 5432 / 3306), *Database*, *User*,
  *Password* (`type=password`; shows "saved" when editing), or **"Paste a
  connection string instead"** (splits into the fields; the pasted text is not
  kept). SQLite: *Database file* with the same Browse (files allowed here, inside
  allowed roots).
- *Table* (optionally `schema.table`) and **column mapping**: *ID column*,
  *File name column*, *Modified time column*, and *File content*: a choice
  between *File path column* and *File bytes column*, each with a column name.
- A line: *"Locus only reads. Use a database user that can only SELECT."*
- Test → "Connected · 5 sample rows" with a small table; errors like *"Couldn't
  connect (connection refused)."*, *"Login failed."*, *"Column 'modified' not
  found in 'documents'."*

**c. Google Drive tab**
- *Name*; *Drive folder link* (paste). Helper: *"Share the folder as 'Anyone
  with the link', then paste the link."*
- A warning line: *"Large folders take a long time to download. Each PDF is
  downloaded to this Mac, indexed, then deleted."*
- If `GOOGLE_API_KEY` is missing: the tab is shown but replaced with *"Google
  Drive isn't set up on this server (GOOGLE_API_KEY is missing)."*
- Test → "Found 312 files (96 PDFs) in the first levels", or *"This folder isn't
  shared with anyone-with-the-link. Private folders aren't supported yet."*,
  *"That doesn't look like a Google Drive folder link."*, *"Google is limiting
  requests right now; try again in a minute."*

### 8.5 Folder browser

Opens as a second layer over the Add panel (same dialog treatment; at phone
width it replaces the panel's content with a Back button).

```
┌─ Choose a folder ────────────────────────────────────── ✕ ┐
│  / Volumes / Archive / Tenders                             │   ← breadcrumb, each part a button
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📁 2024                                               │  │
│  │ 📁 2025                                               │  │
│  │ 📁 2026                                          ›    │  │
│  └──────────────────────────────────────────────────────┘  │
│  "/Volumes/Archive/Tenders" is selected                    │
│                          [ Cancel ]  [ Use this folder ]   │
└────────────────────────────────────────────────────────────┘
```

Start: the allowed roots. Click a row to open it, ↑ / breadcrumb to go up
(cannot go above an allowed root). Keyboard: arrows move, Enter opens, Backspace
goes up. A folder it can't read is shown dimmed with "no access". Empty:
"No folders here." Loading and error states are text, not spinners alone.

### 8.6 Search scope dropdown

One compact select in the search area (replacing the 3-button switch),
`aria-label="Search in"`:

```
 [ All sources        ▾ ]   Library: 48,210 documents · 2.1M pages indexed · 312 still indexing · drive …
     All sources
     ─────────────
     Tenders 2026
     Purchase records
     Shared drive: BHEL tenders
     ─────────────
     This session
```

Native `<select>` styled to the app (so keyboard, screen readers and phones
get the real control); the status line beside it wraps under it at narrow
widths. Persisted per browser; the starting value comes from
`LOCUS_SEARCH_SCOPE`. Library hits get a **source chip** (icon + name) and
the folder-relative path / `db:<id>` / Drive path, as now. Paging, "at least N"
counts and the 3-character library minimum are unchanged.

### 8.7 Sidebar

Footer, top to bottom: **Sources** link (admin only; folder-database icon) ·
*Library* storage card · *Sessions* storage card · **Admin sign-in** (non-admins,
only if an admin passcode exists) or **Admin: sign out** · Log out.

### Responsive and accessibility rules

- Tested at **1440, 1024, 768 and 390 px**: the screenshots script also asserts
  *no horizontal scroll* (`scrollWidth ≤ clientWidth`) and *no overlap* between
  the bounding boxes of sibling controls on each screen.
- Real `<button>`, `<label>`, `<select>`, `<table>` elements; icon-only buttons
  have `aria-label`s; the existing global `:focus-visible` ring is used (not
  removed anywhere); tabs use `role=tablist/tab/tabpanel` with arrow-key
  navigation; dialogs trap focus and restore it on close; status changes are
  in `aria-live="polite"` regions; colour is never the only signal.
- `prefers-reduced-motion`: no progress-bar animation.
- Screenshots saved to `docs/screenshots/`, desktop (1440) and phone (390),
  of: Sources page, Add panel (each of the 3 tabs), folder browser, search
  scope dropdown (open).

---

## 9. Scale benchmark (Phase B, last step)

- **Build** a synthetic library index of **≥ 1,000,000 pages** under
  `data/locus-data-bench/` (inside the project, gitignored, counted against the
  same cap), straight through the library's real write path (`writePages`,
  FTS5 trigram, exact + loose) in 25-page chunks, with `synchronous=OFF` only
  during the build. Text is generated deterministically (seeded) with a
  Zipf-like word-frequency curve over a vocabulary that includes numbers,
  codes (`26-2080`), punctuation and Hindi, ~2,400 characters per page, so
  rare / typical / common queries behave like real tender text.
- **Queries (route-equivalent, via `librarySearch` and via the built route):**
  - **rare:** matches < 100 pages; **typical:** 300–5,000 pages; **common:**
    ≥ 10% of all pages;
  - **short:** the shortest queries the library accepts (3 characters), plus
    the 1–2 character refusal path (instant) and a *measured* full scan over a
    slice, extrapolated, to show why those are refused.
  - Each as first window (hits + exact count within the 300 ms budget), and a
    deep "show more".
  - ≥ 100 queries per class; report **p50 / p95 / max**, how often the count
    hit its budget ("at least"), and the same through the HTTP route.
- **Also reports:** index bytes per page (`library.db` + FTS), build rate, and
  a **projection for 50k documents (~3.3M pages)** by size and by latency
  (extrapolating from a 250k / 500k / 1M curve, not a single point).
- **If p95 > ~500 ms at 1M pages (or at the 3.3M projection):** implement
  **sharding**: N index files split by document-id range, counts run in
  parallel across shards in worker threads (better-sqlite3 is synchronous),
  hit windows read shard by shard in id order (so the cursor stays a rowid),
  and `sources.db` records the shard map. Then re-benchmark and report both
  sets of numbers.
- **Space:** records `df` before and after; **deletes the synthetic index
  afterwards and prints the freed space** (and refuses to start if building
  it would cross the cap or the reserve; on this laptop, 96 GB free, a 1M-page
  index of ~13–20 GB is fine).

Projection inputs I'm starting from (to be replaced by the measurements): the
session index measured 19.7 KB/page with one reading per page; the library
stores one copy of the text instead of three, so roughly **13–20 KB/page**,
i.e. **~45–65 GB for 3.3M pages**, plus an OCR cache of a few GB.

---

## 10. Test plan

**Unit / integration (vitest):**

| Area | Covers |
| --- | --- |
| Storage | **Internal disk now accepted** (real `df/mount/diskutil` fixtures); network, FAT32, exFAT (and the override) still refused; default dir created, explicit `/Volumes/…` must exist. **Cap and reserve:** a fake usage meter and fake `statfs` drive pause and resume at each limit; **nothing deleted** (a snapshot of the index and OCR cache is byte-identical before/after a pause); search works while paused; messages with exact numbers; overshoot bounded; `LIBRARY_MIN_FREE_GB` alias. Real `st_blocks` measurement against a sparse file. |
| Cloud sync | Detects `~/Library/CloudStorage/…`, `Google Drive`, `OneDrive`, `Dropbox`, iCloud paths and symlinks into them; doesn't flag ordinary folders; dataless files still skipped. |
| Admin | Fail closed (no passcode). Login success/failure, cookie attributes, rate limits (per-caller, global lock, spoofed `x-forwarded-for` can't bypass), **user token ≠ admin token** (and reverse), expiry, tampering. **Every source route rejects: no session, user-only session, bad admin cookie** (401/403), a CSRF-style cross-origin POST, wrong content type. Proxy gates `/sources`. |
| Secrets | Seal/open round trip; wrong key; **blob swapped to another source fails**; no key → refused; **no API response and no captured log line contains the test password** (including error paths); `hasPassword` only. |
| Allowed roots | `..`, NUL, relative, `/Volumes-evil`, symlink escape (inside root → outside), NFC/NFD, a folder containing the data dir, root `/` misconfigured, **server-side 403 from browse/test/add/edit**, re-check at scan time, DB `file_path` outside roots skipped. |
| Registry / worker | Add, pause, resume, rescan, remove (index entries gone; **original files byte-identical**), ordinals never reused, heartbeat staleness, commands survive a worker restart, `.env` sources listed read-only. |
| Pipeline changes | Per-source pause; per-source progress; rename-only update; **all Phase 1 pipeline/resume/inventory tests still pass unchanged.** |
| Search | Source filter via rowid range equals a brute-force scan per source; cursor paging across sources; counts per source; hit source labels; old v1 index migrates to ordinal 0. |
| Database form | Identifier validation and quoting per dialect (including injection attempts), connection-string splitting, URL generation never containing the password in a returned value, 169.254.x refused, SQLite fixture end to end. |
| Google Drive | Mocked API: pagination, recursion, PDF-only, change by md5/modifiedTime (no re-download), rename-only, download → index → temp deleted, size limit, **429 and 403 rate-limit backoff** (fake timers, `Retry-After`), private folder message, missing key, bad link, loopback-only API base. |
| UI | Component renders: rows and every status wording, menu, confirm dialog, tabs, folder browser, dropdown, storage cards; **library off ⇒ nothing new renders**; focus trap and Escape. |

**End-to-end (real browser):**

- `e2e:sources` (new): **admin vs normal user** (normal user: no Sources link, `/sources` redirects, APIs 403; admin: full access); **add a folder source and search it** (through the folder browser, restricted to a temp allowed root; outside root refused); **database source against the SQLite fixture** (Test shows 5 rows; indexed; searchable; password never on screen or in responses); **Google Drive tab with a mocked Drive API** (Test, add, indexed, searchable, link errors); pause/resume/rescan/remove from the menu; storage-limit pause banner.
- Updated `e2e:library` (dropdown instead of the 3 buttons), and the existing `e2e` and `e2e:chat` **unchanged and green with the library off**.
- `screenshots-sources.mjs`: the screenshots and the width checks in §8.

**Gates, with literal output, at the end of Phase B:** `vitest` (twice),
`tsc`, `eslint`, `build`, `verify:index`, `verify:library`,
`verify:no-data-leak` (extended to assert nothing under the default data dir
or `sources.db` is traced into a build), `e2e`, `e2e:chat`, `e2e:library`
(both chat modes), `e2e:sources`, plus the unmodified-tests checks
(`git diff --stat pre-library HEAD -- <33 test files>` and
`git diff --stat pre-sources HEAD -- src/characterization` both empty).

---

## 11. Build order (Phase B)

1. Storage: usage meter, limits, volume/guard changes, config; cloud-sync detection; tests.
2. Schema v2 (ordinal, name), id ranges, source filter in query; migration; tests.
3. Registry, secrets, allowed roots; tests.
4. Pipeline: per-source pause/progress, active-set claiming, cap/reserve pauses, rename-only; worker; tests (Phase 1 suites green throughout).
5. Admin (`admin.ts`, routes, proxy gate); tests.
6. Source forms: DB form, Drive client and source, Test operations; mocked-Drive tests.
7. Source APIs and browse.
8. UI: Sources page, panel, tabs, browser, dropdown, storage cards, sidebar; component tests.
9. `share` starts the worker; docs (README, `library.md`, `locus-summary.md`).
10. e2e, screenshots, gates.
11. Benchmark, and sharding only if it's needed; delete the synthetic index.

---

## 12. Risks

1. **Free space on this machine** (§0): 96 GB free means the reserve stops indexing near 76 GB. A full 50k-document library is projected at 45–65 GB plus the OCR cache: it fits, barely. Mitigation: measured projection from the inventory before a big run; `LOCUS_MIN_FREE_GB` is adjustable; the pause is clean and resumable.
2. **Admin over a public tunnel.** The app is shared publicly, so the admin sign-in is reachable by anyone with the normal passcode. Mitigations: separate passcode, strict-SameSite cookie, short sessions, global lockout that spoofed IPs can't dodge, and `LOCUS_ADMIN_LOCAL_ONLY` (recommended). Residual: a weak admin passcode.
3. **Folder browser exposes directory names** under the allowed roots to admins. By design; folders only, roots only, server-enforced.
4. **A database source runs queries against a real database.** Read-only session, generated SELECT with quoted identifiers, no free-form SQL, `LIMIT` on Test, batched in production. Still: a `SELECT`-only user is the real protection.
5. **Cap overshoot between checks.** Bounded to a fraction of the 256 MB margin by chunking and a WAL limit; the worst case is tested.
6. **Two processes on one data dir** (app reads, worker writes; app writes `sources.db`, worker reads). SQLite WAL on a local disk handles this; `busy_timeout` everywhere; each file has exactly one writer *role* except `sources.db` (app writes commands; the worker only reads it and records its own status in `library.db`).
7. **Google Drive:** quota limits, slow large folders, and API-key-only access limited to public folders. Rate limiting is handled with backoff and an honest status; private folders are "not supported yet". A key in `.env.local` is a secret too (never logged; not stored by Locus).
8. **Source ordinal ceiling** (255 sources, 16.7M documents each): far above need; documented.
9. **Schema v1 → v2 migration** touches the library index: done in one transaction, with a copy-free in-place migration (existing ids become ordinal 0); covered by a test that migrates a real Phase 1 index. The session index schema is untouched (the characterization snapshot guards it).
10. **Worker not running** is the most likely "it doesn't work" report: the Sources page says so, with the command, and `npm run share` starts it when library + admin are configured.
11. **Replacing the 3-button scope switch** changes Phase 2's `LOCUS_SEARCH_SCOPE` meanings: `session` stays; `library` and `both` both mean "All sources" now (alias), and `all` is added. No one outside the tests uses it yet.

---

## 13. Decisions (all settled)

Separate worker process; users search only their own uploads (admin also
searches the library); self-registration **gated by a sign-up code** (only people
you invite can register); search text stored; allowed roots = `/Volumes` only
(folders are added with `LOCUS_ALLOWED_ROOTS`); admin sign-in works through the
tunnel (`LOCUS_ADMIN_LOCAL_ONLY` optional). Phase B is building these.
