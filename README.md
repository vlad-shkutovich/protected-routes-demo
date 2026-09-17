# Protected routes demo — partner portal

Companion repository for the FocusReactive article **"How to Implement Protected Routes in
Next.js with Middleware and JWT"**. It is a deliberately unstyled Next.js 16 App Router app
whose only subject is authorization: a JWT session in an `HttpOnly` cookie, an optimistic
check in `proxy.ts`, and a Data Access Layer that is the actual security boundary.

There is no UI library, no Tailwind and no design. Every file is about the logic.

## What it shows

- `src/proxy.ts` — Next.js 16's renamed middleware. An **optimistic** check: it verifies the
  cookie's JWT and bounces signed-out traffic, redirecting page navigations to `/login` and
  answering `/api/*` with a JSON `401`. It also slides the session by re-issuing a token that
  is about to expire.
- `src/lib/dal.ts` — the Data Access Layer. Every page, route handler and Server Action calls
  it, and it re-checks the session **against the store** on every call. This is what catches a
  deleted account or a revoked role that a still-valid token knows nothing about.
- `src/lib/session.ts` — `signSession` / `verifySession` with [jose](https://github.com/panva/jose),
  HS256, pinned `iss` / `aud` / `alg`, runtime-narrowed claims. Plus an unused
  `verifySessionWithJwks` showing the RS256 + JWKS shape you would use with an external IdP.
- `src/app/documents/[id]/download/route.ts` — a download endpoint whose refusal is a `204`,
  not a `403`, and whose success is a `302` to an absolute same-origin URL. Both choices are
  explained in comments; both are browser-behaviour traps.
- `src/app/documents/actions.ts` — a Server Action that checks the session itself, because a
  Server Action is a public HTTP endpoint the proxy may never see.

`examples/next-15/middleware.ts` holds the same logic written as a Next.js 15 `middleware.ts`.
It lives outside `src/` on purpose: Next.js 16 refuses to build a project that contains both
conventions.

## Running it

```bash
npm install
cp .env.example .env.local
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # paste into JWT_SECRET
npm run dev
```

`JWT_SECRET` must be at least 32 characters; `src/lib/session.ts` throws at startup otherwise,
which is the point — an app that boots without a real secret issues forgeable sessions.

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
curl -s -o /dev/null -D - -b member.jar "$BASE/admin"                        # 307 -> /documents

# the revocation demo: delete the account while the cookie is still valid
curl -s -X POST "$BASE/api/dev/revoke" -H 'content-type: application/json' \
  -b member.jar -d '{"userId":"u_member"}'
curl -s -o /dev/null -D - -b member.jar "$BASE/documents"                    # 307 -> /login
```

The server log for that last pair is the whole argument of the article: the proxy prints
`passed the optimistic check`, and the DAL prints `valid token for unknown user`. The proxy was
never the guarantee.

`/api/dev/revoke` returns `404` when `NODE_ENV=production`.

Full transcripts, exact versions and the traps hit while building this against 16.3.5 are in
[VERIFICATION.md](./VERIFICATION.md).
