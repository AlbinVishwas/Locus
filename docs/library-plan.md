# Document library — plan (Phase 0)

Status: **plan only, for review.** No feature code exists yet. Restore point:
tag `pre-library` (commit `ee9b8e0`).

The goal: search a large document library (target ~50,000 PDFs, in a test folder
of more than 2 TB holding millions of files of every type) from a folder path or
a database, beside today's per-session uploads. Every new capability is **off by
default**. With no new settings, Locus behaves exactly as it does today.

---

## 1. What the current code does that matters here

| Fact | Where | Why it matters |
| --- | --- | --- |
| One SQLite index holds the tender corpus (`conversation_id IS NULL`) and every session's uploads | `src/lib/search/schema.ts`, `scripts/indexer/store.ts` | The library gets its **own** file. The session index and its schema stay untouched (pinned by a characterization test). |
| FTS5 trigram, contentless, `case_sensitive 1`, text folded by `normalize.ts` | `schema.ts`, `src/lib/search/normalize.ts` | The library reuses the same tokenizer and the same normalization, so "exact" means the same thing in both scopes. |
| `search()` loads **every page** into an in-memory map, and reloads it whenever the index's generation counter changes; it also returns **every** matching row id before grouping | `src/lib/search/query.ts` | Fine at 871 pages (and ~26 ms for common words at 100k pages). At library scale, with an indexer writing constantly, it isn't. The library gets its own query module (section 6), and `query.ts` is left alone. |
| `extractDocument()` reads a whole file's text layer in one `pdftotext` call (up to a 512 MB buffer) and returns every page's text at once | `scripts/indexer/extract.ts`, `exec.ts` | That breaks the "no step loads a whole large PDF into memory" rule. The library gets a page-by-page extractor built from the same primitives (`pdf.ts`, `classify.ts`, `labels.ts`, `ocrCache.ts`, `exec.ts`), all reused **unchanged**. Uploads keep using `extractDocument()` exactly as now. |
| Scratch files go to `os.tmpdir()`, on the internal disk | `extract.ts` (`ctx.tempDir`), `uploads/pipeline.ts` | The library passes its own temp dir on the external drive and sets `TMPDIR` for itself and the tools it starts. Uploads are unchanged. |
| Measured at 100k synthetic pages: 19.7 KB/page with one reading per page, 39 KB with two; p95 ~24–40 ms for 3+ chars; ~0.5 s for 1–2 char queries (full scan) | `docs/tender-search-report.md` | This is the basis for projecting the library: ~3M+ pages, ~60 GB of index, and short queries unusable at that size (section 6). |
| Uploads are on whenever `LOCUS_ENABLE_UPLOADS=true`; chat is off by default | `src/lib/uploads/config.ts`, `src/config/features.ts` | The library switch follows the same pattern: one env var, read per request, defaulting to off. |

---

## 2. Overview

```
                      ┌──────────────────────────── LOCUS_DATA_DIR (external SSD) ─────────────┐
 LOCUS_LIBRARY_DIR    │  library/library.db   documents · pages · texts · FTS · jobs · failures│
 (read in place) ──┐  │  library/ocr-cache.db OCR cache (same OcrCache class, its own file)    │
                   │  │  library/tmp/         rendered pages, DB blobs being processed          │
 LIBRARY_DB_URL ───┼─▶│  library/logs/        run log, failures (JSONL, rotated)                │
 (read-only query) │  │  library/inventory/   inventory reports + resumable checkpoint          │
                   │  │  .locus-data-dir      marker: volume UUID; checked before every write   │
 (UploadSource) ───┘  └────────────────────────────────────────────────────────────────────────┘
        │                        ▲                                 ▲
        ▼                        │ one writer (lock file)          │ read-only
  npm run index:library ─────────┘                                 │
  (scan → queue → bounded workers → page-by-page extract → write)  │
                                                                   │
  Next.js server: /api/library/search, /api/library/status ────────┘
  UI: scope switch (Session / Library / Both), library results card, status line
```

---

## 3. Source interface

