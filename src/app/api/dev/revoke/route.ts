// src/app/api/dev/revoke/route.ts
import { NextResponse } from "next/server";

import { deleteUser } from "@/lib/db";

/**
 * Development-only. Deletes a user from the in-memory store so the revocation
 * scenario can be reproduced: the caller keeps a perfectly valid, unexpired JWT,
 * the proxy keeps waving it through, and the DAL starts returning null because the
 * account no longer exists. That gap is the point of the article.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let userId: unknown;

  try {
    userId = (await request.json())?.userId;
  } catch (error) {
    console.warn("[dev/revoke] malformed body:", error);
    return NextResponse.json({ error: "expected { userId: string }" }, { status: 400 });
  }

  if (typeof userId !== "string") {
    return NextResponse.json({ error: "expected { userId: string }" }, { status: 400 });
  }

  const deleted = await deleteUser(userId);

  console.warn(`[dev/revoke] deleteUser(${userId}) -> ${deleted}`);

  return NextResponse.json({ deleted });
}
