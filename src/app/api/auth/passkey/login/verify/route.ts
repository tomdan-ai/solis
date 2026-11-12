import { randomUUID } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { PENDING_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, getPendingSession, sessionCookieOptions } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** Verifies the passkey assertion and only then issues the real session cookie. */
export async function POST(request: Request) {
  const session = await getPendingSession(prisma, request);
  if (!session) {
    return NextResponse.json({ error: 'Sign in with your phone number first' }, { status: 401 });
  }

  const challenge = await prisma.passkeyChallenge.findUnique({ where: { sessionId: session.id } });
  if (!challenge || challenge.expiresAt <= new Date()) {
    return NextResponse.json({ error: 'Passkey challenge is missing or expired' }, { status: 400 });
  }

  let response: AuthenticationResponseJSON;
  try {
    response = (await request.json()) as AuthenticationResponseJSON;
  } catch {
    return NextResponse.json({ error: 'Passkey response must be valid JSON' }, { status: 400 });
  }

  // The credential must belong to this very user, not just any registered passkey.
  const passkey = await prisma.passkey.findFirst({ where: { credentialId: response.id, userId: session.userId } });
  if (!passkey) {
    return NextResponse.json({ error: 'This passkey is not registered for your account' }, { status: 403 });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
    }

    await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: verification.authenticationInfo.newCounter } });
    await prisma.passkeyChallenge.delete({ where: { sessionId: session.id } });

    // The pending session is thrown away; the real one gets a new, unrelated id.
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const full = await prisma.session.create({ data: { id: randomUUID(), userId: session.userId, expiresAt } });
    await prisma.session.delete({ where: { id: session.id } });

    const ok = NextResponse.json({ success: true, walletAddress: session.user.walletAddress });
    ok.cookies.set(SESSION_COOKIE, full.id, sessionCookieOptions(expiresAt));
    ok.cookies.set(PENDING_COOKIE, '', { path: '/', maxAge: 0 });
    return ok;
  } catch (error) {
    console.error('Passkey login error:', error);
    return NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
  }
}
