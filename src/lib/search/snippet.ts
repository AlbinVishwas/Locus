import { foldCase, loosenWithOffsets, type SearchMode } from "./normalize";

/**
 * A snippet is a list of plain-text pieces, some flagged as matches. It is
 * never HTML: the page renders `hit` pieces inside <mark>, and React escapes
 * the text, so nothing inside a PDF can inject markup into the page.
 */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

const CONTEXT_CHARS = 90;

/** Every [start, end) range in `haystack` where `needle` occurs. */
function findAll(haystack: string, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!needle) return ranges;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    ranges.push([at, at + needle.length]);
    from = at + 1;
  }
  return ranges;
}

/**
 * Match ranges in `body` (normalized, original case) for an already-prepared
 * query. Exact mode can search the folded text directly, because folding
 * keeps every character in place. Loose mode searches the loosened text and
 * maps each match back through the offsets table.
 */
export function matchRanges(
  body: string,
  preparedQuery: string,
  mode: SearchMode
): Array<[number, number]> {
  const folded = foldCase(body);
  if (mode === "exact") return findAll(folded, preparedQuery);

  const { text, offsets } = loosenWithOffsets(folded);
  return findAll(text, preparedQuery).map(([s, e]) => [
    offsets[s],
    offsets[e - 1] + 1,
  ]);
}

/**
 * A short window of `body` around the first match, with every match inside
 * the window flagged. Overlapping matches (searching "aa" in "aaa") are
 * merged so the highlighting never splits or doubles characters.
 */
export function buildSnippet(
  body: string,
  preparedQuery: string,
  mode: SearchMode
): SnippetPart[] {
  const ranges = matchRanges(body, preparedQuery, mode);
  if (ranges.length === 0) {
    return [{ text: body.slice(0, CONTEXT_CHARS * 2), hit: false }];
  }

  const [firstStart, firstEnd] = ranges[0];
  let start = Math.max(0, firstStart - CONTEXT_CHARS);
  let end = Math.min(body.length, firstEnd + CONTEXT_CHARS);

  // Nudge the edges out to the nearest space so the window doesn't begin or
  // end mid-word. Bounded, so one enormous "word" can't swallow the page.
  const spaceBefore = body.lastIndexOf(" ", start);
  if (start > 0 && spaceBefore !== -1 && start - spaceBefore < 20) start = spaceBefore + 1;
  const spaceAfter = body.indexOf(" ", end);
  if (end < body.length && spaceAfter !== -1 && spaceAfter - end < 20) end = spaceAfter;

  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    if (e <= start || s >= end) continue;
    const cs = Math.max(s, start);
    const ce = Math.min(e, end);
    const last = merged[merged.length - 1];
    if (last && cs <= last[1]) last[1] = Math.max(last[1], ce);
    else merged.push([cs, ce]);
  }

  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: "…", hit: false });
  let cursor = start;
  for (const [s, e] of merged) {
    if (s > cursor) parts.push({ text: body.slice(cursor, s), hit: false });
    parts.push({ text: body.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < end) parts.push({ text: body.slice(cursor, end), hit: false });
  if (end < body.length) parts.push({ text: "…", hit: false });
  return parts;
}
