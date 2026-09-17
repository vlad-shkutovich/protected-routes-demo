// src/app/login/page.tsx

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth";
import { getSession } from "@/lib/dal";

/** Exactly one leading slash: `//host` and `////host` are protocol-relative URLs. */
const SINGLE_LEADING_SLASH = /^\/(?!\/)/u;

/** Any absolute origin works; it exists only so `new URL` has something to resolve against. */
const PROBE_ORIGIN = "http://safe-next.invalid";

/**
 * Only ever redirect to a path on THIS origin. `startsWith("/")` is not enough:
 * the URL parser treats a backslash as a slash, so `/\evil.example` is a
 * protocol-relative URL in disguise and the browser navigates off-site. Resolving
 * the value against a throwaway origin and comparing origins is the check that
 * survives `//host`, `/\host`, `https:evil`, and stray control characters.
 */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/")) {
    return "/documents";
  }

  let resolved: URL;

  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    // `new URL` only throws here on input the parser cannot make sense of at all.
    return "/documents";
  }

  if (resolved.origin !== PROBE_ORIGIN) {
    return "/documents";
  }

  const target = `${resolved.pathname}${resolved.search}`;

  // The origin check alone is not the end of it. Dot segments are resolved BEFORE
  // the authority is parsed, so `/..//evil.example` stays on the probe origin and
  // still comes back with the pathname `//evil.example`, which, handed to
  // `redirect()`, is a protocol-relative URL again. Demand exactly one leading
  // slash on the value that actually goes into the Location header.
  if (!SINGLE_LEADING_SLASH.test(target)) {
    return "/documents";
  }

  return target;
}

async function login(formData: FormData) {
  "use server";

  const email = formData.get("email");
  const password = formData.get("password");
  const next = safeNext(formData.get("next")?.toString());

  if (typeof email !== "string" || typeof password !== "string") {
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  // Same sign-in path as /api/auth/login: see src/lib/auth.ts.
  const result = await signIn(email, password);

  if (!result) {
    console.warn(`[login] failed sign-in attempt for ${email}`);
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  const cookieStore = await cookies();

  cookieStore.set(result.cookie);

  redirect(next);
}

export default async function LoginPage({
  searchParams,
}: {
  // `searchParams` is a Promise in Next.js 15+.
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);

  // Already signed in? Don't show the form again.
  if (await getSession()) {
    redirect(next);
  }

  return (
    <main>
      <h1>Sign in</h1>
      {params.error ? <p role="alert">Invalid email or password.</p> : null}
      <form action={login}>
        <input name="next" type="hidden" value={next} />
        <p>
          <label htmlFor="email">Email</label>
          <input defaultValue="member@example.com" id="email" name="email" type="email" />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <input defaultValue="password123" id="password" name="password" type="password" />
        </p>
        <button type="submit">Sign in</button>
      </form>
      <p>
        Seeded accounts: member@example.com, partner@example.com, admin@example.com, password{" "}
        <code>password123</code>.
      </p>
    </main>
  );
}
