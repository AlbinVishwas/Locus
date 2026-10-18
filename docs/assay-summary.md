# Assay — summary for Omkar

One page, plain English. Branch: `feature/tender-search`, not merged or
pushed yet.

## What it is

Assay is the chat app, renamed, with one thing added: you can attach PDF
tender documents to a conversation and ask whether they mention
something. The answer to "does it mention X" comes from a real text
search of the files — never from the language model guessing — so a page
number is never invented.

## How to use it

1. Run `npm run share` on the laptop. It prints a public URL.
2. Send that URL, plus the passcode (set in `.env.local` as
   `ASSAY_PASSCODE`), to whoever needs it.
3. They open the URL, enter the passcode, and use it like any chat app.
4. To ask about documents: attach PDFs with the paperclip button or by
   dragging them onto the message box. Once a file shows "Ready", ask
   about it in plain language — "does it mention earnest money?" — or
   put the exact phrase in quotes for a more precise search. A results
   card shows every matching page, with a highlighted snippet, above the
   model's own reply.

Full details: [docs/sharing.md](sharing.md).

## What was actually verified, not just written

- **The search itself is exact**, proven against a brute-force scan of
  the same text: 0 disagreements across 2,024 test queries on the real
  13-document, 871-page tender set.
- **It stays fast**: under 50ms per search even at 100,000 pages
  (synthetic benchmark — see
  [docs/tender-search-report.md](tender-search-report.md)).
- **Search works with the model switched off.** It's a separate,
  deterministic step, not something the model is asked to do.
- **The login wall covers every page and every route** — tested with no
  session, a wrong passcode, and too many login attempts in a row.
- **Uploads are isolated per conversation.** One conversation's files are
  never visible to another's search, verified directly, including
  through the real browser UI.
- **A real end-to-end run**, in an actual (headless) Chrome browser:
  logged in, uploaded two real tender PDFs, searched a phrase from each
  and found the right pages (including one that only shows up after
  clicking "show more"), confirmed a brand-new conversation finds
  nothing, confirmed an ordinary chat message still works.
- **A real data leak was found and fixed** during this work, not shipped
  by accident: a Next.js build quirk was about to bundle the client
  tender PDFs into a deployable package. There's now an automated check
  (`npm run verify:no-data-leak`) that fails loudly if this ever happens
  again.
- **315 automated tests pass**, along with type-checking, linting, and a
  production build.

## Storage and retention (the numbers, and why)

| Setting | Default | Reasoning |
| --- | --- | --- |
| Max file size | 50 MB | The largest real tender PDF measured was 11 MB; this stays well under what a Cloudflare tunnel will carry in one request. |
| Max files per conversation | 20 | Comfortably above the 13-document sample set this was built against. |
| Total storage cap | 5 GB | A laptop-friendly number; the full 13-document sample set is under 40 MB. |
| File retention | 14 days | Long enough to work a tender, short enough that a shared laptop doesn't quietly accumulate client documents forever. |
| Session length | 7 days | How long someone stays logged in after entering the passcode. |

All five are environment variables and can be changed without touching
code — see the README.

When a file expires, it's actually deleted (file, search rows, and OCR
cache if nothing else needs it) — not just hidden — and a conversation
that relied on it says so the next time it's searched, rather than
silently finding nothing.

## Hindi text in the documents

One document's signature line is in Devanagari script but stored as a
broken font encoding — unreadable as text no matter what. OCR with
English only misreads it as garbage ("eeaant ve ear"). OCR with
English+Hindi correctly recovers readable Hindi ("हस्ताक्षर एवं दिनाक",
"Signature and Date" — matching the English label right next to it) at
roughly 30–55% more time per page. **Not turned on by default** — see the
decision below.

## Decisions that need your call

1. **Exact vs. loose matching, by default.** Exact (today's default)
   means "26-2080" won't match "26/2080"; loose ignores punctuation. A
   search already offers a one-click "show matches without exact
   punctuation" button when exact finds nothing, so this only decides
   which one a user sees first.
   **My recommendation: keep exact as the default.** It's the more
   trustworthy of the two to show first, and the loose fallback is one
   click away.

2. **OCR every page, or only the ones heuristics flag as needing it.**
   Measurement during the original search feature found real text the
   heuristics missed, so every page is OCR'd by default — slower to
   index, but nothing gets silently skipped.
   **My recommendation: keep OCRing every page.** For tender documents,
   a missed clause is worse than a slower upload.

3. **Hindi OCR (`OCR_LANG=eng+hin`), on or off by default.** It's a real
   improvement where Hindi text actually appears, but it was measured on
   almost no Hindi content (about 30 characters across the whole sample
   set) and costs extra time on every page, including pages with none.
   **My recommendation: leave it off by default**, and turn it on
   (`OCR_LANG=eng+hin` in `.env.local`) only once documents with real
   Hindi content are expected regularly.

4. **A shared passcode, or real accounts per person.** Today, one
   passcode gets anyone in — simple, and fine for a small trusted group.
   Real accounts would mean separate logins, and could support things
   like "whose upload is this" later.
   **My recommendation: keep the shared passcode** unless more than a
   handful of people need access, or you want to know who did what.

5. **Staying on this laptop, or moving to the cloud later.** Today,
   everything — the model, the files, the search index — stays on this
   machine; Vercel only ever gets the chat UI itself, with uploads and
   search explicitly disabled there. Moving further (a cloud-hosted
   model, cloud storage for documents) is possible later but is a real
   change to who can see client documents.
   **My recommendation: stay local** until there's a specific reason to
   move, given these are client tender documents.

6. **Should the model ever read the documents directly (not just see
   search results)?** Today it explicitly can't — it's told not to state
   a filename or page number, and it never will since it has no access.
   A future version could let it read matched pages and summarize them,
   which is a meaningfully bigger feature (and a new way for it to get
   something wrong) than deterministic search.
   **My recommendation: treat this as a separate, later decision** — the
   current version is deliberately the safer, "never invents a page
   number" shape.

## What wasn't done, and why

- **A named Cloudflare tunnel (a fixed URL).** Needs a Cloudflare account
  and a domain decision only you can make. Documented in
  [docs/sharing.md](sharing.md) for when you're ready.
- **Hindi OCR is implemented and measured, not switched on.** See
  decision 3 above.
- **The model answering questions from the documents directly.** See
  decision 6 above.
