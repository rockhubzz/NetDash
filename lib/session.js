// Plain-JS session verification shared between Next's middleware (via
// lib/auth.ts, which re-exports this) and server.js's raw WebSocket upgrade
// handler, which runs outside Next's request pipeline entirely and so needs
// its own auth check.
//
// `jose` v5 ships ESM-only, so a static require() of it would fail from this
// CommonJS file - dynamic import() works from CJS regardless of module
// system, so that's what we use here.

async function verifySessionToken(token) {
  try {
    const { jwtVerify } = await import('jose');
    const secret = new TextEncoder().encode(
      process.env.SESSION_SECRET || 'dev-secret-change-me-before-deploying'
    );
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

module.exports = { verifySessionToken, getCookie };
