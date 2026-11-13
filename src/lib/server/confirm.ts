import { createHash, randomBytes } from 'crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { PrismaClient } from '@/generated/prisma/client';
import type { StellarOperation } from '@/lib/server/stellar';

/**
 * Payment approval by passkey. The passkey signs a challenge derived from the exact
 * operation (kind, counterparty, amount) plus a nonce, so an approval for one payment
 * cannot be replayed for another, and each challenge is single-use.
 */

/** Only the fields the user actually intends; server-set fields (sender, expiry) are excluded. */
export function canonicalOperation(op: StellarOperation): string {
  switch (op.kind) {
    case 'transfer': return JSON.stringify([op.kind, op.recipient, op.amount]);
    case 'deposit': return JSON.stringify([op.kind, op.phoneHash, op.amount]);
    default: return JSON.stringify([op.kind, op.paymentId]);
  }
}

export function challengeFor(op: StellarOperation, nonce: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(`${canonicalOperation(op)}:${nonce}`).digest());
}

export const newNonce = () => randomBytes(16).toString('base64url');
export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export type Approval = { assertion: AuthenticationResponseJSON; nonce: string };

/** Throws unless the user has approved exactly this operation. No-op for users without a passkey. */
export async function requirePasskeyApproval(
  prisma: PrismaClient,
  session: { id: string; userId: string },
  operation: StellarOperation,
  approval: Approval | undefined,
): Promise<void> {
  const passkeyCount = await prisma.passkey.count({ where: { userId: session.userId } });
  if (passkeyCount === 0) return;
  if (!approval?.assertion || typeof approval.nonce !== 'string') {
    throw new Error('Passkey confirmation required');
  }

  const stored = await prisma.passkeyChallenge.findUnique({ where: { sessionId: session.id } });
  if (!stored || stored.expiresAt <= new Date()) throw new Error('Passkey confirmation expired. Try again.');
  if (stored.challenge !== toBase64Url(challengeFor(operation, approval.nonce))) {
    throw new Error('Passkey approval does not match this payment');
  }

  const passkey = await prisma.passkey.findFirst({ where: { credentialId: approval.assertion.id, userId: session.userId } });
  if (!passkey) throw new Error('This passkey is not registered for your account');

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: approval.assertion,
      expectedChallenge: stored.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
      credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter },
      requireUserVerification: true,
    });
  } catch {
    throw new Error('Passkey approval failed');
  }
  if (!verification.verified) throw new Error('Passkey approval failed');

  await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: verification.authenticationInfo.newCounter } });
  await prisma.passkeyChallenge.delete({ where: { sessionId: session.id } }); // single use
}
