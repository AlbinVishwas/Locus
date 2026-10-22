import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for LM Studio that only counts what reaches it. Point
 * LM_STUDIO_BASE_URL at `baseURL` and any model call the code under test
 * makes lands here instead -- so "chat is off, nothing reached LM Studio"
 * is an observed zero, not an inference from which code paths ran.
 */
export interface LmStudioTripwire {
  baseURL: string;
  hits: string[];
  close: () => Promise<void>;
}

export async function startLmStudioTripwire(): Promise<LmStudioTripwire> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("tripwire: this request should never have been made");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
