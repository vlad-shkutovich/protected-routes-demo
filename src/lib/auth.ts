// src/lib/auth.ts
import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { findUserByEmail, verifyPassword } from "@/lib/db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";
import type { Role } from "@/lib/session";

/**
 * Sign-in lives here because the app has two entry points into it: the JSON route
 * handler at /api/auth/login (curl, fetch, mobile clients) and the Server Action
 * behind the login form, which keeps working with JavaScript switched off. One
 * implementation, so the credential check and the cookie cannot drift apart.
 */

export type SessionCookie = {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

export type SignInResult = {
  user: { id: string; email: string; role: Role };
  cookie: SessionCookie;
};

export async function signIn(email: string, password: string): Promise<SignInResult | null> {
  const user = await findUserByEmail(email);

  // Same answer AND the same cost for "no such user" and "wrong password":
  // anything else turns login into an account-enumeration oracle.
  const ok = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user || !ok) {
    return null;
  }

  const value = await signSession({
    sub: user.id,
    role: user.role,
    authTime: Math.floor(Date.now() / 1000),
  });

  return {
    user: { id: user.id, email: user.email, role: user.role },
    cookie: sessionCookie(value),
  };
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_SECONDS): SessionCookie {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true, // JavaScript must never be able to read the session token
    secure: process.env.NODE_ENV === "production", // http://localhost has no TLS
    sameSite: "lax", // survives top-level navigation, blocks cross-site POSTs
    path: "/", // a Set-Cookie on a different path deletes nothing
    maxAge, // cookie and token expire together
  };
}

/**
 * The auth endpoints are exempt from the proxy matcher — a signed-out user has to
 * reach them — so they carry their own cross-site check. `SameSite=Lax` already
 * blocks a cross-site POST from carrying the cookie, but logout has nothing to
 * lose and login can be used to force a victim into an attacker's session.
 *
 * Returns a 403 response when the request looks cross-site, `null` when it is fine.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
  // Sent by every current browser, and more precise than Origin: `none` is a
  // direct navigation, `same-origin` a request the page made to itself.
  const site = request.headers.get("sec-fetch-site");

  if (site === "same-origin" || site === "none") {
    return null;
  }

  const origin = request.headers.get("origin");

  // No Origin at all: curl, a server-to-server call, an old browser. Nothing to
  // compare, and no ambient cookie risk from a form post that has no browser.
  if (origin === null || origin === request.nextUrl.origin) {
    return null;
  }

  console.warn(`[auth] cross-origin request from ${origin} rejected`);

  return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
}
