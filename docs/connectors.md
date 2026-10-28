# Storage connectors

A connector is where Locus reads PDFs from. Two ship with it: `folder` (a local or mounted folder) and `s3` (any S3-compatible
server). Adding another (SFTP, Azure Blob Storage, SharePoint, WebDAV...) is **one new file and three small edits**. Locus only ever
reads from a connector; the interface has no way to write.

## The interface

`src/lib/server/types.ts`:

```ts
interface StorageConnector {
  readonly type: "folder" | "s3";      // add yours here
  readonly label: string;               // shown to people; never contains a secret
  list(signal, onSkip?): AsyncIterable<RemoteFile>;   // every file under the root, recursively
  stat(path, signal?): Promise<RemoteFile | null>;    // one file's current details, null if it's gone
  read(path, signal?, range?): Promise<Readable>;     // the bytes as a stream; range is inclusive
  test(signal?): Promise<ConnectorTestResult>;        // a cheap read-only check; never throws
  close(): Promise<void>;
}
interface RemoteFile { path: string; size: number; modifiedAt: string /* ISO */; etag: string | null }
```

Rules a connector must follow:

1. **Read-only.** Never write, rename, delete or change metadata on the server.
2. **Paths** are relative to the connector's root, `/`-separated whatever the operating system, never start with `/`, never contain `..`.
   Run every incoming path through `cleanRelativePath()`; `read` and `stat` must refuse anything that could leave the root.
3. **Never hang.** Every network call needs a timeout; retry what tends to pass (timeouts, resets, 5xx) a few times with backoff; give up with a
   `ConnectorError` of the right kind (`unreachable`, `auth`, `not-found`, `timeout`, `config`, `other`). A listing that can't read its root must
   *throw*, not return nothing: an empty listing looks like "everything was deleted".
4. **Change detection** is `size` + `modifiedAt` (+ `etag` if the server has a version tag that changes with the content). Give the most reliable
   values the server offers.
5. **No secrets in messages.** Put secrets only in the environment, never in `label`, error messages or logs (`redact()` in `src/lib/errors/redact.ts`
   removes the known ones, but don't rely on it).

## Adding a driver, step by step

Example: an SFTP driver.

1. **`src/lib/server/sftpConnector.ts`**: implement `StorageConnector` (use the folder and S3 drivers as models; `mapFsError` / `mapS3Error` show how to turn a library's
   errors into `ConnectorError`s).
2. **`src/lib/server/config.ts`**: add the type to `ServerConfig` (`{ type: "sftp"; host; port; user; ... }`), the `LOCUS_SERVER_SFTP_*` settings to `loadServerConfig`
   (say exactly which setting is missing), a line to `describeServer` (no secrets) and the identifying fields to `serverFingerprint` (never secrets).
3. **`src/lib/server/connector.ts`**: add `case "sftp": return new SftpConnector(cfg)`.
4. Add `"sftp"` to `StorageConnector["type"]`, `ServerSourceConfig["type"]` (`src/lib/library/sources/forms.ts`) and to the choices in `scripts/setup.ts`.
5. Add the keys to `.env.example` and a row to the table in the README.

Everything else works unchanged, because the rest of Locus talks to the connector only: the indexer (resume, failures, sync, deleted files, disk protection),
the Server page and **Test connection**, and opening the original PDF from a result.

## Testing a driver

Copy `src/lib/server/folderConnector.test.ts` (or `s3Connector.test.ts`, which runs against `src/lib/server/testing/mockS3.ts`, a small in-process S3 server standing
in for MinIO) and check: list / stat / read, a range, paths that try to escape, read-only (nothing on the server changed, and no write calls were made),
a stalled server (timeout, bounded time), a server that answers errors (retried, then a clear message), wrong credentials (the `auth` kind), and that no secret appears in
`label` or any error message. Then run the end-to-end sync tests in `src/lib/server/serverSync.test.ts` with your connector in place of the folder one.
