// Standalone redirect app: no dependency on anything else in this repo.
// LOCUS_URL is the current tunnel link to Locus running on someone's
// laptop. Every request checks whether it's up right now and either
// forwards there (keeping the path) or shows a small offline page --
// never cached, so a new LOCUS_URL takes effect the moment this redeploys.

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Locus</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    background: #0a0a0c;
    color: #f5f1ea;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
  }
  p { font-size: 1.05rem; opacity: 0.85; max-width: 320px; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
  <p>Locus is offline right now. Please try again later.</p>
</body>
</html>
`;

async function locusIsUp(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    // A dead tunnel still answers -- Cloudflare itself replies with a 530
    // "origin not found" page instead of a network error -- so this has
    // to check the status, not just whether fetch resolved.
    const response = await fetch(new URL("/", baseUrl), { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");

  const target = process.env.LOCUS_URL;
  if (target && (await locusIsUp(target))) {
    const destination = new URL(req.url ?? "/", target).toString();
    res.statusCode = 307;
    res.setHeader("Location", destination);
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(OFFLINE_HTML);
}
