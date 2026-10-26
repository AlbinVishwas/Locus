"use client";

import { useEffect, useState } from "react";
import { browseFolder, type BrowseResponse } from "@/lib/sourcesClient";
import Dialog from "./Dialog";

/**
 * Locus's own folder picker. The browser never sees the real file system:
 * every level comes from the server, which only lists folders inside the
 * allowed locations and never above them.
 */
export default function FolderBrowser({ start, onPick, onClose }: { start: string | null; onPick: (path: string) => void; onClose: () => void }) {
  const [at, setAt] = useState<string | null>(start);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    browseFolder(at)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setData(r.data);
          setError(null);
        } else if (at !== null) {
          // The remembered place is gone or not allowed: start over from the allowed locations.
          setAt(null);
        } else setError(r.data.error ?? "Couldn't list folders.");
      })
      .catch(() => live && setError("Couldn't list folders."));
    return () => {
      live = false;
    };
  }, [at]);

  const row = "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-hover disabled:cursor-default disabled:opacity-50";
  return (
    <Dialog title="Choose a folder" onClose={onClose} wide>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-medium text-primary">Choose a folder</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded-lg px-2 py-1 text-secondary hover:bg-surface-hover">
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {data && data.path !== null && (
          <nav aria-label="Location" className="flex flex-wrap items-center gap-1 text-[13px] text-secondary">
            <button type="button" className="cursor-pointer rounded px-1 hover:text-primary" onClick={() => setAt(null)}>
              Locations
            </button>
            {data.crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-1">
                <span aria-hidden>/</span>
                <button type="button" className="cursor-pointer rounded px-1 hover:text-primary" aria-current={i === data.crumbs.length - 1 ? "page" : undefined} onClick={() => setAt(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        {error && <p className="text-[13px] text-red-400">{error}</p>}
        {!data && !error && <p className="text-[13px] text-secondary">Loading…</p>}
        {data && (
          <ul className="flex flex-col rounded-xl border border-line p-1" aria-label="Folders">
            {data.parent !== null && data.path !== null && (
              <li>
                <button type="button" className={row} onClick={() => setAt(data.parent)}>
                  <span aria-hidden>↑</span> Up
                </button>
              </li>
            )}
            {data.entries.length === 0 && (
              <li className="px-2.5 py-2 text-[13px] text-secondary">{data.path === null ? "No allowed locations are available. Is the drive connected?" : "No folders here."}</li>
            )}
            {data.entries.map((e) => (
              <li key={e.path}>
                <button type="button" className={row} disabled={!e.readable} onClick={() => setAt(e.path)}>
                  <span aria-hidden>📁</span>
                  <span className="min-w-0 flex-1 truncate text-primary">{e.name}</span>
                  {!e.readable ? <span className="text-[12px] text-secondary">no access</span> : <span aria-hidden className="text-secondary">›</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {data?.truncated && <p className="text-[12px] text-secondary">Showing the first 1,000 folders. Type the path instead to go deeper.</p>}
        {data?.path != null && <p className="text-[12px] break-all text-secondary">&ldquo;{data.path}&rdquo; is open</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3 py-2 text-[13px] text-secondary hover:bg-surface-hover">
          Cancel
        </button>
        <button
          type="button"
          disabled={!data || data.path === null}
          onClick={() => data?.path && onPick(data.path)}
          className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Use this folder
        </button>
      </div>
    </Dialog>
  );
}
