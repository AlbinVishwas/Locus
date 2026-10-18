"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setError(body.error ?? "Something went wrong");
        setSubmitting(false);
        return;
      }
      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh();
    } catch {
      setError("Could not reach the server");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-page px-4">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-[320px] flex-col gap-4 rounded-xl border border-line bg-surface p-6"
      >
        <div>
          <h1 className="text-[15px] font-medium text-primary">Assay</h1>
          <p className="mt-1 text-[13px] text-secondary">Enter the passcode to continue.</p>
        </div>

        <input
          type="password"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          className="rounded-lg border border-line bg-page px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary"
        />

        {error && <p className="text-[13px] text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting || passcode.length === 0}
          className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
