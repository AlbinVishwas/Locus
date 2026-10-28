import { Readable } from "node:stream";
import { errorResponse } from "../errors/catalog";
import { logError } from "../errors/redact";
import { resolveAllowed } from "../library/allowedRoots";
import type { LibraryConfig } from "../library/config";
import type { FolderConfig } from "../library/sources/forms";
import type { RegistrySource } from "../library/sources/registry";
import { createConnector } from "./connector";
import { FolderConnector } from "./folderConnector";
import { ConnectorError, type StorageConnector } from "./types";

/**
 * Opening the original PDF from a search result. The bytes are read from where they live (the storage server,
 * or a library folder) and streamed through Locus, after the caller has been authorised. The browser is never
 * given a server address, a presigned link or a file path: it only ever sees /api/library/file?doc=<id>.
 */

/** A connector for the source a document belongs to, or null for kinds whose originals can't be served (databases, Drive). */
export function connectorForSource(entry: RegistrySource, config: LibraryConfig): StorageConnector | null {
  if (entry.kind === "server") {
    if (config.server.type === "none") return null;
    return createConnector(config.server);
  }
  if (entry.kind === "folder") {
    const cfg = entry.config as FolderConfig;
    const roots = entry.managedBy === "env" ? [cfg.path] : config.allowedRoots;
    const check = resolveAllowed(cfg.path, { roots, dataDir: config.dataDir });
    return check.ok ? new FolderConnector(check.real) : null;
  }
  return null;
}

function contentDisposition(name: string): string {
  const base = (name.split("/").pop() ?? "document.pdf").replace(/[\u0000-\u001f"\\]/g, "_");
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

/** Streams one PDF from a connector (with Range support, which PDF viewers use for large files). */
export async function streamPdf(req: Request, connector: StorageConnector, rel: string, displayName: string): Promise<Response> {
  try {
    const info = await connector.stat(rel, req.signal);
    if (!info) return errorResponse("LOCUS-SERVER-004");
    const range = parseRange(req.headers.get("range"), info.size);
    const base = {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(displayName),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (range === "invalid") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${info.size}` } });
    const stream = await connector.read(rel, req.signal, range ?? undefined);
    // The connection to the server is released when the download ends or the browser goes away.
    stream.once("close", () => void connector.close().catch(() => {}));
    const body = Readable.toWeb(stream) as unknown as ReadableStream;
    if (range) {
      return new Response(body, { status: 206, headers: { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": String(range.end - range.start + 1) } });
    }
    return new Response(body, { status: 200, headers: { ...base, "Content-Length": String(info.size) } });
  } catch (err) {
    logError("open-original", err);
    void connector.close().catch(() => {});
    if (err instanceof ConnectorError) return errorResponse(err.code);
    return errorResponse("LOCUS-APP-001");
  }
}
