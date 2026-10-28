# Faster uploads and folder picks

A folder of 145 PDFs used to take hours before everything was searchable. This is what changed, and the
measurements behind it. All numbers are from one test folder: 13 real tender PDFs, 871 pages, 40 MB, run
through the real upload pipeline (`npm run bench:upload`) with OCR held to 5 of the machine's 10 cores.

## Where the time went (before)

| | |
| --- | --- |
| Pages OCR'd | 865 of 871 (796 of them *only* because the old rule was "OCR every page", even with a good text layer; 44 had no text layer; 25 were mostly image) |
| OCR work | 4,060 CPU-seconds: 1,417 s making a 300 dpi PNG of each page, 2,642 s in tesseract (English + Hindi) |
| Everything else | text extraction, indexing and hashing: a few seconds in total |
| Time until the *last* file was searchable | 961 s. Each file's text extraction waited in the same queue as every OCR page of the files before it |
| Total | 964 s |

So the time was almost entirely OCR, and most of that OCR read pages whose text was already there.

## What it does now

| | Before | Now |
| --- | --- | --- |
| Which pages are OCR'd | every page | pages that need it (`OCR_PAGES=smart`) |
| Language | English + Hindi on every page | English; English + Hindi again only on pages that show Devanagari |
| Making the page image | PNG (about 0.5 s/page) | uncompressed PGM (about 0.03 s/page), same text |
| Text of the next file | queued behind earlier files' OCR | goes first (priority in the limiter) |
| Searchable | when the file was completely done | as soon as its text layer is indexed |
| Files sent at once | 3 (folder) / all at once (attach) | 4 by default (`LOCUS_UPLOAD_PARALLEL`, 1-8), both |
| Dropped connection | the file failed | resent up to 3 times with backoff; the server recognises a file it already has |
| CPU | cores - 2, normal priority | every core (`OCR_CONCURRENCY`), at a lowered priority (`OCR_NICE`, default 10) so the laptop stays responsive |

Measured on the same folder and cores: **964 s -> 78 s in total; the last file searchable after 9.6 s
instead of 961 s; the first after 0.6 s.** OCR work fell from 4,060 to 347 CPU-seconds.

## Which pages count as "needing OCR"

`OCR_PAGES=smart` (the default for uploads) OCRs a page when any of these holds:

1. **No text layer** (a scan or vector-drawn lettering): as before.
2. **Mostly image** (30% or more of the page is pictures): as before.
3. **A text layer that is not text** (symbol soup from a broken font): as before.
4. **Words broken into pieces**, the letter-spaced layers `BH ARAT H EAVY ... TI RUCH I RAPPALLI` and table
   headers like `De sc ript ion`. Found two ways: from the positions of the words (pieces of words sitting
   much closer than a word space on that page), and from the text itself (a large share of 1-2 letter
   fragments).
5. **Lettering with no word in the layer** (text drawn as shapes, a line missing from the layer): the page is
   drawn at 100 dpi and the dark marks outside every word box and outside ruled lines are counted; 0.6% of
   the page or more means there is lettering the layer doesn't hold.

`OCR_PAGES=all` restores "every page"; `OCR_PAGES=auto` keeps only rules 1-3. The library worker is not
changed: it still uses `all` unless told otherwise.

How well that matches reading every page was measured with `npm run measure:ocr-policy` against the
every-page run (a page "needs OCR" when the OCR reading holds at least 3 real words, found elsewhere in the
collection, that the text layer lacks or has broken): of 79 such pages, 79 are OCR'd by the new rule, and
198 of 871 pages (22.7%) are OCR'd in total. 119 of those are extra: mostly pages with a few broken header
words, which are worth reading.

## English first, Hindi where it shows

The first reading is English (about 35-55% cheaper). A page is read again in English + Hindi when its text
layer already holds Devanagari, or when the English reading was unsure of an unusual share of its words
(5% or more under 60% confidence), which is what Hindi looks like to an English reader. Measured: 13 of 14
pages with a lot of Hindi are caught; about 1 in 20 English pages is read twice for nothing. A page with just
a few Hindi words among English (a stamp, a signature line) can be missed, and then its Hindi words are not
searchable. `OCR_LANG=eng+hin` reads every page in both and turns this off.

The Hindi pages of Bidding_docs (pp. 2-3) come out word for word the same as with every page read in both
languages (170 and 246 Devanagari characters, 204/204 and 208/208 shared words), and the search for
`उत्पाद क्रय विनिर्देश` finds both.

## What searching gives up

`npm run compare:ocr` searches the old index (every page, English + Hindi) and the new one for the same
phrases. On 400 phrases of 1-4 real words, in exact and loose modes: 66,615 hits before, 66,577 after
(99.94%). Of the 800 phrase searches, 22 (11 distinct phrases) lost pages:

- **Reading order, 12 pages.** The words are all in the page's text layer, just not next to each other
  (columns, table cells, a signature block): OCR reads a page line by line, the layer reads it in the order
  the PDF stores it. `signatory with`, `for thickness`, `annealing for`, `table for heat treatments`.
  This is the one real limitation of trusting a text layer; it is the same in the library.
- **OCR misreads, 30 pages.** The old index "found" words OCR got wrong: `Not applicable` read as
  `Applicable/ Net` (so `net` matched), `necessary` read as `newessany` (so `any` matched), and a dotted line
  read as a run of letters (so `case` matched inside it).
- **A different English-only reading, 2 pages.** A page OCR'd in both settings, read slightly differently
  (`bank indian`).

The three known-hard checks pass in the new index: "Tiruchirappalli" -> 26033Terms p. 97, "Balance Sheet" ->
Bidding_docs p. 1, "description" -> 26033Terms p. 126.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OCR_PAGES` | `smart` for uploads, `all` for the library | `all`, `auto`, `smart` as above |
| `OCR_LANG` | `eng` first, `eng+hin` where Devanagari shows | Setting it reads every page in that language only |
| `OCR_LANG_FALLBACK` | `eng+hin` | The second reading's language; empty turns the second reading off |
| `OCR_CONCURRENCY` | every core for uploads, cores - 2 for the library | Parallel OCR processes |
| `OCR_NICE` | `10` for uploads, `0` for the library | Priority the OCR tools run at (0-19; higher is gentler) |
| `LOCUS_UPLOAD_PARALLEL` | `4` | Files the browser sends at once (1-8) |

## Measuring it yourself

```
npm run bench:upload -- <pdf folder> <work dir> [--parallel 4] [--release searchable|ready]
npm run measure:ocr-policy -- <index db from an OCR_PAGES=all run> <pdf folder>
npm run compare:ocr -- <old index db> <new index db> [phrases] [seed]
```

`bench:upload` keeps everything under `<work dir>`, never the app's own data.
