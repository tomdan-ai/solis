import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { getUsdcBalance } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function GET(request: Request) {
  const session = await getSessionFromRequest(prisma, request);
  if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
  if (!session.user.walletAddress) return NextResponse.json({ balance: '0' });
  try {
    return NextResponse.json({ balance: await getUsdcBalance(session.user.walletAddress) });
  } catch {
    return NextResponse.json({ error: 'Could not read balance' }, { status: 502 });
  }
}
