# How Locus works

A walkthrough of the code for a technical reader: how Locus reads PDFs from your storage server and
keeps the index up to date, where uploaded files go, how a PDF becomes searchable, how a search runs,
how disk space is protected, and where (and whether) a model is involved. Every step names the file
and function that does it, so you can open the code beside this page.

Paths are relative to the project root. Locus keeps two search indexes: the **library index** for the
storage server and folders added as sources (`data/locus-data/library/library.db`, section 9), and the
**session index** for files people upload (`data/index/search.db`, sections 3 to 7).

---

## 1. The short version

- Locus is a **PDF search tool**. You point it at a storage server (a folder, a mounted network share
  or an S3-compatible server) or upload files; it reads their text (running OCR on scanned pages) and
  stores that text in a SQLite full-text index **on your own computer**. A search looks the words up in
  that index and shows the file, the page number and a snippet; a click opens the original PDF at that page.
- Locus only ever **reads** the storage server. It never writes, moves or deletes anything there.
- **Search uses no AI model.** It is a database lookup. Page numbers and snippets come from rows the
  indexer wrote, so they cannot be invented. (Section 7.)
- A language model (Qwen3 4B through LM Studio) exists only as an **optional chat mode, switched off**.
  Even when on, it is not given the matching pages. (Section 8.)
- Everything runs on one laptop: one Next.js server, SQLite files, and the command-line tools
  `poppler` and `tesseract`. Nothing is sent to a cloud service to read or search a document.

---

## 2. The big picture

On your own computer the route is short: **browser → `http://localhost:3000` → Locus → the storage server (read-only)**, with the
index on the computer's disk. `npm start` runs the web app and the indexer together (`scripts/start.ts`).

The rest of this section describes the **optional** way of sharing a running copy outside your network (`npm run share`). It isn't
needed for the normal setup.

```
Browser ──► https://local-chat-one-ivory.vercel.app ──307──► https://<random>.trycloudflare.com ──tunnel──► localhost:3000 (Next.js, on the laptop)
            (Vercel: tiny redirect app)                      (Cloudflare quick tunnel)                      (next start)
```

| Hop | What it is | Code |
|---|---|---|
| Vercel link | A tiny standalone app that answers every request with a redirect to the current tunnel address. It checks the tunnel is up first and otherwise shows an "offline" page. It holds no documents and no data. | `redirect/api/redirect.js`, `redirect/vercel.json` |
| Cloudflare tunnel | `cloudflared` opens an outbound connection from the laptop to Cloudflare and gets a random `*.trycloudflare.com` address. The address **changes every time the tunnel restarts**; that is why the Vercel link exists. | started by `scripts/share.ts` |
| Next.js server | `next start` on port 3000: the pages, the API routes, the login check. | `src/app/**`, `src/proxy.ts` |
| Laptop disk | Uploaded PDFs, the search index, the accounts database, the OCR cache. | `data/` (git-ignored) |

`npm run share` (`scripts/share.ts`) does all of it: builds the app, starts `next start` with
`NODE_ENV=production` and `LOCUS_ENABLE_UPLOADS=true`, starts the indexer worker (only when the library
and admin area are set up), starts the tunnel, updates the Vercel redirect, then checks every 60 s
that the tunnel still answers. It also generates `SESSION_SECRET` into `.env.local` if missing.

Every page and API route sits behind `src/proxy.ts`: no valid session cookie means a redirect to
`/login` (pages) or a 401 (APIs). Only `/login`, `/api/login`, `/api/logout` and, in accounts mode,
`/api/signup` are open.

Because the browser talks to the laptop through the tunnel, the laptop must be awake and
`npm run share` running for the link to work.

---

## 3. Upload flow ("Choose folder" and single-file upload)

### 3.1 In the browser

"Choose folder" (`src/components/FolderPicker.tsx`) uses a hidden `<input webkitdirectory>`. The
browser hands over every file inside the chosen folder; nothing has left the machine yet.

1. `readPick()` (`src/lib/folderScope.ts`) keeps the PDFs and skips everything else.
2. `sha256Hex()` computes each file's SHA-256 **in the browser** (`crypto.subtle.digest`).
3. `planFolder()` sends `{ name, files: [{ path, size, sha256 }] }` to **`POST /api/folders`**. No file
   contents yet, only names, sizes and hashes.
4. The server answers with the list of paths that still need uploading (files already indexed with
   the same hash are skipped), or an error such as "over your upload limit".
5. `uploadFile()` (`src/lib/uploadsClient.ts`) sends each needed file as `multipart/form-data` to
   **`POST /api/uploads`** with fields `conversationId`, `file` and `path`. Several go at once
   (`LOCUS_UPLOAD_PARALLEL`, default 4, max 8). A failed send is retried up to 3 times with backoff.
6. The response is a stream of Server-Sent Events: `uploading`, `reading`, `indexing`, `searchable`,
   `running-ocr`, `ready` (or `error`). The UI turns these into the progress line.

A single file attached in a normal session goes through the same `POST /api/uploads`.

### 3.2 On the server

**`POST /api/folders`** (`src/app/api/folders/route.ts`) works out which session the folder belongs to:

- `folderSessionId(userId, folderName)` (`src/lib/uploads/folders.ts`) is an HMAC-SHA256 keyed with
  `SESSION_SECRET` over `userId + folder name`, prefixed `fld_`. The same account picking the same
  folder always lands on the same session (so nothing is uploaded twice), and nobody else can compute it.
- `authorizeConversation()` (`src/lib/session.ts`) makes the caller the owner of that session.
- Existing documents in the session whose hash no longer matches, or whose file has gone, are removed.
- The batch is checked against the limits below *before* anything is sent.

**`POST /api/uploads`** (`src/app/api/uploads/route.ts`), in order:

