import { PrismaPg } from '@prisma/adapter-pg';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function rpId() {
  return process.env.WEBAUTHN_RP_ID ?? 'localhost';
}

export async function POST(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) {
    return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  }

  const existingPasskeys = await prisma.passkey.findMany({
    where: { userId: session.userId },
    select: { credentialId: true },
  });

  const options = await generateRegistrationOptions({
    rpName: 'Solis',
    rpID: rpId(),
    userID: Buffer.from(session.userId),
    userName: session.user.phoneHash,
    userDisplayName: 'Solis wallet',
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map((passkey) => ({ id: passkey.credentialId })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  await prisma.passkeyChallenge.upsert({
    where: { sessionId: session.id },
    update: {
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
    create: {
      sessionId: session.id,
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return NextResponse.json(options);
}
