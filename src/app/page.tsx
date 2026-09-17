// src/app/page.tsx
import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Partner Portal</h1>
      <p>A companion demo for the FocusReactive article on protected routes in Next.js.</p>
      <ul>
        <li>
          <Link href="/documents">Documents</Link> (any signed-in user)
        </li>
        <li>
          <Link href="/admin">Admin</Link> (admin role only)
        </li>
        <li>
          <Link href="/login">Sign in</Link>
        </li>
      </ul>
    </main>
  );
}
