"use client";

import { useRef, useState } from "react";
import { addSource, testSourceForm, type SourcesResponse, type TestResult } from "@/lib/sourcesClient";
import Dialog from "./Dialog";
import FolderBrowser from "./FolderBrowser";

type Kind = "folder" | "database" | "drive";
type Dialect = "postgres" | "mysql" | "sqlite";

const TABS: Array<{ kind: Kind; label: string }> = [
  { kind: "folder", label: "Folder" },
  { kind: "database", label: "Database" },
  { kind: "drive", label: "Google Drive" },
];

const input = "w-full rounded-lg border border-line bg-page px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary";
const label = "flex flex-col gap-1 text-[13px] text-secondary";

/** The Add source panel: three tabs, a Test button per tab, and Add only after a Test has passed with the current values. */
export default function AddSourceDialog({ info, onClose, onAdded }: { info: Pick<SourcesResponse, "allowedRoots" | "driveConfigured" | "secretsConfigured">; onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<Kind>("folder");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [dialect, setDialect] = useState<Dialect>("postgres");
  const [pasted, setPasted] = useState(false);
  const [conn, setConn] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [file, setFile] = useState("");
  const [table, setTable] = useState("");
  const [cols, setCols] = useState({ id: "", filename: "", modified: "", content: "" });
  const [content, setContent] = useState<"file_path" | "file_bytes">("file_path");
  const [link, setLink] = useState("");

  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"test" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef<Record<Kind, HTMLButtonElement | null>>({ folder: null, database: null, drive: null });

  const dirty = [name, path, host, database, user, password, file, table, link, conn].some((v) => v !== "");
  const stale = () => {
    setResult(null);
    setError(null);
  };
  /** Wraps a setter so that editing any field clears the Test result. */
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    stale();
  };

  const payload = (): object => {
    const base = { kind, name: name.trim() };
    if (kind === "folder") return { ...base, path: path.trim() };
    if (kind === "drive") return { ...base, link: link.trim() };
    const common = { ...base, table: table.trim(), columns: cols, content };
    if (dialect === "sqlite") return { ...common, dialect, file: file.trim() };
    if (pasted) return { ...common, connectionString: conn.trim() };
    return { ...common, dialect, host: host.trim(), port: port.trim() === "" ? undefined : Number(port), database: database.trim(), user: user.trim(), password };
  };

  const runTest = async () => {
    setBusy("test");
    setError(null);
    setResult(null);
    try {
      const r = await testSourceForm(payload());
      if (!r.ok) setError(r.data.error ?? "The test couldn't run.");
      else {
        setResult(r.data);
        // A Drive test learns the folder's name; offer it if no name was typed.
        if (r.data.ok && r.data.folderName && name.trim() === "") setName(r.data.folderName);
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const runAdd = async () => {
    setBusy("add");
    setError(null);
    try {
      const r = await addSource(payload());
      if (!r.ok) setError(r.data.error ?? "Couldn't add the source.");
      else onAdded();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (!dirty || window.confirm("Discard this new source?")) onClose();
  };

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].kind;
    setKind(next);
    stale();
    tabRefs.current[next]?.focus();
  };

  const driveBlocked = kind === "drive" && !info.driveConfigured;
  const tested = result?.ok === true;

  return (
    <>
      <Dialog title="Add source" onClose={close} wide>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-medium text-primary">Add source</h2>
          <button type="button" onClick={close} aria-label="Close" className="cursor-pointer rounded-lg px-2 py-1 text-secondary hover:bg-surface-hover">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div role="tablist" aria-label="Kind of source" className="flex gap-1 border-b border-line">
            {TABS.map((t, i) => (
              <button
                key={t.kind}
                ref={(el) => {
                  tabRefs.current[t.kind] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${t.kind}`}
                aria-selected={kind === t.kind}
                aria-controls="source-tabpanel"
                tabIndex={kind === t.kind ? 0 : -1}
                onClick={() => {
                  setKind(t.kind);
                  stale();
                }}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`-mb-px cursor-pointer border-b-2 px-3 py-2 text-[13px] ${kind === t.kind ? "border-cream text-primary" : "border-transparent text-secondary hover:text-primary"}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="source-tabpanel" aria-labelledby={`tab-${kind}`} className="flex flex-col gap-3">
            {driveBlocked ? (
              <p className="rounded-lg border border-line p-3 text-[13px] text-secondary">Google Drive isn&apos;t set up on this server (GOOGLE_API_KEY is missing).</p>
            ) : (
              <>
                <label className={label}>
                  Name
                  <input className={input} autoComplete="off" value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder={kind === "folder" ? "Tenders 2026" : kind === "database" ? "Purchase records" : "Shared drive: BHEL tenders"} />
                </label>

                {kind === "folder" && (
                  <>
                    <label className={label}>
                      Folder
                      <div className="flex gap-2">
                        <input className={input} autoComplete="off" value={path} onChange={(e) => edit(setPath)(e.target.value)} placeholder={`${info.allowedRoots[0] ?? "/Volumes"}/Tenders`} spellCheck={false} />
                        <button type="button" onClick={() => setBrowsing(true)} className="shrink-0 cursor-pointer rounded-lg border border-line px-3 py-2 text-[13px] text-primary hover:bg-surface-hover">
                          Browse
                        </button>
                      </div>
                    </label>
                    <p className="text-[12px] text-secondary">The folder must be on this computer or on a drive connected to it. Allowed: {info.allowedRoots.join(", ") || "nothing"}.</p>
                  </>
                )}

                {kind === "database" && (
                  <>
                    <label className={label}>
                      Type
                      <select className={input} value={dialect} onChange={(e) => edit(setDialect)(e.target.value as Dialect)}>
                        <option value="postgres">PostgreSQL</option>
                        <option value="mysql">MySQL</option>
                        <option value="sqlite">SQLite</option>
                      </select>
                    </label>
                    {dialect === "sqlite" ? (
                      <label className={label}>
                        Database file
                        <input className={input} autoComplete="off" spellCheck={false} value={file} onChange={(e) => edit(setFile)(e.target.value)} placeholder={`${info.allowedRoots[0] ?? "/Volumes"}/records.sqlite`} />
                      </label>
                    ) : pasted ? (
                      <label className={label}>
                        Connection string
                        <input className={input} type="password" autoComplete="off" spellCheck={false} value={conn} onChange={(e) => edit(setConn)(e.target.value)} placeholder="postgres://user:password@host:5432/database" />
                        <button type="button" className="cursor-pointer self-start text-[12px] text-secondary underline hover:text-primary" onClick={() => { setPasted(false); setConn(""); stale(); }}>
                          Enter the details separately instead
                        </button>
                      </label>
                    ) : (
                      <>
                        <div className="grid grid-cols-[1fr_96px] gap-2">
                          <label className={label}>
                            Host
                            <input className={input} autoComplete="off" spellCheck={false} value={host} onChange={(e) => edit(setHost)(e.target.value)} />
                          </label>
                          <label className={label}>
                            Port
                            <input className={input} inputMode="numeric" autoComplete="off" value={port} onChange={(e) => edit(setPort)(e.target.value)} placeholder={dialect === "mysql" ? "3306" : "5432"} />
                          </label>
                        </div>
                        <label className={label}>
                          Database
                          <input className={input} autoComplete="off" spellCheck={false} value={database} onChange={(e) => edit(setDatabase)(e.target.value)} />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className={label}>
                            User
                            <input className={input} autoComplete="off" spellCheck={false} value={user} onChange={(e) => edit(setUser)(e.target.value)} />
                          </label>
                          <label className={label}>
                            Password
                            <input className={input} type="password" autoComplete="new-password" value={password} onChange={(e) => edit(setPassword)(e.target.value)} />
                          </label>
                        </div>
                        <button type="button" className="cursor-pointer self-start text-[12px] text-secondary underline hover:text-primary" onClick={() => { setPasted(true); stale(); }}>
                          Paste a connection string instead
                        </button>
                        {!info.secretsConfigured && <p className="text-[12px] text-warm">A password can&apos;t be saved until LOCUS_SECRETS_KEY is set in .env.local.</p>}
                      </>
                    )}
                    <label className={label}>
                      Table <span className="text-[12px]">(or schema.table)</span>
                      <input className={input} autoComplete="off" spellCheck={false} value={table} onChange={(e) => edit(setTable)(e.target.value)} />
                    </label>
                    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
                      <legend className="px-1 text-[12px] text-secondary">Which columns hold what</legend>
                      <div className="grid grid-cols-2 gap-2">
                        {(
                          [
                            ["id", "ID column"],
                            ["filename", "File name column"],
                            ["modified", "Modified time column"],
                          ] as const
                        ).map(([k, l]) => (
                          <label key={k} className={label}>
                            {l}
                            <input className={input} autoComplete="off" spellCheck={false} value={cols[k]} onChange={(e) => edit(setCols)({ ...cols, [k]: e.target.value })} />
                          </label>
                        ))}
                        <label className={label}>
                          File content
                          <select className={input} value={content} onChange={(e) => edit(setContent)(e.target.value as "file_path" | "file_bytes")}>
                            <option value="file_path">File path column</option>
                            <option value="file_bytes">File bytes column</option>
                          </select>
                        </label>
                        <label className={`${label} col-span-2`}>
                          {content === "file_path" ? "File path column" : "File bytes column"}
                          <input className={input} autoComplete="off" spellCheck={false} value={cols.content} onChange={(e) => edit(setCols)({ ...cols, content: e.target.value })} />
                        </label>
                      </div>
                    </fieldset>
                    <p className="text-[12px] text-secondary">Locus only reads. Use a database user that can only SELECT.</p>
                  </>
                )}

                {kind === "drive" && (
                  <>
                    <label className={label}>
                      Drive folder link
                      <input className={input} autoComplete="off" spellCheck={false} value={link} onChange={(e) => edit(setLink)(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" />
                    </label>
                    <p className="text-[12px] text-secondary">Share the folder as &ldquo;Anyone with the link&rdquo;, then paste the link. Private folders aren&apos;t supported yet.</p>
                    <p className="text-[12px] text-secondary">Large folders take a long time to download. Each PDF is downloaded to this Mac, indexed, then deleted.</p>
                  </>
                )}
              </>
            )}

            <div aria-live="polite" className="flex flex-col gap-2">
              {result && (
                <div className={`rounded-lg border p-3 text-[13px] ${result.ok ? "border-line text-primary" : "border-line text-red-400"}`}>
                  <p>
                    <span aria-hidden>{result.ok ? "✓ " : "✕ "}</span>
                    {result.message}
                  </p>
                  {result.samples.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] text-secondary">
                      {result.samples.map((s) => (
                        <li key={s} className="truncate" title={s}>
                          {s}
                        </li>
                      ))}
                    </ul>
                  )}
                  {result.warnings.map((w) => (
                    <p key={w} className="mt-1.5 text-[12px] text-warm">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {error && <p className="text-[13px] text-red-400">{error}</p>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={close} className="cursor-pointer rounded-lg px-3 py-2 text-[13px] text-secondary hover:bg-surface-hover">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy !== null || driveBlocked}
            onClick={runTest}
            className="cursor-pointer rounded-lg border border-line px-3 py-2 text-[13px] text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            disabled={!tested || busy !== null || name.trim() === ""}
            onClick={runAdd}
            className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "add" ? "Adding…" : "Add source"}
          </button>
        </div>
      </Dialog>
      {browsing && (
        <FolderBrowser
          start={path.trim() === "" ? null : path.trim()}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            setPath(p);
            if (name.trim() === "") setName(p.split("/").filter(Boolean).pop() ?? "");
            stale();
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}
