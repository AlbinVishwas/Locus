# Sources, accounts and activity

How to run Locus with **named accounts, an administrator, the Sources page and
a searchable library**. Everything here is **off unless configured**: with none
of these settings Locus is the one-passcode app it has always been.

Design and decisions: [sources-plan.md](sources-plan.md). The library's
indexing and storage details: [library.md](library.md).

## Who can do what

| | Signed-out | Normal user | Administrator |
| --- | --- | --- | --- |
| See anything | sign-in / create-account page only | their own uploads | everything below |
| Upload PDFs and search them | no | **only their own** | their own, too |
| Search the library (all sources, or one) | no | **no** (only their own folders, if `LOCUS_USER_SOURCES` is on) | yes |
| Sources page (add, test, pause, resume, rescan, remove) | no | no ("My folders" for folders of their own, if `LOCUS_USER_SOURCES` is on) | yes |
| Users page (create, disable, reset passcode, remove) | no | no | yes |
| Activity page (every search, sign-in, upload, source change, problem) | no | no | yes |

This is enforced **on the server**, in every route, not by hiding buttons. A
normal user who types `/sources` is sent back to the search page; their calls
to `/api/sources`, `/api/users`, `/api/activity` or `/api/library/*` get
`403`. A normal user can never search another person's files: using someone
else's session id answers "No such session", exactly as for an id that doesn't
exist.

## Turning it on

```bash
# .env.local
LOCUS_USERS_ENABLED=true            # named accounts (otherwise: the one shared passcode)
LOCUS_ADMIN_PASSCODE=<a long one>   # the administrator signs in as "admin" with this
LOCUS_SIGNUP_CODE=<code you give people>   # who may create an account (see below)
LOCUS_LIBRARY_ENABLED=true          # the library, its search and the Sources page
```

Then `npm run share`. With the library and the admin area both on, it also
**starts the indexer worker** (the process that does the indexing) and
**generates `LOCUS_SECRETS_KEY`** into `.env.local` the first time. Without
`share`, run the worker yourself in another terminal:
`npm run library:worker`. If the worker isn't running, the Sources page says
**"Indexer not running"** and sources wait; searching what's already indexed
works either way.

Sign in as `admin` with `LOCUS_ADMIN_PASSCODE`. It works through the public
tunnel like any other sign-in (admin sessions last `LOCUS_ADMIN_SESSION_HOURS`,
default 8; users' last `SESSION_TTL_HOURS`).

## Letting ordinary accounts add their own folders (optional)

By default only the administrator can point Locus at a folder. With
`LOCUS_USER_SOURCES=true` (users mode) every signed-in account gets:

- **My folders** in the sidebar: the Sources page, folders only (no database or
  Google Drive), with the same folder browser, **Test** and **Add folder**.
- **Folders that are private to them.** A folder an account adds is searched only
  by that account (and by you, the administrator, who sees it marked "added by
  <name>"). Other accounts can't list it, change it, remove it, search it or count
  it: naming it gets the same answer as for a folder that doesn't exist.
- **Folder search scopes** in the search box: *All my folders*, one of their
  folders, *My uploads*, or both. Results, paging and counts are as for the library,
  restricted to their own folders.
- A limit of `LOCUS_USER_SOURCES_MAX` folders each (default 5).

What an ordinary account still can't do: add databases or Drive folders (they hold
passwords and reach other machines), see the library's storage numbers, or open
Users and Activity. A folder must be inside an *allowed root*, and never in or
around Locus's own files (accounts, uploads, the search index, the library
folder), however wide the allowed roots are set. Removing an account removes its
folders from search (the original files are never touched). Every folder action
and search is in the activity log under the person's name.

**The files are read from the computer Locus runs on**, so a remote person can
only choose folders that exist on that computer, within the allowed roots. With
the default (`/Volumes`: connected drives) there may be nothing to choose until a
drive is plugged in or you add a location with `LOCUS_ALLOWED_ROOTS`. Anything you
allow can be read by every account that has this switched on, so allow a folder
meant for that, not your whole disk.

## Accounts

- **Sign-up is gated.** By default (`LOCUS_SIGNUP=code`) a person needs the
  sign-up code to create an account: `LOCUS_SIGNUP_CODE`, or, if that's unset,
  the old shared `LOCUS_PASSCODE`. `LOCUS_SIGNUP=open` lets anyone register;
  `LOCUS_SIGNUP=off` closes it (you create accounts yourself on the Users page,
  which gives a generated passcode shown once).
