"use client";

import { useEffect, useState } from "react";

/**
 * Cycles through a few words for an active stage that has no finer detail
 * to show (e.g. "Reading" / "Scanning" / "Skimming" while a file's text
 * layer is being read) — cosmetic variety for something that actually is
 * happening, not a second, fake indicator. A stage with real progress to
 * report (OCR's "page N of M") shows that instead of cycling.
 *
 * `words.length <= 1` renders the single word statically rather than
 * starting a timer that would just keep re-rendering the same text.
 */
export function useCyclingWord(words: string[], intervalMs = 1400): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (words.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), intervalMs);
    return () => clearInterval(id);
    // Re-started whenever the word set itself changes (a new stage
    // started); not resetting `index` to 0 here is deliberate -- the
    // modulo below keeps it in bounds for any word count, and a fresh
    // stage starting mid-cycle is a harmless cosmetic detail, not worth a
    // setState-in-effect to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words.join("|"), intervalMs]);

  return words[index % words.length] ?? "";
}
