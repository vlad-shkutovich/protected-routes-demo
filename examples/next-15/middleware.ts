// examples/next-15/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SessionError,
  shouldRefresh,
  signSession,
  verifySession,
} from "@/lib/session";

/**
 * The SAME logic as `src/proxy.ts`, written against the Next.js 15 file convention
 * (`middleware.ts` at the project root or in `src/`, named export `middleware`).
 *
 * Keep this file out of `src/`: Next.js 16 errors out when a project ships both
 * `proxy.ts` and `middleware.ts`, and `middleware.ts` prints a deprecation warning
 * (quoted verbatim in VERIFICATION.md). Migrate with:
 *
 *   npx @next/codemod@latest middleware-to-proxy .
 *
 * Note for Next.js 16 readers: `runtime: 'edge'` is NOT available in `proxy.ts`
 * (Proxy is Node.js-only and setting `runtime` throws). If you still need the edge
 * runtime, staying on `middleware.ts` is the documented escape hatch for now.
 */

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy` (the named export
 * moved from `middleware` to `proxy` as well). See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 *
 * This is an OPTIMISTIC check and nothing more. It exists to bounce obviously
 * signed-out traffic before it reaches a render, so the login redirect is fast and
 * cheap. It is NOT the authorization boundary: it only sees the token, never the
 * database, so it cannot know that an account was deleted or a role was revoked a
 * second ago. Every page, route handler and Server Action re-checks through the
 * DAL (src/lib/dal.ts). See the revocation walkthrough in VERIFICATION.md.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname.startsWith("/api/");
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    return reject(request, isApiRequest, "no session cookie");
  }

  try {
    const { payload, expiresAt } = await verifySession(token);

    // The token verified — that is ALL this proves. The account behind `sub` may
    // have been deleted a second ago and this check would not notice.
    console.info(`[proxy] ${pathname} passed the optimistic check for ${payload.sub}`);

    const response = NextResponse.next();

    // Sliding session: a user who is actively browsing should not be logged out
    // mid-session. Re-issue while the current token is still valid, so the new
    // cookie replaces the old one on a request the user never notices.
    //
    // Two things this deliberately does NOT do, because it has no database here:
    // 1. It copies `role` straight out of the old token, so a demotion never
    //    reaches the claim. Harmless only because nothing reads that claim for
    //    authorization — the DAL reads the role from the store on every call.
    // 2. It re-issues for a user who was deleted or suspended a second ago, and
    //    it has no absolute cap, so an active client can slide forever. The DAL
    //    still refuses every one of those requests, so the extended token buys
    //    the holder nothing; but in production you want a ceiling — carry the
    //    original sign-in time as a claim and stop refreshing past it.
    if (shouldRefresh(expiresAt)) {
      const refreshed = await signSession(payload);

      response.cookies.set({
        name: SESSION_COOKIE,
        value: refreshed,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
      });
    }

    return response;
  } catch (error) {
    // Fail closed. Any verification failure — expired, tampered, wrong issuer,
    // wrong algorithm — ends the request; it never falls through to the page.
    const reason =
      error instanceof SessionError ? error.reason : `unexpected error: ${String(error)}`;

    return reject(request, isApiRequest, reason);
  }
}

function reject(request: NextRequest, isApiRequest: boolean, reason: string) {
  console.warn(`[proxy] ${request.nextUrl.pathname} rejected: ${reason}`);

  if (isApiRequest) {
    // An API client gets a machine-readable 401. Redirecting an XHR to an HTML
    // login page produces a 200 full of markup that the caller cannot parse.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.nextUrl.origin);
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);

  return NextResponse.redirect(loginUrl);
}

/**
 * The matcher must be a literal that Next.js can read at BUILD time: it is compiled
 * into the routing manifest and evaluated by the router before any of this module's
 * code runs. A value built from a variable, an env var or a helper call is not
 * statically analysable and is silently ignored — the proxy then either runs on
 * every request or on none, with no error to tell you which.
 *
 * Inverted match: everything except Next's own assets, anything with a file
 * extension (public/ files), the landing page, /login, and the auth endpoints that
 * a signed-out user must be able to reach.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/auth/|login$|[^?]*\\.[^/?]+$).+)"],
};
