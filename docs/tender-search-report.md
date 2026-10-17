# Tender search: final report

Branch `feature/tender-search` (local commits only, nothing pushed or deployed).
Date of measurements: 2026-10-17. Machine: MacBook Air M5, 24 GB, macOS, Node 22.23.1.

## 1. What was built

You type any text and get back every document and page that contains it, with
a highlighted snippet. The index is queried directly. No language model touches
queries or results.

| Part | Where | What it does |
| --- | --- | --- |
| Indexer | `scripts/index-tenders.ts`, `scripts/indexer/` | Reads `data/tenders/*.pdf`, writes `data/index/search.db` (SQLite FTS5) and prints the index report. Runs only on the laptop. |
| Matching rules | `src/lib/search/normalize.ts` | The single definition of "this page contains this query". The indexer, the search and the tests all use it. |
| Search | `src/lib/search/query.ts`, `snippet.ts` | Answers a query from the index: counts, every matching document, paged hits, snippets. |
| API | `src/app/api/search/route.ts`, `src/lib/search/searchRequest.ts`, `indexDb.ts` | `POST /api/search`, read-only, input validated the same way as chat requests. |
| UI | `src/app/search/page.tsx`, `src/components/search/SearchView.tsx` | Search page, linked from the sidebar ("Search documents"). |
| Correctness | `scripts/indexer/oracle.ts`, `scripts/verify-index.ts`, `*.test.ts` | Brute-force ground truth plus the edge-case tests. |
| Audit | `scripts/measure-mixed.ts` | One-off: OCRs every text page to find text missing from the PDF's text layer. |
| Benchmark | `scripts/bench-search.ts` | Builds a 100,000-page synthetic index and reports index time, size and p50/p95 latency, raw and through the route. |

### How to run

```bash
brew install poppler tesseract tesseract-lang    # poppler 26.10.0 and tesseract 5.5.3 were used
npm install                                      # adds better-sqlite3 13.0.3; dev-only: tsx, pdfjs-dist, pdf-lib, @types/better-sqlite3

npm run index                 # incremental; `npm run index -- --force` rebuilds from scratch
npm run dev                   # then http://localhost:3000/search
npm run verify:index          # brute-force check of the real index
npm run measure:mixed         # the mixed-page audit
npm run build && npm run bench  # the 100k-page benchmark (route timings need the build)
```

All the indexer settings are environment variables: `TENDERS_DIR`, `SEARCH_INDEX_PATH`,
`OCR_LANG`, `OCR_PAGES`, `OCR_DPI`, `OCR_CONCURRENCY`, `PAGE_TIMEOUT_MS`. The README has the table.

### Git

```
800df82 Add the Search page, and keep data/ out of server bundles      (Phase 3)
e1f3c6e Search the index through /api/search, proven against brute force (Phase 2)
ac40922 Index tender PDFs page by page, with OCR and an index report   (Phase 1)
ec5b223 Keep data/ out of git and out of Vercel CLI uploads
eae868a Give slow URL fetches room to finish, and say why a fetch failed (your existing chat work)
```

The Phase 4 commit follows this report. The branch was created from
`url-context-hardening`, where the chat work lived, not from `main`.

## 2. Proof

### Quality gates (final run, after all changes)

```
$ npm test
 Test Files  12 passed (12)
      Tests  212 passed (212)
exit=0
$ npx tsc --noEmit
exit=0
$ npm run lint
> eslint
exit=0
$ npm run build
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/chat
├ ƒ /api/search
└ ○ /search
exit=0
```

**Chat still works, but LM Studio wasn't running**, so I couldn't show a model
reply. LM Studio refused connections both at the configured address and on
`localhost:1234` (`curl` exit 7). A message sent through the app returned the
route's normal, explicit error:

```
$ curl -sN -X POST localhost:3125/api/chat -d '{"messages":[{"role":"user","content":"Say hello in five words."}]}'
data: {"type":"error","message":"Could not reach LM Studio at http://localhost:1234/v1 — ECONNREFUSED: "}
```

To see a real reply, start LM Studio and send a message in the app.

### Your measured facts, re-verified

