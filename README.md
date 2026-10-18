# Assay

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
| `ASSAY_PASSCODE` | *(none)* | Required to let anyone log in. Unset means the app stays locked for everyone. |
| `SESSION_SECRET` | *(generated at startup)* | Signs session cookies. Set it explicitly once you're sharing the app regularly — otherwise every restart logs everyone out. |
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

Other commands:

| Command | What it does |
| --- | --- |
| `npm run verify:index` | Compares the real index against a brute-force scan on ~2000 queries |
| `npm run measure:mixed` | One-off audit: OCRs every text page to find text missing from the text layer |
| `npm run bench` | Builds a 100,000-page synthetic index and reports size and p50/p95 latency |
| `npm run share` | Builds, starts production mode with uploads enabled, and shares it over a public Cloudflare tunnel. See [docs/sharing.md](docs/sharing.md). |
| `npm run verify:no-data-leak` | After `npm run build`: confirms no file-tracing manifest references `data/` (client PDFs, the index, uploads never belong in a deployable bundle) |

Indexer settings (environment variables, all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TENDERS_DIR` | `data/tenders` | Folder of PDFs to index |
| `SEARCH_INDEX_PATH` | `data/index/search.db` | Index file (also read by `/api/search`) |
| `OCR_LANG` | `eng` | Tesseract language(s), e.g. `eng+hin` |
| `OCR_PAGES` | `all` | `all`: OCR every non-blank page; `auto`: only pages the heuristics flag |
| `OCR_DPI` | `300` | Render resolution for OCR |
| `OCR_CONCURRENCY` | cores - 2 | Parallel OCR processes |
| `PAGE_TIMEOUT_MS` | `120000` | Per tool call; a page over it is recorded as failed |

## Learn More

Built with [Next.js](https://nextjs.org). See the
[Next.js documentation](https://nextjs.org/docs) for framework details, and
[Vercel's deployment docs](https://nextjs.org/docs/app/building-your-application/deploying)
for deploying it.
