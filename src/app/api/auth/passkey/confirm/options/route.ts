import { PrismaPg } from '@prisma/adapter-pg';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { challengeFor, newNonce } from '@/lib/server/confirm';
import type { StellarOperation } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** Issues a passkey challenge bound to one specific payment operation. */
export async function POST(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });

  const { operation } = (await request.json().catch(() => ({}))) as { operation?: StellarOperation };
  if (!operation || !['transfer', 'deposit', 'claim', 'refund'].includes(operation.kind)) {
    return NextResponse.json({ error: 'A valid operation is required' }, { status: 400 });
  }

  const passkeys = await prisma.passkey.findMany({ where: { userId: session.userId }, select: { credentialId: true } });
  if (passkeys.length === 0) return NextResponse.json({ error: 'No passkey is registered for this account' }, { status: 409 });

  const nonce = newNonce();
  const options = await generateAuthenticationOptions({
    rpID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
    allowCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId })),
    userVerification: 'required',
    challenge: challengeFor(operation, nonce),
  });

  await prisma.passkeyChallenge.upsert({
    where: { sessionId: session.id },
    update: { challenge: options.challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    create: { sessionId: session.id, challenge: options.challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });

  return NextResponse.json({ options, nonce });
}
