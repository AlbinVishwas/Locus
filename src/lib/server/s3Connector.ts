import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { redact } from "../errors/redact";
import { cleanRelativePath, ConnectorError, type ConnectorTestResult, type RemoteFile, type SkipFn, type StorageConnector } from "./types";
import type { ServerConfig } from "./config";

/**
 * Any S3-compatible server: MinIO, AWS S3, Cloudflare R2, Ceph, Backblaze B2... Read-only by construction: only
 * ListObjectsV2, HeadObject and GetObject are ever called, so even a key that has write access is never used
 * to write. Files are streamed; nothing is kept. Change detection uses the object's ETag and LastModified.
 */

type S3Config = Extract<ServerConfig, { type: "s3" }>;

export interface S3ConnectorOptions {
  /** Per request: connect and then wait for the response. */
  requestTimeoutMs?: number;
  /** The SDK's own retries (with backoff) for throttling, 5xx and connection resets. */
  maxAttempts?: number;
}

/** What the SDK throws, reduced to the connector's kinds. The raw SDK message can hold request details, so it's redacted before use. */
export function mapS3Error(err: unknown, what: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = err as { name?: string; code?: string; Code?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  const name = e.name ?? e.Code ?? e.code ?? "";
  const status = e.$metadata?.httpStatusCode;
  const code = String(e.code ?? "");
  if (name === "NoSuchKey" || name === "NotFound" || status === 404 && name !== "NoSuchBucket") return new ConnectorError("not-found", `${what}: not found`);
  if (name === "NoSuchBucket") return new ConnectorError("config", `The bucket doesn't exist on this server (${what}).`);
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "InvalidToken", "ExpiredToken", "AllAccessDisabled"].includes(name) || status === 401 || status === 403) {
    return new ConnectorError("auth", `${what}: the server refused the access key and secret (or they can't read this bucket)`);
  }
  if (name === "TimeoutError" || code === "ETIMEDOUT" || name === "RequestTimeout") return new ConnectorError("timeout", `${what}: the server took too long to answer`);
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code) || name === "UnknownEndpoint") {
    return new ConnectorError("unreachable", `${what}: couldn't connect to the server (${code || name})`);
  }
  return new ConnectorError("other", `${what}: ${redact(e.message ?? name ?? "unknown error")}`);
}

export class S3Connector implements StorageConnector {
  readonly type = "s3" as const;
  readonly label: string;
  private readonly client: S3Client;

  constructor(
    private readonly cfg: S3Config,
    options: S3ConnectorOptions = {}
  ) {
    const host = cfg.endpoint ? cfg.endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "") : `AWS S3 (${cfg.region})`;
    this.label = `s3 bucket ${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""} on ${host}`;
    const timeout = options.requestTimeoutMs ?? 30_000;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      maxAttempts: options.maxAttempts ?? 4,
      requestHandler: new NodeHttpHandler({ connectionTimeout: timeout, requestTimeout: timeout, throwOnRequestTimeout: true }),
    });
  }

  private key(rel: string): string {
    const clean = cleanRelativePath(rel);
    if (clean === null) throw new ConnectorError("not-found", "That path isn't valid");
    return this.cfg.prefix + clean;
  }

  async *list(signal: AbortSignal, onSkip?: SkipFn): AsyncIterable<RemoteFile> {
    let token: string | undefined;
    do {
      let page;
      try {
        page = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.cfg.prefix || undefined, ContinuationToken: token }), { abortSignal: signal });
      } catch (err) {
        throw mapS3Error(err, "listing the bucket");
      }
      for (const o of page.Contents ?? []) {
        if (!o.Key || o.Key.endsWith("/")) continue; // "folder" placeholder objects
        const rel = o.Key.slice(this.cfg.prefix.length);
        const clean = cleanRelativePath(rel);
        if (clean === null) {
          onSkip?.({ path: rel, reason: "a name Locus can't use (empty or '..' segments)", isDirectory: false });
          continue;
        }
        yield { path: clean, size: o.Size ?? 0, modifiedAt: (o.LastModified ?? new Date(0)).toISOString(), etag: o.ETag ? o.ETag.replace(/"/g, "") : null };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && !signal.aborted);
  }

  async stat(rel: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    const key = this.key(rel); // an invalid path is an error, not "not there"
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { abortSignal: signal });
      return { path: cleanRelativePath(rel)!, size: r.ContentLength ?? 0, modifiedAt: (r.LastModified ?? new Date(0)).toISOString(), etag: r.ETag ? r.ETag.replace(/"/g, "") : null };
    } catch (err) {
      const mapped = mapS3Error(err, rel);
      if (mapped.failure === "not-found") return null;
      throw mapped;
    }
  }

  async read(rel: string, signal?: AbortSignal, range?: { start: number; end: number }): Promise<Readable> {
    const key = this.key(rel);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: signal });
      if (!r.Body) throw new ConnectorError("other", `${rel}: the server sent an empty response`);
      const body = r.Body as unknown as Readable;
      body.on("error", () => {});
      return body;
    } catch (err) {
      throw mapS3Error(err, rel);
    }
  }

  async test(signal?: AbortSignal): Promise<ConnectorTestResult> {
    try {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.cfg.prefix || undefined, MaxKeys: 50 }), { abortSignal: signal });
      const pdfs = (page.Contents ?? []).filter((o) => o.Key?.toLowerCase().endsWith(".pdf")).length;
      return {
        ok: true,
        message: `Connected. The bucket is readable${page.KeyCount ? ` (the first look found ${page.KeyCount} object${page.KeyCount === 1 ? "" : "s"}, ${pdfs} PDF${pdfs === 1 ? "" : "s"})` : " (it is empty)"}.`,
        details: { objectsSeen: page.KeyCount ?? 0, pdfsSeen: pdfs },
      };
    } catch (err) {
      const e = mapS3Error(err, "the server");
      return { ok: false, code: e.code, message: e.message };
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
