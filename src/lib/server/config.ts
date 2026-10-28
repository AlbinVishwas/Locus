import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The storage server, from .env.local. LOCUS_SERVER_TYPE is folder, s3 or none (the default: nothing is
 * connected and Locus behaves as before). Secrets are read here and nowhere logged; `describeServer` is the one
 * place that turns a config into text for people, and it never includes them.
 */

type Env = Record<string, string | undefined>;

export type ServerConfig =
  | { type: "none" }
  | { type: "folder"; path: string; syncIntervalMin: number }
  | {
      type: "s3";
      endpoint: string | null;
      region: string;
      bucket: string;
      prefix: string;
      accessKey: string;
      secretKey: string;
      forcePathStyle: boolean;
      syncIntervalMin: number;
    };

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

const flag = (v: string | undefined) => ["true", "1", "yes"].includes(v?.trim().toLowerCase() ?? "");

export const DEFAULT_SYNC_INTERVAL_MIN = 10;

export function syncIntervalMin(env: Env = process.env): number {
  const raw = env.LOCUS_SYNC_INTERVAL_MIN?.trim();
  if (!raw) return DEFAULT_SYNC_INTERVAL_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ServerConfigError(`LOCUS_SYNC_INTERVAL_MIN must be a positive number of minutes, got "${raw}".`);
  return n;
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const type = (env.LOCUS_SERVER_TYPE ?? "none").trim().toLowerCase();
  if (type === "" || type === "none") return { type: "none" };
  const interval = syncIntervalMin(env);
  if (type === "folder") {
    const p = env.LOCUS_SERVER_PATH?.trim();
    if (!p) throw new ServerConfigError("LOCUS_SERVER_TYPE=folder needs LOCUS_SERVER_PATH (the folder, mounted share or UNC path that holds the PDFs).");
    if (!isAbsolutePath(p)) throw new ServerConfigError(`LOCUS_SERVER_PATH must be an absolute path, got "${p}".`);
    return { type: "folder", path: p, syncIntervalMin: interval };
  }
  if (type === "s3") {
    const missing = (["LOCUS_SERVER_S3_BUCKET", "LOCUS_SERVER_S3_ACCESS_KEY", "LOCUS_SERVER_S3_SECRET_KEY"] as const).filter((k) => !env[k]?.trim());
    if (missing.length) throw new ServerConfigError(`LOCUS_SERVER_TYPE=s3 needs ${missing.join(", ")}.`);
    const endpoint = env.LOCUS_SERVER_S3_ENDPOINT?.trim() || null;
    if (endpoint && !/^https?:\/\/[^/\s]+/i.test(endpoint)) throw new ServerConfigError(`LOCUS_SERVER_S3_ENDPOINT must start with http:// or https://, got "${endpoint}".`);
    const prefix = (env.LOCUS_SERVER_S3_PREFIX ?? "").trim().replace(/^\/+/, "");
    return {
      type: "s3",
      endpoint,
      region: env.LOCUS_SERVER_S3_REGION?.trim() || "us-east-1",
      bucket: env.LOCUS_SERVER_S3_BUCKET!.trim(),
      prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
      accessKey: env.LOCUS_SERVER_S3_ACCESS_KEY!.trim(),
      secretKey: env.LOCUS_SERVER_S3_SECRET_KEY!.trim(),
      // A custom endpoint (MinIO and friends) almost always needs path-style; AWS itself doesn't.
      forcePathStyle: env.LOCUS_SERVER_S3_FORCE_PATH_STYLE === undefined ? endpoint !== null : flag(env.LOCUS_SERVER_S3_FORCE_PATH_STYLE),
      syncIntervalMin: interval,
    };
  }
  throw new ServerConfigError(`LOCUS_SERVER_TYPE must be folder, s3 or none, got "${type}".`);
}

/** Absolute on any OS: /mnt/x, C:\x, \\server\share. (path.isAbsolute only knows the current OS's idea.) */
export function isAbsolutePath(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** One line for people. No secrets. */
export function describeServer(cfg: ServerConfig): string {
  switch (cfg.type) {
    case "none":
      return "No storage server is connected";
    case "folder":
      return `Folder ${cfg.path}`;
    case "s3": {
      const host = cfg.endpoint ? cfg.endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "") : `AWS S3 (${cfg.region})`;
      return `S3 bucket ${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""} on ${host}`;
    }
  }
}

/** Changes whenever the place being indexed changes (never when only a secret does), so a different server is treated as new. */
export function serverFingerprint(cfg: ServerConfig): string {
  const key = cfg.type === "folder" ? ["folder", cfg.path] : cfg.type === "s3" ? ["s3", cfg.endpoint ?? "", cfg.region, cfg.bucket, cfg.prefix] : ["none"];
  return createHash("sha1").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}