| Claim | Result |
| --- | --- |
| 13 PDFs, 871 pages | **Confirmed** (pdfinfo and pdf.js agree on every file) |
| 821 pages have a text layer | **Confirmed** (871 − 50 pages under 30 characters) |
| 43 need OCR + 7 blank | **Corrected: 44 need OCR, 6 blank.** Your own page list adds up to 44: 1759N1 36, 0_NIT pp. 10–11, 26033Terms p. 229 and pp. 258–262. The blank pages are BoQ pp. 2–6 and 1759N1 p. 37, which have exactly 0 dark pixels when rendered. The next-lightest page, 26033 p. 229, has 0.043% dark pixels, so it is OCR'd. |
| Hardly any Hindi | In the text layer, yes. But Bidding_docs pp. 2–3 show Devanagari that exists only as images or unmapped fonts; English OCR turns it into nonsense. See section 6. |
| Printed page labels | None of the 13 PDFs defines any. The column exists, and a test proves it is filled in when a PDF does define labels. |

### Index report (`npm run index -- --force`, current index)

```
document                                                         pages     text text+ocr      ocr    blank   failed ocr-empty
00_Tender_Docu-2026-09-23-03_31_26.pdf                              69        0       69        0        0        0        0
0_NIT_of_Gem_Tender_No_26-2080-2026-09-23-09_11_19.pdf              20        0       18        2        0        0        0
1759N1-2026-09-16-04_26_50.pdf                                     130        0       93       36        1        0        0
26033Terms-2026-09-23-01_20_49.pdf                                 264        0      258        6        0        0        0
26038Terms-2026-09-23-02_07_05.pdf                                 166        0      166        0        0        0        0
34990000021-2026-09-23-02_17_41.pdf                                  1        0        1        0        0        0        0
5_TCC_Civil_Works_SRGM_Mumbai-Final-2026-09-17-02_15_46.pdf         58        0       58        0        0        0        0
ATC-2026-09-17-11_12_43.pdf                                         45        0       45        0        0        0        0
Annexure-A_General_TERMS_AND_CONDITIONS_OF_ENQUIRY_REV_03_06        12        0       12        0        0        0        0
Annexure_B-2026-09-23-04_16_44.pdf                                   3        0        3        0        0        0        0
Bidding_docs-2026-09-16-04_46_27.pdf                                49        0       49        0        0        0        0
Bidding_docs-2026-09-23-04_08_50.pdf                                47        0       47        0        0        0        0
BoQ_MKAE000010-2026-09-23-01_31_43.pdf                               7        0        2        0        5        0        0
TOTAL (13 documents)                                               871        0      821       44        6        0        0

Blank pages (no ink when rendered):
  1759N1-2026-09-16-04_26_50.pdf: p 37
  BoQ_MKAE000010-2026-09-23-01_31_43.pdf: p 2-6
Failed pages and documents:
  (none)
Completeness: every document has exactly one row per page.
Run: 13 added, 0 updated, 0 renamed, 0 removed, 0 unchanged; OCR 0 pages run, 865 from cache; 2.1 s
```

The `text` column is 0 because OCR_PAGES=all also OCRs every text page, which
makes them `text+ocr`. The report also lists every OCR'd page with its reason
(`no-text-layer`, `image-coverage`, `suspect-text-layer`, `all-pages`). The
first run, before OCR_PAGES=all existed, took 23.9 s for 69 OCR pages on 8
cores and gave 796 text / 25 text+ocr / 44 ocr / 6 blank / 0 failed.

### Mixed-page measurement

This was the approved "mixed page" rule: also OCR a page with a text layer when
images cover at least 30% of it. On these 13 files it flagged **25 pages**: 21 in
26038Terms (pp. 113, 132–151, full-page scans that already carry an OCR layer),
plus 1759N1 p. 130, 26033 p. 263, 34990000021 p. 1 and 5_TCC p. 1. The count is
stable between 30% and 50% coverage. No page was flagged as `suspect-text-layer`.

Then the audit (`npm run measure:mixed`) OCR'd the other 796 text pages and compared:

