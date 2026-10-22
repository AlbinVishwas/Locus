import { afterEach, describe, expect, it } from "vitest";
import { features, isChatEnabled } from "./features";

afterEach(() => {
  delete process.env.LOCUS_CHAT_ENABLED;
});

describe("isChatEnabled", () => {
  it("defaults to off", () => {
    expect(features.chatEnabled).toBe(false);
    expect(isChatEnabled()).toBe(false);
  });

  it("is turned on by LOCUS_CHAT_ENABLED=true (or 1), any case", () => {
    for (const value of ["true", "TRUE", " true ", "1"]) {
      process.env.LOCUS_CHAT_ENABLED = value;
      expect(isChatEnabled()).toBe(true);
    }
  });

  it("stays off for false, 0, empty, or anything unrecognised", () => {
    for (const value of ["false", "0", "", "yes", "on"]) {
      process.env.LOCUS_CHAT_ENABLED = value;
      expect(isChatEnabled()).toBe(false);
    }
  });
});
