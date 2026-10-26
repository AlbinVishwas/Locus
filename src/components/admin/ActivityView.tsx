"use client";

import { useCallback, useEffect, useState } from "react";

interface Row {
  id: number;
  at: string;
  username: string | null;
  role: string | null;
  kind: string;
  scope: string | null;
  queryText: string | null;
  resultPages: number | null;
  resultDocuments: number | null;
  status: string;
  message: string | null;
  ip: string | null;
}

interface Summary {
  failedSignIns: number;
  deniedAccess: number;
  searchErrors: number;
  uploadFailures: number;
  indexingProblems: number;
  storagePauses: number;
  serverErrors: number;
}

type Page = { rows: Row[]; total: number; nextBefore: number | null };

const ISSUES: Array<[keyof Summary, string]> = [
  ["failedSignIns", "failed sign-ins"],
  ["deniedAccess", "access denied"],
  ["searchErrors", "search errors"],
  ["uploadFailures", "upload failures"],
  ["indexingProblems", "indexing problems"],
  ["storagePauses", "storage pauses"],
  ["serverErrors", "server errors"],
];

const KINDS = ["search", "search_more", "login", "login_failed", "signup", "upload_ready", "upload_failed", "access_denied", "search_failed"];

export default function ActivityView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [user, setUser] = useState("");
  const [kind, setKind] = useState("");
  const [text, setText] = useState("");
  const [issues, setIssues] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (user.trim()) p.set("user", user.trim());
    if (kind) p.set("kind", kind);
    if (text.trim()) p.set("q", text.trim());
    if (issues) p.set("issues", "1");
    return p;
  }, [user, kind, text, issues]);

  // Page one for the current filters; "Show older" appends the next page.
  useEffect(() => {
    let live = true;
    fetch(`/api/activity?${params()}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<Page>) : null))
      .then((data) => {
        if (!live) return;
        if (!data) return setError("Could not load the activity log.");
        setError(null);
        setRows(data.rows);
        setTotal(data.total);
        setNext(data.nextBefore);
      })
      .catch(() => live && setError("Could not load the activity log."));
    return () => {
      live = false;
    };
  }, [params]);

  const older = async (before: number) => {
    setLoading(true);
    const p = params();
    p.set("before", String(before));
    const res = await fetch(`/api/activity?${p}`, { cache: "no-store" });
    setLoading(false);
    if (!res.ok) return setError("Could not load the activity log.");
    const data = (await res.json()) as Page;
    setRows((old) => [...old, ...data.rows]);
    setNext(data.nextBefore);
  };

  useEffect(() => {
    fetch("/api/activity/summary", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Summary>) : null))
      .then(setSummary)
      .catch(() => {});
  }, []);

  const field =
    "rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary";
  const problems = summary ? ISSUES.filter(([k]) => summary[k] > 0) : [];

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px]">
        {summary === null ? (
          <span className="text-secondary">Checking the last 24 hours…</span>
        ) : problems.length === 0 ? (
          <span className="text-secondary">Nothing wrong in the last 24 hours.</span>
        ) : (
          <span className="text-primary">
            Last 24 hours:{" "}
            {problems.map(([k, label], i) => (
              <span key={k}>
                {i > 0 && " · "}
                {summary[k]} {label}
              </span>
            ))}
            <button type="button" onClick={() => setIssues(true)} className="ml-3 cursor-pointer text-secondary underline hover:text-primary">
              Show them
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User" aria-label="User" className={`${field} w-32`} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Event" className={field}>
          <option value="">All events</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Contains…" aria-label="Contains" className={`${field} w-44`} />
        <label className="flex items-center gap-2 text-[13px] text-secondary">
          <input type="checkbox" checked={issues} onChange={(e) => setIssues(e.target.checked)} />
          Problems only
        </label>
        <a href={`/api/activity/export?${params()}`} className="ml-auto text-[13px] text-secondary underline hover:text-primary">
          Download CSV
        </a>
      </div>

      {error && <p className="text-[13px] text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-secondary">
            <tr>
              <th className="px-3 py-2 font-normal">Time</th>
              <th className="px-3 py-2 font-normal">User</th>
              <th className="px-3 py-2 font-normal">Event</th>
              <th className="px-3 py-2 font-normal">Detail</th>
              <th className="px-3 py-2 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-secondary">
                  Nothing matches.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="px-3 py-2 whitespace-nowrap text-secondary">{new Date(r.at).toLocaleString()}</td>
                <td className="px-3 py-2 text-primary">{r.username ?? "—"}</td>
                <td className="px-3 py-2 text-secondary">{r.kind.replace(/_/g, " ")}</td>
                <td className="px-3 py-2 break-words text-primary">
                  {r.queryText ? <span>“{r.queryText}”</span> : (r.message ?? "")}
                  {r.scope && <span className="ml-2 text-[12px] text-secondary">{r.scope}</span>}
                </td>
                <td className={`px-3 py-2 whitespace-nowrap ${r.status === "ok" ? "text-secondary" : "text-red-400"}`}>
                  {r.status !== "ok"
                    ? r.status
                    : r.resultPages !== null
                      ? `${r.resultPages} pages · ${r.resultDocuments ?? 0} docs`
                      : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[13px] text-secondary">
        <span>{total === null ? "" : `${total.toLocaleString()} matching`}</span>
        {next !== null && (
          <button type="button" disabled={loading} onClick={() => older(next)} className="cursor-pointer rounded-lg px-3 py-1.5 hover:bg-surface-hover disabled:opacity-50">
            {loading ? "Loading…" : "Show older"}
          </button>
        )}
      </div>
    </div>
  );
}
