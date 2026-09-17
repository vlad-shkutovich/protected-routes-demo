// src/lib/session.ts
import type { JWTVerifyResult } from "jose";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";

/**
 * Session constants. `iss` and `aud` are pinned so a token minted for another
 * service (or another environment) cannot be replayed against this app.
 */
export const SESSION_COOKIE = "session";
export const SESSION_ISSUER = "https://partner-portal.example.com";
export const SESSION_AUDIENCE = "partner-portal";

/**
 * Token lifetime, and the ceiling the sliding re-issue may not push past.
 * Both are overridable so the behaviour can be exercised locally (see
 * VERIFICATION.md, check j) without waiting out a real token.
 */
export const SESSION_TTL_SECONDS = readPositiveInt("SESSION_TTL_SECONDS", 3600);
export const MAX_SESSION_SECONDS = readPositiveInt("MAX_SESSION_SECONDS", 8 * 60 * 60);

/** Re-issue the token when it has less than this many seconds left. */
export const SESSION_REFRESH_THRESHOLD_SECONDS = 10 * 60;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  // A NaN TTL produces a token with an invalid `exp` and a cookie with no Max-Age —
  // a silently broken session rather than a loud misconfiguration. Fail at boot.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }

  return parsed;
}

export const ROLES = ["member", "partner", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type SessionPayload = {
  sub: string;
  /** A hint for the UI only. Authorization always reads the role from the store. */
  role: Role;
  /** Unix seconds of the original sign-in. Survives every re-issue; caps the sliding session. */
  authTime: number;
};

/** Thrown by `verifySession` for every failure mode. Callers fail closed on it. */
export class SessionError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(reason: string, cause?: unknown) {
    super(`Session rejected: ${reason}`);
    this.name = "SessionError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Fail fast at module load rather than at the first request: a missing or weak
 * secret is a deployment mistake, and an app that boots with one is an app that
 * silently issues forgeable sessions.
 *
 * HS256 needs at least 32 BYTES of key material, which is not the same as 32
 * characters: a 32-char hex string carries only 16 bytes, so hex is decoded first.
 */
function readSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Copy .env.example to .env.local and generate a secret.",
    );
  }

  const bytes = /^[0-9a-f]+$/iu.test(secret)
    ? Uint8Array.from(Buffer.from(secret, "hex"))
    : new TextEncoder().encode(secret);

  if (bytes.length < 32) {
    throw new Error(
      `JWT_SECRET is too weak (${bytes.length} bytes of key material). HS256 needs at least 32; run: openssl rand -hex 32`,
    );
  }

  return bytes;
}

const secretKey = readSecret();

/** Runtime narrowing. The claims come off the wire, so they are `unknown` until proven otherwise. */
function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function narrowPayload(claims: Record<string, unknown>): SessionPayload {
  const { sub, role, authTime } = claims;

  if (typeof sub !== "string" || sub.length === 0) {
    throw new SessionError("payload.sub is missing or not a string");
  }

  if (!isRole(role)) {
    throw new SessionError(`payload.role is not a known role (got ${JSON.stringify(role)})`);
  }

  if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
    throw new SessionError("payload.authTime is missing or not a number");
  }

  // Note the absence of a cast: every field is narrowed by the checks above.
  return { sub, role, authTime };
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ role: payload.role, authTime: payload.authTime })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey);
}

export type VerifiedSession = {
  payload: SessionPayload;
  /** Unix seconds. Present because `exp` is required by the verify options below. */
  expiresAt: number;
};

/**
 * Verifies a compact JWS and returns the narrowed session, or throws `SessionError`.
 * Every caller treats a throw as "no session" — there is no path that keeps going
 * with an unverified token.
 */
export async function verifySession(token: string): Promise<VerifiedSession> {
  let result: JWTVerifyResult;

  try {
    result = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"], // pin the alg: never let the token's header choose it
      typ: "JWT",
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: "5s", // two servers are never quite agreed on the time
    });
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      // error.code is stable across jose releases; the class name is what shows up in logs.
      throw new SessionError(`${error.constructor.name} (${error.code})`, error);
    }

    throw new SessionError("unexpected verification failure", error);
  }

  const { exp } = result.payload;

  if (typeof exp !== "number") {
    throw new SessionError("payload.exp is missing after verification");
  }

  return { payload: narrowPayload(result.payload), expiresAt: exp };
}

/**
 * True when the token is close to expiry AND the session has not yet run out its
 * absolute life. Without the second half an active client slides forever: every
 * re-issue would push the expiry out again, and a stolen cookie in an open tab
 * would never age out.
 */
export function shouldRefresh(session: VerifiedSession, now = Date.now()): boolean {
  const nowSeconds = Math.floor(now / 1000);

  if (nowSeconds > session.payload.authTime + MAX_SESSION_SECONDS) {
    return false;
  }

  return session.expiresAt - nowSeconds < SESSION_REFRESH_THRESHOLD_SECONDS;
}
