import { PrismaClient } from '@/generated/prisma/client';

export const SESSION_COOKIE = 'solis_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Between a correct OTP and a passkey check, a user holds only this short-lived "pending"
// cookie. It grants nothing: every API route reads SESSION_COOKIE, never this one.
export const PENDING_COOKIE = 'solis_pending';
export const PENDING_TTL_MS = 5 * 60 * 1000;
export const PENDING_ID_PREFIX = 'pending_';

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/** Session id from the httpOnly cookie, falling back to a bearer token for tooling. */
export function readSessionId(request: Request): string | null {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) return cookie;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim() || null;
}

export async function getSessionFromRequest(
  prisma: PrismaClient,
  request: Request,
) {
  const sessionId = readSessionId(request);
  // A pending (post-OTP, pre-passkey) id must never work as a real session, even if copied into the session cookie.
  if (!sessionId || sessionId.startsWith(PENDING_ID_PREFIX)) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date()) return null;

  return session;
}

export async function getPendingSession(prisma: PrismaClient, request: Request) {
  const sessionId = readCookie(request, PENDING_COOKIE);
  if (!sessionId || !sessionId.startsWith(PENDING_ID_PREFIX)) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!session || session.expiresAt <= new Date()) return null;
  return session;
}
