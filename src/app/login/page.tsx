"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * How long to wait, after a login the server reported as successful, for
 * the redirect it triggers to actually land somewhere else. If this
 * component is still here after that, the session cookie the login route
 * just set isn't being accepted -- e.g. the proxy (Edge runtime) and the
 * login route (Node runtime) derived different SESSION_SECRET fallbacks --
 * and the fix is to show that, not leave the button saying "Checking..."
 * forever.
 */
const STUCK_AFTER_LOGIN_MS = 4000;

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
  // null until /api/login says whether this server uses named accounts.
  const [mode, setMode] = useState<LoginMode | null>(null);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
    };
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/login")
      .then((r) => (r.ok ? (r.json() as Promise<LoginMode>) : { usersEnabled: false as const }))
      .catch(() => ({ usersEnabled: false as const }))
      .then((m) => live && setMode(m));
    return () => {
      live = false;
    };
  }, []);

  const users = mode?.usersEnabled === true;
  const canCreate = users && mode.signup !== "off";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(users && creating ? "/api/signup" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          !users ? { passcode } : creating ? { username, passcode, ...(mode.signup === "code" ? { code } : {}) } : { username, passcode }
        ),
      });

      let body: { ok: boolean; error?: string };
      try {
        body = (await res.json()) as { ok: boolean; error?: string };
      } catch {
        setError("The server sent back something unexpected. Try again.");
        setSubmitting(false);
        return;
      }

      if (!body.ok) {
        setError(body.error ?? "Something went wrong");
        setSubmitting(false);
        return;
      }

      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh();

      stuckTimer.current = setTimeout(() => {
        setError(
          "Logged in, but the session wasn't accepted. If the server was started without " +
            "SESSION_SECRET set, restart it with one in .env.local and try again."
        );
        setSubmitting(false);
      }, STUCK_AFTER_LOGIN_MS);
    } catch {
      setError("Could not reach the server");
      setSubmitting(false);
    }
  };

  const input =
    "rounded-lg border border-line bg-page px-3 py-2 text-[13px] text-primary outline-none focus:border-secondary";
  const ready = !users
    ? passcode.length > 0
    : username.length > 0 && passcode.length > 0 && (!creating || mode.signup !== "code" || code.length > 0);

  return (
    <div className="flex h-dvh items-center justify-center bg-page px-4">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-[320px] flex-col gap-4 rounded-xl border border-line bg-surface p-6"
      >
        <div>
          <h1 className="text-[15px] font-medium text-primary">Locus</h1>
          <p className="mt-1 text-[13px] text-secondary">
            {mode === null
              ? "\u00a0"
              : !users
                ? "Enter the passcode to continue."
                : creating
                  ? "Create an account."
                  : "Sign in to continue."}
          </p>
        </div>

        {mode !== null && (
          <>
            {users && (
              <input
                type="text"
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className={input}
              />
            )}
            <input
              type="password"
              autoFocus={!users}
              autoComplete={creating ? "new-password" : "current-password"}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder={creating ? "Choose a password (8+ characters)" : "Password"}
              className={input}
            />
            {users && creating && mode.signup === "code" && (
              <input
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Sign-up code"
                className={input}
              />
            )}
          </>
        )}

        {error && <p className="text-[13px] text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting || mode === null || !ready}
          className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Checking…" : creating ? "Create account" : "Continue"}
        </button>

        {users && (
          <>
            {canCreate && (
              <button
                type="button"
                onClick={() => {
                  setCreating((c) => !c);
                  setError(null);
                }}
                className="cursor-pointer text-left text-[13px] text-secondary hover:text-primary"
              >
                {creating ? "I already have an account" : "Create an account"}
              </button>
            )}
            {!creating && (
              <p className="text-[12px] leading-snug text-secondary">
                Use the username and password you were given. The old shared passcode no longer works.
              </p>
            )}
            <p className="text-[12px] leading-snug text-secondary">
              Searches are logged for the administrator.
            </p>
          </>
        )}
      </form>
    </div>
  );
}

type LoginMode = { usersEnabled: false } | { usersEnabled: true; signup: "code" | "open" | "off" };
