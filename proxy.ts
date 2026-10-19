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

/**
 * Nonce CSP (Phase 13, replaces the static T10 H5 policy; next/dist/docs/01-app/02-guides/
 * content-security-policy.md). Next reads the nonce from the request's CSP header and puts it on
 * its own scripts; `'strict-dynamic'` lets those load the chunks. A prerendered shell has no
 * nonce, so the root layout renders per request (`instant = false`) and passes `x-nonce` to its
 * locale script. Styles keep `'unsafe-inline'`: React renders `style=` attributes and the
 * print helper writes a `<style>` and `style` at run time, none of which can carry a nonce.
 * `'unsafe-eval'` is for React's dev tooling only.
 */
export function contentSecurityPolicy(nonce: string, isDev = process.env.NODE_ENV === "development"): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const { pathname } = request.nextUrl;

  if (!isPublic(pathname) && !getSessionCookie(request)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: "Authentication required", details: null },
        { status: 401, headers: { "x-request-id": requestId, "Content-Security-Policy": csp } },
      );
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    const redirect = NextResponse.redirect(login);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  // Next.js takes the nonce from the request's CSP header while rendering.
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
