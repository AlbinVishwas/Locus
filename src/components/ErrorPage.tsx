import Link from "next/link";
import { ERRORS, type ErrorCode } from "@/lib/errors/catalog";

/**
 * The one look for every problem page: the dark theme, the system font stack, the cream accent. Server-safe (no hooks),
 * so not-found, the error boundaries and the /problem/<code> pages can all use it. `children` carries any buttons.
 */
export default function ErrorPage({ code, title, message, action, reference, children }: { code?: ErrorCode; title?: string; message?: string; action?: string; reference?: string; children?: React.ReactNode }) {
  const entry = code ? ERRORS[code] : null;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-[460px]">
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-full border border-line text-cream" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5M12 16.2h.01" />
          </svg>
        </div>
        <h1 className="text-[22px] font-medium leading-tight text-warm">{title ?? entry?.title ?? "Something went wrong"}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-secondary">{message ?? entry?.message}</p>
        {(action ?? entry?.action) && <p className="mt-3 text-[14px] leading-relaxed text-primary">{action ?? entry?.action}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {children ?? (
            <Link href="/" className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink">
              Back to search
            </Link>
          )}
        </div>
        {(code || reference) && (
          <p className="mt-8 text-[11px] text-secondary">
            {code}
            {code && reference ? " · " : ""}
            {reference ? `reference ${reference}` : ""}
          </p>
        )}
      </div>
    </main>
  );
}
