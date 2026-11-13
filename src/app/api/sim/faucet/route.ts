import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { simFaucet, simUsdcEnabled } from '@/lib/server/sim-usdc';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** DEMO ONLY: credits 100 simulated USDC (capped at 1000 per wallet). */
export async function POST(request: Request) {
  if (!simUsdcEnabled()) return NextResponse.json({ error: 'Simulated USDC is disabled' }, { status: 404 });
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  const wallet = session.user.walletAddress;
  if (!wallet) return NextResponse.json({ error: 'Wallet has not been created yet' }, { status: 409 });
  const result = await simFaucet(prisma, wallet);
  if (result === 'cap') return NextResponse.json({ error: 'You already have plenty of test USDC' }, { status: 429 });
  return NextResponse.json({ success: true });
}
