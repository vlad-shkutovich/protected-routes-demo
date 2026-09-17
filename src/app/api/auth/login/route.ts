// src/app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { assertSameOrigin, signIn } from "@/lib/auth";

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
  const crossOrigin = assertSameOrigin(request);

  if (crossOrigin) {
    return crossOrigin;
  }

  // Accept both a JSON fetch and a plain <form> POST, so the demo works with curl
  // and with JavaScript switched off.
  let raw: unknown;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    raw = contentType.includes("application/json")
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch (error) {
    console.warn("[login] could not parse the request body:", error);
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }

  const body = parseBody(raw);

  if (!body) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const result = await signIn(body.email, body.password);

  if (!result) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const response = NextResponse.json(result.user);

  response.cookies.set(result.cookie);

  return response;
}
