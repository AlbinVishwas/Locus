"use client";

/**
 * The last resort: the whole app crashed, so not even the layout (and its stylesheet) can be relied on. This page
 * brings its own html/body and styles, inline, in the same dark theme.
 */
export default function GlobalError({ reset, error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0a0a0c", color: "#f5f5f7", fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif' }}>
        <main style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 460 }}>
            <h1 style={{ fontSize: 22, fontWeight: 500, color: "#f2efe8", margin: 0 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: "#8a8a90", marginTop: 12 }}>Locus hit an unexpected problem. It has been logged on the server. Try again; if it keeps happening, quote the reference below to the administrator.</p>
            <button type="button" onClick={reset} style={{ marginTop: 20, cursor: "pointer", border: 0, borderRadius: 8, background: "#e6dccb", color: "#0a0a0c", padding: "8px 14px", fontSize: 13, fontWeight: 500 }}>
              Try again
            </button>
            <p style={{ marginTop: 32, fontSize: 11, color: "#8a8a90" }}>LOCUS-APP-001{error.digest ? ` · reference ${error.digest}` : ""}</p>
          </div>
        </main>
      </body>
    </html>
  );
}
