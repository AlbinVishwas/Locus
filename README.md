# Locus

Deterministic full-text search over your own PDF documents, running locally,
with an optional chat interface for [LM Studio](https://lmstudio.ai/) that is
**off by default** (see [Chat switch](#chat-switch)). Built on Next.js.

## Chat switch

Locus runs as a document search tool unless chat is turned on. One setting
controls it, in [`src/config/features.ts`](src/config/features.ts):

```ts
export const features = {
  chatEnabled: false,
};
```

Override it without editing code with an environment variable (in
`.env.local`, or on the command line), then restart -- no rebuild needed,
it's read when each page is served:

```bash
LOCUS_CHAT_ENABLED=true    # chat on: model replies, exactly as before
LOCUS_CHAT_ENABLED=false   # chat off (also what unset means)
```

| | Chat off (default) | Chat on |
| --- | --- | --- |
| A message | Searched over that session's files: quoted text if there is any, otherwise the whole message as exact text. The results card is the answer, including "No matches in your files" (with the punctuation hint when loose mode finds something). A session with no files gets a prompt to upload some. | Sent to LM Studio; the same search card appears above the reply when the conversation has files. |
| `/api/chat`, `/api/title` | Refuse with 403 "Chat is disabled…", before reading the request. Nothing reaches LM Studio or the URL fetcher. | Model reply / model-generated title. |
| Stages shown | Upload stages (Uploading, Reading, Scanning page N of M) and Searching | Also Thinking, URL reading |
| Model pill, "Read a link" chip, URL reading | Hidden / off | Shown / on |
| Wording | "New session", "Sessions", "Search your documents" | "New chat", "Recent", time-of-day greeting |
| `npm run share` | Skips the LM Studio check; LM Studio can be off | Checks LM Studio first |

Either way, each session/conversation keeps its own files, and deleting it
deletes them. No chat code is removed while chat is off; everything
chat-related checks this one setting.

## Local Setup

Run `npm run dev`. With chat turned on, also configure `LM_STUDIO_BASE_URL`
and `LM_STUDIO_MODEL` in `.env.local`.

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
| `npm run e2e` | End to end through a real (headless) browser with **chat off**: search-tool wording and hidden model pieces, the no-files prompt, upload, plain/quoted/zero-match/punctuation-hint searches, deleting a session deletes its files -- and proof that nothing reached `/api/chat`, `/api/title` or LM Studio (a stand-in LM Studio on port 1239 counts requests). Needs a chat-off server already running with `LOCUS_ENABLE_UPLOADS=true`, a known passcode and `LM_STUDIO_BASE_URL=http://127.0.0.1:1239/v1`; usage at the top of `scripts/e2e-search-only.mjs`. |
| `npm run e2e:chat` | The same kind of run with **chat on**: upload, search, a files-less conversation, a normal chat message. Needs a server started with `LOCUS_CHAT_ENABLED=true`: `E2E_BASE_URL=http://localhost:3000 E2E_PASSCODE=... npm run e2e:chat` |

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

Attach PDFs to a session and search inside them (or, with chat on, ask
about them in chat -- see [docs/locus-summary.md](docs/locus-summary.md)). Off by default outside
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
| `MAX_UPLOAD_FILE_BYTES` | `104857600` (100 MB) | Largest single file accepted. |
| `MAX_FILES_PER_CONVERSATION` | `20` | Per-conversation cap, independent of the storage cap. |

## Learn More

Built with [Next.js](https://nextjs.org). See the
[Next.js documentation](https://nextjs.org/docs) for framework details, and
[Vercel's deployment docs](https://nextjs.org/docs/app/building-your-application/deploying)
for deploying it.
