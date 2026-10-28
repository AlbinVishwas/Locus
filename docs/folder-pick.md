# Choose folder: searching a folder from your own device

The **Choose folder** chip under the search box opens the browser's own folder picker, on the
computer you're sitting at (Chrome, Edge, Safari and Firefox all have one). It is a different thing
from **My folders** (a folder on the laptop that runs Locus, added by an account) and from the
administrator's **Sources**; those pages are unchanged.

## What happens

1. You pick a folder. Only PDFs are kept, subfolders included; everything else is skipped and
   counted: *Found 3 PDFs (2 other files skipped)*.
2. The browser reads each PDF once to get its content hash and asks the server which of them it
   already has (`POST /api/folders`). Files already indexed with the same content stay; files that
   changed or are no longer in the folder are removed; the rest are uploaded one request each
   (four at a time, and resent if the connection drops) through the ordinary upload pipeline
   (`/api/uploads`) with the usual progress: *Uploading → Reading → Scanning page N of M → Ready*.
   The OCR cache is keyed by file hash, so a page OCR'd before is never OCR'd again.
   A file is searchable as soon as its text is indexed; only the pages that need OCR (see
   `docs/faster-uploads.md`) are read afterwards, in the background.
3. A chip appears above the search box: **Searching: Tender Pack · 3 files ×**. If scanned pages are
   still being read when the chip appears, the line under it says *Searchable now · improving N scanned
   pages*, with a bar, until they are done. While the chip is up,
   every search covers only that folder's files: not your other uploads, not other folders, not the
   library. Each result is labelled with the file's path inside the folder (`Annex/annex-c.pdf`).
4. **×** goes back to searching your own uploads. Picking another folder replaces the chip. Picking
   the same folder again uploads only what is new or changed (nothing, if nothing changed).

## Privacy

A picked folder is one private upload session of its own, owned by the account that picked it, with
exactly the rules uploads have: nobody else can search it, list it, or delete it. Its session id is a
keyed hash of the account and the folder name, so another account picking a folder with the same name
gets a separate index, and the id can't be worked out from outside. Two folders with the same name
picked by the same account share one index (the later pick replaces the earlier one's files).

The chip is remembered for the browser tab (so a reload keeps it) and forgotten when the tab closes;
the files stay indexed until the account removes them or the session is deleted.

## Limits (all with a message, none silent)

| Limit | Default | Setting |
| --- | --- | --- |
| PDFs in one pick | 500 | `MAX_FOLDER_FILES` |
| Files sent at once | 4 | `LOCUS_UPLOAD_PARALLEL` |
| Size of one file | 90 MB (never above `MAX_UPLOAD_FILE_BYTES`, 100 MB) | `MAX_UPLOAD_FILE_BYTES` |
| Storage for everything | 5 GB | `STORAGE_CAP_BYTES` |
| One account's uploads | 1000 MB (users mode) | `LOCUS_USER_UPLOAD_MB` |

The 90 MB per-file figure is the tunnel's: a Cloudflare quick tunnel refuses request bodies over about
100 MB, and a file's multipart envelope counts toward that, so a file is held a little under it. 500
files bounds one pick to a few hours of OCR at worst. A folder over a limit is refused before anything
is uploaded, with the reason and the suggestion to ask the administrator to add it as a library folder
(Sources), which indexes on the laptop itself and has none of these limits. A single file over the size
limit is left out and listed under "not added"; the rest of the folder still goes in.

## Checks

`npm run build && npm run e2e:folder-pick` drives all of it in a headless browser against a scratch Locus:
the chooser opens (a folder chooser, no dropdown), the *Found 3 PDFs (2 other files skipped)* message,
progress to Ready, the chip, a control phrase that is both inside and outside the folder (the chip finds
only the folder's copy, × finds only the outside one), a second account that finds nothing and gets 404
on the first one's session, a re-pick that uploads 0 files, the limit messages, and a no-overlap and
no-sideways-scroll check at 1440, 1024, 768 and 390 px. `SAVE_SHOTS=1` writes the screenshots to
`docs/screenshots/`. `scripts/live-folder-pick-check.ts` runs the same checks against the public link
with two throwaway accounts, deleted afterwards.

## Library scope

With the folder chip off, the library's scope (my uploads / all my folders / one folder / all sources)
is still a "Search in" selector, now a small line under the library status rather than a chip, so it can
never sit over anything. It is hidden while a picked folder is active.
