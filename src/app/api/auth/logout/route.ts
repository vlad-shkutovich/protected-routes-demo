// src/app/api/auth/logout/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { assertSameOrigin, sessionCookie } from "@/lib/auth";

export function POST(request: NextRequest) {
  const crossOrigin = assertSameOrigin(request);

  if (crossOrigin) {
    return crossOrigin;
  }

  const response = NextResponse.json({ ok: true });

  // Overwrite with an empty, immediately-expiring cookie carrying the same
  // attributes the login path used (src/lib/auth.ts).
  response.cookies.set(sessionCookie("", 0));

  return response;
}
