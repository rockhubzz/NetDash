import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/auth';

export const config = {
  // NOTE: /ws/* MUST stay excluded. Device streams are raw WebSocket
  // upgrades handled in server.js (which verifies the session cookie
  // itself). If middleware matched them, Next's upgrade pipeline would
  // invoke this middleware with the socket as the response object, race
  // server.js's own upgrade handler, and corrupt the handshake - the
  // device view would sit at "Connecting…" forever.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|ws).*)'],
};

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const token = req.cookies.get('dashboard_session')?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}
