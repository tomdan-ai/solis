import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { buildPreparedTransaction, StellarOperation } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOperation(value: unknown): value is StellarOperation {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'transfer') {
    return typeof value.sender === 'string' && typeof value.recipient === 'string' && typeof value.amount === 'string';
  }
  if (value.kind === 'deposit') {
    return typeof value.sender === 'string' && typeof value.phoneHash === 'string' && typeof value.amount === 'string' && typeof value.expiresAt === 'number';
  }
  return (value.kind === 'claim' || value.kind === 'refund') && typeof value.paymentId === 'string';
}

export async function POST(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }
    if (!session.user.walletAddress) {
      return NextResponse.json({ error: 'Wallet has not been created yet' }, { status: 409 });
    }

    const body = await request.json() as { operation?: unknown };
    if (!isOperation(body.operation)) {
      return NextResponse.json({ error: 'A valid transaction operation is required' }, { status: 400 });
    }

    const source = session.user.walletAddress;
    if ('sender' in body.operation && body.operation.sender !== source) {
      return NextResponse.json({ error: 'Operation sender does not match the session wallet' }, { status: 403 });
    }

    const prepared = await buildPreparedTransaction(source, body.operation);
    return NextResponse.json({ success: true, simulationSucceeded: true, ...prepared });
  } catch (error) {
    console.error('Transaction build error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not build transaction' },
      { status: 400 },
    );
  }
}