```ts
// src/lib/library/sources/types.ts
export interface SourceEntry {
  /** Stable identity within the source: a folder-relative path (NFC), or a database row id. */
  key: string;
  /** What results show: the folder-relative path, or "db:<id> · <filename>". Never an absolute path. */
  displayName: string;
  sizeBytes: number | null;     // null when the source can't say without reading
  modifiedAt: string;           // ISO; change detection compares (sizeBytes, modifiedAt)
}

export interface OpenedFile {
  path: string;                 // a local path poppler can read
  sha256: string;               // computed by streaming, never by loading the file
  cleanup(): Promise<void>;     // folder: no-op (nothing copied). database: delete the temp file.
}

export interface LibrarySource {
  readonly id: string;          // stable, e.g. "folder:<sha1 of root>", "db:<sha1 of url without credentials + query>"
  readonly kind: "folder" | "database" | "upload";   // later: "s3" | "sharepoint" | "gdrive"
  describe(): { kind: string; label: string };       // for status/logs; never contains credentials
  /** Streams entries: constant memory, whatever the size of the source. */
  scan(signal: AbortSignal, onSkip: (s: SkipRecord) => void): AsyncIterable<SourceEntry>;
  /** Makes one entry readable as a local file (a temp copy only when the source isn't a filesystem). */
  open(entry: SourceEntry, tempDir: string, signal: AbortSignal): Promise<OpenedFile>;
  close(): Promise<void>;
}
```

S3, SharePoint and Google Drive fit the same shape: `scan` pages through the
provider's list API, and `open` streams the object into `tempDir` on the
external drive. Nothing else in the pipeline needs to know about them.

### FolderSource (`LOCUS_LIBRARY_DIR`)

- **Streaming walk.** Depth-first with `fs.opendir` (which streams a directory
  rather than reading it whole), using an explicit stack of open directory
  handles. Memory is bounded by directory depth, not by file count or by the
  size of any one directory. No file list is ever held.
- **PDFs only.** A file is a candidate if its extension is `.pdf` (any case) and
  it passes the include/exclude patterns. Everything else is counted by
  extension (a bounded table; past 1,000 distinct extensions the rest are
  aggregated as "other") and skipped. Opening a candidate checks the `%PDF-`
  header; a `.pdf` that isn't one is logged as `skipped: not a PDF`.
- **Patterns** (`LIBRARY_INCLUDE` / `LIBRARY_EXCLUDE`, comma-separated globs,
  matched with `picomatch` against the folder-relative path). Default
  excludes: `.Trashes`, `.Spotlight-V100`, `.fseventsd`,
  `.DocumentRevisions-V100`, `.TemporaryItems`, `$RECYCLE.BIN`,
  `System Volume Information`, `**/.*` (hidden), `**/~$*`, `**/*.tmp`,
  `**/*.part`, `**/*.crdownload`, `**/*.download`, `**/*.zip`. An excluded
  directory is never descended into.
- **Symlinks are never followed**, so a symlink loop can't happen. They're
  counted and logged as `skipped: symlink`. A firmlink or hard-linked
  directory cycle is caught by keeping the (dev, inode) of every directory on
  the current path. The walk stays on one device by default
  (`LIBRARY_CROSS_DEVICE=false`); another mount point inside the folder is
  logged and skipped.
- **Problems are logged with a reason, then the walk continues:**
  - `EACCES`/`EPERM` → `skipped: permission denied`
  - `ENAMETOOLONG` → `skipped: path too long`
  - `ENOENT` mid-scan → `skipped: disappeared during scan`
  - a name that isn't valid Unicode → `skipped: unreadable filename` (keys are stored NFC; the raw name is used to open)
  - a file modified in the last `LIBRARY_SETTLE_SECONDS` (default 120), or whose size or mtime changes while it's being hashed → `deferred: still being written`, retried on a later pass
  - over `LIBRARY_MAX_FILE_BYTES` (default 500 MB) → `skipped: too large`, listed so you can decide later
  - an online-only file in a synced folder (macOS `SF_DATALESS`) → `skipped: not downloaded`. Reading one would make the sync client download it to the internal disk, which breaks the storage rule.
- **Read-only.** Files are opened with `O_RDONLY` only (hashing, the header
  check); poppler and tesseract only read. Nothing is ever copied, and no route
  ever serves a source file. Proof: the Phase 1 tests run against a fixture
  tree made read-only with `chmod -R a-w`, plus a before/after snapshot of
  every file's (size, mtime, inode, sha256). Reading can update access times,
  which is metadata, not content.
- **Change detection: mark-and-sweep, no in-memory list.** Each scan has a
  scan id. For each entry seen, the indexer looks up `(source_id, key)` (in
  batches, using the unique index):
  - unknown → queue `index`
  - same size and mtime → mark seen
  - size or mtime different → hash; same hash → update mtime only, otherwise queue `index`

  After a scan **completes** (never after an aborted one, or one whose root
  became unreachable), documents not seen in it are candidates for deletion.
  **Renames:** a newly queued file whose hash matches a not-seen document
  becomes a rename in place, with no re-extraction. Whatever is still unseen
  once the queue has drained is deleted.
