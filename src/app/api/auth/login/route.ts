// src/app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { findUserByEmail, verifyPassword } from "@/lib/db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";

type LoginBody = { email: string; password: string };

function parseBody(value: unknown): LoginBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { email, password } = value as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string") {
    return null;
  }

  return { email, password };
}

export async function POST(request: NextRequest) {
  // Accept both a JSON fetch and a plain <form> POST, so the demo works with curl
  // and with JavaScript switched off.
  let raw: unknown;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      raw = await request.json();
    } else {
      raw = Object.fromEntries(await request.formData());
    }
  } catch (error) {
    console.warn("[login] could not parse the request body:", error);
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }

  const body = parseBody(raw);

  if (!body) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const user = await findUserByEmail(body.email);

  // Same response AND the same cost for "no such user" and "wrong password":
  // anything else turns the login endpoint into an account-enumeration oracle.
  // `verifyPassword` runs scrypt even for a null hash — see src/lib/db.ts.
  const ok = await verifyPassword(body.password, user?.passwordHash ?? null);

  if (!(user && ok)) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await signSession({ sub: user.id, role: user.role });
  const response = NextResponse.json({ id: user.id, email: user.email, role: user.role });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true, // JavaScript must never be able to read the session token
    secure: process.env.NODE_ENV === "production", // http://localhost has no TLS
    sameSite: "lax", // survives top-level navigation, blocks cross-site POSTs
    path: "/",
    maxAge: SESSION_TTL_SECONDS, // cookie and token expire together
  });

  return response;
}
