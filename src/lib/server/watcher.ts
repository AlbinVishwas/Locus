import fs from "node:fs";

/**
 * Notices changes in a local or mounted server folder so a sync can start sooner than the next timed one. It is
 * only a hint: network shares often miss events (and some systems can't watch a folder tree at all), so the
 * periodic scan (LOCUS_SYNC_INTERVAL_MIN) always runs as well and is what keeps the index right.
 *
 * Bursts are collapsed: a sync is requested once the folder has been quiet for `quietMs` (a big copy in progress
 * keeps resetting it), and never more often than `minGapMs`.
 */
export interface WatcherOptions {
  onChange: () => void;
  quietMs?: number;
  minGapMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Test hook: the function that starts watching. */
  watch?: typeof fs.watch;
}

export function startFolderWatcher(root: string, o: WatcherOptions): () => void {
  const quietMs = o.quietMs ?? 10_000;
  const minGapMs = o.minGapMs ?? 60_000;
  const now = o.now ?? Date.now;
  const watch = o.watch ?? fs.watch;
  let timer: NodeJS.Timeout | null = null;
  let last = -Infinity; // the first sync request is never held back
  let watcher: fs.FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
      if (name !== null && name !== undefined && !/\.pdf$/i.test(String(name)) && String(name).includes(".")) return; // other file types don't matter
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          const wait = last + minGapMs - now();
          if (wait > 0) {
            timer = setTimeout(() => {
              timer = null;
              last = now();
              o.onChange();
            }, wait);
            return;
          }
          last = now();
          o.onChange();
        },
        quietMs
      );
    });
  } catch (err) {
    o.log?.(`Not watching the server folder for changes (${err instanceof Error ? err.message : err}); the timed scan still keeps the index up to date.`);
    return () => {};
  }
  watcher.on("error", (err) => o.log?.(`The folder watcher stopped (${err.message}); the timed scan still keeps the index up to date.`));
  o.log?.("Watching the server folder for changes (the timed scan runs as well).");
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
