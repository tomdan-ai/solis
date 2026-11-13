import { PrismaPg } from '@prisma/adapter-pg';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getPendingSession } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** Step 2 of login: a pending (post-OTP) session asks for a passkey challenge. */
export async function POST(request: Request) {
  const session = await getPendingSession(prisma, request);
  if (!session) {
    return NextResponse.json({ error: 'Sign in with your phone number first' }, { status: 401 });
  }

  const passkeys = await prisma.passkey.findMany({
    where: { userId: session.userId },
    select: { credentialId: true },
  });
  if (passkeys.length === 0) {
    return NextResponse.json({ error: 'No passkey is registered for this account' }, { status: 409 });
  }

  const options = await generateAuthenticationOptions({
    rpID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
    allowCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId })),
    userVerification: 'required',
  });

  await prisma.passkeyChallenge.upsert({
    where: { sessionId: session.id },
    update: { challenge: options.challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    create: { sessionId: session.id, challenge: options.challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });

  return NextResponse.json(options);
}