- **Passwords** are stored only as salted scrypt hashes. People change their own
  at **Change password** in the sidebar (`/account`; needs the current one, signs
  out their other devices). The admin's lives in `.env.local`.
- The sign-in page says "username and password" and that the old shared passcode no
  longer works; the shared passcode alone answers "Enter your username and
  password", and isn't accepted as anyone's password.
- **Disable / reset / remove** (Users page) take effect at once: the person's
  sign-in token carries a version number that those actions move. Removing a
  user also deletes their uploaded files and sessions (their activity history
  stays, under their name).
- **Rate limits:** 5 failed sign-ins per address and 5 per username per 5
  minutes; 10 failed admin sign-ins per 15 minutes in total; 5 sign-ups per
  address and 30 overall per hour. A refused attempt is logged too.
- **Per-user upload limit:** `LOCUS_USER_UPLOAD_MB` (default 1000) on top of the
  shared 5 GB cap.
- Each person's saved sessions live in the browser under their own key
  (`chat-conversations:<id>`), so two people on one browser never see each
  other's.

## The Sources page

`/sources` (administrator only; linked from the sidebar). Each row: an icon, the
**name**, the **location** (folder path, `database · table`, or the Drive
link: never a password), a **status** and the last scan. The `⋯` menu has
**Pause / Resume**, **Rescan** and **Remove**.

| Status | Meaning |
| --- | --- |
| `Scanning… 8,311 PDFs found so far` | The indexer is listing the source. |
| `Indexing… 1,204 of 2,880` | Reading and indexing, with a progress bar. |
| `Up to date · 12,480 docs · 1.1M pages` | Nothing left to do (`· N couldn't be read` if some failed). |
| `Paused` | You paused it; nothing is read or downloaded. |
| `Paused: storage limit reached` / `Paused: low disk space` | See *Storage limits*. |
| `Error: …` | A plain-language reason (folder gone, bad login, key rejected, …). |
| `Indexer not running` | Start it: `npm run library:worker` (or `npm run share`). |
| `Removing…` | Its index entries are being deleted in the background. |

**Remove** asks first. It deletes the source's entries from the index and frees
the space; **the original files are never touched** (they're not even opened for
writing). Removing can't be undone, but adding the source again indexes it
again.

The indexer picks up changes within a couple of seconds (it watches the
sources registry, `library/sources.db`).

### Add source

A panel with three tabs and a **Test** button on each. **Add source** stays
disabled until a Test has passed with the current values; editing any field
clears the result. Test builds the source exactly as the indexer will, reads a
few entries and stops: nothing is saved or indexed.

- **Folder:** a path (or **Browse**, Locus's own folder picker). The folder must
  be inside an *allowed root* (below). Test reports "Found at least N PDFs" (it
  counts for up to 8 seconds / 5,000 files) and warns if the folder is synced
  from the cloud (iCloud, OneDrive, Dropbox, Google Drive…): reading its files
  can download them to this Mac. Online-only files are skipped, never
  downloaded.
- **Database:** PostgreSQL, MySQL or SQLite. Host / port / database / user /
  password, **or** paste a connection string (it's split into the fields and not
  kept). A table (`table` or `schema.table`) and which columns hold the ID, file
  name, modified time and the file's **path** or **bytes**. Locus only reads; use
  a database user that can only `SELECT`. Table and column names are checked
  as plain identifiers and quoted, never pasted into SQL. SQLite takes the
  database file's path (inside an allowed root). Test connects and reads 5
  sample rows. Postgres/MySQL have only been tested against fixtures and SQL
  generation so far; try yours with Test.
- **Google Drive:** paste the link of a folder shared as **"Anyone with the
  link"**. Needs `GOOGLE_API_KEY` in `.env.local` (a Google Cloud API key with
  the Drive API enabled); without it the tab says so. Locus lists the folder
  through the Drive API, and for each PDF: downloads it to a temp file inside the
  library folder, indexes it, deletes it. Unchanged files aren't downloaded again.
  Rate limits are met with exponential backoff shared by all requests. Private
  folders say *"Private folders aren't supported yet."*

