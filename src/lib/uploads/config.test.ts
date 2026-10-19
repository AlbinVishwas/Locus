import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetEnvWarningsForTests } from "../env";
import {
  maxFilesPerConversation,
  maxUploadFileBytes,
  retentionDays,
  retentionMs,
  storageCapBytes,
  uploadsEnabled,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
  _resetEnvWarningsForTests();
  delete process.env.MAX_UPLOAD_FILE_BYTES;
  delete process.env.MAX_FILES_PER_CONVERSATION;
  delete process.env.STORAGE_CAP_BYTES;
  delete process.env.LOCUS_RETENTION_DAYS;
});

describe("uploadsEnabled", () => {
  it("is enabled outside production by default", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(uploadsEnabled()).toBe(true);
  });

  it("fails closed in production without the flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCUS_ENABLE_UPLOADS", "");
    expect(uploadsEnabled()).toBe(false);
  });

  it("is enabled in production once the flag is explicitly set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCUS_ENABLE_UPLOADS", "true");
    expect(uploadsEnabled()).toBe(true);
  });

  it("falls back to the deprecated ASSAY_ENABLE_UPLOADS name, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ASSAY_ENABLE_UPLOADS", "true");
    expect(uploadsEnabled()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ASSAY_ENABLE_UPLOADS is deprecated"));
    warn.mockRestore();
  });
});

describe("env-configurable limits", () => {
  it("use sensible defaults when unset", () => {
    expect(maxUploadFileBytes()).toBeGreaterThan(0);
    expect(maxFilesPerConversation()).toBeGreaterThan(0);
    expect(storageCapBytes()).toBeGreaterThan(0);
  });

  it("respect an override", () => {
    process.env.MAX_FILES_PER_CONVERSATION = "3";
    expect(maxFilesPerConversation()).toBe(3);
  });
});

describe("retentionDays / retentionMs", () => {
  it("is off (null) by default -- files don't expire unless explicitly configured", () => {
    expect(retentionDays()).toBeNull();
    expect(retentionMs()).toBeNull();
  });

  it("returns the configured number of days, and the matching millisecond value", () => {
    process.env.LOCUS_RETENTION_DAYS = "14";
    expect(retentionDays()).toBe(14);
    expect(retentionMs()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("rejects a non-positive override rather than silently ignoring it", () => {
    process.env.LOCUS_RETENTION_DAYS = "-1";
    expect(() => retentionDays()).toThrow();
  });

  it("rejects a non-numeric override", () => {
    process.env.LOCUS_RETENTION_DAYS = "forever";
    expect(() => retentionDays()).toThrow();
  });
});