- **Rescan** every `LIBRARY_RESCAN_MINUTES` in `--watch` mode (default 60).
  File watching (`LIBRARY_WATCH=true`, `fs.watch` recursive) only triggers an
  earlier rescan; it's never trusted as the only signal, because synced and
  network drives drop events.

### DatabaseSource (`LIBRARY_DB_URL` + `LIBRARY_DB_QUERY`, in `.env.local`, never committed)

- **One interface, three dialects:** `sqlite:` (better-sqlite3, already a
  dependency), `postgres://` (`pg`), `mysql://` (`mysql2`). The drivers are
  loaded lazily, only when that dialect is configured.
- **The query** returns `id, filename, modified_at`, plus either `file_path`
  or `file_bytes`. It's wrapped, never edited:
  - **Listing, in batches (keyset):** `SELECT id, filename, modified_at, <file_path | byte length> FROM (<query>) q WHERE q.id > ? ORDER BY q.id LIMIT ?`. Batch size `LIBRARY_DB_BATCH_SIZE`, default 500. The batch never includes `file_bytes`, so 50k rows never load at once.
  - **Bytes, per row, in chunks:** `SELECT substr(file_bytes, ?, ?) …` (`substring(… from … for …)` on Postgres, `SUBSTRING` on MySQL), 8 MB at a time, written straight to `library/tmp/` on the external drive. Memory stays bounded even for a 500 MB blob.
  - **Paths:** with `file_path`, the file is read in place under the same rules as FolderSource.
- **Read-only, three ways:** a read-only connection (SQLite `readonly: true`;
  Postgres `default_transaction_read_only = on`; MySQL `START TRANSACTION READ
  ONLY`), every value passed as a bound parameter, and the docs recommend a
  database user that only has `SELECT`.
- **No credentials in logs:** the URL is shown with its password masked, and
  driver error messages are run through the same redaction before logging.
- **Tests:** a local SQLite fixture covers both `file_path` and `file_bytes`
  (including a blob bigger than one chunk), the read-only guarantee (a write
  attempt fails) and batching (a 2,000-row fixture with a batch size of 100
  never holds more than 100 rows). Postgres and MySQL are covered by
  documentation with exact configs, plus SQL generation unit tests. A test
  against real servers needs one running (see intervention points).

### UploadSource

A thin adapter over the existing upload flow. `scan` lists one session's
uploads (`uploadedDocuments`), and `open` returns the stored path. Upload
routes, the pipeline and storage stay exactly as they are. The adapter exists
so later code (and future sources) can treat uploads as one more source, for
example in "Both" search. It doesn't make the library indexer index uploads;
those already live in the session index.

---

## 4. Indexing pipeline

- **Job queue, persistent, in `library.db`.** The queue lives in the same file
  as the documents on purpose: completing a job and writing its result commit
  in **one transaction**. Two separate SQLite files can't commit atomically
  together.
  - Jobs are `(source_id, key, action index|delete|rename, state pending|running|failed, attempts, lease_until, last_error)`, with a unique partial index so a key has at most one live job.
  - **Nothing lost:** a job is only removed in the same transaction that writes its outcome.
  - **Nothing done twice:** identity is `UNIQUE(source_id, key)`. A redo first deletes whatever partial rows that document has, and the OCR cache means redone work doesn't re-run OCR.
- **Resumable.** On start, `running` jobs from a crash, sleep, Ctrl+C or a
  pulled drive go back to `pending`. On Ctrl+C, workers stop taking new work,
  finish in-flight pages up to a grace period, then exit. Anything still
  running is simply redone next time.
- **Page-by-page extraction.** Built from the existing primitives; no step
  loads a whole PDF:
  - `pdfinfo` gives the page count and sizes, plus encryption.
  - Encrypted PDFs that need a password are logged as `skipped: encrypted`. Owner-password-only PDFs (readable, just restricted) are also skipped by default, per your rule; `LIBRARY_INDEX_RESTRICTED_PDFS=true` would index them (open question 2).
  - Text layer: `pdftotext -f N -l N` per window of pages (default 1 page; small files may use a 50-page window).
  - Image coverage: `pdfimages -list -f -l` per window.
  - Blank check and OCR on flagged pages: `pdftoppm` → PNG in `library/tmp/`, then `tesseract`. Each PNG is deleted as soon as its page is done.
  - Pages are written in chunks (one transaction per 25 pages), so a large document becomes searchable as it goes. A partly indexed document is marked `indexing` in results.
- **OCR policy:** `LIBRARY_OCR_PAGES=auto` (flagged pages only) by default;
  `all` stays available. `LIBRARY_OCR_LANG=eng+hin`.