## Allowed roots (what the folder box may point at)

The Sources page can be reached over the internet by anyone who learns the
admin passcode, so it must not be able to point the indexer at *any* folder on
the Mac (your home folder, `~/.ssh`, …). **Allowed roots** are the only places a
folder or SQLite file may be: by default **`/Volumes`**, where external and
connected drives appear. `LOCUS_ALLOWED_ROOTS` (comma-separated absolute paths;
never `/`) adds more, e.g. a folder on the laptop's disk you want to index.

Checked on the server for every path: Test, Add, the folder browser, a
database's file path, and again by the indexer before each scan. The real path
is resolved first (so a symlink out of an allowed root is refused), `..` is
refused, and a folder that contains or sits inside Locus's own data folder is
refused. A folder set in `.env` by whoever runs the app (`LOCUS_LIBRARY_DIR`) is
trusted where it is.

## Secrets

A database password is **encrypted at rest** (AES-256-GCM, a key derived from
`LOCUS_SECRETS_KEY`, bound to the source's id so a copied blob won't open
elsewhere) in `library/sources.db`. It is never sent back to the browser, never
in a log, the activity log, an error message or the status API: a connection
error that echoes it has it removed. Without `LOCUS_SECRETS_KEY` (a long random
string, at least 32 characters) a password can't be saved, and Locus says so;
`npm run share` generates one for you. **Keep it with your backups**: without
it, saved passwords can't be read and must be entered again.

## Storage limits

The library now lives **on this laptop's disk by default**
(`data/locus-data`, or `LOCUS_DATA_DIR`), with two limits:

- a **cap**: `LOCUS_LIBRARY_MAX_GB` (default **100**) on everything the library
  writes (the index, OCR cache, registry, logs, temp files; measured as real
  disk use, not file sizes). Source PDFs are never copied, so they don't count.
- a **reserve**: `LOCUS_MIN_FREE_GB` (default **20**): the disk is never filled
  below this much free space. On a laptop with little free space the reserve is
  the limit that bites first.

When either is reached, indexing **pauses and nothing is deleted**. Search keeps
working. The Sources page shows a banner with the numbers; the activity log
records the pause; it **resumes by itself** when there's room again (a source
removed, the cap raised, space freed). Session uploads keep their own separate
5 GB cap; the sidebar shows both ("Library" and "Sessions").

Still refused for `LOCUS_DATA_DIR`: network drives, FAT32 and exFAT
(`LOCUS_DATA_DIR_ALLOW_EXFAT=true` overrides exFAT). An external APFS drive
still works exactly as before. Details: [library.md](library.md#the-storage-rule).

## The search scope

For the administrator the search box has a **Search in** dropdown: **All
sources**, each source by name, **My uploads**, or **My uploads and all
sources**. Each library hit shows the **source's name** beside the file (the
folder-relative path, `db:<id> · name`, or the Drive path; never an absolute
path). Paging (50 at a time), "at least N" counts and the 3-character minimum are
as before. `LOCUS_SEARCH_SCOPE` sets the starting choice (`session`, `all`,
`library`, `both`). A normal user has no dropdown: they search their own uploads.

## The activity log (the records database)

