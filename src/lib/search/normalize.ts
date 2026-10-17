/**
 * The one definition of "what text matches what query".
 *
 * Every party that decides whether a page contains a query goes through this
 * file: the indexer when it stores a page, the search when it prepares a
 * query, and the brute-force checker in the tests that proves the index right.
 * If any of them normalized text its own way, the index and the checker could
 * disagree about a page and neither would be "wrong" — so nobody does.
 *
 * There are three layers, each built on the one before:
 *
 *   normalizeText  what we store and show. Unicode compatibility forms folded
 *                  (the "ﬁ" ligature becomes "fi"), dash and quote variants
 *                  unified, and every run of whitespace — including line
 *                  breaks — collapsed to a single space, so a phrase broken
 *                  across two lines in the PDF still reads as one phrase.
 *   foldCase       what exact-mode search compares: normalizeText lowercased.
 *                  Punctuation is untouched, so "26-2080" never matches
 *                  "26/2080".
 *   loosen         what loose-mode search compares: foldCase with every
 *                  character that is not a letter or digit turned into a
 *                  space, so "26-2080", "26/2080" and "26 2080" are all equal.
 */

// Hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar,
// minus sign, small/fullwidth hyphen-minus. Treated as the ASCII "-" a user
// types: tender numbers are routinely typeset with an en dash, and nobody
// searching for "26-2080" means to exclude "26–2080".
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;

// Characters with no visible form: soft hyphen, zero-width space/joiners,
// byte-order mark. PDFs scatter them inside words; left in, "tender" could
// silently fail to match "ten\u00ADder".
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

// C0/C1 control characters other than ordinary whitespace. Replaced with a
// space rather than deleted, because some extractors use them as separators.
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lowercases without ever changing the string's length.
 *
 * A handful of characters grow when lowercased (Turkish "İ" becomes two code
 * units). Those few are left as they are. Keeping the length fixed means a
 * match position found in the folded text is the same position in the
 * original-case text, which is what lets the snippet highlight exactly the
 * characters that matched.
 */
export function foldCase(normalized: string): string {
  let out = "";
  for (const ch of normalized) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Letters (any script), combining marks, and digits survive loose mode. */
const KEEP_IN_LOOSE = /[\p{L}\p{M}\p{N}]/u;

/**
 * Loose-mode text, plus where each of its characters came from.
 *
 * `offsets[i]` is the index in the input of loose character `i`, so a match
 * found in loose text can be mapped back to the original for highlighting.
 * Input must already be normalized and folded.
 */
export function loosenWithOffsets(folded: string): {
  text: string;
  offsets: number[];
} {
  let text = "";
  const offsets: number[] = [];
  // Index of the first separator in the current run, or -1 if none pending.
  // The single space that replaces the run points back at it.
  let separatorAt = -1;

  for (let i = 0; i < folded.length; ) {
    const cp = folded.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);

    if (KEEP_IN_LOOSE.test(ch)) {
      if (separatorAt !== -1 && text.length > 0) {
        text += " ";
        offsets.push(separatorAt);
      }
      separatorAt = -1;
      text += ch;
      for (let k = 0; k < ch.length; k++) offsets.push(i + k);
    } else if (separatorAt === -1) {
      separatorAt = i;
    }
    i += ch.length;
  }

  return { text, offsets };
}

export function loosen(folded: string): string {
  return loosenWithOffsets(folded).text;
}

export type SearchMode = "exact" | "loose";

/** Stored/compared form of a page's text for the given mode. */
export function searchableText(text: string, mode: SearchMode): string {
  const folded = foldCase(normalizeText(text));
  return mode === "exact" ? folded : loosen(folded);
}

/** Length in characters as SQLite's trigram tokenizer counts them. */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}
