import { SignJWT } from 'jose';
import { verifySessionToken } from './session';

// Falls back to a dev-only secret so `next dev` doesn't crash without a .env,
// but this MUST be overridden in production via SESSION_SECRET.
const secret = new TextEncoder().encode(
  process.env.SESSION_SECRET || 'dev-secret-change-me-before-deploying'
);

export async function createSessionToken(username: string) {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export { verifySessionToken };