- **Timeouts:** per tool call `PAGE_TIMEOUT_MS` (existing, 120 s), and per
  file `LIBRARY_FILE_TIMEOUT_MS` (default 30 min). Either one logs and marks
  the document failed, then moves on.
- **Failures:** each one goes to the `failures` table and to
  `logs/failures.jsonl`, with a kind (`corrupt`, `encrypted`, `unreadable`,
  `too-large`, `timeout`, `not-a-pdf`, `permission`, `vanished`, `other`) and
  a message. Then the indexer skips the file and continues. `--retry-failed`
  queues them again.
- **Bounded CPU and memory:**
  - `LIBRARY_CONCURRENCY` caps external tool processes (default: cores − 2).
  - `LIBRARY_FILES_IN_FLIGHT` caps files being worked on (default 4).
  - The process lowers its own priority (`os.setPriority`, nice 10; children inherit it).
  - Memory is sampled every 5 s for the indexer plus its child processes, and the peak is reported. Phase 3 reports the measured peak.
- **`npm run index:library`:**
  - Wraps itself in `caffeinate -i -w <pid>`, like `share` does.
  - Takes one writer lock (`library/indexer.lock`, holding the pid; stale locks are detected).
  - Runs one pass and exits; `--watch` keeps rescanning.
  - Progress every 2 s: files done/queued, pages done, pages/sec (rolling), ETA, failures, free space, and state (`running`, `paused: low disk space`, `paused: library drive not connected`).
  - Search works on whatever's indexed so far.

### `npm run library:inventory` (Phase 3's first step)

This scans `LOCUS_LIBRARY_DIR` with **no indexing and no OCR** and writes a
report to `LOCUS_DATA_DIR/library/inventory/` (JSON and Markdown):

- **Counts:** total files and bytes by type, number of PDFs.
- **PDF sizes:** median, p90 and largest. A fixed log-bucket histogram keeps
  memory constant (about 1% resolution); the largest few files are tracked
  exactly.
- **Skipped files and why:** same reasons as FolderSource.
- **Sample:** about 300 PDFs, chosen uniformly at random while the scan streams
  (reservoir sampling, constant memory). From these: pages per PDF, and the
  share of pages that would need OCR (text layer, image coverage and blank
  check per page, with no OCR run).
- **Projection for the full folder:**
  - total pages
  - indexing time with OCR on flagged pages only, using an OCR rate measured on ~20 of the sampled flagged pages. The rendered pages and their text are discarded and nothing is indexed.
  - index size on the external drive, measured by building a throwaway index of the sampled pages' text in `library/tmp/` and deleting it.

  If you'd rather the inventory run no tesseract at all, the time estimate
  can use the rate measured in the trial instead.
- **How long the scan took**, for this run and in total across resumed runs.
- **Safe to stop and rerun.** A checkpoint records directories (up to depth 3)
  that are fully counted, and saves the running totals each time one
  finishes. A rerun skips those and redoes only the directory that was
  interrupted. The report is written to a temp name, then renamed, so a
  half-written report never exists.

---

## 5. New data, and where it lives

Everything the library writes goes under `LOCUS_DATA_DIR`. Nothing goes into
`data/` or the session index.

| File | Contents |
| --- | --- |
| `library/library.db` | `meta`, `sources`, `documents(id, source_id, key, display_name, size, modified_at, sha256, page_count, status, error, last_seen_scan, …, UNIQUE(source_id, key))`, `pages(doc_id, page_no, label, source, ocr_reason, …) WITHOUT ROWID`, `texts(id, body)`, FTS5 `texts_exact` / `texts_loose` (trigram, contentless, `case_sensitive 1`), `jobs`, `failures`, `scans` |
| `library/ocr-cache.db` | The existing `OcrCache` class, pointed at this file |
| `library/tmp/` | Scratch files; deleted per page or per file, and the folder is emptied on start |
| `library/logs/` | `run-<date>.log`, `failures.jsonl`; rotated at 50 MB × 10 |
| `library/inventory/` | `report-<date>.{json,md}`, `checkpoint.json` |
| `.locus-data-dir` | Marker file: the volume UUID it was created on, and a format version |

Two choices in this layout that differ from the session index, on purpose:

- **Text row id = `docId × 2²¹ + pageNo × 2 + kind`.** A match then says which
  document, page and reading it is with **no page map in memory and no
  join**. `ORDER BY rowid` is document order then page order, so pagination is
  a cursor (`rowid > ?`) rather than collecting every hit. The limits are
  about a million pages per document and 2³² documents, safely inside
  JavaScript's integer range.
