// src/proxy.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { sessionCookie } from "@/lib/auth";
import {
  SESSION_COOKIE,
  SessionError,
  shouldRefresh,
  signSession,
  verifySession,
} from "@/lib/session";

/**
 * Next.js 16's renamed middleware. An OPTIMISTIC check and nothing more: it bounces
 * obviously signed-out traffic before it reaches a render, so the login redirect is
 * fast and cheap. It is NOT the authorization boundary — it only ever sees the
 * token, never the store, so it cannot know that an account was deleted or a role
 * revoked a second ago. Every page, route handler and Server Action re-checks
 * through the DAL (src/lib/dal.ts); that is the authority.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname.startsWith("/api/");
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    return reject(request, isApiRequest, "no session cookie");
  }

  let session: Awaited<ReturnType<typeof verifySession>>;

  try {
    session = await verifySession(token);
  } catch (error) {
    // Fail closed. Any verification failure — expired, tampered, wrong issuer,
    // wrong algorithm — ends the request; it never falls through to the page.
    const reason =
      error instanceof SessionError ? error.reason : `unexpected error: ${String(error)}`;

    return reject(request, isApiRequest, reason);
  }

  // The token verified — that is ALL this proves. The account behind `sub` may have
  // been deleted a second ago, and the `role` claim is a hint for the UI, never the
  // basis of a decision; the DAL reads the real role from the store on every call.
  console.info(`[proxy] ${pathname} passed the optimistic check for ${session.payload.sub}`);

  const response = NextResponse.next();

  // Sliding session: someone who is actively browsing should not be logged out
  // mid-session, so a token close to expiry is re-issued on a request they never
  // notice. `authTime` rides along unchanged, which is what stops the slide from
  // being infinite — past authTime + MAX_SESSION_SECONDS, `shouldRefresh` says no
  // and the session runs out. The re-issue still cannot notice a revoked account;
  // the DAL refuses those requests anyway, so the longer token buys nothing.
  if (shouldRefresh(session)) {
    response.cookies.set(sessionCookie(await signSession(session.payload)));
  }

  return response;
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
 * extension, the landing page, /login, and the auth endpoints that a signed-out
 * user must be able to reach.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/auth/|login$|[^?]*\\.[^/?]+$).+)"],
};
