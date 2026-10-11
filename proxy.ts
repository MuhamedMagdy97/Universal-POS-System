import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic gate (Next.js 16 "proxy", formerly middleware).
 *
 * Deny by default: anything not listed as public needs a session cookie.
 * This only checks that a cookie is present; the real session, tenant and
 * permission checks run server-side in lib/auth/tenant.ts.
 */
const PUBLIC_PAGES = new Set(["/", "/welcome", "/onboarding", "/login"]);
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PAGES.has(pathname) || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { pathname } = request.nextUrl;

  if (!isPublic(pathname) && !getSessionCookie(request)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: "Authentication required", details: null },
        { status: 401, headers: { "x-request-id": requestId } },
      );
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