`data/app/records.db` (`LOCUS_APP_DB_PATH` moves it; it lives apart from the
library so signing in works with the library's drive unplugged) holds the users,
who owns which session, a history of uploads, and the **activity log**: sign-ins
and failures, sign-ups, searches, uploads, source changes, user changes,
indexer pauses and problems, and refused attempts. The **Activity** page filters
by user, event, text and "problems only", pages with an "older" button, shows an
**issues strip** (failed sign-ins, denied access, search errors, upload failures,
indexing problems, storage pauses in the last 24 hours) and **downloads a CSV**
(cells that start with `=`, `+`, `-` or `@` are defused so a search typed as a
spreadsheet formula can't run when opened).

- **Search text is stored** (`LOCUS_LOG_QUERY_TEXT=false` turns that off and
  keeps everything else), with counts of pages and documents found: **never
  snippets or document text**. Readable only by the administrator.
- Kept **365 days** (`LOCUS_ACTIVITY_RETENTION_DAYS`), purged hourly.
- The sign-in page tells everyone: *"Searches are logged for the administrator."*
- A username typed at sign-in is logged only if it's a real account (people
  sometimes type their passcode into the username box).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCUS_USERS_ENABLED` | `false` | Named accounts. Off: the one shared passcode. |
| `LOCUS_ADMIN_PASSCODE` | — | Enables the admin area; the passcode for the `admin` account. Changing it signs the admin out everywhere. |
| `LOCUS_ADMIN_SESSION_HOURS` | `8` | Admin sign-in lifetime. |
| `LOCUS_SIGNUP` | `code` | `code`, `open` or `off`. |
| `LOCUS_SIGNUP_CODE` | `LOCUS_PASSCODE` | The sign-up code. |
| `LOCUS_USER_UPLOAD_MB` | `1000` | Per-user upload limit. |
| `LOCUS_LOG_QUERY_TEXT` | `true` | Store search text in the activity log. |
| `LOCUS_ACTIVITY_RETENTION_DAYS` | `365` | |
| `LOCUS_APP_DB_PATH` | `data/app/records.db` | The records database. |
| `LOCUS_LIBRARY_ENABLED` | `false` | The library, its search, the Sources page. |
| `LOCUS_DATA_DIR` | `data/locus-data` | Where the library writes. |
| `LOCUS_LIBRARY_MAX_GB` | `100` | The cap. |
| `LOCUS_MIN_FREE_GB` | `20` | The reserve (`LIBRARY_MIN_FREE_GB` still works). |
| `LOCUS_ALLOWED_ROOTS` | `/Volumes` | Where folders and SQLite files may be. |
| `LOCUS_USER_SOURCES` | `false` | Ordinary accounts may add their own folders (private to them). |
| `LOCUS_USER_SOURCES_MAX` | `5` | Folders per ordinary account. |
| `LOCUS_USER_DATABASES` | off | Testing switch: with `LOCUS_USER_SOURCES` on, ordinary accounts also get the **Database** tab (never Google Drive). The account supplies the host to connect to, so leave it off where people shouldn't be able to point this computer at other machines. |
| `LOCUS_SECRETS_KEY` | generated by `share` | Encrypts saved database passwords. |
| `GOOGLE_API_KEY` | — | Google Drive sources. |
| `LOCUS_SEARCH_SCOPE` | `session` | Starting scope: `session`, `all`/`library`, `both`. |

## Checking it

| Command | What it does |
| --- | --- |
| `npm run e2e:sources` | Starts its own scratch Locus (users mode, the worker, a mock Google Drive, generated PDFs, a SQLite database) on port 3210 and drives the whole thing in a real browser: sign-up with a wrong and right code, two users who can't see each other's files, the admin adding a folder, a database and a Drive source, searching all/one source, pause/resume/rescan/remove, creating and disabling users, the activity log and its CSV. `KEEP_ENV=1` keeps the scratch folder. Build first (`npm run build`). |
| `npm run screenshots:sources` | The same scratch Locus; saves screenshots of every new screen at 1440, 1024, 768 and 390 px to `docs/screenshots/` and checks each for sideways scrolling and overlapping controls. |
| `npm run bench:library` | The synthetic scale benchmark (see *Scale*). |

## Scale

See [sources-scale.md](sources-scale.md) for the benchmark: query times at a
million pages, bytes per page and the projection to ~50,000 documents.

## Known limits

- **The admin area needs users mode.** There's no separate `/admin` page: the
  administrator signs in as `admin` on the normal sign-in page. (The plan had a
  separate admin sign-in on top of the one-passcode app; it was simpler and safer
  to make "admin" one of the accounts.)
- Sources defined in `.env` (`LOCUS_LIBRARY_DIR`, `LIBRARY_DB_URL`) show on the
  Sources page marked "managed in .env" and can be paused but not removed there.
  A database source from `.env` is run only by `npm run index:library`.
- A SQLite file is typed in; the folder browser lists folders only.
- The list of files that couldn't be indexed is "N couldn't be read" on the row,
  not yet a clickable list; the reasons are in `library/logs/failures.jsonl` and
  `npm run index:library -- --status`.
- Editing a source (changing its folder or password) isn't there yet: remove it
  and add it again. Renaming works through the API.
- Private Google Drive folders (sign-in with Google) are not supported yet.
- Real PostgreSQL and MySQL servers haven't been run against (SQL generation and
  connection handling are tested; try yours with Test first).
