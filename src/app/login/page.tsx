import { cookies } from "next/headers";
// src/app/login/page.tsx
import { redirect } from "next/navigation";

import { getSession } from "@/lib/dal";
import { findUserByEmail, verifyPassword } from "@/lib/db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";

/** Only ever redirect to a path on this origin — `next=https://evil.example` is an open redirect. */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/documents";
  }

  return value;
}

async function login(formData: FormData) {
  "use server";

  const email = formData.get("email");
  const password = formData.get("password");
  const next = safeNext(formData.get("next")?.toString());

  if (typeof email !== "string" || typeof password !== "string") {
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  const user = await findUserByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!(user && ok)) {
    console.warn(`[login] failed sign-in attempt for ${email}`);
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  const cookieStore = await cookies();

  cookieStore.set({
    name: SESSION_COOKIE,
    value: await signSession({ sub: user.id, role: user.role }),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

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
        Seeded accounts: member@example.com, partner@example.com, admin@example.com — password{" "}
        <code>password123</code>.
      </p>
    </main>
  );
}
