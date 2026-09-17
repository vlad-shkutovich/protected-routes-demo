// src/app/api/auth/logout/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { assertSameOrigin, sessionCookie } from "@/lib/auth";

export function POST(request: NextRequest) {
  const crossOrigin = assertSameOrigin(request);

  if (crossOrigin) {
    return crossOrigin;
  }

  // The plain HTML logout form has no JS to intercept the response, so a real
  // browser ends up rendering whatever this route returns. A JSON client can
  // still ask for the old body via `Accept: application/json`.
  const wantsJson = request.headers.get("accept")?.includes("application/json") ?? false;

  const response = wantsJson
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/login", request.nextUrl.origin), 303);

  // Overwrite with an empty, immediately-expiring cookie carrying the same
  // attributes the login path used (src/lib/auth.ts).
  response.cookies.set(sessionCookie("", 0));

  return response;
}