```
text-only pages checked: 796  (OCR run 796, cached 0, 339 s)
OCR errors: 0
share of OCR words missing from text layer: median 0.7%, p90 3.6%, p99 14.8%, max 66.7%
likely misses (>= 15 missing words AND >= 20%): 0
pages missing >= 3 known words (words found in other pages' text layers): 44
  Bidding_docs-2026-09-23-04_08_50.pdf p1: 13 known words missing, e.g. annex, profit, loss, account, balance, sheet, returns, other, acceptable, document
  Bidding_docs-2026-09-16-04_46_27.pdf p1: 10 known words missing, ...
  26033Terms-2026-09-23-01_20_49.pdf p97: 9 known words missing, e.g. bharat, heavy, tiruchirappalli, civil, engineering, department, bhel, schedule, analysis
  26033Terms ... p126, p168, p179, ... (table headers "unit, rate, description")
  ...
letter-spaced text layers (>= 25% of words are 1-2 letter fragments): 11
  26033Terms-2026-09-23-01_20_49.pdf: 4 pages (97, 104, 168, 169)
  26038Terms-2026-09-23-02_07_05.pdf: 7 pages (130, 156, 157, 160, 162, 163, 166)
```

My first rule (≥15 missing words *and* ≥20%) said 0. That was wrong. I
checked the top pages by eye and found three kinds of real misses that the
image-coverage rule cannot detect:

1. **Text with no text layer and no image.** On Bidding_docs p. 1 (both copies),
   the line *"Last 3 years Profit & Loss account/Balance Sheet/ GST returns/Any
   other acceptable"* is not in the text layer at all.
2. **Letter-spaced text layers.** The layer of 26033 p. 97 reads
   `BH ARAT H EAVY ELECTRI CALS LI M I TED TI RUCH I RAPPALLI`, so neither exact
   nor loose mode can match "Tiruchirappalli". `pdftotext -raw` only partly fixes it.
3. **Letter-spaced table headers.** `U nit Item De sc ript ion N o. Ra t e`
   appears on dozens of 26033 pages.

Not a real miss: the font maps curly quotes to digits (`8tenderer9`,
`<Bidder=`). A substring search for *tenderer* still matches.

**Action taken:** the default is now `OCR_PAGES=all`. Every non-blank page is
OCR'd as well, and both readings are kept. After the rebuild:

```
"Tiruchirappalli": 42 pages; 26033Terms p97 present: YES (ocr-only)
"Balance Sheet":   9 pages;  Bidding_docs p1 present: YES (ocr-only)
"description":     227 pages; 26033Terms p126 present: YES (ocr-only)
```

`OCR_PAGES=auto` keeps the heuristic-only behaviour. This is open decision #5.

### Brute-force correctness

`scripts/indexer/oracle.ts` reads every stored page and checks it with
`String.includes`. No SQL and no index are involved. Search results must
match it exactly, both the (document, page) set and the counts.

Real collection (final code, final index):

```
$ npm run verify:index
stored texts: 1696, exact-index rows: 1696, loose-index rows: 1696
queries: 2025 (31 fixed + 1994 sampled), 4050 comparisons across exact+loose, ~1646 queries with hits, 28.9 s
disagreements: 0
exit=0
```

The test suite runs the same comparison on 600 sampled queries × 2 modes over a
synthetic index, on 300 × 2 over an index built from generated PDFs through
real poppler and tesseract, and on 42 hostile inputs × 2 modes. All pass.

Required edge cases. Each one is a named test, and all pass:

| Case | Test |
| --- | --- |
| Phrase crossing a line break | `query.test.ts` and `pipeline.test.ts`: "finds a phrase that crosses a line break" |
| Query found only on an OCR page | both files: "finds a query that exists only on an OCR page, and flags it" (real tesseract in the pipeline test) |
| 26-2080 vs 26/2080 | "keeps punctuation exact…", "matches punctuation variants in loose mode" |
| Query under 3 characters | "answers a 2-character query completely" (full scan, compared against brute force) |
| Filename-only match | "finds a filename-only match" / "reports a filename-only match, flagged as such" |
| Deleted file | "removes a deleted file from the index" (also checks index rows = text rows) |
| Modified file | "re-indexes a modified file: old text gone, new text found" |
| Malicious or odd input | `route.test.ts` (quotes, FTS operators, SQL-injection shapes, 501-char query, wrong types, 20 KB body → 413) and the hostile list in `query.test.ts` (NUL bytes, emoji, Devanagari, `*`, `^`, `NEAR(`, `col:`…) |
| Also covered | mixed page, blank page, corrupt PDF, OCR failure, process timeout, rename, force rebuild, OCR policy change triggers re-index, page labels, pagination has no gaps or duplicates |

