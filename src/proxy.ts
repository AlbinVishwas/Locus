import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { userSourcesEnabled, usersEnabled } from "@/lib/users/mode";

/**
 * Pages and APIs only the admin may use, in users mode. The proxy only reads
 * the signed session (it can't open the records database); each of these
 * routes then checks the account itself (src/lib/session.ts), so this is the
 * first of two checks, not the only one.
 */
const ADMIN_PREFIXES = ["/server", "/sources", "/users", "/activity", "/search", "/api/server", "/api/sources", "/api/users", "/api/activity", "/api/search", "/api/library"];
/** With LOCUS_USER_SOURCES=true these are open to ordinary accounts too (the routes then limit them to their own folders). */
const SOURCES_PREFIXES = ["/sources", "/api/sources", "/api/library"];
const isAdminPath = (p: string) => {
  const sourcesOpen = userSourcesEnabled();
  return ADMIN_PREFIXES.some((x) => (p === x || p.startsWith(`${x}/`)) && !(sourcesOpen && SOURCES_PREFIXES.includes(x)));
};

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

  const users = usersEnabled();
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/api/logout" || (users && pathname === "/api/signup")) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = await readSessionToken(token);
  // In users mode a session must name a user; one from the one-passcode days doesn't count.
  const authenticated = claims !== null && (!users || claims.u !== undefined);
  if (authenticated) {
    if (users && isAdminPath(pathname) && claims.r !== "admin") {
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
      return NextResponse.redirect(new URL("/", request.url));
    }
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
  // The web-app manifest and icons are fetched by the browser without a session (to offer "install"), and hold nothing private.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.png|apple-icon.png|icons/).*)"],
};
