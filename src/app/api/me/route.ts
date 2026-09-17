// src/app/api/me/route.ts
import { NextResponse } from "next/server";

import { getSession } from "@/lib/dal";

/**
 * Exists so the API-shaped half of the proxy can be demonstrated: unauthenticated
 * requests under /api/* get a JSON 401 from the proxy instead of a redirect.
 * The DAL check here is not redundant: see the revocation case in VERIFICATION.md,
 * where the proxy lets the request through and this handler still says 401.
 */
export async function GET() {
  const session = await getSession();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(session);
}
