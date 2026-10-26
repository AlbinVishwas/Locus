import type { Conversation } from "./types";

const STORAGE_KEY = "chat-conversations";

/** With named accounts each person's sessions are kept under their own key, so two people on one browser never see each other's. No user: the key the app has always used. */
function keyFor(userId?: number): string {
  return userId === undefined ? STORAGE_KEY : `${STORAGE_KEY}:${userId}`;
}

/**
 * Only ever call this from inside a useEffect (never during render) — the
 * App Router server-renders and does a first client hydration pass before
 * any effect runs, so touching localStorage during render would make that
 * pass diverge from what the server sent and throw a hydration mismatch.
 */
export function loadConversations(userId?: number): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation);
  } catch {
    // Corrupt JSON, or storage inaccessible (e.g. Safari private mode) —
    // treat it as "nothing saved" rather than crashing the app.
    return [];
  }
}

export function saveConversations(conversations: Conversation[], userId?: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(conversations));
  } catch {
    // Quota exceeded or storage unavailable — drop the write silently;
    // this runs from a debounced effect, not user-initiated, so there's
    // no good place to surface it.
  }
}

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.messages) &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}
