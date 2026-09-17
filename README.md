# Protected routes demo — partner portal

Companion repository for the FocusReactive article **"How to Implement Protected Routes in
Next.js with Middleware and JWT"**. It is a deliberately unstyled Next.js 16 App Router app
whose only subject is authorization: a JWT session in an `HttpOnly` cookie, an optimistic
check in `proxy.ts`, and a Data Access Layer that is the actual security boundary.

There is no UI library, no Tailwind and no design. Every file is about the logic.

## What it shows

- `src/proxy.ts` — Next.js 16's renamed middleware. An **optimistic** check: it verifies the
  cookie's JWT and bounces signed-out traffic, redirecting page navigations to `/login` and
  answering `/api/*` with a JSON `401`. It also slides the session, up to the absolute
  ceiling carried in the token's `authTime` claim.
- `src/lib/dal.ts` — the Data Access Layer. Every page, route handler and Server Action calls
  it, and it re-checks the session **against the store** on every call. This is what catches a
  deleted account or a revoked role that a still-valid token knows nothing about.
- `src/lib/session.ts` — `signSession` / `verifySession` with [jose](https://github.com/panva/jose),
  HS256, pinned `iss` / `aud` / `alg` / `typ`, runtime-narrowed claims.
  `src/lib/session-jwks.example.ts` shows the RS256 + JWKS shape you would use with an
  external IdP; nothing imports it.
- `src/lib/auth.ts` — one sign-in implementation behind two entry points (the JSON route and
  the login form's Server Action), the session cookie options, and the same-origin check the
  auth endpoints need because the proxy matcher skips them.
- `src/app/documents/[id]/download/route.ts` — the files live in `content/files/`, outside
  `public/`, so this handler is the only way to read them. Its refusal is a `204`, not a
  `403`, because the click comes from an `<a download>` anchor.
- `src/app/documents/actions.ts` — a Server Action that checks the session, validates its own
  argument and resolves the document through the DAL, because a Server Action is a public
  HTTP endpoint the proxy may never see.

`examples/next-15/middleware.ts` holds the same logic written as a Next.js 15 `middleware.ts`.
It lives outside `src/` on purpose: Next.js 16 refuses to build a project that contains both
conventions.

## Running it

```bash
npm install
cp .env.example .env.local
openssl rand -hex 32   # paste into JWT_SECRET
npm run dev
```

`JWT_SECRET` must carry at least 32 bytes of key material — a 32-character hex string is only
16 bytes and is rejected. It is read at module load, so `next build` needs it too: route
collection imports `src/lib/session.ts` and a build without the variable fails with
`Failed to collect configuration for /api/auth/logout`. An empty `SESSION_TTL_SECONDS=` also
throws at boot, by design: a silently broken session is worse than a loud misconfiguration.

Scripts: `npm run dev`, `npm run build`, `npm run start`, `npm run typecheck`, `npm run lint`,
`npm run format`.

## Seeded accounts

The store is in memory and re-seeds on every server start. Password for all three:
`password123`.

| Email                 | Role      | Can download                   |
| --------------------- | --------- | ------------------------------ |
| `member@example.com`  | `member`  | brochure                       |
| `partner@example.com` | `partner` | brochure, pricing sheet        |
| `admin@example.com`   | `admin`   | brochure, pricing sheet, audit |

## curl walkthrough

```bash
BASE=http://localhost:3000

# unauthenticated page navigation -> 307 to /login with the original path preserved
curl -s -o /dev/null -D - "$BASE/documents"

# unauthenticated API request -> JSON 401, not a redirect
curl -s -i "$BASE/api/me"

# sign in; note HttpOnly, SameSite=Lax, Path=/
curl -s -i -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"member@example.com","password":"password123"}' -c member.jar

curl -s -o /dev/null -D - -b member.jar "$BASE/documents"                    # 200
curl -s -o /dev/null -D - -b member.jar "$BASE/documents/pricing/download"   # 204, empty
curl -s -D - -b member.jar "$BASE/documents/brochure/download"               # 200 + attachment
curl -s -o /dev/null -D - -b member.jar "$BASE/admin"                        # 307 -> /documents

# a cross-site POST to the auth endpoints -> 403
curl -s -i -X POST "$BASE/api/auth/logout" -H 'Origin: https://evil.example' -b member.jar

# the revocation demo: an admin deletes the account while the member's cookie is still valid
curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"password123"}' -c admin.jar
curl -s -X POST "$BASE/api/dev/revoke" -H 'content-type: application/json' \
  -b admin.jar -d '{"userId":"u_member"}'
curl -s -o /dev/null -D - -b member.jar "$BASE/documents"                    # 307 -> /login
```

The server log for that last pair is the whole argument of the article: the proxy prints
`passed the optimistic check`, and the DAL prints `valid token for unknown user`. The proxy was
never the guarantee.

`/api/dev/revoke` requires an `admin` session and returns `404` when `NODE_ENV=production`.

## What this demo deliberately does not do

- **Logout is stateless.** It clears the cookie; a copy of the token taken beforehand stays
  valid until it expires. A `jti` denylist checked by the DAL is the production answer.
- **The store lives on `globalThis`, so it is per process.** On serverless, every instance
  seeds its own copy and a revocation in one is invisible to the others.
- **No rate limiting on login**, by choice: it would be one more moving part in a demo about
  authorization. A real login endpoint needs it.

Full transcripts, exact versions and the traps hit while building this against 16.3.5 are in
[VERIFICATION.md](./VERIFICATION.md).
