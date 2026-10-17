import type { SearchMode } from "./normalize";

export const MAX_QUERY_CHARS = 500;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_OFFSET = 1_000_000;
/** Bodies larger than this are refused before they are parsed. */
export const MAX_BODY_BYTES = 8_192;

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  offset: number;
  limit: number;
}

type ValidationResult = { ok: true; request: SearchRequest } | { ok: false; error: string };

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates the untrusted body of a /api/search request, in the same shape
 * as validateChatRequest. Only checks types and sizes; what the query means
 * is search's business, and it treats the text purely as data.
 */
export function validateSearchRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const { query, mode, offset, limit } = body as Record<string, unknown>;

  if (typeof query !== "string") {
    return { ok: false, error: "`query` must be a string" };
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `\`query\` is limited to ${MAX_QUERY_CHARS} characters` };
  }
  if (query.trim() === "") {
    return { ok: false, error: "`query` must contain some text" };
  }

  if (mode !== undefined && mode !== "exact" && mode !== "loose") {
    return { ok: false, error: '`mode` must be "exact" or "loose"' };
  }

  if (offset !== undefined && !isIntegerIn(offset, 0, MAX_OFFSET)) {
    return { ok: false, error: `\`offset\` must be an integer from 0 to ${MAX_OFFSET}` };
  }

  if (limit !== undefined && !isIntegerIn(limit, 1, MAX_LIMIT)) {
    return { ok: false, error: `\`limit\` must be an integer from 1 to ${MAX_LIMIT}` };
  }

  return {
    ok: true,
    request: {
      query,
      mode: mode ?? "exact",
      offset: offset ?? 0,
      limit: limit ?? DEFAULT_LIMIT,
    },
  };
}
