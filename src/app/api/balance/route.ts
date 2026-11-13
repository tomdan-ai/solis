import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { getUsdcBalance, getXlmBalance } from '@/lib/server/stellar';
import { simBalance, simUsdcEnabled } from '@/lib/server/sim-usdc';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function GET(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  if (!session.user.walletAddress) return NextResponse.json({ balance: '0', xlm: '0', simulated: simUsdcEnabled() });
  try {
    const wallet = session.user.walletAddress;
    const simulated = simUsdcEnabled();
    const [balance, xlm] = await Promise.all([
      simulated ? simBalance(prisma, wallet).then(String) : getUsdcBalance(wallet),
      getXlmBalance(wallet).catch(() => '0'),
    ]);
    return NextResponse.json({ balance, xlm, simulated });
  } catch {
    return NextResponse.json({ error: 'Could not read balance' }, { status: 502 });
  }
}
