import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken } from '@/lib/auth';

// The Secure cookie attribute tells browsers to only send/store the cookie
// over HTTPS. Setting it on a plain-HTTP response makes browsers silently
// discard the cookie, so login would "succeed" (200) yet the session never
// sticks and every page bounces back to /login. Only mark the cookie Secure
// when the request actually arrived over HTTPS (direct or via a
// TLS-terminating proxy signalling x-forwarded-proto), unless explicitly
// overridden with COOKIE_SECURE=true/false.
function shouldMarkCookieSecure(req: NextRequest) {
  const override = process.env.COOKIE_SECURE?.toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  if (forwardedProto === 'http') return false;
  return req.nextUrl.protocol === 'https:';
}

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;

  if (!validUser || !validPass) {
    return NextResponse.json(
      { error: 'Server auth is not configured (set ADMIN_USERNAME / ADMIN_PASSWORD)' },
      { status: 500 }
    );
  }

  if (username !== validUser || password !== validPass) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const token = await createSessionToken(username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set('dashboard_session', token, {
    httpOnly: true,
    secure: shouldMarkCookieSecure(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}
