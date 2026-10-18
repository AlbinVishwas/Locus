import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Gate for every page and API route: no valid session cookie, no access.
 * `/login` and `/api/login` are the only unauthenticated routes, since
 * that's how a session gets created in the first place.
 *
 * Named `proxy.ts`, not `middleware.ts`: Next.js 16 renamed the file
 * convention (the old name still works but is deprecated and warns on
 * every build). Runs on the Edge runtime (Next's default here), which is
 * why `src/lib/auth.ts` is built on Web Crypto instead of `node:crypto`.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/login" || pathname === "/api/login" || pathname === "/api/logout") {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);
  if (authenticated) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next's own static assets and the favicon. Those are
  // public by nature (there's nothing in them to protect) and gating them
  // would just add latency to every page load.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
