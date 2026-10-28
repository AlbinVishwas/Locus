import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { cleanRelativePath, ConnectorError, type ConnectorTestResult, type RemoteFile, type SkipFn, type StorageConnector } from "./types";

/**
 * A folder: on this computer, or any network share the operating system has mounted (SMB, NFS, a NAS, a
 * Windows drive letter or \\server\share path). Locus only reads it.
 *
 * A network share can be slow, stall or vanish, so every call to it has a timeout (a call that never returns
 * is abandoned, not waited for) and a few retries with a pause for the errors that tend to pass by themselves.
 * Nothing here ever writes, renames or deletes: files are opened with the read-only flag and nothing else is
 * called on the share.
 */

export interface FolderConnectorOptions {
  /** Each call to the share may take this long before it counts as a timeout. */
  opTimeoutMs?: number;
  /** A file being read that goes quiet for this long is abandoned. */
  idleTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxDepth?: number;
}

const TRANSIENT = new Set(["EIO", "ETIMEDOUT", "ESTALE", "EBUSY", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ECONNRESET", "EAGAIN", "ENOTCONN", "EREMOTEIO"]);

function codeOf(err: unknown): string {
  return String((err as NodeJS.ErrnoException)?.code ?? "");
}

/** Rejects with a ConnectorError("timeout") if `work` doesn't settle in time. The abandoned call is left to finish or fail on its own. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectorError("timeout", `${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** Turns a Node filesystem error into the connector's own kind, with a message a person can act on. */
export function mapFsError(err: unknown, what: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const code = codeOf(err);
  if (code === "ENOENT" || code === "ENOTDIR") return new ConnectorError("not-found", `${what}: not found`);
  if (code === "EACCES" || code === "EPERM") return new ConnectorError("auth", `${what}: permission denied`);
  if (TRANSIENT.has(code)) return new ConnectorError("unreachable", `${what}: the share isn't answering (${code})`);
  return new ConnectorError("other", `${what}: ${err instanceof Error ? err.message : String(err)}`);
}

export class FolderConnector implements StorageConnector {
  readonly type = "folder" as const;
  readonly label: string;
  private readonly o: Required<FolderConnectorOptions>;

  constructor(
    private readonly root: string,
    options: FolderConnectorOptions = {}
  ) {
    this.label = `folder ${root}`;
    this.o = { opTimeoutMs: 30_000, idleTimeoutMs: 60_000, retries: 3, retryDelayMs: 500, maxDepth: 64, ...options };
  }

  /** A relative path joined to the root, refusing anything that would leave it. */
  private resolve(rel: string): string {
    const clean = cleanRelativePath(rel);
    if (clean === null) throw new ConnectorError("not-found", "That path isn't valid");
    const abs = path.join(this.root, ...clean.split("/"));
    const back = path.relative(this.root, abs);
    if (back.startsWith("..") || path.isAbsolute(back)) throw new ConnectorError("not-found", "That path isn't inside the server folder");
    return abs;
  }

  /** One call to the share, with a timeout and retries for errors that pass. */
  private async call<T>(what: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let last: ConnectorError | null = null;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      if (signal?.aborted) throw new ConnectorError("other", "cancelled");
      try {
        return await withTimeout(fn(), this.o.opTimeoutMs, what);
      } catch (err) {
        const mapped = mapFsError(err, what);
        last = mapped;
        const retryable = mapped.failure === "timeout" || mapped.failure === "unreachable";
        if (!retryable || attempt === this.o.retries) break;
        await sleep(this.o.retryDelayMs * 2 ** attempt, signal);
      }
    }
    throw last!;
  }

  async *list(signal: AbortSignal, onSkip?: SkipFn): AsyncIterable<RemoteFile> {
    // The root itself must be there and be a folder: this is where "drive not connected" shows up.
    const rootStat = await this.call("the server folder", () => fs.promises.stat(this.root), signal).catch((err) => {
      // A root that isn't there is a share that isn't mounted, not "a file went missing".
      if (err instanceof ConnectorError && err.failure === "not-found") throw new ConnectorError("unreachable", "the server folder wasn't found. If it's a network share, is it mounted?");
      throw err;
    });
    if (!rootStat.isDirectory()) throw new ConnectorError("config", "LOCUS_SERVER_PATH isn't a folder");

    const stack: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
    while (stack.length > 0 && !signal.aborted) {
      const { rel, depth } = stack.pop()!;
      const abs = rel === "" ? this.root : this.resolve(rel);
      let entries: fs.Dirent[];
      try {
        entries = await this.call(`folder ${rel || "/"}`, () => fs.promises.readdir(abs, { withFileTypes: true }), signal);
      } catch (err) {
        if (rel === "") throw err; // the root can't be read: nothing to index, say so
        onSkip?.({ path: rel, reason: err instanceof ConnectorError ? err.message : "unreadable", isDirectory: true });
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subfolders: Array<{ rel: string; depth: number }> = [];
      for (const e of entries) {
        if (signal.aborted) return;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (depth + 1 > this.o.maxDepth) onSkip?.({ path: childRel, reason: "folders nested too deeply", isDirectory: true });
          else subfolders.push({ rel: childRel, depth: depth + 1 });
          continue;
        }
        if (e.isSymbolicLink()) {
          // A link to a file is followed (stat below); a link to a folder isn't, so a loop can't trap the walk.
          try {
            const target = await this.call(childRel, () => fs.promises.stat(path.join(abs, e.name)), signal);
            if (target.isDirectory()) {
              onSkip?.({ path: childRel, reason: "link to a folder (not followed)", isDirectory: true });
              continue;
            }
          } catch {
            onSkip?.({ path: childRel, reason: "broken link", isDirectory: false });
            continue;
          }
        } else if (!e.isFile()) {
          continue;
        }
        try {
          const st = await this.call(childRel, () => fs.promises.stat(path.join(abs, e.name)), signal);
          yield { path: childRel, size: st.size, modifiedAt: new Date(st.mtimeMs).toISOString(), etag: null };
        } catch (err) {
          onSkip?.({ path: childRel, reason: err instanceof ConnectorError ? err.message : "unreadable", isDirectory: false });
        }
      }
      stack.push(...subfolders.reverse());
    }
  }

  async stat(rel: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    const abs = this.resolve(rel);
    try {
      const st = await this.call(rel, () => fs.promises.stat(abs), signal);
      if (!st.isFile()) return null;
      return { path: cleanRelativePath(rel)!, size: st.size, modifiedAt: new Date(st.mtimeMs).toISOString(), etag: null };
    } catch (err) {
      if (err instanceof ConnectorError && err.failure === "not-found") return null;
      throw err;
    }
  }

  async read(rel: string, signal?: AbortSignal, range?: { start: number; end: number }): Promise<Readable> {
    const abs = this.resolve(rel);
    // 'r': read-only. This is the only way Locus ever opens a file on the server.
    const handle = await this.call(rel, () => fs.promises.open(abs, "r"), signal);
    const source = handle.createReadStream({ ...(range ?? {}), autoClose: true });
    const out = new PassThrough();
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        const err = new ConnectorError("timeout", `reading ${rel} stalled for ${Math.round(this.o.idleTimeoutMs / 1000)} s`);
        source.destroy(err);
        out.destroy(err);
      }, this.o.idleTimeoutMs);
    };
    arm();
    source.on("data", arm);
    source.on("error", (err) => out.destroy(mapFsError(err, rel)));
    source.on("end", () => clearTimeout(idle));
    out.on("close", () => {
      clearTimeout(idle);
      source.destroy();
    });
    signal?.addEventListener("abort", () => out.destroy(new ConnectorError("other", "cancelled")), { once: true });
    source.pipe(out);
    return out;
  }

  async test(signal?: AbortSignal): Promise<ConnectorTestResult> {
    try {
      const st = await this.call("the server folder", () => fs.promises.stat(this.root), signal);
      if (!st.isDirectory()) return { ok: false, code: "LOCUS-SERVER-003", message: "LOCUS_SERVER_PATH exists but isn't a folder." };
      const names = await this.call("the server folder", () => fs.promises.readdir(this.root), signal);
      return { ok: true, message: `Connected. The folder is readable (${names.length} item${names.length === 1 ? "" : "s"} at the top level).`, details: { topLevelItems: names.length } };
    } catch (err) {
      const e = err instanceof ConnectorError ? err : mapFsError(err, "the server folder");
      const message =
        e.failure === "not-found"
          ? "The folder wasn't found. If it's a network share, is it mounted (and, on Windows, is the drive letter or \\\\server\\share path reachable)?"
          : e.failure === "auth"
            ? "The folder exists but this account isn't allowed to read it."
            : e.message;
      return { ok: false, code: e.failure === "not-found" ? "LOCUS-SERVER-001" : e.code, message };
    }
  }

  async close(): Promise<void> {}
}
