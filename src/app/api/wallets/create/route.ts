import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { custodialEnabled, keypairFromEncrypted, newCustodialKey, setupCustodialWallet } from '@/lib/server/custodial';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** DEMO ONLY: creates a server-held wallet for the signed-in user. */
export async function POST(request: Request) {
  if (!custodialEnabled()) {
    return NextResponse.json({ error: 'Server-held wallets are disabled' }, { status: 404 });
  }
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  try {
    let kp;
    let firstTime = false;
    if (session.user.walletAddress && session.user.walletSecretEnc) {
      // Retry of an unfinished setup: reuse the stored key.
      kp = keypairFromEncrypted(session.user.walletSecretEnc);
    } else if (session.user.walletAddress) {
      return NextResponse.json({ error: 'This account already has a self-custody wallet' }, { status: 409 });
    } else {
      const created = newCustodialKey();
      // Save the key BEFORE any on-chain step, so a later failure can never orphan funds or a registry entry.
      const saved = await prisma.user.updateMany({
        where: { id: session.userId, walletAddress: null },
        data: { walletAddress: created.address, walletSecretEnc: created.secretEnc },
      });
      if (saved.count === 0) return NextResponse.json({ error: 'Wallet already exists' }, { status: 409 });
      kp = created.kp;
      firstTime = true;
    }
    const { registryTxHash } = await setupCustodialWallet(session.user.phoneHash, kp, firstTime);
    return NextResponse.json({ success: true, walletAddress: kp.publicKey(), registryTxHash });
  } catch (error) {
    // Details stay in the server log; internal errors must never reach the browser.
    console.error('Custodial wallet setup failed:', error);
    return NextResponse.json({ error: 'Could not finish wallet setup. Please try again.' }, { status: 502 });
  }
}
