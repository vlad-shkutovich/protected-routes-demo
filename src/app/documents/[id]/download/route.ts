// src/app/documents/[id]/download/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getDocumentForCurrentUser } from "@/lib/dal";

export async function GET(
  request: NextRequest,
  // `params` is a Promise in Next.js 15+.
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Authorization happens here, through the DAL, not in the proxy. The proxy only
  // knows there is a token; it does not know which documents this user may read,
  // and it never will without a database round trip it should not be making.
  const doc = await getDocumentForCurrentUser(id);

  if (!doc) {
    // 204, not 403. The click comes from an `<a download>` anchor: the browser
    // writes whatever body it receives straight to disk under the link's filename,
    // so a 403 with a JSON or HTML body lands in ~/Downloads as a broken "file".
    // An empty 204 makes the browser do nothing at all, which is the honest UX.
    return new NextResponse(null, { status: 204 });
  }

  // Absolute, same-origin Location. A relative Location, or one pointing at a CDN
  // on another origin, makes the browser drop the `download` attribute and open
  // the file in a tab instead of saving it.
  const target = new URL(`/files/${doc.fileName}`, request.nextUrl.origin);

  return NextResponse.redirect(target, 302);
}
