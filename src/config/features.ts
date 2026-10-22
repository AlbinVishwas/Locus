/**
 * Feature switches -- the one place a whole product mode gets turned on or
 * off. Server-side only (reads process.env); the browser gets the resolved
 * values from the root layout through FeaturesProvider, never by reading
 * this file itself.
 *
 * Imported by scripts/share.ts too, so this file stays free of "@/..."
 * imports and anything Next-specific.
 */

export const features = {
  /**
   * Model replies over LM Studio: /api/chat, /api/title, URL reading, the
   * Thinking/Writing stages, the model pill and chat wording. Off means
   * Locus is a document search tool: every message is a search over that
   * session's files and nothing ever reaches /api/chat or LM Studio.
   *
   * Override without editing code: LOCUS_CHAT_ENABLED=true (or false).
   */
  chatEnabled: false,
};

/** `features.chatEnabled`, unless LOCUS_CHAT_ENABLED says otherwise. Read per call, so a restart with a new env value is all it takes to flip it. */
export function isChatEnabled(): boolean {
  const raw = process.env.LOCUS_CHAT_ENABLED?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return features.chatEnabled;
}

export const CHAT_DISABLED_MESSAGE =
  "Chat is disabled: Locus is running as a document search tool. Set LOCUS_CHAT_ENABLED=true and restart to turn model replies back on.";
