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
    // 204, not 403. The click comes from an `<a download>` anchor: the browser
    // writes whatever body it receives straight to disk under the link's filename,
    // so a 403 with a JSON or HTML body lands in ~/Downloads as a broken "file".
    // An empty 204 makes the browser do nothing at all, which is the honest UX.
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
