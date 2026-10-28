"use client";

import { useCallback, useEffect, useState } from "react";
import { getServerStatus, rescanServer, testServer, type ServerStatus, type TestResult } from "@/lib/serverClient";
import { formatBytes, timeAgo } from "@/components/sources/format";

const FAST_MS = 3000;
const SLOW_MS = 30_000;

function eta(seconds: number | null): string {
  if (seconds === null) return "working it out…";
  if (seconds < 90) return "about a minute";
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${(seconds / 3600).toFixed(1)} hours`;
}

export function Banner({ banner }: { banner: NonNullable<ServerStatus["banner"]> }) {
  const tone = banner.tone === "error" ? "border-[#6b3a3a]" : banner.tone === "warning" ? "border-cream/40" : "border-line";
  return (
    <div role={banner.tone === "info" ? "status" : "alert"} className={`rounded-lg border ${tone} bg-surface p-3 text-[13px]`}>
      <p className="font-medium text-primary">
        {banner.title}
        {banner.code && <span className="ml-2 text-[11px] font-normal text-secondary">{banner.code}</span>}
      </p>
      <p className="mt-1 text-secondary">{banner.message}</p>
      {banner.action && <p className="mt-1 text-primary">{banner.action}</p>}
    </div>
  );
}

export default function ServerView() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const busy = status ? status.index.pending > 0 || status.sync.scanning : false;
  useEffect(() => {
    let live = true;
    getServerStatus()
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setStatus(r.data);
          setError(null);
        } else setError(r.message);
      })
      .catch(() => live && setError("Couldn't reach Locus."));
    const timer = setTimeout(refresh, busy ? FAST_MS : SLOW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick, busy, refresh]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await testServer());
    } finally {
      setTesting(false);
    }
  };
  const rescan = async () => {
    setRescanning(true);
    const r = await rescanServer();
    if (!r.ok) setError(r.message ?? "That didn't work.");
    setRescanning(false);
    refresh();
  };

  if (error && !status) return <p role="alert" className="text-[13px] text-secondary">{error}</p>;
  if (!status) return <p className="text-[13px] text-secondary">Loading…</p>;

  const card = "rounded-lg border border-line p-4";
  const label = "text-[12px] uppercase tracking-wide text-secondary";
  const { index, sync, space } = status;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="text-[13px] text-secondary">{error}</p>}
      {status.banner && <Banner banner={status.banner} />}

      <section className={card} aria-labelledby="srv-conn">
        <h2 id="srv-conn" className={label}>Storage server</h2>
        {status.configured ? (
          <>
            <p className="mt-1.5 text-[14px] text-primary break-words">{status.label}</p>
            <p className="mt-1 text-[12px] text-secondary">Settings come from .env.local (LOCUS_SERVER_*). Locus only reads from the server; it never writes, moves or deletes anything there.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={runTest} disabled={testing} className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50">
                {testing ? "Testing…" : "Test connection"}
              </button>
              {test && (
                <p role="status" className={`text-[13px] ${test.ok ? "text-primary" : "text-secondary"}`}>
                  {test.ok ? "✓ " : "✗ "}
                  {test.message}
                  {test.code && <span className="ml-2 text-[11px] text-secondary">{test.code}</span>}
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1.5 text-[13px] text-secondary">
            No storage server is connected. Set <code className="rounded bg-surface px-1.5 py-0.5 text-primary">LOCUS_SERVER_TYPE</code> in .env.local (run <code className="rounded bg-surface px-1.5 py-0.5 text-primary">npm run setup</code>), then restart Locus.
          </p>
        )}
      </section>

      {status.configured && (
        <>
          <section className={card} aria-labelledby="srv-index">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="srv-index" className={label}>Index</h2>
              <div className="flex items-center gap-3 text-[12px] text-secondary">
                <span>{sync.scanning ? "Checking the server for changes…" : sync.lastSyncedAt ? `Last synced ${timeAgo(sync.lastSyncedAt).toLowerCase()}` : "Not synced yet"}</span>
                <button type="button" onClick={rescan} disabled={rescanning || !status.indexer.running} className="cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50">
                  Rescan now
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-[14px] text-primary">
              {index.documents.toLocaleString("en-US")} of {(index.total - index.failed).toLocaleString("en-US")} files indexed
              <span className="text-secondary"> · {index.pagesIndexed.toLocaleString("en-US")} pages{index.ocrPagesRun ? ` · ${index.ocrPagesRun.toLocaleString("en-US")} scanned pages read` : ""}{index.failed > 0 ? ` · ${index.failed.toLocaleString("en-US")} couldn\u2019t be read` : ""}</span>
            </p>
            {index.percent !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="Indexing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={index.percent}>
                <div className="h-full rounded-full bg-cream" style={{ width: `${index.percent}%` }} />
              </div>
            )}
            {index.pending > 0 && (
              <p className="mt-1.5 text-[12px] text-secondary">
                {index.pending.toLocaleString("en-US")} left{index.filesPerMinute ? ` · ${index.filesPerMinute.toFixed(1)} files a minute` : ""} · {eta(index.etaSeconds)} to go. You can search what is done so far.
              </p>
            )}
            {sync.error && <p className="mt-1.5 text-[12px] text-secondary">Last sync problem: {sync.error.message}</p>}
            <p className="mt-1.5 text-[12px] text-secondary">Checked automatically every {status.syncIntervalMin} min, and again whenever you press Rescan now.</p>
          </section>

          {space && (
            <section className={card} aria-labelledby="srv-disk">
              <h2 id="srv-disk" className={label}>Disk</h2>
              <p className="mt-1.5 text-[14px] text-primary">
                {formatBytes(space.freeBytes)} free · {formatBytes(space.reserveBytes)} always kept in reserve
              </p>
              <p className="mt-1 text-[12px] text-secondary">
                {space.indexBytes !== null ? `The index uses ${formatBytes(space.indexBytes)} so far. ` : ""}
                {space.estimateBytes !== null && space.pdfBytes !== null
                  ? `The server's PDFs total ${formatBytes(space.pdfBytes)}; the whole index is expected to take about ${formatBytes(space.estimateBytes)} (${space.ratioSource === "observed" ? "judged from what is built so far" : "a first estimate"}). ${space.fits === false ? "That may not fit — see the message above." : ""}`
                  : "The estimate appears once the server has been listed."}
              </p>
            </section>
          )}

          {status.failures.length > 0 && (
            <section className={card} aria-labelledby="srv-fail">
              <h2 id="srv-fail" className={label}>Files that couldn&apos;t be read ({status.failures.length})</h2>
              <p className="mt-1 text-[12px] text-secondary">These were skipped, and everything else carried on. A file is tried again when it changes on the server.</p>
              <ul className="mt-2 divide-y divide-line text-[13px]">
                {status.failures.map((f) => (
                  <li key={f.file} className="py-2">
                    <p className="break-words text-primary">{f.file}</p>
                    <p className="text-[12px] text-secondary" title={f.detail ?? undefined}>
                      {f.message}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
