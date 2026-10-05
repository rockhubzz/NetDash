import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  // Mirror the login cookie's flags: some browsers won't delete a Secure
  // cookie with a non-Secure clearing response, so derive Secure the same
  // way login does.
  const override = process.env.COOKIE_SECURE?.toLowerCase();
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
  const secure =
    override === 'true' ||
    (override !== 'false' &&
      (forwardedProto === 'https' ||
        (!forwardedProto && req.nextUrl.protocol === 'https:')));
  res.cookies.set('dashboard_session', '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