- **Only `body` is stored**, not the `search` and `loose` copies. Those exist
  in the session index for full-scan short queries and the brute-force
  checker; the library recomputes them from `body` when needed. That's
  roughly ⅓ less text on disk.

Durability: WAL, `synchronous=FULL`, `fullfsync=ON` (macOS needs that for a
real flush to the drive), and `PRAGMA quick_check` before resuming after the
drive was disconnected.

---

## 6. Search

- **Scope:** `LOCUS_SEARCH_SCOPE=session|library|both`, default `session`
  (today's behaviour). It only matters when `LOCUS_LIBRARY_ENABLED=true`.
  When the library is enabled, a scope switch (Session / Library / Both)
  appears by the search box; the browser remembers each user's choice locally,
  starting from the setting.
- **"Both"** shows two cards: today's session card, unchanged, then a library
  card, each with its own "show more". Merging two differently scaled result
  sets into one ranked list would invent an ordering neither has.
- **Library search** (`src/lib/library/query.ts`, a new file; `query.ts` is
  untouched):
  - FTS phrase match with the same normalization. Hits come back in windows of 50 using a rowid cursor, so the browser never receives everything.
  - Each hit shows the folder-relative path (or `db:<id> · filename`), the page, a snippet and the OCR badge.
  - Counts: pages and documents are counted exactly within a time budget (default 300 ms). Past that, it shows "at least N" and the exact count is fetched separately. Phase 3 measures whether a budget is needed at all.
  - Queries under 3 characters get "Type at least 3 characters to search the library". A full scan at 3M pages takes many seconds; session search keeps its current short-query behaviour.
- **Status line** (`/api/library/status`, polled every 30 s): documents, pages
  indexed, still indexing, failed, and drive connected or not.
- **Drive disconnected:** the marker file is checked before the library
  database is opened. A missing marker, a wrong volume UUID, or an I/O error
  gives "Library drive not connected" in the card and the status line (search
  returns 503 with that message). The server never crashes, and reconnects on
  its own when the drive is back.
- **Works in both modes.** With chat off, a message runs the scoped searches
  and the cards are the answer. With chat on, the library card sits above the
  reply the same way the session card does, and the model is still told it
  can't read the files.

---

## 7. How the storage rule is enforced

| Requirement | Mechanism |
| --- | --- |
| Source PDFs are never copied | FolderSource `open()` returns the original path. Only DatabaseSource `file_bytes` makes a temp file, under `library/tmp/`, deleted after processing. No route serves file bytes. |
| Everything goes under `LOCUS_DATA_DIR` | Every library path is derived from one function, `libraryPaths(dataDir)`. Tests assert that no library code calls `os.tmpdir()` or uses a relative path, and the indexer sets `process.env.TMPDIR` to `library/tmp/` before starting any tool. |
| Refuse if unset | A clear message naming the variable and an example `/Volumes/<drive>/locus-data`. |
| Refuse internal/boot volume | **Volume detection, not path guessing:** `fs.statfs` + `stat` give the device, `mount` gives the filesystem type and flags, and `diskutil info -plist <mount point>` gives `Internal`, `DeviceLocation`, `BusProtocol`, `VolumeUUID` and `FilesystemType`. Refused: `Internal: true`, the boot volume's device or anything in its APFS container, or a **disk image** (`BusProtocol: Disk Image`, which could be a file on the internal disk). Each refusal has its own message. |
| Refuse network filesystems | `mount` flags lack `local`, or the type is `smbfs`, `nfs`, `afpfs`, `webdav` or `osxfuse`/`macfuse`: refused with "SQLite isn't safe on network drives". FAT32 (`msdos`) is refused too, since files can't exceed 4 GB. exFAT is allowed, with a warning recommending APFS. |
| `LOCUS_DATA_DIR` must already exist | It's **never created**. After an unplug, macOS can leave an empty `/Volumes/<name>` folder behind on the internal disk, and creating `LOCUS_DATA_DIR` there would write to the boot volume. The marker file plus the volume UUID check catch this before every write batch. |
| Drive unplugged mid-run | Workers stop, the database closes (WAL plus full fsync keeps it consistent), and the indexer polls every 10 s for the marker and UUID. When they're back it runs `quick_check`, resets jobs to pending and resumes. The app shows "Library drive not connected". |
| Temp files on the drive, deleted as soon as done | `library/tmp/`, one subfolder per file, removed in `finally`; each PNG is removed after its page; the folder is emptied on start. |
| Free space | Checked with `statfs` before start and every 30 s. Below `LIBRARY_MIN_FREE_GB` (default 20) the indexer pauses with "paused: low disk space on library drive (X GB free, need Y)", and resumes when space is freed. |
| Uploads unchanged | No upload file is edited, and the characterization test pins upload storage paths exactly. |
| **Showing that nothing was written to the internal disk** | **(1) Automated (Phase 1):** run `index:library` as a child process with `TMPDIR` and `HOME` pointed at empty canary folders on the internal disk, and snapshot the project folder and those canaries before and after. They must be byte-identical and empty. **(2) In the trial (Phase 3):** `sudo fs_usage -w -f filesys` filtered to the indexer's process tree. Every create, write, rename or unlink outside `LOCUS_DATA_DIR` is listed, and the expected count is zero. It needs `sudo`, so I'll ask you to run one command (see intervention points). |

---

## 8. New settings (all off or inert by default)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCUS_LIBRARY_ENABLED` | `false` | The master switch: library routes, UI and status. Off means today's app exactly. |
| `LOCUS_DATA_DIR` | — | Where everything the library writes goes. Must be an existing folder on an external, local, non-FAT volume. |
| `LOCUS_LIBRARY_DIR` | — | Folder source root. |
| `LIBRARY_DB_URL`, `LIBRARY_DB_QUERY`, `LIBRARY_DB_BATCH_SIZE` | —, —, `500` | Database source. |
| `LOCUS_SEARCH_SCOPE` | `session` | `session`, `library` or `both`. |
| `LIBRARY_INCLUDE`, `LIBRARY_EXCLUDE` | `**/*.pdf`, system folders + temp patterns | Globs. |
| `LIBRARY_MAX_FILE_BYTES` | `524288000` (500 MB) | Above this: `skipped: too large`. |
| `LIBRARY_OCR_PAGES`, `LIBRARY_OCR_LANG` | `auto`, `eng+hin` | |
| `LIBRARY_CONCURRENCY`, `LIBRARY_FILES_IN_FLIGHT` | cores − 2, `4` | |
| `LIBRARY_FILE_TIMEOUT_MS` | `1800000` | |
| `LIBRARY_SETTLE_SECONDS` | `120` | |
| `LIBRARY_MIN_FREE_GB` | `20` | |
| `LIBRARY_RESCAN_MINUTES`, `LIBRARY_WATCH`, `LIBRARY_CROSS_DEVICE` | `60`, `false`, `false` | |
| `LIBRARY_SAMPLE`, `LIBRARY_SAMPLE_SEED` | — | Trial: index a random N PDFs only (reservoir-sampled). |
| `LIBRARY_INDEX_RESTRICTED_PDFS` | `false` | See open question 2. |

---

## 9. Files

### New

| File | Why |
| --- | --- |
| `src/lib/library/config.ts` | Env parsing, `isLibraryEnabled()`, `searchScope()`, `libraryPaths()` |
| `src/lib/library/storage/volume.ts` | Volume probe (`statfs`, `mount`, `diskutil`), with the command runner injectable for tests |
| `src/lib/library/storage/guard.ts` | Refusals, marker plus UUID check, connected check, free space |
| `src/lib/library/sources/{types,folder,database,upload,index}.ts` | The source interface and implementations |
| `src/lib/library/sources/db/{sqlite,postgres,mysql}.ts` | Dialect SQL and read-only connections |
| `src/lib/library/walk.ts` | Streaming directory walk, patterns, skip reasons |
| `src/lib/library/schema.ts`, `store.ts`, `jobs.ts` | Library index layout, writes, the queue |
| `src/lib/library/extract.ts` | Page-by-page extraction over the existing `pdf.ts`/`classify.ts` primitives |
| `src/lib/library/pipeline.ts`, `progress.ts`, `memory.ts` | Scan → queue → workers, pause and resume, progress, peak memory |
| `src/lib/library/db.ts`, `query.ts`, `status.ts` | The app's read-only connection (copes with disconnects), cursor search, status |
| `src/lib/library/inventory.ts` | The inventory scan, histograms, reservoir sample, projection |
| `src/app/api/library/search/route.ts`, `src/app/api/library/status/route.ts` | Routes: 404 when the library is disabled |
| `src/lib/libraryClient.ts` | Browser calls |
| `src/components/LibraryResultCard.tsx`, `ScopeSwitch.tsx`, `LibraryStatusLine.tsx` | UI, only rendered when the library is enabled |
| `scripts/index-library.ts`, `scripts/library-inventory.ts` | The CLIs |
| `scripts/verify-library.ts` | Brute-force checker for the library index (the `verify:index` approach) |
| `scripts/bench-library.ts` | ≥1M-page synthetic benchmark, built on `LOCUS_DATA_DIR` |
| `scripts/e2e-library.mjs` | Browser e2e: library on, each scope |
| `docs/library.md` | User docs, including the exact Postgres/MySQL/SQLite config |
| `src/characterization/*` | **Already added in Phase 0** (section 11) |

### Changed (small and gated; each is a no-op unless the library is enabled)

| File | Change |
| --- | --- |
| `package.json` | Scripts `index:library`, `library:inventory`, `verify:library`, `bench:library`, `e2e:library`; dependencies `picomatch`, plus lazily loaded `pg` and `mysql2` |
| `src/config/features.ts` | Add `isLibraryEnabled()` (default false) beside `isChatEnabled()` |
| `src/app/layout.tsx`, `src/components/FeaturesProvider.tsx` | Pass `libraryEnabled` and the default scope. When disabled, the context value is `{ chatEnabled }` plus `libraryEnabled: false`, which nothing reads. |
| `src/components/Chat.tsx` | When the library is enabled and the scope includes it, also call `/api/library/search`. Otherwise the code path is today's, untouched. |
| `src/components/MessageBubble.tsx` | Render the library card if the message has one |
| `src/lib/types.ts` | An optional `libraryResult` on `DisplayMessage` (older stored messages lack it, which is fine) |
| `src/components/ChatInput.tsx` | Mount the scope switch, only when the library is enabled |
| `README.md`, `docs/locus-summary.md` | Docs |

**Not changed:**
- the session index schema or `scripts/indexer/*`
- `src/lib/search/*`
- uploads (`src/lib/uploads/*`, `/api/uploads`)
- `/api/session-search`, `/api/chat`, `/api/title`, `/api/config`
- auth and the proxy
- `scripts/share.ts`: the library needs nothing from it. A `LOCUS_DATA_DIR` in `.env.local` already reaches the server through the env it inherits.

---

## 10. How existing behaviour is protected

1. **Restore point:** tag `pre-library`.
2. **Off by default:** every new entry point checks `isLibraryEnabled()`
   first. With it off, the routes return 404, the UI renders nothing new, and
   no library module touches the disk.
3. **Characterization tests** (section 11) stay green in every phase. They pin
   the upload flow and its on-disk layout, the exact session-search responses,
   the login round trip, the chat on/off matrix, `npm run share`'s exact server
   environment, and the session-index and OCR-cache schemas.
4. **Existing tests unmodified:** a gate step runs
   `git diff --stat pre-library -- $(git ls-files 'src/**/*.test.*' 'scripts/**/*.test.*' | <files that existed at the tag>)`,
   and it must be empty.
5. **No shared state:** a separate index file, a separate OCR cache, separate
   temp and log folders, and one writer for each database.
6. **E2E with the library off** (the existing `npm run e2e`) every phase,
   plus `e2e:library` with it on.

---

## 11. Test plan

**Phase 0 (done):** `src/characterization/`, 29 tests.

| File | Pins |
| --- | --- |
| `sessionIndexSchema.test.ts` | Session index tables, indexes, FTS, pragmas, schema version 4 and its refusal message; OCR cache schema (snapshots) |
| `uploadFlow.test.ts` | Real PDF: the SSE stage sequence, GET list shape, search hit, **every file written and where**, temp dir cleaned, DELETE; 403 when disabled |
| `sessionSearch.test.ts` | Exact response snapshots (ordering, every field), quoted phrase, loose fallback, 50-hit paging, zero matches, every 400 message |
| `loginFlow.test.ts` | Cookie attributes, proxy pass and deny for pages and APIs, open routes, logout cookie, wrong or no passcode |
| `chatSwitch.test.ts` | Chat off/on × `/api/chat`, `/api/title`, `/api/config`, session search, LM Studio tripwire |
| `share.test.ts` | Real `scripts/share.ts` with stand-in binaries: log sequence, build/start/tunnel/caffeinate arguments, the **exact server env** (and nothing library-related), SESSION_SECRET generation, the missing-cloudflared refusal, chat-on checking LM Studio first |

**Phase 1:**
- **Volume guard:** fixture `diskutil`/`mount` outputs for internal APFS (captured from this Mac), external APFS, exFAT, FAT32, SMB, NFS, a disk image, and a ghost `/Volumes` folder. Plus a **real** check that this Mac's internal disk is refused.
- **Walk:** constant memory (a 200k-file synthetic tree with heap measured flat), symlink loop, firmlink cycle, permission denied, a very long path, non-English/NFD/emoji names, a file vanishing mid-scan, a file still being written, too large, not a PDF, excluded folders.
- **FolderSource:** read-only proof (`chmod -R a-w` fixture plus snapshot), add, change, delete, rename, rescan.
- **DatabaseSource (SQLite):** `file_path` and `file_bytes`, a chunked blob, batching bound, read-only, credential redaction.
- **Queue and resume:** kill mid-run (SIGKILL) at random points, then resume. Each document is indexed exactly once and the page counts match a clean run.
- **Storage rule:** drive "unplugged" mid-run (the probe flips, plus an injected `SQLITE_IOERR`): the indexer pauses, the index passes `quick_check`, and it resumes. Low free space pauses and resumes. Temp folder empty after each file. Internal-write canaries stay empty.
- **Extraction:** a large PDF is processed page by page (peak RSS bounded), an encrypted PDF is skipped, corrupt and timeout cases.
- `verify:library` with 0 disagreements against brute force.

**Phase 2:**
- Library search: cursor paging continuity, capped counts, the under-3-characters message.
- Scope matrix: session, library, both × chat off/on.
- Status line; "Library drive not connected" in the API and UI.
- `e2e` (library off, must be identical to today) and `e2e:library` (each scope).

**Every phase's gates, with literal output:** `vitest`, `tsc`, `eslint`,
`build`, `verify:index`, `verify:no-data-leak`, `e2e`, and from Phase 1 on also
`verify:library` and `e2e:library`. Build and e2e run in a detached git
worktree of the commit being checked, so the live `npm run share` server isn't
disturbed.

**Phase 3:**
1. `library:inventory` on the real folder, then **stop** and show you the report.
2. After your go-ahead: the 1,000-PDF trial with measured pages/doc, % OCR, pages/sec, index bytes/page, failures and **peak RAM**, plus the 50k projection.
3. Benchmark: a synthetic ≥1M-page index on the external drive, p50/p95 for rare, typical, common and short queries. If p95 is over ~500 ms at the projected size: compare sharding, a word index plus selective trigram, Tantivy, Meilisearch, OpenSearch and Postgres, and recommend one. No full-library run and no engine switch without asking.

---

## 12. Risks

1. **Index size and build time at full scale.** About 3M pages at roughly
   13–20 KB/page comes to ~40–60 GB, plus FTS merge work during the build.
   The trial measures it; the inventory projects it before anything big
   runs.
2. **Counting common words at millions of pages.** FTS has to walk the full
   match list to count, and that grows with corpus size; it extrapolates to
   ~0.7 s at 3M pages from the 100k numbers. Mitigation: the time-budgeted
   count. Phase 3 decides whether that's enough.
3. **Short queries (1–2 characters)** aren't searchable in the library
   (section 6). It's a deliberate limit, in library scope only.
4. **Drives that lie about flushing.** Some cheap USB enclosures acknowledge a
   flush they haven't done, so a yank can still damage the database despite
   WAL and full fsync. Mitigation: `quick_check` on reconnect; worst case,
   rebuild, which is cheap because the OCR cache is on the drive too.
5. **exFAT** works for SQLite locally but is less robust after a pull than
   APFS. It's allowed with a warning recommending APFS.
6. **Synced or online-only folders.** Reading a placeholder would download it
   to the internal disk. Such files are detected (`SF_DATALESS`) and skipped,
   but a sync client that hydrates files some other way is outside Locus's
   control.
7. **Postgres and MySQL are only tested through SQL generation** unless real
   servers are available.
8. **Per-page `pdftotext`** is slower than one whole-file call: a process per
   page. The trial measures the cost; small files can use page windows.
9. **Next.js file tracing.** Every runtime path gets `turbopackIgnore`, so
   nothing under `LOCUS_DATA_DIR` can be bundled. `verify:no-data-leak` keeps
   running, and the library e2e checks trace files for the data dir's path.
10. **Multi-day runs.** Bounded queues, memory sampling and log rotation; peak
    RAM is measured in the trial.

## 13. Open questions and intervention points

1. **Phase 3 needs the external SSD connected,** plus the paths for
   `LOCUS_DATA_DIR` and the >2 TB `LOCUS_LIBRARY_DIR`. No external volume is
   mounted right now (`/Volumes` only has `Macintosh HD`).
2. **Encrypted PDFs:** skip all of them (your rule, and the default), or index
   owner-password-only PDFs, which are readable without a password?
3. **The inventory's OCR-rate sample** runs tesseract on ~20 pages and indexes
   nothing. OK, or should it use the rate from the trial instead?
4. **Proving no internal writes in the trial** needs `sudo fs_usage`; I'll ask
   you to run a single command.
5. **A real unplug test** needs you to pull the drive mid-run, or your OK for
   me to force-unmount it (`diskutil unmount force`) during the trial.
6. **Postgres and MySQL against real servers:** only if you want it and Docker
   (or servers) are available.
