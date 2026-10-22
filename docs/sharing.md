# Sharing Locus

One command shares this laptop's Locus with someone else, over one
permanent public link, with your documents and your local model —
nothing moves to the cloud.

## Running it

```bash
npm run share
```

What it does, in order:

1. **Chat off (the default):** prints that chat is disabled and skips
   the LM Studio check entirely — LM Studio can be closed; nothing in
   search-only mode talks to it. **Chat on** (`LOCUS_CHAT_ENABLED=true`,
   see the [README](../README.md#chat-switch)): checks LM Studio is
   reachable at `http://localhost:1234/v1` and has a model loaded. If
   not, it tells you why and stops — nothing else starts. It reads
   `.env.local` the same way the server does, so the setting there
   applies to both.
2. Makes sure `SESSION_SECRET` is set, generating one and saving it to
   `.env.local` the first time (so sessions survive a restart; see
   "One-time setup" below if you'd rather set it yourself).
3. Runs `npm run build`.
4. Starts the app in production mode on port 3000, with uploads and
   search turned on (`LOCUS_ENABLE_UPLOADS=true`), and — only with chat
   on — URL context turned on (`LOCAL_CHAT_ENABLE_URL_CONTEXT=true`).
   Both are off by default in production, and this is the one place
   they're meant to be on.
5. Runs `caffeinate -i` for as long as the server runs, so the laptop
   doesn't go to sleep mid-conversation.
6. Starts a Cloudflare quick tunnel to port 3000, gets back a one-off
   `*.trycloudflare.com` URL, then points the permanent link below at it.

Press **Ctrl+C** to stop everything — the tunnel, the server, and
caffeinate all stop together. The permanent link then shows a small
"Locus is offline right now" page instead of forwarding anywhere, until
the next `npm run share`.

## One permanent link

**<https://local-chat-one-ivory.vercel.app>** always points at whichever
`npm run share` is currently running, anywhere. The underlying tunnel URL
changes every run, but this link doesn't — `npm run share` updates it for
you as its last step, by setting the `LOCUS_URL` environment variable on
the `redirect/` app (a separate, minimal Vercel project that does nothing
but check whether `LOCUS_URL` answers and either redirect there or show
the offline page — it has no access to Locus's code, data, or uploads)
and redeploying it.

If that Vercel step fails (not logged in, no network), `npm run share`
still prints the tunnel URL as a fallback and explains why — it never
stops Locus itself over this. Pass `--no-vercel` to skip updating the
link entirely (e.g. while offline, or testing locally):

```bash
npm run share -- --no-vercel
```

## What the other person needs

- The permanent link above (or the tunnel URL printed in the terminal,
  if you used `--no-vercel`).
- The passcode from `LOCUS_PASSCODE` in your `.env.local`.

They open the link, enter the passcode, upload PDFs to a session, and
type a word or phrase to find every page that contains it (with chat
on: chat, attach PDFs, ask about them). Everything runs on your laptop;
nothing is uploaded anywhere except to this machine.

## One-time setup

```bash
brew install cloudflared
```

(`poppler`, `tesseract`, and `tesseract-lang` are also needed for
documents — see the main [README](../README.md) if you haven't installed
those yet.)

Set a passcode once, in `.env.local`:

```bash
LOCUS_PASSCODE=choose-something-only-you-and-they-know
```

## If the tunnel URL changes

A Cloudflare **quick** tunnel (what `npm run share` uses) gets a new
random `*.trycloudflare.com` address every time you run it. That's fine —
the permanent link above gets pointed at the new one automatically, each
time `npm run share` runs, including just to pick up a code change. The
person you're sharing with never needs the raw tunnel URL at all.

## The redirect app itself

`redirect/` is a separate, minimal Vercel project, deployed on its own
(`vercel deploy --prod` from inside `redirect/`, already linked to the
`chat` project that serves `local-chat-one-ivory.vercel.app`). It has no
dependencies and no access to anything else in this repo — just
`api/redirect.js`, which reads `LOCUS_URL`, checks whether it currently
answers, and either 307-redirects there (keeping the path) or renders the
offline page, with `Cache-Control: no-store` so a new link takes effect
immediately. `npm run share` manages its `LOCUS_URL` env var for you; you
shouldn't need to touch `redirect/` directly unless the offline page
itself needs to change.

## Troubleshooting

- **"Could not reach LM Studio"** — only possible with chat on. Open LM
  Studio, load a model, and make sure its local server is started (the
  button that says "Start Server"), or turn chat off.
- **Chat replies are missing** — chat is off by default; see the
  [README](../README.md#chat-switch) to turn it on.
- **"cloudflared is not installed"** — `brew install cloudflared`.
- **The tunnel closes on its own** — `npm run share` notices and stops the
  server too, rather than leaving it running with no way to reach it.
  Quick tunnels can drop on a flaky connection; just run it again.
- **Port 3000 is already in use** — something else (often `npm run dev`)
  is already listening there. Stop it first; `npm run share` always uses
  port 3000.