1. Uploads must be enabled (`uploadsEnabled()`, `src/lib/uploads/config.ts`).
2. `authorizeConversation()`: the signed-in user must own this session id.
3. `validateUploadBytes()` (`src/lib/uploads/validate.ts`): not empty, not over the size limit, and the
   content must **start with `%PDF-`**. The check is on the bytes, never on the file extension or the
   declared type, so a renamed `.exe` is refused.
4. Per-account limit (accounts mode): refuse if the account's bytes already used plus this file exceed
   `userUploadLimitBytes()`.
5. For a picked folder: if a file with the same path and hash is already in the session, answer with
   its current state instead of storing a second copy.
6. File-count limit: `maxFilesPerConversation()` (20) for a normal session, `maxFolderFiles()` (500)
   for a folder.
7. Total-storage cap: `measureStorageUsage()` (`src/lib/uploads/storage.ts`) measures the real size of
   the uploads folder plus the index folder; refuse if adding this file passes `storageCapBytes()`.
8. `indexUpload()` (`src/lib/uploads/pipeline.ts`) stores and reads the file (section 4).

### 3.3 Where the files are saved

- **Folder:** `data/uploads/` (override with `UPLOADS_DIR`). `uploadsDir()` in `src/lib/uploads/config.ts`.
- **Name:** `<sha256 of the content>.pdf`. `storedPathFor()` in `src/lib/uploads/storage.ts`.
  The name the person gave the file is never used as a path.
- **This folder is shared by all accounts. It is not split per account.** Two accounts that upload
  byte-identical PDFs share one stored file. The per-account separation is in the databases, not in
  the folder layout (3.4). When a document is deleted, `deleteSingleUpload()` /
  `deleteConversationUploads()` (`pipeline.ts`) remove the stored file only if no other document, in
  any session, still points at the same hash (`sha256StillReferenced()`).

### 3.4 What goes into SQLite

Two databases:

**The search index, `data/index/search.db`** (`SEARCH_INDEX_PATH`). Schema in `src/lib/search/schema.ts`.
Written by `insertUploadedDocument()` / `upsertPageOcr()` in `scripts/indexer/store.ts`.

| Table | One row per | Notable columns |
|---|---|---|
| `documents` | PDF | `conversation_id` (the session it belongs to), `original_filename` (display name), `filename` (= `<sha>.pdf`), `sha256`, `size_bytes`, `page_count`, `status` (`ready`/`indexing`/`failed`), `uploaded_at`, `expires_at` |
| `pages` | physical page | `page_no`, `page_label`, `source` (`text`, `text+ocr`, `ocr`, `blank`, `failed`, `pending-ocr`), `ocr_reason`, `image_coverage` |
| `texts` | reading of a page (up to two: `layer`, `ocr`) | `body` (as shown), `search` (case-folded), `loose` (punctuation removed) |
| `texts_exact`, `texts_loose` | the full-text indexes over `search` / `loose` | FTS5, trigram tokenizer |

**The records database, `data/app/records.db`** (`LOCUS_APP_DB_PATH` / `LOCUS_APP_DIR`). Schema in
`src/lib/records/db.ts`.

| Table | Holds |
|---|---|
| `users` | username, role (`user`/`admin`), passcode hash, token version, last login, disabled flag |
| `conversation_owners` | session id → owning user |
| `uploads` | one record per upload: user, session, file name, size, sha256, page count, status (`ready`/`failed`/`deleted`), error |
| `activity` | the admin's log: who did what, when, from which IP; search text is included unless `LOCUS_LOG_QUERY_TEXT=false` |

### 3.5 Limits and checks

