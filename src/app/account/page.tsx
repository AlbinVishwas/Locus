"use client";

import Link from "next/link";
import { useState } from "react";
import { useFeatures } from "@/components/FeaturesProvider";

/** Where a signed-in person changes their own password. Needs the current one; other devices are signed out. */
export default function AccountPage() {
  const { username, isAdmin } = useFeatures();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const input =
    "rounded-lg border border-line bg-page px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary";
  const mismatch = again !== "" && again !== next;
  const ready = current !== "" && next.length >= 8 && next === again && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account/passcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) {
        setMessage({ ok: true, text: "Your password has been changed. Other devices have been signed out." });
        setCurrent("");
        setNext("");
        setAgain("");
      } else setMessage({ ok: false, text: body.error ?? "That didn't work." });
    } catch {
      setMessage({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  };

  if (!username || isAdmin) {
    return <div className="flex h-dvh items-center justify-center bg-page px-4 text-[13px] text-secondary">Not available.</div>;
  }
  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4">
      <form onSubmit={submit} className="flex w-full max-w-[340px] flex-col gap-4 rounded-xl border border-line bg-surface p-6">
        <div>
          <h1 className="text-[15px] font-medium text-primary">Change password</h1>
          <p className="mt-1 text-[13px] text-secondary">Signed in as {username}.</p>
        </div>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current password" className={input} />
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (8+ characters)" aria-label="New password" className={input} />
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="New password again" aria-label="New password again" className={input} />
        {mismatch && <p className="text-[13px] text-red-400">The two new passwords don&apos;t match.</p>}
        {message && (
          <p role="status" className={`text-[13px] ${message.ok ? "text-primary" : "text-red-400"}`}>
            {message.text}
          </p>
        )}
        <button type="submit" disabled={!ready} className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? "Saving…" : "Change password"}
        </button>
        <Link href="/" className="text-[13px] text-secondary hover:text-primary">
          ← Back to search
        </Link>
      </form>
    </div>
  );
}
