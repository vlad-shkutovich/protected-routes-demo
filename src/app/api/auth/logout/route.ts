// src/app/api/auth/logout/route.ts
import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

export function POST() {
  const response = NextResponse.json({ ok: true });

  // Overwrite with an empty, immediately-expiring cookie on the same path the
  // login route used — a Set-Cookie with a different Path deletes nothing.
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