### Performance (100,000 pages)

The synthetic pages are halves of two random real pages (808 distinct sources),
so they have realistic length (~2,440 characters) and vocabulary. Each page also
carries a unique code for single-hit queries. Queries are 296 slices of real
text (3–30 characters, a quarter in loose mode), 100 single-hit codes, 100
misses, 30 very common words, and 12 queries under 3 characters. Route times
are measured by the client, round trip to `next start` on localhost.

**As shipped: two readings per page (OCR_PAGES=all)**, fixed query set:

```
index build: 100000 pages in 1000 documents (2 readings per page), avg 2445 chars/page, 150.4 s, 3832 MB (39.2 KB/page)
raw search() latency, limit 50:
  ALL indexed (>=3 ch)   n= 526  p50    10.15 ms  p95    39.76 ms  max    94.44 ms
  typical                n= 296  p50    19.50 ms  p95    45.40 ms  max    94.44 ms  hits median 631
  rare                   n= 100  p50     0.33 ms  p95     0.42 ms
  miss                   n= 100  p50     0.05 ms  p95     0.05 ms
  common                 n=  30  p50    26.07 ms  p95    39.49 ms  hits median 98919
  short (full scan)      n=  12  p50   451.75 ms  p95   511.34 ms
POST /api/search latency:
  ALL indexed (>=3 ch)   n= 526  p50    12.40 ms  p95    39.88 ms  max    96.03 ms
  typical                n= 296  p50    21.00 ms  p95    46.18 ms
  common                 n=  30  p50    24.54 ms  p95    35.51 ms
  short (full scan)      n=  12  p50   397.55 ms  p95   525.92 ms
```

**The target (p95 < 50 ms at 100k pages) is met for queries of 3+ characters,
both raw and through the route, but with little margin.** An earlier run with a
different random query set got p95 **54.2 ms raw and 52.1 ms route**. So
whether you land just under or just over 50 ms depends on the query mix. Queries
under 3 characters cannot use the index and take **~0.4–0.5 s** (worst seen 0.95 s).

Other variants (same query set):

| Variant | Size | p95 raw (≥3 chars) |
| --- | --- | --- |
| Two readings, after FTS5 `optimize` | 3840 MB | 39.0 ms (not worth adding) |
| **One reading per page** (≈ OCR_PAGES=auto) | **1922 MB (19.7 KB/page)** | **23.8 ms** (typical 26.9, short 273 ms) |

How the speed was reached: the first version took **p95 189 ms raw**. Profiling
showed that joining every hit to its page row took most of the time (for
"tender", 21 ms in the index and 120 ms with the joins). Text-row ids now encode
the page and the reading, and a small in-memory page map replaces the joins.
That brought p95 to the numbers above. The remaining cost is FTS5 itself: a
phrase made of very common trigrams ("the contractor shall") costs ~90 ms in the
index alone at this size. I tried a "rarest trigrams first" plan and it was
slower (confirming each candidate meant reading its text). mmap was no clear win.

The real index today: 36 MB (`data/index`) for 871 pages.

## 3. Not done or only partly done

- **No model reply in the chat check**: LM Studio wasn't running (see above).
- **Deployment**: nothing deployed, nothing chosen. Option (b), the tunnel
  forwarding mode, is designed but not built (section 5).
- **Short queries (1–2 characters) are not fast at scale**: ~0.5 s at 100k pages.
  They are correct and complete, and the UI says "every page was scanned".
- **The 50 ms target has little margin** with two readings per page (39.8 / 54.2
  ms across two query sets). One reading per page gives 23.8 ms.
