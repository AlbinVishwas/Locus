# Locus

Search every PDF on your company's storage server by keyword, in milliseconds. Locus reads the PDFs once (running OCR
on scanned pages, English and Hindi), keeps a search index on **your own computer**, and then answers a search with the
**file, page number and a snippet**. Click a result to open the original PDF at that page.

- **No AI model in search.** A search is a database lookup. Page numbers and snippets come straight from the stored text,
  so they can't be invented. (An optional chat mode exists, off by default; it needs LM Studio and is never used for search.)
- **Read-only.** Locus never writes to, moves or deletes anything on the server. A PDF is streamed to a temp file only while it
  is being read, then the temp file is deleted.
- **Stays up to date.** Every 10 minutes (and on "Rescan now") it compares the server with the index and reads only the files that
  are new or changed; files deleted on the server leave the index.
- **Runs on a laptop.** macOS, Windows or Linux, natively or in Docker. Everything stays on that computer.

```
 your browser ──► Locus (this computer) ──► storage server (folder / network share / S3)  [read-only]
                       │
                       └─► index on this computer's disk (SQLite full-text index)
```

## Quickstart (about 10 minutes)

You need: **Node.js 22**, **poppler** (reads PDFs) and **tesseract** with English and Hindi data (reads scanned pages).
`npm run doctor` checks all of this and prints the exact install command for your system if anything is missing.

### macOS

```bash
brew install node@22 poppler tesseract tesseract-lang
git clone <your copy of Locus> locus && cd locus      # or unzip the source and cd into it
npm ci
npm run setup        # asks for an admin password and where the PDFs are; tests the connection
npm run doctor       # everything green?
npm run build
npm start            # then open http://localhost:3000 and sign in as "admin"
```

### Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install oschwartz10612.Poppler
winget install UB-Mannheim.TesseractOCR      # then add Hindi: see below
# reopen PowerShell so the new tools are on PATH
cd locus
npm ci
npm run setup
npm run doctor
npm run build
npm start            # open http://localhost:3000
```

Hindi OCR on Windows: download `hin.traineddata` from <https://github.com/tesseract-ocr/tessdata_fast> into Tesseract's `tessdata`
folder (usually `C:\Program Files\Tesseract-OCR\tessdata`). Without it Locus still works; Hindi scanned pages are read poorly.
Chocolatey works too: `choco install nodejs-lts poppler tesseract`.

### Linux (Ubuntu / Debian)

```bash
# Node 22: https://github.com/nodesource/distributions (or: nvm install 22)
sudo apt install poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin
npm ci && npm run setup && npm run doctor && npm run build && npm start
```

### Docker (any OS, one command)

```bash
cp .env.example .env          # set SESSION_SECRET, LOCUS_ADMIN_PASSCODE, LOCUS_SERVER_TYPE and the server settings
docker compose up -d --build  # open http://localhost:3000
```

For a folder server, point `LOCUS_SERVER_HOST_PATH` in `.env` at the folder (or a mounted network share); it is mounted into the
container **read-only**. For S3, set the `LOCUS_SERVER_S3_*` settings. To try everything without your real server,
`docker compose --profile test up -d --build` also starts a local MinIO (S3) with a `tenders` bucket. Details in
[docker-compose.yml](docker-compose.yml).

`npm start` is the normal way to run Locus (after `npm run build`). `npm run dev` is for working on the code.

## Connecting the storage server

Run `npm run setup` (it asks), or set these in `.env.local` (the full list, with a comment for each, is in [.env.example](.env.example)):

| Server | Settings |
| --- | --- |
| **A folder**: on this computer, or a network share your system has mounted (SMB, NFS, a NAS, a Windows drive letter or `\\server\share`) | `LOCUS_SERVER_TYPE=folder`, `LOCUS_SERVER_PATH=/Volumes/tenders` (Windows: `Z:\tenders` or `\\nas01\share\tenders`) |
| **S3-compatible**: MinIO, AWS S3, Cloudflare R2, Ceph, Backblaze B2 | `LOCUS_SERVER_TYPE=s3`, `LOCUS_SERVER_S3_ENDPOINT`, `LOCUS_SERVER_S3_REGION`, `LOCUS_SERVER_S3_BUCKET`, `LOCUS_SERVER_S3_PREFIX` (optional), `LOCUS_SERVER_S3_ACCESS_KEY`, `LOCUS_SERVER_S3_SECRET_KEY`, `LOCUS_SERVER_S3_FORCE_PATH_STYLE` |

A **folder** server needs the share mounted on the computer first (Finder → Connect to Server on macOS, "Map network drive" on Windows,
`mount -t cifs` or an fstab entry on Linux). Locus then reads it like any folder: a slow or dropped share can't hang the app (every
call has a timeout and a few retries). Give the S3 key **read** access only; Locus only lists and reads.

Sign in as `admin`, open **Server** in the sidebar: it shows the connection, **Test connection**, indexing progress with an estimate of the
time left, "Last synced X min ago", **Rescan now**, the disk estimate, and any file that couldn't be read, with the reason.
Adding another kind of server (SFTP, Azure Blob...) is one file: see [docs/connectors.md](docs/connectors.md).

## First index

Locus starts indexing as soon as it runs. Files become searchable within seconds (the text layer first; scanned pages follow as OCR
reaches them), and you can search what is done so far while the Server page shows progress. It uses every CPU core at a lowered
priority, so the computer stays usable. If you restart Locus (or the laptop restarts) it carries on where it stopped; files already
indexed are never read again unless they changed. A file that can't be read (corrupt, password-protected, too slow) is skipped and listed.

Before a first index Locus estimates how big the index will be (about 18 KB per page of text) and refuses to start if it won't fit on
the disk, saying how much it needs, how much is free and what to do. While running it pauses before the disk fills and carries on by
itself once there is room. Everything already indexed stays searchable throughout.

## How it stays up to date

Every `LOCUS_SYNC_INTERVAL_MIN` minutes (default 10) Locus lists the server and compares **size and modified time** (the version tag too, on S3)
with the index: new and changed files are read, deleted files are removed from the index, renamed files are recognised by content and
only renamed. A folder server is also watched for changes (a hint so a sync starts sooner; the timed scan always runs as well, because
network shares miss events). A file modified in the last two minutes is left until it settles, so a PDF still being copied is never read
half-written (`LIBRARY_SETTLE_SECONDS`). If the server is down the banner says so and search carries on over what is indexed.

## Where things are stored

| What | Where | Setting |
| --- | --- | --- |
| The search index of the storage server | `./data/locus-data/library/` | `LOCUS_DATA_DIR` (choose a disk with room; a real local disk, not a network share) |
| Accounts, who owns what, the activity log | `./data/app/records.db` | `LOCUS_APP_DIR` |
| Files people upload, and their index | `./data/uploads/`, `./data/index/` | `UPLOADS_DIR`, `SEARCH_INDEX_PATH` |
| Your settings and secrets | `.env.local` | (git-ignored; never share it) |

Nothing from the storage server is kept except the text in the index. Results show the file's path on the server.

## Troubleshooting

`npm run doctor` finds most problems. Locus's own messages carry a code; the list with what to do for each is in
**[docs/errors.md](docs/errors.md)**. The common ones:

| You see | Meaning | Do this |
| --- | --- | --- |
| `LOCUS-SERVER-001` Can't reach the storage server | The server or share is off, unmounted or unreachable | Check the network/VPN or the mount, then **Test connection** on the Server page |
| `LOCUS-SERVER-002` Server refused the login | Wrong or read-less S3 key | Fix `LOCUS_SERVER_S3_ACCESS_KEY` / `_SECRET_KEY`, restart |
| `LOCUS-DISK-001` Not enough disk space to build the index | The index won't fit | Free space, set `LOCUS_DATA_DIR` to a bigger disk, or index a smaller folder (`LOCUS_SERVER_PATH` / `LOCUS_SERVER_S3_PREFIX`) |
| `LOCUS-DISK-002` Indexing paused: low disk space | The disk is nearly full | Free space; it resumes by itself |
| `LOCUS-TOOL-001` OCR isn't installed | tesseract is missing | Install it (`npm run doctor` prints the command); scanned pages are skipped until then |
| "Indexer isn't running" | Locus was started with `npm run start:web`, or the indexer stopped | Use `npm start`, which starts both |
| Nothing new appears after adding files | A file changed in the last 2 minutes waits to settle | Wait, or press **Rescan now** |

## Sharing outside your network (optional)

Locus doesn't need the internet. For letting someone reach it from elsewhere there is `npm run share` (a Cloudflare tunnel plus a Vercel
redirect link); see [docs/sharing.md](docs/sharing.md). It is an extra, not part of the normal setup.

## More

- [docs/how-it-works.md](docs/how-it-works.md): the exact flow, with file names and diagrams
- [docs/reference.md](docs/reference.md): the settings reference (chat switch, accounts, uploads, library)
- [docs/errors.md](docs/errors.md): every error code
- [docs/connectors.md](docs/connectors.md): adding a new kind of server
- [docs/server-benchmark.md](docs/server-benchmark.md): indexing and search speed, measured
- Developing: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run verify:index`, `npm run verify:library`, `npm run e2e:server`
