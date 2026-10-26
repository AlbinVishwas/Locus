# Scale benchmark: a million pages

`npm run bench:library` (script: `scripts/bench-library.ts`). Run on this
laptop (96.3 GB free before), 2026-10-26. Build first with `npm run build` for
the route numbers.

## What it does

Builds a synthetic library index of **1,000,000 pages in 15,152 documents**
(66 pages each: the same ratio as 50,000 documents ≈ 3.3M pages) in
`data/locus-data-bench/`, through the library's real write path
(`beginDocument` / `writePages`: normalisation, FTS5 trigram exact + loose) in
25-page chunks. Text is generated and seeded: Zipf-like word frequencies over
150,000 words, numbers and codes (`26-2080`), punctuation, Hindi, about 2,400
characters a page, plus a unique code per page. Search is measured at 250k, 500k
and 1M pages, 100 queries per class, each class chosen by its **measured**
page count: rare (< 100 pages), typical (300–5,000), common (≥ 10% of all
pages), short (3 characters). "First window" = 50 hits plus the exact count
within its 300 ms budget. Warm file cache (as the app's own searches are after
the first few); the 250k/500k points were taken right after a write burst and
are noisier than the 1M point.

## Results (milliseconds, first window)

| Pages | Class | p50 | p95 | max | count hit its budget |
| --- | --- | --- | --- | --- | --- |
| 250k | rare | 29 | 53 | 79 | 0% |
| | typical | 16 | 28 | 44 | 0% |
| | common | 47 | 77 | 83 | 0% |
| | short | 18 | 37 | 38 | 0% |
| 500k | rare | 64 | 107 | 157 | 0% |
| | typical | 35 | 74 | 95 | 0% |
| | common | 109 | 221 | 294 | 0% |
| | short | 48 | 107 | 126 | 0% |
| **1M** | rare | 16 | 25 | 30 | 0% |
| | typical | 100 | 199 | 264 | 0% |
| | common | 245 | 304 | 305 | **30%** ("at least N") |
| | short | 95 | 200 | 236 | 0% |

Through the real route (`POST /api/library/search` on `next start`, 1M pages):
rare p50 19 / p95 25 · typical 84 / 170 · common 234 / 307 · short 94 / 187.
The route adds almost nothing to the library call.

A deep "show more" (the fifth window of a query) takes p50 1.5–10 ms, p95
2.5–72 ms at 1M: windows are cursor-based, so deep paging doesn't get slower.

**Queries under 3 characters** are refused in 0.1 ms. Searching for one anyway
(a scan of a 20,000-text slice, extrapolated) would take about **51 seconds** at
1M pages: that's why they are refused.

## Size

**15,288 bytes per page** (`library.db`: 14.24 GB for 1M pages). The text is
stored once and indexed twice (exact and loose): `texts` 4.1 GB, the exact
index 5.7 GB, the loose index 5.4 GB; page and document rows are under 30 MB.
Build rate: about 800–2,300 pages/s (slowing as the index grows), roughly 20
minutes for the million.

**Projection for 50,000 documents (~3.3M pages): about 47 GB** for the index
(15.3 KB × 3.3M), plus an OCR cache of a few GB. Under the 100 GB cap. On this
laptop the 20 GB reserve leaves about 76 GB, so it fits with room to spare, but
it would be the largest thing on the disk.

## Do we need sharding? No, and why

The plan said to shard if p95 exceeded about 500 ms at 1M pages or at the 3.3M
projection.

- **At 1M pages the worst p95 is 304 ms** (common words), 199 ms for typical and
  short queries. Under 500 ms: no sharding at this size.
- A straight-line extrapolation to 3.3M gives p95 of about 730 ms (typical) and
  970 ms (common). **That is pessimistic and not what would happen**: the exact
  count is cut off at its 300 ms budget, after which the answer says "at least
  N pages" and carries on. The hits themselves come from the first rows of an
  index in id order and don't get slower with more pages. So first-window time
  is bounded by roughly the 300 ms budget plus a few milliseconds, whatever the
  size. What does change at 3.3M is *how many* queries show "at least N" instead
  of an exact number: 30% of common-word queries already do at 1M, and typical
  queries (200 ms at 1M) would start to at about 1.5M–3M pages.
- I did not build 3.3M pages (about 47 GB, an hour or more) to confirm it. It is
  one command (`npm run bench:library -- --pages 3300000`, which refuses to start
  if it would cross the cap or the reserve) if you want it measured rather than
  argued. If the real library turns out to have most queries returning "at least
  N" and exact counts matter, sharding by document-id range with parallel counts
  is the next step; it is designed in §9 of [sources-plan.md](sources-plan.md)
  but not built.

## Space

Free space: 96.30 GB before, 81.77 GB with the index built, **96.04 GB after
deleting it** (14.27 GB freed; the small difference from 96.30 is the report and
filesystem housekeeping). The synthetic index is gone: `data/locus-data-bench/`
doesn't exist. The raw numbers are in `data/bench-library-report.json`
(gitignored).
