import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { custodialEnabled } from '@/lib/server/custodial';
import { simUsdcEnabled } from '@/lib/server/sim-usdc';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** Lets the client restore state after a reload. */
export async function GET(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    userId: session.userId,
    walletAddress: session.user.walletAddress,
    custodial: custodialEnabled(),
    hasPasskey: (await prisma.passkey.count({ where: { userId: session.userId } })) > 0,
    simulatedUsdc: simUsdcEnabled(),
    expiresAt: session.expiresAt,
    network: process.env.STELLAR_NETWORK_PASSPHRASE?.includes('Public') ? 'mainnet' : 'testnet',
  });
}
