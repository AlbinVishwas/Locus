# Locus

A local chat interface for [LM Studio](https://lmstudio.ai/), with deterministic
full-text search over PDF documents alongside it. Built on Next.js.

## Local Setup

Configure `LM_STUDIO_BASE_URL` and `LM_STUDIO_MODEL` in `.env.local`, then run
`npm run dev`.

The optional URL-context feature retrieves links from user messages only during
development. A production deployment must explicitly set
`LOCAL_CHAT_ENABLE_URL_CONTEXT=true`; do that only for a trusted local
deployment, not a public service.

## Access control

Every page and API route requires a session, created by posting the right
passcode to `/login`. There are no user accounts — one shared passcode, for
sharing the app with a small group over a tunnel.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCUS_PASSCODE` | *(none)* | Required to let anyone log in. Unset means the app stays locked for everyone. (`ASSAY_PASSCODE` still works, with a deprecation warning.) |
| `SESSION_SECRET` | *(generated at startup in development; required in production)* | Signs session cookies. `npm run share` generates and saves one to `.env.local` the first time it's missing; a production server started any other way without one refuses every login instead of silently generating a different secret per runtime. |
| `SESSION_TTL_HOURS` | `168` (7 days) | How long a session lasts after logging in. |

Login attempts are rate-limited (5 per 5 minutes per caller) and the passcode
comparison is constant-time.

## Document search

Full-text search over PDFs: type any text, get every document and page that
contains it, with a highlighted snippet. Deterministic: the index is queried
directly and no language model is involved. Details, measurements and open
decisions: [docs/tender-search-report.md](docs/tender-search-report.md).

One-time setup (macOS):

```bash
brew install poppler tesseract tesseract-lang
npm install
```

Put the PDFs in `data/tenders/` (gitignored and excluded from Vercel uploads;
never commit them), then:

```bash
npm run index            # build/update data/index/search.db and print the index report
npm run dev              # open http://localhost:3000/search
```

`npm run index` is incremental: unchanged files are skipped, changed ones
re-indexed, deleted ones removed. `npm run index -- --force` rebuilds from
scratch (OCR results are cached, so this is fast).

Don't run `npm run index` while `npm run share` (or any other server with
uploads enabled) is running against the same `data/index/search.db` --
there's exactly one writer this is built for, and two processes writing to
the same SQLite file at once can corrupt it. Stop the server first.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run verify:index` | Compares the real index against a brute-force scan on ~2000 queries |
| `npm run measure:mixed` | One-off audit: OCRs every text page to find text missing from the text layer |
| `npm run bench` | Builds a 100,000-page synthetic index and reports size and p50/p95 latency |
| `npm run share` | Builds, starts production mode with uploads enabled, and shares it over a public Cloudflare tunnel. See [docs/sharing.md](docs/sharing.md). |
| `npm run verify:no-data-leak` | After `npm run build`: confirms no file-tracing manifest references `data/` (client PDFs, the index, uploads never belong in a deployable bundle) |
| `npm run e2e` | End to end through a real (headless) browser: login, upload, search, a files-less conversation, a normal chat message. Needs a server already running with `LOCUS_ENABLE_UPLOADS=true` and a known passcode: `E2E_BASE_URL=http://localhost:3000 E2E_PASSCODE=... npm run e2e` |

Indexer settings (environment variables, all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TENDERS_DIR` | `data/tenders` | Folder of PDFs to index |
| `SEARCH_INDEX_PATH` | `data/index/search.db` | Index file (also read by `/api/search`) |
| `OCR_LANG` | `eng+hin` | Tesseract language(s). Indian tender documents often carry Devanagari text that `eng` alone misreads as garbage; `eng+hin` costs roughly 30-55% more time per page, only at index/upload time. |
| `OCR_PAGES` | `all` | `all`: OCR every non-blank page; `auto`: only pages the heuristics flag |
| `OCR_DPI` | `300` | Render resolution for OCR |
| `OCR_CONCURRENCY` | cores - 2 | Parallel OCR processes |
| `PAGE_TIMEOUT_MS` | `120000` | Per tool call; a page over it is recorded as failed |

## Uploads

Attach PDFs to a conversation and ask about them in chat (see
[docs/locus-summary.md](docs/locus-summary.md)). Off by default outside
development -- set `LOCUS_ENABLE_UPLOADS=true` only for a trusted local
deployment.

Files don't expire. Once uploaded, a file stays until it's removed (each
file in a conversation has its own remove button) or its conversation is
deleted. A shared 5 GB cap (configurable) covers everything uploaded
across every conversation; an upload that would go over it is refused
with a message naming how much is used.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCUS_RETENTION_DAYS` | *(unset: never expires)* | Set to re-enable automatic expiry -- e.g. for a shared machine that should forget files on its own -- after this many days from upload. |
| `STORAGE_CAP_BYTES` | `5368709120` (5 GB) | Total size of every uploaded file, across every conversation, before uploads are refused. |
| `MAX_UPLOAD_FILE_BYTES` | `52428800` (50 MB) | Largest single file accepted. |
| `MAX_FILES_PER_CONVERSATION` | `20` | Per-conversation cap, independent of the storage cap. |

## Learn More

Built with [Next.js](https://nextjs.org). See the
[Next.js documentation](https://nextjs.org/docs) for framework details, and
[Vercel's deployment docs](https://nextjs.org/docs/app/building-your-application/deploying)
for deploying it.
