// src/app/documents/[id]/download/route.ts
import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getDocumentForCurrentUser } from "@/lib/dal";

// The files live in content/, not public/: anything under public/ is served as a
// static asset by path, with no session in sight, so a "protected" file there is
// one guessed URL away from everyone. This handler is the only way to read them.
const FILES_DIR = path.join(process.cwd(), "content", "files");

export async function GET(
  _request: Request,
  // `params` is a Promise in Next.js 15+.
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Authorization happens here, through the DAL, not in the proxy. The proxy only
  // knows there is a token; it does not know which documents this user may read.
  const doc = await getDocumentForCurrentUser(id);

  if (!doc) {
    // 204, not 403. The click comes from an `<a download>` anchor: on the client
    // build this demo is based on, Chrome saved a 403 body to disk as the "file"
    // itself, while in Chromium 149 a non-2xx response instead cancels the
    // download, so the user sees nothing either way. A 204 with no body is
    // correct under both behaviours, and it also hides whether the document
    // exists, because "no such document" and "not allowed" both answer 204.
    return new NextResponse(null, { status: 204 });
  }

  const bytes = await readFile(path.join(FILES_DIR, doc.fileName));

  return new NextResponse(bytes, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // The filename the browser saves under; without it the anchor's URL wins
      // and the file lands on disk called "download".
      "content-disposition": `attachment; filename="${doc.fileName}"`,
    },
  });
}
