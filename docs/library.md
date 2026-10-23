# Document library

Search a large library of PDFs (a folder, or rows in a database) beside each
session's uploads. **Everything here is off unless configured.** With none
of these settings, Locus behaves exactly as it always has.

Status: Phase 1 is built (indexing: sources, pipeline, storage rule,
`index:library`, `library:inventory`). Search in the app is Phase 2. Design
and decisions: [library-plan.md](library-plan.md).

## The storage rule

Nothing the library writes goes on the Mac's internal disk:

- **Source PDFs are read in place**, never copied, never written (opened
  read-only), and never served by the app.
- **Everything the library writes** (index, OCR cache, temp files, job
  state, logs, inventory reports) goes under `LOCUS_DATA_DIR`, a folder on
  an **external drive formatted as APFS**.
- **`index:library` and `library:inventory` refuse to start** when
  `LOCUS_DATA_DIR` is unset, missing, on the internal disk (or anything in
  the boot disk's APFS container), a disk image, a network drive, FAT32,
  exFAT (unless overridden, see below), or read-only. The volume is
  identified with `df`, `mount` and `diskutil`, never guessed from the
  path. Each case has its own message.
- **Locus never creates `LOCUS_DATA_DIR`.** After a drive is unplugged,
  macOS can leave an empty `/Volumes/<name>` folder on the internal disk;
  creating the data folder there would write to the boot volume. Create it
  once yourself: `mkdir /Volumes/<drive>/locus-data`.
- **A marker file** (`LOCUS_DATA_DIR/.locus-data-dir`) records the drive's
  volume UUID. Before every write, the indexer checks the marker is still
  there on the same device. If the drive is unplugged mid-run, it stops
  safely, closes the index, and waits. When the same drive is back, it
  checks the index (`PRAGMA quick_check`) and carries on.
- **Free space** is checked before starting and every 30 s. Below
  `LIBRARY_MIN_FREE_GB`, indexing pauses with a message, and resumes once
  space is freed.
- **Temp files** (rendered pages for OCR, database blobs being processed) go
  in `LOCUS_DATA_DIR/library/tmp/`, and each is deleted as soon as its page
  or file is done. The indexer also points `TMPDIR` there before doing
  anything, so the tools it runs (poppler, tesseract) put their scratch files
  on the external drive too.
- **Session uploads are unchanged:** same storage, same behaviour.

### Why exFAT is refused by default

exFAT has no journal. Pulling the drive mid-write, which the library is
built to survive, can then damage the **filesystem itself**, underneath
SQLite, and a damaged filesystem is beyond what SQLite's own crash safety
can repair. macOS's exFAT driver also gives weaker flush guarantees than
APFS. APFS is journaled, and `F_FULLFSYNC` (which the library index uses)
works on it. So exFAT is refused with a message recommending APFS. If you
must use an exFAT drive, `LOCUS_DATA_DIR_ALLOW_EXFAT=true` allows it, with
a warning on every run. FAT32 is refused outright: it can't hold a file
over 4 GB, and the index will be far bigger than that.

### Showing that nothing is written to the internal disk

- **Automated:** `src/lib/library/resume.test.ts` runs a real indexer
  process with `TMPDIR` and `HOME` pointed at empty canary folders. They
  must stay empty, and no file in the project may change.
- **On a real run:** while `index:library` runs, in another terminal:

  ```bash
  sudo fs_usage -w -f filesys $(pgrep -f index-library) | grep -vE "/Volumes/<drive>/"
  ```

  Any create, write, rename or unlink that isn't on the external drive
  shows up in this listing.
- **Two things outside Locus's code** write to the internal disk unless you
  avoid them:
  - **npm** writes a debug log to `~/.npm/_logs` on every `npm run`. Use
    `npm run --logs-max=0 index:library`, or run the command directly:
    `TSX_DISABLE_CACHE=1 node --import tsx scripts/index-library.ts`.
  - **The tsx command** writes a compile cache and a pipe to `$TMPDIR`.
    That's why the npm scripts run `node --import tsx` with
    `TSX_DISABLE_CACHE=1` instead: that combination writes nothing.

## Quick start (folder)

```bash
# .env.local (never committed)
LOCUS_DATA_DIR=/Volumes/LocusSSD/locus-data     # an existing folder on an external APFS drive
LOCUS_LIBRARY_DIR=/Volumes/Archive/Tenders      # the PDFs, read in place

npm run library:inventory     # what's there, and what indexing it would take (no indexing)
npm run index:library         # index it; Ctrl+C to stop, rerun to continue
npm run index:library -- --status
npm run verify:library        # brute-force check of the index
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run library:inventory [-- --sample 300] [--fresh]` | Scans `LOCUS_LIBRARY_DIR` with no indexing and no OCR. Writes a report (Markdown + JSON) to `LOCUS_DATA_DIR/library/inventory/`: files and bytes by type, PDF count and size distribution (median, p90, largest), what was skipped and why, plus a ~300-PDF random sample (pages per PDF, share of pages needing OCR, ~20 pages OCR'd once to time it, nothing kept). From those, a projection: total pages, indexing time, index size and the free space needed on the drive. It reports how long the scan took, and is safe to stop and rerun (it continues). `--fresh` starts over. |
| `npm run index:library` | Indexes every configured source, then exits. Keeps the Mac awake, runs at lowered priority, and prints progress (files and pages done, pages/s, ETA, failures, free space, memory). Ctrl+C stops it cleanly; rerunning continues where it stopped. |
| `npm run index:library -- --watch` | Keeps running and rescans every `LIBRARY_RESCAN_MINUTES`. |
| `npm run index:library -- --retry-failed` | Also retries files that failed before. Normally a failure is only retried once the file changes. |
| `npm run index:library -- --sample N [--seed S]` | Indexes a uniform random N of the PDFs only: the trial. |
| `npm run index:library -- --status` | Counts: documents, pages, queued, failures by kind. |
| `npm run verify:library` | Picks random documents and checks that the index's matches equal a plain substring scan of their text. Exits 1 on any difference. |

## What gets indexed, and what's skipped

- **PDFs only**: a `.pdf` extension in any case, which must start with
  `%PDF-` within its first 1 KB. Everything else is counted (inventory) and
  skipped.
- **Encrypted PDFs:**
  - PDFs that **open without a password** but restrict printing, copying or
    editing **are indexed**, because their text is readable. They're marked
    `encryption = 'restricted'` in the index.
  - PDFs that **need a password to open** are skipped and logged as
    `encrypted`.
- **Skipped, with a reason, and the run carries on:** permission denied,
  path too long, a name that isn't valid Unicode (possible on exFAT/SMB/NTFS
  sources), a file that disappears mid-scan, symlinks (never followed, so
  loops can't happen), directory cycles, other mounted devices inside the
  folder (unless `LIBRARY_CROSS_DEVICE=true`), more than 128 folders deep,
  online-only files in a synced folder (reading them would download them to
  the internal disk), files over `LIBRARY_MAX_FILE_BYTES` (`too-large`, so
  you can decide later), not a PDF, corrupt, a timeout, more than ~1M pages.
- **Files still being copied:** a file modified in the last
  `LIBRARY_SETTLE_SECONDS`, or one whose size or modified time changes while
  it's being read, is retried later.
- **Every problem** goes to the `failures` table and to
  `LOCUS_DATA_DIR/library/logs/failures.jsonl` (rotated at 50 MB).

## Change detection

Each file is identified by its folder-relative path (or database id). A
rescan compares size and modified time; only a file where those moved is
hashed again.

- **Same hash:** only the size and time are updated.
- **A new path with the hash of a file that disappeared:** a rename, so the
  document is kept with no re-extraction.
- **A document whose file a complete scan didn't find:** removed from the
  index. Files inside a folder that couldn't be read that time are not
  removed.

## Memory and CPU

- **Constant memory:** the scan streams, so there's no file list anywhere,
  and text is extracted page by page in windows of `LIBRARY_PAGE_WINDOW`
  pages. Printed page labels need the whole file in memory (pdf.js), so
  they're only read for files up to `LIBRARY_LABELS_MAX_BYTES`.
- **Bounded:** at most `LIBRARY_CONCURRENCY` tool processes and
  `LIBRARY_FILES_IN_FLIGHT` files at a time, at nice 10.
- **Peak memory** (the indexer plus its tool processes) is sampled every 5 s
  and reported at the end of a run.

## Settings

All are optional; none does anything until set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCUS_DATA_DIR` | — | Where the library writes everything. An existing folder on an external APFS drive. |
| `LOCUS_LIBRARY_DIR` | — | Folder source. |
| `LIBRARY_DB_URL`, `LIBRARY_DB_QUERY` | — | Database source (below). |
| `LIBRARY_DB_BATCH_SIZE` | `500` | Rows fetched per batch. |
| `LIBRARY_INCLUDE` | `**/*.pdf` | Comma-separated globs (folder-relative). |
| `LIBRARY_EXCLUDE` | system folders, hidden files, `~$*`, `*.tmp`, `*.part`, `*.crdownload`, `*.download`, `*.zip` | Comma-separated globs; a matching folder isn't descended into. Setting this replaces the defaults. |
| `LIBRARY_MAX_FILE_BYTES` | `524288000` (500 MB) | Larger files are skipped as `too-large`. |
| `LIBRARY_OCR_PAGES` | `auto` | `auto`: OCR only flagged pages (no text layer, large images, suspect text). `all`: every non-blank page. |
| `LIBRARY_OCR_LANG` | `eng+hin` | Tesseract languages. |
| `LIBRARY_OCR_DPI` | `300` | |
| `LIBRARY_CONCURRENCY` | cores − 2 | Tool processes at once. |
| `LIBRARY_FILES_IN_FLIGHT` | `4` | Files worked on at once. |
| `LIBRARY_PAGE_WINDOW` | `20` | Pages per text-extraction call. |
| `PAGE_TIMEOUT_MS` | `120000` | Per tool call. |
| `LIBRARY_FILE_TIMEOUT_MS` | `1800000` | Per file. |
| `LIBRARY_SETTLE_SECONDS` | `120` | A file modified more recently than this waits. |
| `LIBRARY_MIN_FREE_GB` | `20` | Pause below this much free space on the drive. |
| `LIBRARY_RESCAN_MINUTES` | `60` | With `--watch`. |
| `LIBRARY_CROSS_DEVICE` | `false` | Descend into other mounted devices inside the folder. |
| `LIBRARY_LABELS_MAX_BYTES` | `20971520` | Read printed page labels only for files up to this size. |
| `LIBRARY_SAMPLE`, `LIBRARY_SAMPLE_SEED` | — | Same as `--sample` / `--seed`. |
| `LOCUS_DATA_DIR_ALLOW_EXFAT` | `false` | Allow `LOCUS_DATA_DIR` on exFAT (not recommended; see above). |

## Database source

`LIBRARY_DB_QUERY` is one read-only `SELECT` returning these columns (alias
them as needed):

| Column | |
| --- | --- |
| `id` | Unique and sortable (integer or text). Batches are fetched in `id` order. |
| `filename` | Shown in results as `db:<id> · <filename>`. |
| `modified_at` | A timestamp; when it changes, the file is re-read. |
| `file_path` **or** `file_bytes` | A path Locus can read (read in place), or the PDF's bytes (fetched in 8 MB chunks into the temp folder on the external drive, then deleted). Exactly one of the two. |

How Locus treats the database:
- **The query is never edited, only wrapped:**
  `SELECT … FROM (<your query>) AS locus_q WHERE locus_q.id > ? ORDER BY locus_q.id LIMIT 500`.
  So it can't end with anything but the `SELECT` (a trailing `;` is fine).
- **Every value is a bound parameter.**
- **The connection is read-only:** SQLite opens the file read-only;
  Postgres sets `default_transaction_read_only`; MySQL sets
  `SESSION TRANSACTION READ ONLY`.
- **Use a database user that only has `SELECT`** as well.
- **Passwords never appear in logs or messages.**

Put these in `.env.local`, which is never committed.

**SQLite**

```bash
LIBRARY_DB_URL=sqlite:///Volumes/Archive/documents.db
LIBRARY_DB_QUERY="SELECT doc_id AS id, title AS filename, updated_at AS modified_at, pdf AS file_bytes FROM documents WHERE deleted = 0"
```

**PostgreSQL**

```bash
LIBRARY_DB_URL=postgres://locus_reader:PASSWORD@db.internal:5432/records?sslmode=require
LIBRARY_DB_QUERY="SELECT d.id, d.original_name AS filename, d.updated_at AS modified_at, d.storage_path AS file_path FROM documents d WHERE d.mime_type = 'application/pdf'"
```

```sql
-- once, as an admin: a user that can only read
CREATE ROLE locus_reader LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE records TO locus_reader;
GRANT USAGE ON SCHEMA public TO locus_reader;
GRANT SELECT ON documents TO locus_reader;
ALTER ROLE locus_reader SET default_transaction_read_only = on;
```

**MySQL**

```bash
LIBRARY_DB_URL=mysql://locus_reader:PASSWORD@db.internal:3306/records
LIBRARY_DB_QUERY="SELECT id, file_name AS filename, updated_at AS modified_at, content AS file_bytes FROM documents WHERE content_type = 'application/pdf'"
```

```sql
CREATE USER 'locus_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT ON records.documents TO 'locus_reader'@'%';
```

Status of testing: SQLite is tested end to end against a local fixture
(paths, chunked blobs, batching, read-only). Postgres and MySQL are covered
by SQL-generation tests and mocked-driver tests (read-only session,
password redaction). No real server has been tested yet; that comes once
the target database is known.

## Files on the drive

```
LOCUS_DATA_DIR/
  .locus-data-dir           marker: the volume UUID
  library/
    library.db              the library index (separate from the session index)
    ocr-cache.db            OCR results, so nothing is OCR'd twice
    tmp/                    scratch files, emptied as it goes and on every start
    logs/                   run-<date>.log, failures.jsonl (rotated)
    inventory/              report-<date>.md / .json, checkpoint.json
    indexer.lock            one indexer at a time
```
