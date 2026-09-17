// src/app/layout.tsx
import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Partner Portal: protected routes demo",
  description: "Middleware/proxy + JWT protected routes demo for a FocusReactive article.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