- **Hindi**: not OCR'd. `OCR_LANG=eng+hin` is a one-variable change, but untested.
- **Hyphenation at line ends is not rejoined**, on purpose ("perfor-↵mance"
  stays split, so "26-↵2080" isn't turned into 262080). Searching
  "performance" misses a word split this way in the text layer.
- **The UI was checked with screenshots** (headless Chrome, desktop and 390 px
  mobile) but has no automated UI tests. The existing project has none either.

## 4. Choices I made on my own

1. **`OCR_PAGES=all` as the default.** The audit found real text the heuristics
   miss (section 2). It costs a one-time ~0.43 s of wall time per page on 8
   cores, about 12 hours for 100k pages. It doubles index size and roughly
   doubles query time compared with one reading. It can be reversed with one
   environment variable.
2. **Dash and quote variants are always unified** (`–`, `—`, `−` → `-`; curly
   quotes → straight), even in exact mode. Nobody types an en dash, and tender
   numbers are often printed with one. `/` vs `-` stays distinct.
3. **Five page sources instead of four:** `text+ocr` was added for pages with both
   readings, so the report shows which pages have two readings.
4. **A page that can't be fully read is `failed` but keeps its text layer.** Its
   text stays searchable, and the report lists the page.
5. **A blank page means < 0.005% dark pixels at 50 DPI**, calibrated on the 50
   low-text pages. The 6 blank pages have exactly 0; the next page has 0.043%.
6. **Mixed-page threshold: 30% image coverage** (stable from 30% to 50%).
7. **POST, not GET**, so search terms from client documents stay out of URLs,
   history and access logs. The route never logs the query. The 503 for a
   missing index doesn't reveal the server's file path.
8. **Snippets are built in TypeScript, not with FTS5's `snippet()`**, so the
   highlight uses exactly the matching rules. Snippets are plain-text pieces,
   never HTML.
9. **The snippet prefers the text layer** when both readings match. The OCR
   badge appears only when *only* OCR matched.
10. **Renames are detected by content hash** and don't re-extract. The OCR cache is
    keyed by content hash, page, language and DPI. Changing any extraction
    setting re-indexes affected documents automatically.
11. **Forced rebuilds write to a temp file and swap it in**, so the app keeps
    serving the old index meanwhile.
12. **Excluded `data/**` from Next's file tracing.** I found that the runtime index
    path made the tracer copy all 13 client PDFs, the OCR cache and the index into
    the `/api/search` server bundle. Now: 0 files under `data/`.
13. **Indexer exit codes:** 0 when every page was read, 2 when any page or document
    failed, 1 when the run broke or a document is missing page rows.
14. The zip was `~/Downloads/document 1.zip` (with a space, not an underscore). It
    was the only match. I extracted it with `unzip -j -n`; its SHA-256 was the same
    before and after (`a5ee41cc…f21d`).

## 5. Open decisions for your mentor

### a. Exact vs loose matching
Both are built. Exact is the default, and the toggle explains in one line what
it changes. A real example from these files: the NIT's *filename* says
`26-2080`, but its *text* says `26/2080` on 11 pages. Exact `26-2080` finds 0
text pages (plus the filename match); loose finds all 11.
**Recommendation:** keep exact as the default, so what you type is what's
matched. Add a hint when exact finds nothing but loose would ("11 pages match
if punctuation is ignored"). That costs one extra query and isn't built yet.

### b. Page numbering
The physical page number is always shown, and the printed label is shown
when the PDF defines one. None of these 13 PDFs does, so only physical
numbers appear. Pages that print "Page 5 of 20" in their text are not parsed.
**Recommendation:** keep the physical number as the primary one. It's what
every PDF viewer's "go to page" uses and it can't be misread. Show the printed
label as secondary.

### c. Filename search
Built. Filename matches are listed with a FILENAME badge, separately from page hits.
**Recommendation:** keep it. Tender numbers often appear in filenames with
different punctuation than inside the document (the NIT case).

### d. Deployment option. Not chosen, both still possible.

| | (a) Ship a read-only index with the deployment | (b) Search from the laptop behind the tunnel |
| --- | --- | --- |
| Does better-sqlite3 work? | Yes on Vercel's Node runtime (Linux x64, glibc): the package includes a `linux-x64` prebuilt binary, and read-only opening suits Vercel's read-only filesystem. **Not verified by deploying.** Caveat: the binary is picked at runtime from the build machine's platform, so the build must run on Vercel (Linux). A `vercel build`/`--prebuilt` from this Mac would ship the macOS binary and crash, unless `prebuilds/linux-x64.node` is force-included. | Not needed on Vercel at all; it runs on the laptop. |
| Size limit | Vercel's function bundle limit, 250 MB uncompressed as I recall it (I haven't checked it against Vercel's docs for your plan). At 39 KB/page (two readings) that's ~6,000 pages; at 20 KB/page (one reading) ~12,000. **This doesn't reach 100k pages.** | None (laptop disk). |
| Data location | The full text of every client document sits in Vercel's deployment artifacts. The PDFs stay local, but their text doesn't. This arguably breaks "never pushed". | Stays on the laptop. |
| Freshness | Redeploy after every index change. | Immediate. |
| Availability | Always on. | Only while the laptop and tunnel are up, like the model is today. |
| Latency | Query time + cold start. | Query time + tunnel round trip (Mumbai region → Cloudflare → laptop). |
| What it needs | Remove `/data/index/search.db` (only that file) from `.vercelignore`; add an explicit `outputFileTracingIncludes` for it on `/api/search` (the current config excludes all of `data/`); set `SEARCH_INDEX_PATH`; deploy from a Linux build. | A forwarding mode in `/api/search` (`SEARCH_BACKEND=remote`, `SEARCH_REMOTE_URL`) that passes the validated request on and returns the response unchanged; a shared-secret header that the laptop's route checks; run `next start` (or the same route) on the laptop behind cloudflared. About one small module plus tests. |
| Current state | `/api/search` on Vercel today returns 503 "index hasn't been built", because no index is uploaded. | Same. |

**For either option the app has no login.** Once search is reachable on Vercel,
anyone with the URL can search the client documents. That needs a decision
before any deployment (for example Vercel's password protection, which is a
paid feature, or the app's own auth).
**Recommendation:** (b). It keeps client text off third-party servers, has no
size ceiling, and matches how the model is already served. (a) only makes
sense if the collection stays under a few thousand pages and the mentor
accepts the text living on Vercel.

### e. OCR_PAGES=all vs auto
`all` (default) finds text the heuristics miss: 44 pages with ≥3 real words
missing from the layer, and 11 letter-spaced pages. It costs 2× index size,
~1.7× query time (p95 39.8 vs 23.8 ms at 100k pages) and OCR time for every page.
**Recommendation:** keep `all`. On these files the misses are real content
(eligibility criteria, the company name, table headers), and missing a page
is the failure that matters most here.

## 6. Known limitations and risks

- **OCR quality.** OCR-only hits are flagged because tesseract can misread
  characters. A word that OCR misreads *and* that exists only as an image
  can still be missed. Nothing short of a person reading the page closes that gap.
- **Hindi or other scripts shown only as images** (Bidding_docs pp. 2–3) are
  garbled by English OCR. Try `OCR_LANG=eng+hin` and compare.
- **Broken font mappings** (`8tenderer9`, letter-spaced words) are covered only
  through the OCR reading. Under `OCR_PAGES=auto` they would be missed.
- **Line-end hyphenation** is not rejoined (section 3).
- **Short queries** scan everything: fine today (~3 ms at 871 pages), ~0.5 s at 100k.
- **The benchmark corpus repeats 808 real pages**, so phrase hit counts are
  higher than in a diverse collection would be (typical median 631 pages). That
  is likely pessimistic for latency, but real tender collections also repeat a
  lot of boilerplate.
- **Index size** is ~39 KB/page with both readings (3.8 GB at 100k pages).
  `data/bench/bench.db` (1.9 GB) is left on disk for re-runs; delete
  `data/bench/` to reclaim the space.
- **The OCR cache key doesn't include the tesseract version.** After upgrading
  tesseract, run `rm data/index/ocr-cache.db && npm run index -- --force`
  to re-OCR.
- **One process, one read-only connection.** That's fine for local use. Concurrent
  searches queue in Node's single thread; under real concurrent load, measure first.
- **The extraction tests need poppler and tesseract.** They fail with a clear
  message if either is missing, unless `SKIP_OCR_TESTS=1` is set deliberately.
- **Tested on macOS only.** The indexer shells out to Homebrew tools.
- **Tooling quirk found during the work:** `\u` escapes in my editor input were
  saved as literal characters. Every affected file was found and fixed, and the
  regexes were re-checked (`grep` shows the escapes).
