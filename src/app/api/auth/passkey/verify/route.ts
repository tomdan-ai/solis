import { PrismaPg } from '@prisma/adapter-pg';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function rpId() {
  return process.env.WEBAUTHN_RP_ID ?? 'localhost';
}

function origin() {
  return process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';
}

export async function POST(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) {
    return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  }

  const challenge = await prisma.passkeyChallenge.findUnique({
    where: { sessionId: session.id },
  });
  if (!challenge || challenge.expiresAt <= new Date()) {
    return NextResponse.json({ error: 'Passkey challenge is missing or expired' }, { status: 400 });
  }

  let response: RegistrationResponseJSON;
  try {
    response = (await request.json()) as RegistrationResponseJSON;
  } catch {
    return NextResponse.json({ error: 'Passkey response must be valid JSON' }, { status: 400 });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin(),
      expectedRPID: rpId(),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
    }

    const { id: credentialID, publicKey: credentialPublicKey, counter } = verification.registrationInfo.credential;
    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: credentialID,
        publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
        counter,
      },
    });
    await prisma.passkeyChallenge.delete({ where: { sessionId: session.id } });

    return NextResponse.json({ success: true, message: 'Passkey registered' });
  } catch (error) {
    console.error('Passkey verification error:', error);
    return NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
  }
}
