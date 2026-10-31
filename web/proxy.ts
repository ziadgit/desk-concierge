import { NextResponse, type NextRequest } from "next/server";

// HTTP basic auth on everything the owner uses: the inbox page, the
// CopilotKit endpoint (it spends Claude credits), and the owner API.
// Any username works; only OWNER_PASSWORD is checked. With OWNER_PASSWORD
// unset the inbox is open to anyone with the URL. The device API and
// health check are excluded by the matcher; FastAPI checks the device
// token itself.
export function proxy(request: NextRequest) {
  const expected = process.env.OWNER_PASSWORD;
  if (!expected) return NextResponse.next();
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password === expected) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Desk Inbox"' },
  });
}

export const config = {
  matcher: ["/((?!api/device|healthz|_next/static|_next/image|favicon.ico).*)"],
};
