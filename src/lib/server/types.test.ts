import { describe, expect, it } from "vitest";
import { cleanRelativePath } from "./types";
import { describeServer, isAbsolutePath, loadServerConfig, serverFingerprint, ServerConfigError } from "./config";

describe("relative paths (the same rules on every operating system)", () => {
  it("accepts ordinary paths and turns backslashes into /", () => {
    expect(cleanRelativePath("a/b/c.pdf")).toBe("a/b/c.pdf");
    expect(cleanRelativePath("tenders\\2025\\x.pdf")).toBe("tenders/2025/x.pdf");
  });
  it("refuses anything that could leave the server folder", () => {
    for (const bad of ["../x.pdf", "a/../../x.pdf", "/etc/passwd", "C:\\Windows\\x.pdf", "c:/x.pdf", "\\\\server\\share\\x.pdf", "a//b.pdf", "a/./b.pdf", "", "a\0b.pdf"]) {
      expect(cleanRelativePath(bad), bad).toBeNull();
    }
  });
});

describe("server settings", () => {
  it("none by default", () => expect(loadServerConfig({})).toEqual({ type: "none" }));

  it("folder: accepts POSIX, drive-letter and UNC paths", () => {
    for (const p of ["/mnt/tenders", "/Volumes/tenders", "Z:\\tenders", "C:/data/tenders", "\\\\nas01\\share\\tenders"]) {
      expect(isAbsolutePath(p), p).toBe(true);
      expect(loadServerConfig({ LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: p })).toMatchObject({ type: "folder", path: p, syncIntervalMin: 10 });
    }
  });

  it("says exactly which setting is missing", () => {
    expect(() => loadServerConfig({ LOCUS_SERVER_TYPE: "folder" })).toThrow(/LOCUS_SERVER_PATH/);
    expect(() => loadServerConfig({ LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: "tenders" })).toThrow(/absolute/);
    expect(() => loadServerConfig({ LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_BUCKET: "b" })).toThrow(/LOCUS_SERVER_S3_ACCESS_KEY, LOCUS_SERVER_S3_SECRET_KEY/);
    expect(() => loadServerConfig({ LOCUS_SERVER_TYPE: "ftp" })).toThrow(ServerConfigError);
    expect(() => loadServerConfig({ LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: "/x", LOCUS_SYNC_INTERVAL_MIN: "0" })).toThrow(/LOCUS_SYNC_INTERVAL_MIN/);
  });

  it("s3: defaults, path style follows the endpoint, prefix is normalised", () => {
    const env = { LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_BUCKET: "b", LOCUS_SERVER_S3_ACCESS_KEY: "AK", LOCUS_SERVER_S3_SECRET_KEY: "SK" };
    expect(loadServerConfig(env)).toMatchObject({ endpoint: null, region: "us-east-1", prefix: "", forcePathStyle: false });
    expect(loadServerConfig({ ...env, LOCUS_SERVER_S3_ENDPOINT: "http://minio:9000", LOCUS_SERVER_S3_PREFIX: "/tenders/2025" })).toMatchObject({ forcePathStyle: true, prefix: "tenders/2025/" });
    expect(loadServerConfig({ ...env, LOCUS_SERVER_S3_ENDPOINT: "http://minio:9000", LOCUS_SERVER_S3_FORCE_PATH_STYLE: "false" })).toMatchObject({ forcePathStyle: false });
    expect(() => loadServerConfig({ ...env, LOCUS_SERVER_S3_ENDPOINT: "minio:9000" })).toThrow(/http/);
  });

  it("the description and fingerprint never contain a secret, and the fingerprint ignores secrets", () => {
    const env = { LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_BUCKET: "tenders", LOCUS_SERVER_S3_ENDPOINT: "https://minio.corp:9000", LOCUS_SERVER_S3_ACCESS_KEY: "AKIAVERYSECRETKEY", LOCUS_SERVER_S3_SECRET_KEY: "s3cr3t-value-123" };
    const cfg = loadServerConfig(env);
    expect(describeServer(cfg)).toBe("S3 bucket tenders on minio.corp:9000");
    expect(describeServer(cfg)).not.toMatch(/AKIA|s3cr3t/);
    expect(serverFingerprint(cfg)).toBe(serverFingerprint(loadServerConfig({ ...env, LOCUS_SERVER_S3_SECRET_KEY: "another" })));
    expect(serverFingerprint(cfg)).not.toBe(serverFingerprint(loadServerConfig({ ...env, LOCUS_SERVER_S3_BUCKET: "other" })));
  });
});
