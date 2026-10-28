# Indexing and search speed

Measured with `npm run bench:server` on a generated set of PDFs (nothing from a client): a MacBook-class laptop, 10 CPU cores,
macOS, poppler and tesseract from Homebrew, Node 22. The set (`scripts/gen-test-pdfs.ts`) has typed PDFs of 3 to 40 pages in
sub-folders, scanned PDFs (a picture of the words, no text layer, so every page needs OCR), mixed ones and one corrupt file, and plants
a unique word on one known page of each file so search can be checked end to end.

## Result (160 files, 10.7 MB, 2,749 pages, 74 pages of OCR)

| | before | after |
|---|---|---|
| What it is | a library folder with OCR `auto` (how it was indexed before) | the storage server through the connector with OCR `smart` (the new default) |
| First page searchable | 0.9 s | 0.7 s |
| First file ready | 0.9 s | 0.7 s |
| **Full index** | **12.0 s** | **27.2 s** |
| Index size | 50.9 MB (18.1 KB per page) | 50.9 MB (18.1 KB per page) |
| Search, p50 / p95 | 0.19 ms / 2.38 ms | 0.16 ms / 2.22 ms |
| Planted words found on the right file and page | 160 of 160 | 160 of 160 |

- Search is the same module and the same index in both, so latency is the same: **sub-millisecond at the median** in the index itself, a few
  milliseconds over HTTP (3.3 ms median, 4.2 ms 95th percentile through the real app, measured by `scripts/e2e-server.mjs`).
- "Smart" OCR costs time, not accuracy of search: on this clean set it OCRs the same 74 pages as `auto` (the scanned ones), but it also
  checks every typed page for a broken text layer (letter-spaced words, lettering drawn outside the layer), which costs a small render per
  page. It takes 2.3x as long to index as `auto` here. It was 3.2x before the check was made cheaper (47 s against 15 s for `auto`, in the first measurement) (one `pdftoppm` call per window of pages
  instead of per page, and skipping the ruled-line passes when a page is clearly clean): 47 s down to 27 s on this set. Set
  `LIBRARY_OCR_PAGES=auto` to trade the check for speed.
- **Time to first searchable file is seconds**, not "after the index is built": pages are committed in chunks of 25 as they are read, and the
  Server page shows files done, pages read and an estimate of the time left while you search what is done.

## From a fresh clone, through the app (`scripts/e2e-server.mjs`, 60 PDFs, folder server)

| | |
|---|---|
| Time from start until the first file is searchable | 0.6 s |
| Time until all 60 files are indexed | 10.3 s |
| 50 searches, each planted word on the right file and page | 50 of 50 |
| Round trip over HTTP, median / 95th percentile | 3.3 ms / 4.2 ms |

## Size of the index (and the disk estimate)

What the index costs is per page of text, not per byte of PDF: **18 to 19 KB per page** on every set here (typed, scanned and mixed), the same
figure as the earlier 100,000-page test (19.7 KB per page, `docs/tender-search-report.md`). Pages that are OCR'd keep two readings and cost about twice that.

The estimate shown before a first index (`src/lib/server/preflight.ts`) turns that into bytes of PDF: it assumes a dense 30 KB of PDF per page,
so **index bytes = PDF bytes x 0.65**, plus 25 percent for safety; scanned PDFs, which are several times larger per page, come out well under that. Once
20 files are indexed the ratio actually seen replaces the assumption, and the Server page says which one it is using. (On these generated PDFs, which are
tiny per page, the index is 4.7 to 7.1 times the PDF bytes: the ratio is a property of how big a PDF is per page, which is why it is measured as it runs.)

## What this does not tell you

- These PDFs are generated and clean. Real scans cost much more: OCR of a scanned page takes on the order of a second of CPU, so a server full of scans takes
  about `pages x 1 s / cores` for the OCR part, far longer than the figures above. The Server page's files-per-minute and time-left figures come from your own
  files as they are read; trust those over any projection.
- A network share or an S3 server adds the time to read each file (about the file size over the connection). Indexing runs four files at a time, so a slow link is
  partly hidden; a very slow one will dominate.
- The numbers move by about 10 percent from run to run.

Reproduce: `npm run bench:server -- --files 160`.
