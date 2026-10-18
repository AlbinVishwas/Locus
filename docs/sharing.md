# Sharing Assay

One command shares this laptop's Assay with someone else, over a public
link, with your documents and your local model — nothing moves to the
cloud.

## Running it

```bash
npm run share
```

What it does, in order:

1. Checks LM Studio is reachable at `http://localhost:1234/v1` and has a
   model loaded. If not, it tells you why and stops — nothing else starts.
2. Runs `npm run build`.
3. Starts the app in production mode on port 3000, with uploads and
   search turned on (`ASSAY_ENABLE_UPLOADS=true`) and URL context turned on
   (`LOCAL_CHAT_ENABLE_URL_CONTEXT=true`) — both are off by default in
   production, and this is the one place they're meant to be on.
4. Runs `caffeinate -i` for as long as the server runs, so the laptop
   doesn't go to sleep mid-conversation.
5. Starts a Cloudflare quick tunnel to port 3000 and prints the public
   URL.

Press **Ctrl+C** to stop everything — the tunnel, the server, and
caffeinate all stop together.

## What the other person needs

- The URL printed in the terminal.
- The passcode from `ASSAY_PASSCODE` in your `.env.local`.

They open the URL, enter the passcode, and use it like any other web app:
chat, attach PDFs, ask about them. Everything runs on your laptop; nothing
is uploaded anywhere except to this machine.

## One-time setup

```bash
brew install cloudflared
```

(`poppler`, `tesseract`, and `tesseract-lang` are also needed for
documents — see the main [README](../README.md) if you haven't installed
those yet.)

Set a passcode once, in `.env.local`:

```bash
ASSAY_PASSCODE=choose-something-only-you-and-they-know
```

## If the URL changes

A Cloudflare **quick** tunnel (what `npm run share` uses) gets a new
random `*.trycloudflare.com` address every time you run it. If you stop
and restart `npm run share` — including just to pick up a code change —
send the new URL to whoever's using it.

## A fixed URL instead (later, optional)

A **named** tunnel keeps the same address across restarts. It needs:

- A Cloudflare account (free tier is fine).
- A domain added to that account (Cloudflare doesn't sell domains itself,
  but you can point one you already own at it, or buy one from any
  registrar and add it).
- `cloudflared tunnel login`, then `cloudflared tunnel create <name>`, then
  a DNS route for it (`cloudflared tunnel route dns <name> <hostname>`).

None of this is set up yet — it's a deliberate choice to leave for later,
since it needs an account and a domain decision this script shouldn't make
for you. When you want it, the quick-tunnel line in `scripts/share.ts`
(`cloudflared tunnel --url ...`) is what to replace with
`cloudflared tunnel run <name>`, pointed at a small `config.yml` instead of
a URL.

## Troubleshooting

- **"Could not reach LM Studio"** — open LM Studio, load a model, and make
  sure its local server is started (the button that says "Start Server").
- **"cloudflared is not installed"** — `brew install cloudflared`.
- **The tunnel closes on its own** — `npm run share` notices and stops the
  server too, rather than leaving it running with no way to reach it.
  Quick tunnels can drop on a flaky connection; just run it again.
- **Port 3000 is already in use** — something else (often `npm run dev`)
  is already listening there. Stop it first; `npm run share` always uses
  port 3000.
