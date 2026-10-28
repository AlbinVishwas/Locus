"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSources, removeSource, sourceAction, type SourcesResponse, type SourceView } from "@/lib/sourcesClient";
import AddSourceDialog from "./AddSourceDialog";
import Dialog from "./Dialog";
import { storageLine, timeAgo } from "./format";

const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 30_000;

const BUSY = new Set(["scanning", "indexing", "removing"]);

export default function SourcesView() {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SourceView | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Poll quickly while anything is scanning, indexing or being removed; slowly otherwise.
  const fast = data?.sources.some((s) => BUSY.has(s.status.kind)) ?? false;
  useEffect(() => {
    let live = true;
    getSources()
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setData(r.data);
          setError(null);
        } else setError(r.data.error ?? "Couldn't load the sources.");
      })
      .catch(() => live && setError("Couldn't reach the server."));
    const timer = setTimeout(refresh, fast ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick, fast, refresh]);

  const act = async (s: SourceView, action: "pause" | "resume" | "rescan") => {
    const r = await sourceAction(s.id, action);
    if (!r.ok) setError(r.data.error ?? "That didn't work.");
    refresh();
  };

  const confirmRemove = async () => {
    const s = removing;
    setRemoving(null);
    if (!s) return;
    const r = await removeSource(s.id);
    if (!r.ok) setError(r.data.error ?? "That didn't work.");
    refresh();
  };

  const mine = data?.scope === "mine";
  const withDb = Boolean(data?.kinds?.includes("database"));
  const worker = data?.worker;
  const used = worker?.usedBytes ?? null;
  const cap = worker?.capBytes ?? data?.capBytes ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {data && mine && (
            <p className="text-[13px] text-secondary">
              Folders you add are searched only by you. The files stay where they are; Locus only reads them.
              {data.maxSources ? ` You can add up to ${data.maxSources}.` : ""}
            </p>
          )}
          {data && !mine && (
            <p className="text-[13px] text-secondary">
              {storageLine(
                { usedBytes: used, capBytes: cap, freeBytes: worker?.freeBytes ?? null, minFreeBytes: worker?.minFreeBytes ?? null },
                { capBytes: data.capBytes, minFreeBytes: data.minFreeBytes }
              )}
            </p>
          )}
          {!mine && used !== null && cap ? (
            <div className="mt-2 h-1.5 max-w-[420px] overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="Library storage used" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}>
              <div className="h-full rounded-full bg-cream" style={{ width: `${Math.min((used / cap) * 100, 100)}%` }} />
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={!data}
          className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mine && !withDb ? "+ Add folder" : "+ Add source"}
        </button>
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {data && !data.worker.running && (
          <p className="rounded-lg border border-line p-3 text-[13px] text-warm">
            {mine ? (
              "Indexing isn't running right now. Your folders are saved and will be indexed as soon as it is."
            ) : (
              <>
                Indexer not running. Start it with <code className="rounded bg-surface px-1.5 py-0.5 text-primary">npm run library:worker</code> — sources are saved, and indexing starts when it does.
              </>
            )}
          </p>
        )}
        {data?.worker.limit && (
          <p className="rounded-lg border border-line p-3 text-[13px] text-warm">
            {data.worker.limit.message} {mine ? "Nothing has been deleted; searching keeps working." : "Indexing is paused and nothing has been deleted; searching keeps working. It resumes by itself once there is room."}
          </p>
        )}
        {data && !data.connected && <p className="rounded-lg border border-line p-3 text-[13px] text-warm">The library&apos;s drive isn&apos;t connected.</p>}
        {error && <p className="text-[13px] text-red-400">{error}</p>}
      </div>

      {data === null && !error && <p className="text-[13px] text-secondary">Loading…</p>}
      {data && data.sources.length === 0 && (
        <div className="rounded-xl border border-line p-8 text-center">
          <p className="text-[13px] text-secondary">{mine ? (withDb ? "Nothing added yet. Add a folder of PDFs on this computer, or a database that lists them, to search it." : "No folders yet. Add a folder of PDFs on this computer or a connected drive to search it.") : "No sources yet. Add a folder, a database, or a Google Drive folder to search it."}</p>
          <button type="button" onClick={() => setAdding(true)} className="mt-3 cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink">
            {mine && !withDb ? "+ Add folder" : "+ Add source"}
          </button>
        </div>
      )}
      {data && data.sources.length > 0 && (
        <ul className="overflow-hidden rounded-xl border border-line" aria-label="Sources">
          {data.sources.map((s) => (
            <SourceRow key={s.id} s={s} onAct={act} onRemove={() => setRemoving(s)} />
          ))}
        </ul>
      )}

      {adding && data && (
        <AddSourceDialog
          info={data}
          kinds={mine ? data.kinds ?? ["folder"] : undefined}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {removing && (
        <Dialog title={`Remove ${removing.name}`} role="alertdialog" onClose={() => setRemoving(null)} initialFocus="[data-cancel]">
          <div className="p-5">
            <h2 className="text-[14px] font-medium text-primary">Remove &ldquo;{removing.name}&rdquo;?</h2>
            <p className="mt-2 text-[13px] text-secondary">
              This removes it from search and frees its index space
              {removing.documents > 0 ? ` (${removing.documents.toLocaleString("en-US")} documents, ${removing.pagesIndexed.toLocaleString("en-US")} pages)` : ""}. The original files are not touched.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button data-cancel type="button" onClick={() => setRemoving(null)} className="cursor-pointer rounded-lg border border-line px-3 py-2 text-[13px] text-primary hover:bg-surface-hover">
                Cancel
              </button>
              <button type="button" onClick={confirmRemove} className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink">
                Remove
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

const ICON: Record<SourceView["kind"], React.ReactNode> = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  drive: <path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7Z" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
};

function SourceRow({ s, onAct, onRemove }: { s: SourceView; onAct: (s: SourceView, a: "pause" | "resume" | "rescan") => void; onRemove: () => void }) {
  const stats = s.documents > 0 ? `${s.documents.toLocaleString("en-US")} docs · ${s.pagesIndexed.toLocaleString("en-US")} pages` : null;
  const removing = s.state === "removing";
  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0 text-secondary">
        {ICON[s.kind]}
      </svg>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-[14px] font-medium text-primary" title={s.name}>
            {s.name}
          </p>
          {s.managedBy === "env" && <span className="shrink-0 text-[11px] text-secondary">managed in .env</span>}
          {s.owner && <span className="shrink-0 text-[11px] text-secondary">added by {s.owner}</span>}
        </div>
        <p className="truncate text-[12px] text-secondary" title={s.location}>
          {s.location}
        </p>
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-[13px]">
          <p className={s.status.kind === "error" || s.status.kind === "limit" ? "text-warm" : "text-primary"}>
            {s.status.text}
            {stats && s.status.kind !== "scanning" && <span className="text-secondary"> · {stats}</span>}
          </p>
          <p className="text-[12px] text-secondary">Last scan {timeAgo(s.lastScanAt).toLowerCase()}</p>
        </div>
        {s.progress !== null && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-page" role="progressbar" aria-label={`${s.name} indexing progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progress * 100)}>
            <div className="h-full rounded-full bg-cream" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {!removing && <RowMenu s={s} onAct={onAct} onRemove={onRemove} />}
    </li>
  );
}

function RowMenu({ s, onAct, onRemove }: { s: SourceView; onAct: (s: SourceView, a: "pause" | "resume" | "rescan") => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const key = (e: React.KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item = "block w-full cursor-pointer px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-hover focus:bg-surface-hover";

  return (
    <div className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-label={`Actions for ${s.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer rounded-lg px-2 py-1 text-secondary hover:bg-surface-hover hover:text-primary"
      >
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={`${s.name} actions`} onKeyDown={key} className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
          {s.state === "paused" ? (
            <button type="button" role="menuitem" className={item} onClick={choose(() => onAct(s, "resume"))}>
              Resume
            </button>
          ) : (
            <button type="button" role="menuitem" className={item} onClick={choose(() => onAct(s, "pause"))}>
              Pause
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={choose(() => onAct(s, "rescan"))}>
            Rescan
          </button>
          {s.managedBy !== "env" && (
            <button type="button" role="menuitem" className={item} onClick={choose(onRemove)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