| Check | Setting | Default | Per what | Code |
|---|---|---|---|---|
| File type | (none) | PDF magic bytes `%PDF-` | each file | `validateUploadBytes` |
| Largest file | `MAX_UPLOAD_FILE_BYTES` | 100 MB | each file | `maxUploadFileBytes` |
| Largest file in a folder pick | (derived) | 90 MB (stays under the tunnel's ~100 MB body limit) | each file | `maxFolderFileBytes` |
| Files in a normal session | `MAX_FILES_PER_CONVERSATION` | 20 | session | `maxFilesPerConversation` |
| Files in a folder pick | `MAX_FOLDER_FILES` | 500 | folder | `maxFolderFiles` |
| **Upload limit per account** | `LOCUS_USER_UPLOAD_MB` | 20000 MB (20 GB) | account (sum of its ready uploads in `records.db`) | `userUploadLimitBytes` in `src/lib/users/mode.ts` |
| **Total storage cap** | `STORAGE_CAP_BYTES` | half the disk, never under 5 GB | whole machine: uploads folder + index folder | `storageCapBytes` (`src/lib/uploads/config.ts`), `measureStorageUsage` |
| **Free-disk reserve** | `LOCUS_MIN_FREE_GB` | 5 GB | the disk holding the uploads | `checkUploadSpace` in `src/lib/uploads/space.ts`: refused (LOCUS-DISK-003) before anything is written unless the disk keeps its reserve after twice the file (the file and its index) |
| Retention | `LOCUS_RETENTION_DAYS` | off | document | `retentionMs`, `src/lib/uploads/cleanup.ts` |

Notes: the per-account limit applies in accounts mode only. A folder pick is checked as a whole, from the sizes the browser
declares, before anything is sent. The storage server's index has its own disk protection (section 9.6).

### 3.6 Privacy between accounts

- A session id belongs to the first signed-in user to use it (`claimConversation()`,
  `src/lib/records/ownership.ts`). Anyone else asking for it gets "No such session", the same answer as
  for an id that does not exist, so ids cannot be probed (`authorizeConversation()`, `src/lib/session.ts`).
- Every route that takes a session id calls `authorizeConversation()` first.
- Uploaded documents are tied to their session through `documents.conversation_id`, and a search is
  restricted to that session (section 7.3).
- The session is looked up from the signed cookie on every request, so disabling an account takes
  effect at the next request.

---

## 4. Reading the PDF

`indexUpload()` in `src/lib/uploads/pipeline.ts` runs in two passes so a file is searchable quickly
and the slow OCR finishes afterwards.

### 4.1 Pass 1: text layer (fast)

1. `onStage("reading")`. The file's SHA-256 is computed; if `data/uploads/<sha>.pdf` does not exist it is written.
2. `extractDocument()` (`scripts/indexer/extract.ts`) with `skipOcr: true`. The command-line tools it runs are in `scripts/indexer/pdf.ts`:
   - `pdfinfo` → page count and page sizes
   - `readPageLabels()` (`scripts/indexer/labels.ts`, uses `pdfjs-dist`) → printed page labels such as `iv` or `A-3`, when the PDF defines them
   - `pdftotext` → the **text layer** of every page in one call (falls back to page by page)
   - `pdfimages -list` → how much of each page is covered by images
   - `pdftotext -bbox` → where every word sits (used to spot broken words)
3. `planPage()` (`scripts/indexer/classify.ts`) decides, page by page, whether OCR is needed (4.2).
4. `insertUploadedDocument()` (`scripts/indexer/store.ts`) writes the document, all its pages and the
   text-layer text in one transaction. Pages that need OCR are written as `source = 'pending-ocr'`.
5. `onStage("searchable")` fires if any page is pending. **From this moment the file shows up in
   search results** using its text layer, and the browser shows "Searchable now · improving N scanned pages".
   With no pending pages it goes straight to `ready`.

### 4.2 When OCR runs ("smart" mode)

Uploads use `OCR_PAGES=smart` (`loadUploadConfig()` in `scripts/indexer/config.ts`). A page is OCR'd only if
`planPage()` gives it a reason (`OcrReason`):

| Reason | Meaning |
|---|---|
| `no-text-layer` | fewer than `MIN_TEXT_CHARS` (30) characters of text: a scan or drawn lettering (checked first for blank, using `pdftoppm` at 50 DPI; a blank page is not OCR'd) |
| `image-coverage` | images cover ≥ 30% of the page (a typed header over a scanned annexure) |
| `suspect-text-layer` | the layer exists but looks like symbol soup (broken font map) |
| `letter-spaced-text` | words come out in pieces like `BH ARAT H EAVY`, so a phrase would not match |
| `text-outside-layer` | lettering is drawn on the page but is not in the text layer (ink check, `scripts/indexer/ink.ts`) |

Other pages keep their text layer and are not OCR'd; that is where most of the time saving comes from.
`OCR_PAGES=all` restores OCR on every page. Measurements are in `docs/faster-uploads.md`.

### 4.3 Pass 2: OCR (background)

For each pending page, `ocrPage()` (`scripts/indexer/extract.ts`):

1. Looks in the **OCR cache** first (`scripts/indexer/ocrCache.ts`, `data/index/ocr-cache.db`), keyed by file hash + page + language + DPI. A page OCR'd before is not OCR'd again (re-uploading the same file is fast). Deleting the last document that uses a file also deletes its cache entries (`deleteSingleUpload()`).
2. Otherwise renders the page with `pdftoppm` (greyscale, 300 DPI by default) and runs `tesseract`.
3. **English first, Hindi on demand:** the first reading uses `eng`. If the page's text layer contains Devanagari, or ≥ 5% of recognised words came out under 60% confidence (`needsHindiReading()` in `classify.ts`), the page is read again with `eng+hin`. Only those pages pay the extra 30-55%.
4. Work is shared by one limiter sized to the CPU count (`OCR_CONCURRENCY`) and run at a lowered priority (`OCR_NICE`, default 10) so the laptop stays usable. Text extraction for other files is queued ahead of OCR.
5. `upsertPageOcr()` writes the result and flips the page to `text+ocr` or `ocr`. A page that fails is stored as `failed` with the error, so a gap is visible rather than silent.
6. `onStage("running-ocr")` after each page; `onStage("ready")` when all are done.

### 4.4 How a page becomes searchable rows

For each reading (`layer`, `ocr`) of a page, `store.ts` stores:

- `body`: the text after `normalizeText()` (`src/lib/search/normalize.ts`): Unicode folded (the `ﬁ` ligature becomes `fi`), dash and quote variants unified, invisible characters removed, **all whitespace including line breaks collapsed to one space** (so a phrase broken across two lines still reads as one phrase);
- `search`: `foldCase(body)`, lower-cased;
- `loose`: `loosen(search)`, every character that is not a letter or digit replaced by a space.

`texts_exact` indexes `search` and `texts_loose` indexes `loose`, both as SQLite **FTS5 with the trigram
tokenizer** (every 3-character slice is indexed, so a query matches anywhere, mid-word included, like a
plain substring search but without reading every page). The FTS tables are contentless (they hold only
the index), which roughly halves the file size.

A text row's id is `pageId * 2 (+1 for OCR)` (`textId()` in `schema.ts`), so a match tells you its page
and which reading it came from without a join.

---

## 5. Folder pick: the same flow, with idempotence

Picking the same folder again sends only what changed: `/api/folders` compares each file's hash with
what is indexed, keeps the matches, deletes the stale ones and returns the rest. A dropped connection
can be retried safely because `/api/uploads` answers a re-sent file (same path + hash) with its current
state instead of adding a copy. Design notes: `docs/folder-pick.md`.

---

## 6. Search-only is the default mode

With `LOCUS_CHAT_ENABLED` off (`src/config/features.ts`, `isChatEnabled()`), every message typed in a
session is a search over that session's files. The browser calls **`POST /api/session-search`**, never `/api/chat`.

---

## 7. Search flow

### 7.1 Request

`src/app/api/session-search/route.ts`:

1. `authorizeConversation()`: only the session's owner.
2. `hasDocumentsForConversation()` (`src/lib/search/query.ts`): if the session has no live documents the answer is `no-files` (the UI shows the upload prompt).
3. `runDocumentSearch()` (`src/lib/chat/documentSearch.ts`):
   - the query is the first `"quoted phrase"` in the message if there is one, otherwise the whole message;
   - it runs **exact** mode, up to 50 hits;
   - if exact finds nothing, it also runs **loose** mode and offers the result as a one-click "without exact punctuation" alternative (never switched on automatically).
4. If the account has logging on (accounts mode), a row goes into `activity`.

The query is sent by `POST`, not `GET`, so it does not end up in URLs, history or access logs, and the
server never writes the query text to its own error log.

### 7.2 Exact and loose modes

| Mode | Compared as | Effect |
|---|---|---|
| exact | `foldCase(normalizeText(query))` against `texts.search` | case-insensitive; punctuation matters, so `26-2080` does **not** match `26/2080` |
| loose | `loosen(...)` against `texts.loose` | `26-2080`, `26/2080` and `26 2080` are the same query |

`prepareQuery()` in `query.ts` builds the compared form. `toFtsPhrase()` wraps it as **one quoted FTS5
phrase** with quotes doubled, so `AND`, `OR`, `NEAR`, `*` and column filters in the query are literal
text, and the phrase is bound as a parameter, never spliced into SQL.

### 7.3 The lookup

`search()` in `src/lib/search/query.ts`:

1. `SELECT rowid FROM texts_exact WHERE texts_exact MATCH ?` (or `texts_loose`). Queries shorter than 3 characters cannot use the trigram index, so they scan every page's text with `instr()` (`usedFullScan`): still exact, just slower.
2. Each matching row id is split into `pageId` and reading (`splitTextId`). An in-memory page map (`pageDoc`, `pageNo` arrays, reloaded when the index's `generation` counter changes) turns page ids into document and page number with no join.
3. **Privacy is enforced here:** `inScope(docId)` keeps a hit only if `map.scope.get(docId) === scope`, where `scope` is the session id passed in (`scope: conversationId`), and the document has not expired. Hits from other sessions never leave this function. Documents with `conversation_id NULL` (the standalone tender index) are reachable only with `scope: null`, via the admin-only `/api/search`.
4. Hits are grouped by document (ordered by file name, then page) and a window (`offset`/`limit`) of them is loaded.
5. For each hit, `buildSnippet()` (`src/lib/search/snippet.ts`) cuts a snippet out of the stored text with the match highlighted. The text layer is preferred over OCR for the snippet, and `ocrOnly` is set when only the OCR reading matched ("worth checking by eye").
6. Result: `{ documents: [{ docId, filename, hitCount }], hits: [{ filename, pageNo, pageLabel, source, matchedIn, ocrOnly, snippet }], totalPages, totalDocuments, hasMore, tookMs }`.

The filename is also matched (`filenameMatch`). There is no relevance ranking: results are in file-name then page order, deterministic.

"Show more" calls the same route with `offset` and `mode`, via `runDocumentSearchPage()`.

---

## 8. The model: search does not use one

**Search never touches an AI model.** `search()` is SQL over a text index. There is no embedding, no
semantic matching, no generated text anywhere in a result. `src/lib/search/query.ts` says so at the top, and
`src/app/api/search/route.ts` repeats it.

### The optional chat mode (off)

- Switch: `LOCUS_CHAT_ENABLED=true` and restart (`isChatEnabled()`, `src/config/features.ts`). Off now: the default in code is `false` and `.env.local` does not turn it on.
- With it **off**: `POST /api/chat` and `POST /api/title` answer 403 before reading the request body, so nothing reaches LM Studio or the URL fetcher. `scripts/share.ts` also skips the LM Studio check.
- With it **on**, `POST /api/chat` (`src/app/api/chat/route.ts`):
  1. runs the same document search first and streams the results card to the browser;
  2. optionally expands links in the user's message into page text (`src/lib/urlContext.ts`; only when `LOCAL_CHAT_ENABLE_URL_CONTEXT` is on, which `share.ts` sets only with chat);
  3. sends the conversation to the local model through `lmStudioClient()` (`src/lib/lmStudioClient.ts`): the OpenAI SDK pointed at `LM_STUDIO_BASE_URL` (default `http://localhost:1234/v1`), model `LM_STUDIO_MODEL` (default `qwen/qwen3-4b`), streaming the answer back.
- **What the prompt contains:** the conversation messages the browser sent (plus any fetched web-page text), and, when the session has documents, a system note (`DOCUMENT_SEARCH_SYSTEM_NOTE` in `documentSearch.ts`) that says, in effect: *results were computed from the index and shown in a separate card; you cannot read the uploaded files; do not state a document name, page number or any detail about their contents.*
- **The matching page text is not passed to the model.** The model never receives the search hits or the document text. Only the results card (built by `search()`) tells the user what the documents say. This is deliberate: a model describing documents it cannot read would be guesswork presented as fact.
- **Where requests go:** to whatever `LM_STUDIO_BASE_URL` says. `share.ts` forces `http://localhost:1234/v1` for the server it starts, so the model is always the one on the same laptop. There is **no `--allow-remote` flag in this code**: nothing here has a switch that permits a remote model. The only way a request leaves the machine is someone editing `LM_STUDIO_BASE_URL` to point elsewhere when running the server some other way, so keep that setting local.

---

## 9. The storage server and the library

Everything that is indexed *in place* (not uploaded) lives in the **library**: a separate SQLite file with its own schema
(`src/lib/library/schema.ts`) under `LOCUS_DATA_DIR` (default `data/locus-data`): `library/library.db` (the index and the job queue),
`library/sources.db` (the sources registry), `library/ocr-cache.db`, `library/server-preflight.json` (the last disk estimate). An
always-on **indexer worker** (`scripts/library-worker.ts` → `src/lib/library/worker.ts`, `pipeline.ts`) reads the registry every
two seconds and does what it says. `npm start` starts it with the web app.

A *source* is anything the worker reads: a folder (`sources/folder.ts`), a database, a public Google Drive folder, or **the company
storage server**.

### 9.1 The connector (where the PDFs live)

`src/lib/server/types.ts` defines `StorageConnector`, deliberately small: `list()` (every file with size, modified time and, where the
server has one, a version tag), `stat()`, `read()` (a byte stream, optionally a range), `test()` and `close()`. Paths are always relative
to the root, `/`-separated whatever the operating system, and checked by `cleanRelativePath()` (no `..`, no drive letters, no NUL).

| Driver | File | What it does |
|---|---|---|
| `folder` | `src/lib/server/folderConnector.ts` | A folder on this computer or a network share the OS has mounted (SMB, NFS, NAS, a Windows drive letter or `\\server\share`). Every call has a timeout (a call that never returns is abandoned, not waited for) and retries with backoff for the errors that pass (EIO, ESTALE, timeouts). Files are opened with the read-only flag only. Links to folders aren't followed (no loops). A root that isn't there is "unreachable", not "empty": a scan stops and says so instead of deleting the index. |
| `s3` | `src/lib/server/s3Connector.ts` | MinIO, AWS S3, R2 and friends via `@aws-sdk/client-s3`. Only `ListObjectsV2`, `HeadObject` and `GetObject` are ever called, so even a key that can write is never used to. Paged listing, request timeouts, SDK retries; errors mapped to catalog codes with the raw SDK text redacted. |

Settings (`LOCUS_SERVER_*`) are parsed in one place, `src/lib/server/config.ts` (`loadServerConfig`); bad settings become a message on
the Server page rather than a crash. `createConnector()` (`connector.ts`) is the one place a driver is chosen: adding SFTP or Azure Blob
is one new file plus a case there (`docs/connectors.md`).

### 9.2 From server to index

```mermaid
flowchart TD
    A[LOCUS_SERVER_* in .env.local] --> B[createConnector: folder or s3]
    B --> C[ConnectorSource<br/>src/lib/server/connectorSource.ts]
    C -->|scan: list, only PDFs| D[LibraryIndexer.scanSource<br/>pipeline.ts]
    D -->|compare size + modified time<br/>+ etag with the index| E{new or changed?}
    E -- no --> F[nothing read, nothing downloaded]
    E -- yes --> G[job queue in library.db]
    G --> H[worker: open → stream to a temp file<br/>sha256, size cap, %PDF- check]
    H --> I[extractPages: pdftotext text layer,<br/>pdfimages, smart OCR plan,<br/>tesseract eng+hin where needed]
    I --> J[writePages: 25 pages at a time<br/>→ texts + FTS5 trigram rows]
    J --> K[markDocumentReady: one transaction]
    K --> L[temp file deleted]
    D -->|files not seen in a completed scan| M[sweep: remove from the index]
```

- `ConnectorSource` (`src/lib/server/connectorSource.ts`) turns each listed PDF into a `SourceEntry`. `modifiedAt` includes the S3 version tag, so
  a file replaced with same-size content and the same timestamp is still noticed.
- `open()` streams the file into the library's own `tmp/` folder while hashing it, enforces the size limit and the `%PDF-` header, and returns an
  `OpenedFile` whose `cleanup()` deletes the temp copy; the pipeline calls it in a `finally`, and the worker empties `tmp/` at start, so a
  crash leaves nothing behind. A file whose size changed between listing and reading is still being written: it is deferred and retried, not failed.
  A server that stops answering mid-file defers the file too (retried later) instead of marking it failed forever.
- **Searchable early.** `extractPages` yields pages in windows of `LIBRARY_PAGE_WINDOW`; `writePages` commits them in chunks of 25, so a large file's first
  pages are searchable (and the hit is marked "still indexing") before the file is done. `markDocumentReady` makes the whole file "ready" in one transaction.
- **Smart OCR** (`src/lib/library/extract.ts`, the default once a server is connected; `LIBRARY_OCR_PAGES=auto|all|smart`): a page is OCR'd only if it has no
  text layer, is mostly image, has a text layer that isn't text, has letter-spaced words, or has lettering drawn outside the layer (the same `planPage` rules as
  uploads, section 4.2). Files over `LIBRARY_LABELS_MAX_BYTES` (20 MB) use the `auto` rules, because the check reads the whole file's word positions. Languages
  are English and Hindi (`LIBRARY_OCR_LANG=eng+hin`). Work runs on every core (`LIBRARY_CONCURRENCY`) at a lowered priority.
- **One transaction per file, and resume.** A file is begun as `indexing`, its pages are written, and it becomes `ready` in one transaction. A killed worker leaves
  `indexing` documents and `running` jobs; on start `resetRunningJobs` puts the jobs back and `beginDocument` replaces the partial rows, so the result is the same as
  an uninterrupted run (tested by killing a real process: `src/lib/server/serverSync.test.ts`). Files already `ready` and unchanged are never read again.
- **Per-file failures** never stop the job. A corrupt, password-protected, not-a-PDF, too-large, too-slow or vanished file is recorded in the `failures` table with a
  kind and a message (`recordFailure`), listed on the Server page, and not retried until the file changes.

### 9.3 Keeping it up to date

```mermaid
flowchart LR
    T[timer: every LOCUS_SYNC_INTERVAL_MIN] --> R
    W[folder watcher: PDF changed, quiet 10 s] --> R
    B[Rescan now button<br/>POST /api/server/rescan] --> R
    R[scan the server again<br/>LibraryIndexer.reconcile] --> C[compare with the index]
    C --> N[new / changed → read and index]
    C --> D[gone → swept once the queue drains]
    C --> K[unchanged → untouched]
    C --> Z[renamed → renamed by content hash, not re-read]
```

- `reconcile()` (`pipeline.ts`) decides when each source is due: `ServedSource.rescanMinutes` is the source's own interval (the server's `LOCUS_SYNC_INTERVAL_MIN`,
  default 10), and a rescan requested through the registry (`requestRescan`) starts at once.
- The folder watcher (`src/lib/server/watcher.ts`, started by `scripts/library-worker.ts` for a folder server) only *asks* for a rescan after the folder has been quiet
  for 10 s and never more than once a minute. It is a hint: network shares miss events and some systems can't watch a tree, so the timed scan always runs.
- Deleted files are removed only after a **completed** scan whose queue has drained (`sweepOne`), so a scan that failed halfway (the server went away) never deletes
  anything. Directories that couldn't be read in a scan are excluded from the sweep.
- A file changed in the last `LIBRARY_SETTLE_SECONDS` (120) is held until it has settled, so a PDF still being copied is never read half-written.
- "Last synced" on the Server page is the end of the last *completed* scan (`scans` table); a failed scan records its reason on the source (`sources.last_error`),
  shown as a banner with its catalog code, and cleared by the next scan that completes.

### 9.4 The Server page, and the connector being down

`GET /api/server` (`src/app/api/server/route.ts`, admin only) returns `buildServerStatus()` (`src/lib/server/status.ts`), built from the library database read-only
plus the worker's own status line, so it works whatever the storage server is doing: connection settings (never secrets), files done / total, pages and scanned
pages read, files per minute and an ETA, last synced, the sync error, disk numbers, and the list of files that couldn't be read. `POST /api/server/test`
runs `connector.test()` (a read-only look); `POST /api/server/rescan` requests a rescan. The browser never receives a secret: the S3 key and secret exist only
in the server process's environment and are redacted from every message (`src/lib/errors/redact.ts`).

Search never depends on the server being up: it reads only the local index. When the server, the disk or a tool has a problem, `ServerBanner`
(`src/components/ServerBanner.tsx`) shows one slim notice to the administrator and search carries on.

### 9.5 Opening the original PDF

A result's "Open PDF" link points at `/api/library/file?doc=<id>#page=<n>` (`src/app/api/library/file/route.ts`); for uploads, `/api/uploads/file?conversationId=<id>&docId=<id>`.
The route checks who is asking (admin: any document; an ordinary account with `LOCUS_USER_SOURCES`: only documents of folders it owns; an upload: only the session's owner),
looks the file up **in the index** (the path comes from the database, never from the request), and streams it from the connector (`src/lib/server/originals.ts`), with
`Range` support for large files and `Cache-Control: private, no-store`. A document that doesn't exist and one that isn't yours get the same answer, so ids can't be probed. The
browser is never given a server address, a presigned link or a path. The `#page=` fragment is handled by the browser's own PDF viewer.

### 9.6 Disk space

```mermaid
flowchart TD
    A[first scan of a server] --> B{estimate known for this server<br/>and it fitted?}
    B -- yes --> G[index]
    B -- no --> C[sizes-only listing pass<br/>measureServer in preflight.ts]
    C --> D[estimate = PDF bytes × ratio × 1.25<br/>ratio 0.65, or the ratio seen so far]
    D --> E{estimate - what the index already uses<br/>fits in free space - LOCUS_MIN_FREE_GB?}
    E -- no --> F[do not start: LOCUS-DISK-001<br/>needs X, free Y, what to do]
    E -- yes --> G
    G --> H[before every write batch and every 30 s:<br/>DataDirGuard.checkLimits]
    H -- low space or SQLITE_FULL --> I[pause: LOCUS-DISK-002<br/>everything indexed stays searchable]
    I -->|space freed| G
```

- **Before indexing** (`src/lib/library/sources/build.ts` → `buildServer`, `src/lib/server/preflight.ts`): the first scan of a server (or any scan after the last check said it
  wouldn't fit) starts with a sizes-only pass and refuses to begin if the index wouldn't fit (`LOCUS-DISK-001`, with the numbers and what to do). The estimate is the server's
  PDF bytes × `DEFAULT_INDEX_RATIO` × 1.25. What the index really costs is about 18 KB a page (measured, `docs/server-benchmark.md`); the ratio assumes a dense 30 KB per page. Once 20 files
  are indexed the ratio actually seen (`observedRatio`) replaces the default, which is what the Server page shows ("judged from what is built so far").
- **While running** (`DataDirGuard.checkLimits`, `src/lib/library/storage/guard.ts`, `limits.ts`): free space and the cap are checked before every write batch and every 30 s;
  below the reserve (`LOCUS_MIN_FREE_GB`, 5 GB) the worker pauses (`onLimit`), keeps everything already indexed searchable, repeats the message, and resumes by itself when room appears. A
  `SQLITE_FULL` error takes the same path, and SQLite's transactions mean a full disk never leaves a half-written file.
- **Uploads** (`src/lib/uploads/space.ts`): refused before anything is written unless the disk keeps its reserve after twice the file; the per-account limit (20 GB) and the total cap (half the disk) apply as well.
- The disk helpers (`src/lib/server/disk.ts`) use `fs.statfs`, so the same code runs on macOS, Windows and Linux. The check that the index folder is on a suitable volume (`src/lib/library/storage/volume.ts`) uses
  `diskutil` on a Mac and, elsewhere, `/proc/mounts` (Linux) or the UNC form of the path (Windows) to refuse a network filesystem, where SQLite's locking isn't safe.

### 9.7 Errors

All user-facing problems come from one catalog (`src/lib/errors/catalog.ts`, listed in `docs/errors.md`): a code (`LOCUS-DISK-001`), a title, a plain message and what to do. The app shows them
as `/problem/<code>` pages, the not-found page, `error.tsx` (with "Try again"), `global-error.tsx` and banners; APIs answer `{ code, message, action }`, never a stack trace; the server log gets the
full detail with secrets redacted (`logError`). Pages and the catalog need nothing from the database, so they render when the index or the server is down.

### 9.8 Other sources, safety limits, who may search

- Folders added on the Sources page are read in place, only under `LOCUS_ALLOWED_ROOTS`; databases and public Google Drive folders work as before (`docs/sources.md`).
- The library may write at most `LOCUS_LIBRARY_MAX_GB` (100) and never fills the disk below `LOCUS_MIN_FREE_GB` (5 GB with a server connected; 20 GB for the original always-on library). At a limit indexing pauses; nothing is deleted.
- `POST /api/library/search`: the administrator searches everything; with `LOCUS_USER_SOURCES=true` ordinary accounts add and search only their own folders.

---

## 10. Accounts and login

Accounts mode is on when `LOCUS_USERS_ENABLED=true` (`src/lib/users/mode.ts`).

- **Users:** rows in `users`. A passcode is stored only as an **scrypt** hash (N=16384, r=8, p=1, 16-byte salt), compared in constant time (`src/lib/records/passcodes.ts`). A wrong username and a wrong passcode take the same time.
- **Sign-up:** `LOCUS_SIGNUP` = `code` (needs the sign-up code), `open`, or `off`. The code is `LOCUS_SIGNUP_CODE`, else the old shared `LOCUS_PASSCODE`.
- **Admin:** one `admin` account. Its password is `LOCUS_ADMIN_PASSCODE_HASH` (a scrypt hash that `npm run setup` writes, so the password itself is never stored) or, if you prefer, `LOCUS_ADMIN_PASSCODE` in plain text; the hash is kept in the table and changing either signs the admin out (`ensureAdminUser`, `adminLoginOk` in `src/lib/records/users.ts`).
- **Login:** `POST /api/login` (`src/app/api/login/route.ts`) checks the passcode, rate-limited to 5 failures per 5 minutes per IP (`isRateLimited`, in memory), and sets the cookie `locus_session`.
- **Session cookie:** a token `base64url(payload).HMAC-SHA256(payload)` signed with `SESSION_SECRET`, holding expiry, user id, role and a token version (`src/lib/auth.ts`). It is built on Web Crypto so the same code runs in the Edge `proxy.ts` and the Node routes. `httpOnly`; lasts `SESSION_TTL_HOURS` (default 7 days). The user is looked up on every request (`currentUser()`, `src/lib/session.ts`); disabling the account or resetting its passcode bumps `token_version`, which signs the person out everywhere.
- **Admin-only areas:** `/server`, `/sources`, `/users`, `/activity`, `/search`, `/api/server`, `/api/sources`, `/api/users`, `/api/activity`, `/api/search`, `/api/library` (`ADMIN_PREFIXES` in `src/proxy.ts`). This is a first check on the signed token; each route then checks again with `requireAdmin()` (`src/lib/session.ts`), which also refuses cross-site requests and non-JSON bodies. With `LOCUS_USER_SOURCES=true`, the Sources paths open to ordinary accounts, limited to their own folders.
- **Admin pages:** Server (the storage server: connection, progress, sync, disk, failures), Users (create, disable, reset passcode, remove with their files), Activity (searches, uploads, opened PDFs, denied access; export), Sources.

With accounts mode off, Locus is a single-shared-passcode app (`LOCUS_PASSCODE`).

---

## 11. Diagrams

### 11.1 Upload flow

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant F as /api/folders
    participant U as /api/uploads
    participant P as indexUpload (pipeline.ts)
    participant D as data/uploads/<sha>.pdf
    participant X as search.db (SQLite)
    participant R as records.db (SQLite)

    B->>B: pick folder, keep PDFs, SHA-256 each file
    B->>F: POST {name, files:[path,size,sha256]}
    F->>F: folderSessionId(user, name); owner check
    F->>X: drop stale docs, keep unchanged ones
    F->>F: per-account limit + total cap (whole batch)
    F-->>B: paths still to upload
    loop each file, 4 at a time (retry up to 3x)
        B->>U: POST multipart {conversationId, file, path}
        U->>U: owner check, %PDF- check, size/count/limit/cap checks
        U->>P: indexUpload()
        P->>D: write <sha256>.pdf if not already there
        P->>P: pdfinfo, pdftotext, pdfimages, planPage (which pages need OCR)
        P->>X: insert document + pages + text-layer text
        P-->>B: SSE "searchable" (file is now findable)
        loop each page that needs OCR
            P->>P: OCR cache? else pdftoppm + tesseract (eng, then eng+hin if Devanagari)
            P->>X: add OCR text to the page
            P-->>B: SSE "running-ocr n of N"
        end
        P-->>B: SSE "ready"
        U->>R: record upload + activity row
    end
```

### 11.2 Search flow

```mermaid
flowchart TD
    A[User types a message] --> B[POST /api/session-search<br/>conversationId + message]
    B --> C{signed in and<br/>owns this session?}
    C -- no --> C1[404 No such session]
    C -- yes --> D{session has<br/>documents?}
    D -- no --> D1[no-files: show upload prompt]
    D -- yes --> E[query = first quoted phrase,<br/>else the whole message]
    E --> F[normalize: fold Unicode, lower-case,<br/>collapse whitespace]
    F --> G[wrap as ONE quoted FTS5 phrase<br/>bound as a parameter]
    G --> H[SQLite FTS5 trigram lookup<br/>texts_exact]
    H --> I[drop hits whose document is not<br/>in THIS session, or has expired]
    I --> J{any hits?}
    J -- yes --> K[group by document, order by file name and page,<br/>build snippets from stored text]
    J -- no --> L[try loose mode<br/>punctuation ignored]
    L --> K
    K --> M[Results card: document, page number, snippet,<br/>OCR-only flag. No AI model involved.]
    B -. writes .-> N[(activity log in records.db)]
```

---

## 12. Map of the folders

```
.
├── src/
│   ├── app/                  Next.js pages and API routes
│   │   ├── api/server/       Server page: status, test connection, rescan (admin)
│   │   ├── api/library/      library search and status; file/ streams an original PDF after the privacy check
│   │   ├── api/uploads/      receive a PDF, stream progress, list, delete; file/ opens your own upload
│   │   ├── api/folders/      plan a folder pick (what to send, limits)
│   │   ├── api/session-search/   the search a user runs over their own files
│   │   ├── api/search/       admin-only search of the standalone tender index
│   │   ├── api/sources/      add / test / remove sources (admin; own folders if enabled)
│   │   ├── api/users/, activity/   admin: accounts, activity log
│   │   ├── api/login, logout, signup, account/   sign-in and passcodes
│   │   ├── api/chat, title/  optional model chat (403 while chat is off)
│   │   ├── server/, sources/, users/, activity/, login/, search/   pages
│   │   ├── problem/[code]/   a catalog error as a page; with not-found.tsx, error.tsx, global-error.tsx
│   │   └── manifest.ts, icon.png, apple-icon.png, favicon.ico   installable web app + icons
│   ├── components/           React UI (Chat, FolderPicker, SearchResultCard, ErrorPage, ServerBanner, admin/, sources/ ...)
│   ├── config/features.ts    the chat on/off switch
│   ├── proxy.ts              gate for every page/API: session cookie and admin paths
│   └── lib/
│       ├── server/           the storage server: connector types, config, folder + S3 drivers, ConnectorSource,
│       │                     preflight (disk estimate), status, watcher, originals, disk helpers, tool checks
│       ├── errors/           the error catalog, redaction of secrets, generated docs
│       ├── library/          the indexer: worker, pipeline, extract (smart OCR), sources/, storage guards, query
│       ├── uploads/          config, validation, storage on disk, free-disk check, the upload pipeline
│       ├── search/           session index schema, normalisation, query, snippets
│       ├── records/          users, ownership, uploads record, activity (records.db)
│       ├── users/            accounts-mode settings and sign-in
│       ├── chat/             document-search glue and reasoning helpers for chat
│       ├── auth.ts, session.ts   cookie signing; who is calling; owner checks
│       └── lmStudioClient.ts     the OpenAI-compatible client for the local model
├── scripts/
│   ├── setup.ts, doctor.ts, start.ts   npm run setup / doctor / start
│   ├── library-worker.ts     the always-on indexer (started by npm start)
│   ├── indexer/              PDF reading: pdf.ts (poppler/tesseract calls), classify.ts (OCR decisions),
│   │                         extract.ts, store.ts (writes the session index), ocrCache.ts, config.ts
│   ├── gen-test-pdfs.ts, bench-server.ts, e2e-server.mjs   generated test PDFs, benchmark, end-to-end check
│   ├── share.ts              npm run share: build, serve, tunnel, Vercel redirect (optional)
│   └── e2e-*.mjs, bench-*.ts, verify-*.ts   other end-to-end checks and measurements
├── Dockerfile, docker-compose.yml, .dockerignore   the container setup (poppler + tesseract eng+hin, read-only server mount, MinIO test profile)
├── redirect/                 the tiny Vercel redirect app for `npm run share` (separate package)
├── docs/                     this file, errors.md, connectors.md, server-benchmark.md, reference.md, design notes
├── data/                     runtime data, git-ignored (never in the source zip):
│   ├── uploads/              <sha256>.pdf, every uploaded file
│   ├── index/                search.db, ocr-cache.db (session index)
│   ├── app/                  records.db (accounts, ownership, activity)
│   └── locus-data/           the library index of the storage server, sources registry, OCR cache
└── .env.local                your settings and secrets, git-ignored (see .env.example)
```

---

## 13. Running it

### Requirements

- **Node.js 22** (`.nvmrc`, `engines`). `better-sqlite3` installs a prebuilt binary for macOS (arm64 and x64), Windows x64 and Linux.
- **poppler** (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`) and **tesseract** with English and Hindi data, on the `PATH`. Without tesseract Locus still runs: PDFs with a
  text layer work and scanned pages are skipped, with a notice (`LOCUS-TOOL-001`).
- `npm run doctor` (`scripts/doctor.ts`) checks all of this, free disk, write access to the index folder and the server connection, and prints the exact install command for macOS (brew), Windows (winget/choco) and Ubuntu (apt).

### Steps

```bash
npm ci
npm run setup      # scripts/setup.ts: .env.local, SESSION_SECRET, admin password (as a hash), server, index folder
npm run doctor
npm run build
npm start          # scripts/start.ts: the web app + the indexer, on http://localhost:3000
```

`npm run dev` is for working on the code. Docker: `docker compose up -d --build` (see the README). The tunnel and Vercel link (`npm run share`) are optional (section 2).

### `.env.local` keys

`.env.example` lists every key with a one-line comment; `npm run setup` fills in the ones that matter. By group:

| Group | Keys |
|---|---|
| Sign-in | `SESSION_SECRET`, `LOCUS_USERS_ENABLED`, `LOCUS_ADMIN_PASSCODE_HASH` (or `LOCUS_ADMIN_PASSCODE`), `LOCUS_SIGNUP`, `LOCUS_SIGNUP_CODE`, `LOCUS_PASSCODE` |
| Storage server | `LOCUS_SERVER_TYPE`, `LOCUS_SERVER_PATH`, `LOCUS_SERVER_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_PREFIX`, `_ACCESS_KEY`, `_SECRET_KEY`, `_FORCE_PATH_STYLE`, `LOCUS_SYNC_INTERVAL_MIN`, `LOCUS_SERVER_WATCH`, `LOCUS_LIBRARY_ENABLED` |
| Space | `LOCUS_DATA_DIR`, `LOCUS_MIN_FREE_GB`, `LOCUS_USER_UPLOAD_MB`, `STORAGE_CAP_BYTES`, `UPLOADS_DIR`, `SEARCH_INDEX_PATH`, `LOCUS_APP_DIR` |
| Reading PDFs | `LIBRARY_OCR_PAGES`, `LIBRARY_OCR_LANG`, `LIBRARY_FILES_IN_FLIGHT`, `LIBRARY_CONCURRENCY`, `LIBRARY_MAX_FILE_BYTES`, `LIBRARY_SETTLE_SECONDS` |
| Chat (off) | `LOCUS_CHAT_ENABLED`, `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL` |

Never commit `.env.local`; `.gitignore` excludes it.
