# Error codes

Every problem Locus reports has a code like `LOCUS-DISK-001`. The same code, title and wording appear on the page or banner,
in the JSON an API answers with (`{ "code", "message", "action" }`, never a stack trace) and here. Full technical details go to the
server's log only, with passwords and keys removed.

This file is generated from `src/lib/errors/catalog.ts` (`npm run gen:error-docs`); a test fails if they differ.

| Code | Title |
| --- | --- |
| [LOCUS-AUTH-001](#locus-auth-001-please-sign-in) | Please sign in |
| [LOCUS-AUTH-002](#locus-auth-002-no-access) | No access |
| [LOCUS-NOTFOUND-001](#locus-notfound-001-page-not-found) | Page not found |
| [LOCUS-SERVER-001](#locus-server-001-cant-reach-the-storage-server) | Can't reach the storage server |
| [LOCUS-SERVER-002](#locus-server-002-the-storage-server-refused-the-login) | The storage server refused the login |
| [LOCUS-SERVER-003](#locus-server-003-the-storage-server-isnt-set-up-correctly) | The storage server isn't set up correctly |
| [LOCUS-SERVER-004](#locus-server-004-that-file-is-no-longer-on-the-server) | That file is no longer on the server |
| [LOCUS-SERVER-005](#locus-server-005-the-storage-server-is-too-slow-to-answer) | The storage server is too slow to answer |
| [LOCUS-DISK-001](#locus-disk-001-not-enough-disk-space-to-build-the-index) | Not enough disk space to build the index |
| [LOCUS-DISK-002](#locus-disk-002-indexing-paused-low-disk-space) | Indexing paused: low disk space |
| [LOCUS-DISK-003](#locus-disk-003-not-enough-disk-space-for-this-upload) | Not enough disk space for this upload |
| [LOCUS-INDEX-001](#locus-index-001-the-index-is-still-being-built) | The index is still being built |
| [LOCUS-INDEX-002](#locus-index-002-nothing-is-indexed-yet) | Nothing is indexed yet |
| [LOCUS-UPLOAD-001](#locus-upload-001-upload-limit-reached) | Upload limit reached |
| [LOCUS-UPLOAD-002](#locus-upload-002-storage-is-full) | Storage is full |
| [LOCUS-TOOL-001](#locus-tool-001-ocr-isnt-installed) | OCR isn't installed |
| [LOCUS-TOOL-002](#locus-tool-002-pdf-tools-are-missing) | PDF tools are missing |
| [LOCUS-APP-001](#locus-app-001-something-went-wrong) | Something went wrong |
| [LOCUS-APP-002](#locus-app-002-locus-is-under-maintenance) | Locus is under maintenance |

### LOCUS-AUTH-001: Please sign in

You need to sign in to use this page.

**What to do:** Sign in, then try again.

### LOCUS-AUTH-002: No access

Your account doesn't have access to this.

**What to do:** Ask the administrator if you need it.

### LOCUS-NOTFOUND-001: Page not found

That page or file doesn't exist, or it was moved.

**What to do:** Go back to search and try again.

### LOCUS-SERVER-001: Can't reach the storage server

Locus couldn't connect to the storage server. Search still works on everything already indexed.

**What to do:** Check that the server is on and reachable from this computer (VPN, network share mounted, correct address), then press Test connection on the Server page.

### LOCUS-SERVER-002: The storage server refused the login

The server answered, but it didn't accept the access key and secret (or the account has no read access).

**What to do:** Check LOCUS_SERVER_S3_ACCESS_KEY and LOCUS_SERVER_S3_SECRET_KEY in .env.local, and that the account can read the bucket. Then restart Locus.

### LOCUS-SERVER-003: The storage server isn't set up correctly

The server settings in .env.local are missing or don't make sense.

**What to do:** Run `npm run setup` again, or fix the LOCUS_SERVER_* settings in .env.local (see .env.example), then restart Locus.

### LOCUS-SERVER-004: That file is no longer on the server

The file was moved, renamed or deleted on the storage server after it was indexed.

**What to do:** Press Rescan now on the Server page to bring the index up to date.

### LOCUS-SERVER-005: The storage server is too slow to answer

The server didn't answer in time. Locus will retry on its own.

**What to do:** If it keeps happening, check the network connection to the server.

### LOCUS-DISK-001: Not enough disk space to build the index

The index for everything on the server won't fit on this computer's disk.

**What to do:** Free up space, choose a disk with more room by setting LOCUS_DATA_DIR, or index fewer folders (set LOCUS_SERVER_PATH or LOCUS_SERVER_S3_PREFIX to a smaller folder).

### LOCUS-DISK-002: Indexing paused: low disk space

The disk is almost full, so indexing paused. Everything already indexed is still searchable, and indexing resumes by itself when there is room.

**What to do:** Free up disk space, or point LOCUS_DATA_DIR at a disk with more room.

### LOCUS-DISK-003: Not enough disk space for this upload

There isn't enough free disk space to take this upload safely.

**What to do:** Free up disk space on this computer, or upload less.

### LOCUS-INDEX-001: The index is still being built

Locus is still reading the server's PDFs. You can search what's done so far; results will grow as it continues.

**What to do:** Check progress on the Server page.

### LOCUS-INDEX-002: Nothing is indexed yet

There is no search index yet.

**What to do:** Connect a storage server on the Server page (or upload files), then wait for the first files to be indexed.

### LOCUS-UPLOAD-001: Upload limit reached

This upload would go over your account's upload limit.

**What to do:** Remove some of your files first, or ask the administrator to raise the limit.

### LOCUS-UPLOAD-002: Storage is full

The total storage limit for uploads and the index has been reached.

**What to do:** Remove old files or conversations, or ask the administrator to raise STORAGE_CAP_BYTES.

### LOCUS-TOOL-001: OCR isn't installed

tesseract isn't installed, so scanned pages are skipped. PDFs with a text layer work normally.

**What to do:** Install tesseract with English and Hindi data (run `npm run doctor` for the exact command), then restart Locus.

### LOCUS-TOOL-002: PDF tools are missing

poppler (pdftotext, pdftoppm) isn't installed, so PDFs can't be read.

**What to do:** Install poppler (run `npm run doctor` for the exact command), then restart Locus.

### LOCUS-APP-001: Something went wrong

Locus hit an unexpected problem. It has been logged on the server.

**What to do:** Try again. If it keeps happening, quote the reference below to the administrator.

### LOCUS-APP-002: Locus is under maintenance

Locus is being updated or restarted and will be back shortly.

**What to do:** Try again in a few minutes.
