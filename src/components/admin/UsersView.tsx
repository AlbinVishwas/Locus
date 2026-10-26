"use client";

import { useCallback, useEffect, useState } from "react";

interface UserRow {
  id: number;
  username: string;
  role: "user" | "admin";
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  sessions: number;
  uploads: number;
  uploadBytes: number;
  searches30d: number;
}

interface UploadRow {
  id: number;
  filename: string;
  sizeBytes: number;
  pageCount: number | null;
  status: string;
  error: string | null;
  uploadedAt: string;
}

const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export default function UsersView() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  // A generated passcode, shown once.
  const [secret, setSecret] = useState<{ username: string; passcode: string } | null>(null);
  const [open, setOpen] = useState<{ id: number; username: string; uploads: UploadRow[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    fetch("/api/users", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ users: UserRow[] }>) : null))
      .then((data) => {
        if (!live) return;
        if (data) setUsers(data.users);
        else setError("Could not load users.");
      })
      .catch(() => live && setError("Could not load users."));
    return () => {
      live = false;
    };
  }, [version]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await send("/api/users", "POST", { username: name });
    if (!r.ok) return setError(String(r.data.error ?? "Could not create the user."));
    setSecret({ username: (r.data.user as { username: string }).username, passcode: String(r.data.passcode) });
    setName("");
    load();
  };

  const act = async (u: UserRow, action: "disable" | "enable" | "reset-passcode") => {
    setError(null);
    const r = await send(`/api/users/${u.id}`, "PATCH", { action });
    if (!r.ok) return setError(String(r.data.error ?? "That didn't work."));
    if (action === "reset-passcode") setSecret({ username: u.username, passcode: String(r.data.passcode) });
    load();
  };

  const remove = async (u: UserRow) => {
    const r = await send(`/api/users/${u.id}`, "DELETE");
    setConfirmRemove(null);
    if (!r.ok) return setError(String(r.data.error ?? "That didn't work."));
    load();
  };

  const showUploads = async (u: UserRow) => {
    const res = await fetch(`/api/users/${u.id}/uploads`, { cache: "no-store" });
    if (!res.ok) return setError("Could not load uploads.");
    setOpen({ id: u.id, username: u.username, uploads: ((await res.json()) as { uploads: UploadRow[] }).uploads });
  };

  const btn = "cursor-pointer rounded-lg px-2.5 py-1.5 text-[13px] text-secondary hover:bg-surface-hover hover:text-primary";

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New username"
          autoCapitalize="none"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary sm:w-64"
        />
        <button
          type="submit"
          disabled={name.trim() === ""}
          className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add user
        </button>
        <span className="text-[12px] text-secondary">A passcode is generated and shown once.</span>
      </form>

      {secret && (
        <div role="status" className="rounded-xl border border-line bg-surface p-4 text-[13px]">
          <p className="text-primary">
            Passcode for <strong>{secret.username}</strong> — copy it now, it won&apos;t be shown again:
          </p>
          <p className="mt-2 font-mono text-[15px] break-all text-primary select-all">{secret.passcode}</p>
          <button type="button" onClick={() => setSecret(null)} className={`${btn} mt-2 -ml-2.5`}>
            Done
          </button>
        </div>
      )}

      {error && <p className="text-[13px] text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-secondary">
            <tr>
              <th className="px-3 py-2 font-normal">User</th>
              <th className="px-3 py-2 font-normal">Last sign-in</th>
              <th className="px-3 py-2 font-normal">Uploads</th>
              <th className="px-3 py-2 font-normal">Searches (30 d)</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users === null && (
              <tr>
                <td className="px-3 py-3 text-secondary" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {users?.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-primary">
                  {u.username}
                  {u.role === "admin" && <span className="ml-2 text-[12px] text-secondary">administrator</span>}
                  {u.disabled && <span className="ml-2 text-[12px] text-red-400">disabled</span>}
                </td>
                <td className="px-3 py-2 text-secondary">{when(u.lastLoginAt)}</td>
                <td className="px-3 py-2 text-secondary">
                  {u.uploads} · {mb(u.uploadBytes)}
                </td>
                <td className="px-3 py-2 text-secondary">{u.searches30d}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {u.role === "user" &&
                    (confirmRemove === u.id ? (
                      <>
                        <span className="mr-1 text-[12px] text-secondary">Delete their files too?</span>
                        <button type="button" className={btn} onClick={() => remove(u)}>
                          Remove
                        </button>
                        <button type="button" className={btn} onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={btn} onClick={() => showUploads(u)}>
                          Uploads
                        </button>
                        <button type="button" className={btn} onClick={() => act(u, "reset-passcode")}>
                          Reset passcode
                        </button>
                        <button type="button" className={btn} onClick={() => act(u, u.disabled ? "enable" : "disable")}>
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                        <button type="button" className={btn} onClick={() => setConfirmRemove(u.id)}>
                          Remove
                        </button>
                      </>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <section className="rounded-xl border border-line p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-primary">Uploads by {open.username}</h2>
            <button type="button" className={btn} onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          {open.uploads.length === 0 ? (
            <p className="text-[13px] text-secondary">Nothing uploaded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {open.uploads.map((f) => (
                <li key={f.id} className="flex flex-wrap justify-between gap-x-4 text-secondary">
                  <span className="min-w-0 break-all text-primary">{f.filename}</span>
                  <span>
                    {mb(f.sizeBytes)} · {f.pageCount ?? "?"} pages · {f.status}
                    {f.error ? ` (${f.error})` : ""} · {when(f.uploadedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
