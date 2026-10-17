This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Local Setup

This is a local chat interface for [LM Studio](https://lmstudio.ai/). Configure
`LM_STUDIO_BASE_URL` and `LM_STUDIO_MODEL` in `.env.local`, then run `npm run dev`.

The optional URL-context feature retrieves links from user messages only during
development. A production deployment must explicitly set
`LOCAL_CHAT_ENABLE_URL_CONTEXT=true`; do that only for a trusted local
deployment, not a public service.

## Tender search

Full-text search over tender PDFs: type any text, get every document and page
that contains it, with a highlighted snippet. Deterministic: the index is
queried directly and no language model is involved. Details, measurements and
open decisions: [docs/tender-search-report.md](docs/tender-search-report.md).

One-time setup (macOS):

```bash
brew install poppler tesseract tesseract-lang
npm install
```

Put the PDFs in `data/tenders/` (gitignored and excluded from Vercel uploads;
never commit them), then:

```bash
npm run index            # build/update data/index/search.db and print the index report
npm run dev              # open http://localhost:3000/search (or "Search documents" in the sidebar)
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

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
