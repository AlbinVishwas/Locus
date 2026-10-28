"use client";

import { useCallback, useRef, useState } from "react";
import { getFolderLimits, planFolder, readPick, setFolderScope, sha256Hex, type FolderScope } from "@/lib/folderScope";
import { uploadFile, type UploadStageEvent } from "@/lib/uploadsClient";

/**
 * Searching a folder from the user's own device: "Choose folder" opens the
 * browser's folder picker, the PDFs in it (subfolders included) go through
 * the ordinary upload pipeline into a private session of their own, and a
 * chip then limits every search to that folder until it's dismissed.
 * Everything here is client-side orchestration; /api/folders decides which
 * files still need sending and /api/uploads does the work.
 */

/** How many files to send at once when the server doesn't say (it does: LOCUS_UPLOAD_PARALLEL). */
const DEFAULT_PARALLEL = 4;
/** Resends of a file after a dropped connection or a temporary error from a proxy; the server recognises a file it already has. */
const UPLOAD_RETRIES = 3;
/**
 * Once every file is searchable, wait this long for the scanned pages to finish before announcing the folder:
 * a small folder then arrives complete, while a big one doesn't keep the person waiting and says what's left.
 */
const PARTIAL_GRACE_MS = 8000;

export interface FolderPickState {
  busy: boolean;
  /** One line about where the pick is. */
  message: string | null;
  /** A problem the user has to act on (too many files, too big, nothing to search). */
  error: string | null;
  /** Files handled so far, out of how many need uploading. */
  progress: { done: number; total: number } | null;
  /** What each in-flight file is doing, e.g. "tender.pdf — Scanning page 2 of 5". */
  current: string[];
  /** Files that couldn't be read, with the reason. */
  failures: string[];
  /** Scanned pages still being read after the files became searchable (the "improving" phase), if any. */
  improving: { pagesDone: number; pagesTotal: number } | null;
}

