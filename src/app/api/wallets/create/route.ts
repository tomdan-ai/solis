import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { createCustodialWallet, custodialEnabled } from '@/lib/server/custodial';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** DEMO ONLY: creates a server-held wallet for the signed-in user. */
export async function POST(request: Request) {
  if (!custodialEnabled()) {
    return NextResponse.json({ error: 'Server-held wallets are disabled' }, { status: 404 });
  }
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  if (session.user.walletAddress) {
    return NextResponse.json({ success: true, walletAddress: session.user.walletAddress });
  }
  try {
    const wallet = await createCustodialWallet(session.user.phoneHash);
    // Only set if still empty, so a double-click cannot create two wallets.
    const updated = await prisma.user.updateMany({
      where: { id: session.userId, walletAddress: null },
      data: { walletAddress: wallet.address, walletSecretEnc: wallet.secretEnc },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: 'Wallet already exists' }, { status: 409 });
    }
    return NextResponse.json({ success: true, walletAddress: wallet.address, registryTxHash: wallet.registryTxHash });
  } catch (error) {
    console.error('Custodial wallet creation failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create wallet' }, { status: 502 });
  }
}