const IDLE: FolderPickState = { busy: false, message: null, error: null, progress: null, current: [], failures: [], improving: null };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${Math.round(bytes / (1024 * 1024))} MB`);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stageLabel(e: UploadStageEvent): string {
  if (e.type === "ready") return "Ready";
  if (e.type === "error") return "Failed";
  // The file is searchable and its first scanned page is the one being read now.
  if (e.type === "searchable") return `Scanning page 1 of ${e.ocrPages} · searchable now`;
  if (e.stage === "running-ocr") return `Scanning page ${e.page} of ${e.totalPages}`;
  return e.stage === "uploading" ? "Uploading" : e.stage === "reading" ? "Reading" : "Indexing";
}

export function useFolderPick() {
  const [state, setState] = useState<FolderPickState>(IDLE);
  const busyRef = useRef(false);
  // Changes with every pick and every clear, so work still finishing in the background for an
  // earlier pick can tell it is no longer the current one and leave the display alone.
  const runRef = useRef(0);
  const patch = useCallback((p: Partial<FolderPickState>) => setState((s) => ({ ...s, ...p })), []);

  const clear = useCallback(() => {
    runRef.current++;
    setFolderScope(null);
    setState(IDLE);
  }, []);

  const pick = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0 || busyRef.current) return;
      const picked = readPick(list);
      if (!picked) return;
      busyRef.current = true;
      const run = ++runRef.current;
      setState({ ...IDLE, busy: true });
      const fail = (error: string) => {
        busyRef.current = false;
        setState({ ...IDLE, error });
      };
      try {
        const { name, pdfs, skipped } = picked;
        if (pdfs.length === 0) {
          return fail(`No PDFs found in “${name}” (${plural(skipped, "other file")} skipped). Pick a folder that has PDFs in it.`);
        }
        const found = `Found ${plural(pdfs.length, "PDF")}${skipped > 0 ? ` (${plural(skipped, "other file")} skipped)` : ""}`;
        patch({ message: found });

        const limits = await getFolderLimits();
        if (!limits.enabled) return fail("Uploads are turned off on this server.");
        if (pdfs.length > limits.maxFiles) {
          return fail(
            `${found}, but one pick takes at most ${limits.maxFiles}. Pick a smaller folder (or a subfolder), or ask the administrator to add this folder as a library folder, which has no such limit.`
          );
        }
        const tooBig = pdfs.filter((p) => p.file.size > limits.maxFileBytes);
        const usable = pdfs.filter((p) => p.file.size <= limits.maxFileBytes);
        const failures = tooBig.map((p) => `${p.path} — ${size(p.file.size)}, over the ${size(limits.maxFileBytes)} limit for one file`);
        if (usable.length === 0) {
          return fail(`Every PDF in “${name}” is over the ${size(limits.maxFileBytes)} limit for one file. Ask the administrator to add the folder as a library folder instead.`);
        }

        // Work out which files the server already has, by content, so a second pick uploads only what's new or changed.
        patch({ message: `${found}. Checking ${plural(usable.length, "file")}…`, failures });
        const hashed = [];
        for (const p of usable) hashed.push({ path: p.path, size: p.file.size, sha256: await sha256Hex(p.file) });
        const plan = await planFolder(name, hashed);

        const byPath = new Map(usable.map((p) => [p.path, p.file]));
        const queue = plan.upload.map((path) => ({ path, file: byPath.get(path) as File }));
        let done = 0;
        let uploaded = 0;
        const inFlight = new Map<string, string>();
        // Files whose text is searchable but whose scanned pages are still being read: path -> pages done / total.
        const improving = new Map<string, { done: number; total: number }>();
        const pages = () => {
          let pagesDone = 0;
          let pagesTotal = 0;
          for (const v of improving.values()) {
            pagesDone += v.done;
            pagesTotal += v.total;
          }
          return { pagesDone, pagesTotal };
        };
        const show = () => patch({ progress: { done, total: queue.length }, current: [...inFlight.values()] });
        patch({ message: `${found}. ${plural(plan.present, "file")} already indexed, ${plural(queue.length, "file")} to upload.`, progress: { done: 0, total: queue.length } });

        const finishing: Promise<void>[] = [];
        const next = [...queue];
        const worker = async () => {
          for (let item = next.shift(); item; item = next.shift()) {
            const { path, file } = item;
            inFlight.set(path, `${path} — Uploading`);
            show();
            let release: () => void = () => {};
            const slot = new Promise<void>((resolve) => (release = resolve));
            let counted = false;
            // A file is handled once it is searchable (or failed); its scanned pages carry on in the
            // background, and the next file doesn't wait for them.
            const count = (ok: boolean, why?: string) => {
              if (counted) return;
              counted = true;
              done++;
              if (ok) uploaded++;
              else failures.push(`${path} — ${why ?? "the upload was interrupted"}`);
              release();
            };
            finishing.push(
              uploadFile(
                plan.conversationId,
                file,
                (e) => {
                  inFlight.set(path, `${path} — ${stageLabel(e)}`);
                  if (e.type === "searchable") improving.set(path, { done: 0, total: e.ocrPages });
                  else if (e.type === "stage" && e.stage === "running-ocr") improving.set(path, { done: e.page, total: e.totalPages });
                  if (e.type === "searchable" || e.type === "ready") count(true);
                  else if (e.type === "error") count(false, e.message);
                  show();
                  if (runRef.current === run && !busyRef.current) showImproving();
                },
                undefined,
                path,
                UPLOAD_RETRIES
              )
                .catch((err) => count(false, err instanceof Error ? err.message : "Upload failed"))
                .finally(() => {
                  count(false);
                  improving.delete(path);
                  inFlight.delete(path);
                  show();
                  if (runRef.current === run && !busyRef.current) showImproving();
                })
            );
            await slot;
          }
        };

        // After the scope is set: what is still being read, then "Ready" once it is all done.
        let readyMessage = "";
        const showImproving = () => {
          const { pagesDone, pagesTotal } = pages();
          if (improving.size === 0) {
            patch({ message: readyMessage, improving: null, current: [], progress: queue.length > 0 ? { done: queue.length, total: queue.length } : null });
          } else {
            patch({
              message: `Searchable now · improving ${plural(pagesTotal - pagesDone, "scanned page")}. ${readyMessage.replace(/^Ready — /, "")}`,
              improving: { pagesDone, pagesTotal },
              current: [],
              progress: null,
            });
          }
        };

        await Promise.all(Array.from({ length: Math.min(limits.uploadParallel ?? DEFAULT_PARALLEL, next.length) }, worker));

        const files = plan.present + uploaded;
        if (files === 0) {
          await Promise.allSettled(finishing);
          return fail(`None of the PDFs in “${name}” could be read. ${failures[0] ?? ""}`.trim());
        }

        // Every file is searchable. A short wait lets a small folder's scanned pages finish first.
        if (improving.size > 0) {
          const { pagesTotal, pagesDone } = pages();
          patch({ message: `${plural(files, "file")} searchable. Reading ${plural(pagesTotal - pagesDone, "scanned page")}…` });
          await Promise.race([Promise.allSettled(finishing), sleep(PARTIAL_GRACE_MS)]);
        }
        if (runRef.current !== run) return;

        readyMessage = `Ready — ${plural(files, "file")} (${uploaded} uploaded, ${plan.present} already indexed${plan.removed > 0 ? `, ${plural(plan.removed, "old file")} removed` : ""}).`;
        const scope: FolderScope = { name, files, conversationId: plan.conversationId };
        setFolderScope(scope);
        busyRef.current = false;
        setState({ ...IDLE, message: readyMessage, progress: queue.length > 0 ? { done: queue.length, total: queue.length } : null, failures });
        showImproving();
      } catch (err) {
        fail(err instanceof Error && err.message ? err.message : "Couldn't read that folder.");
      }
    },
    [patch]
  );

  return { state, pick, clear };
}

export type FolderPick = ReturnType<typeof useFolderPick>;

/**
 * The "Choose folder" chip, in the same style as "Upload documents" and "Find a phrase".
 *
 * The folder input is made when the button is clicked (a folder chooser is a file input with
 * `webkitdirectory`, which every current browser supports), rather than sitting in the page
 * beside the ordinary attach input.
 */
export function FolderPill({ folder }: { folder: FolderPick }) {
  // Held here until its change event fires, so the browser can't collect it while the chooser is open.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const open = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.addEventListener("change", () => {
      void folder.pick(input.files);
      inputRef.current = null;
    });
    input.addEventListener("cancel", () => {
      inputRef.current = null;
    });
    inputRef.current = input;
    input.click();
  };
  return (
    <button
      type="button"
      disabled={folder.state.busy}
      onClick={open}
      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-secondary hover:border-composer-line hover:text-primary disabled:cursor-wait disabled:opacity-60"
    >
      <FolderIcon />
      Choose folder
    </button>
  );
}

/** The active-folder chip and the pick's progress, above the search box. Nothing at all when neither applies. */
export function FolderStatus({ folder, active }: { folder: FolderPick; active: FolderScope | null }) {
  const { state } = folder;
  const showPanel = state.busy || state.error || state.message || state.failures.length > 0;
  if (!active && !showPanel) return null;
  const pct = state.progress && state.progress.total > 0 ? Math.round((state.progress.done / state.progress.total) * 100) : null;
  return (
    <div className="mb-3 flex flex-col items-center gap-2 px-1" data-testid="folder-status">
      {active && (
        <span className="flex max-w-full items-center gap-1.5 rounded-full border border-composer-line px-3 py-1.5 text-[13px] text-primary" data-testid="folder-chip">
          <FolderIcon />
          <span className="min-w-0 truncate">
            Searching: {active.name} · {active.files.toLocaleString("en-US")} {active.files === 1 ? "file" : "files"}
          </span>
          <button type="button" onClick={folder.clear} aria-label="Stop searching this folder" title="Back to searching my uploads" className="-mr-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-secondary hover:bg-surface-hover hover:text-primary">
            ×
          </button>
        </span>
      )}
      {state.error ? (
        <p role="alert" className="max-w-full break-words text-center text-[13px] text-warm" data-testid="folder-error">
          {state.error}
        </p>
      ) : (
        showPanel && (
          <div className="w-full max-w-full text-center text-[12px] text-secondary" data-testid="folder-progress" aria-live="polite">
            {state.message && <p className="break-words">{state.message}</p>}
            {pct !== null && state.busy && (
              <div className="mx-auto mt-1.5 h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Folder upload progress">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
            {state.improving && state.improving.pagesTotal > 0 && (
              <div className="mx-auto mt-1.5 h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round((state.improving.pagesDone / state.improving.pagesTotal) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Scanned pages being read">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((state.improving.pagesDone / state.improving.pagesTotal) * 100)}%` }} />
              </div>
            )}
            {state.progress && state.busy && state.progress.total > 0 && (
              <p className="mt-1">
                {state.progress.done} of {state.progress.total} uploaded
              </p>
            )}
            {state.current.map((c) => (
              <p key={c} className="mx-auto max-w-full truncate">
                {c}
              </p>
            ))}
            {state.failures.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer">{plural(state.failures.length, "file")} not added</summary>
                {state.failures.map((f) => (
                  <p key={f} className="break-words">
                    {f}
                  </p>
                ))}
              </details>
            )}
          </div>
        )
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}
