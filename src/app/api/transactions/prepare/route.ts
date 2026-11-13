import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { prepareInvocation, StellarOperation } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    const wallet = session.user.walletAddress;
    if (!wallet) return NextResponse.json({ error: 'Wallet has not been created yet' }, { status: 409 });

    const { operation } = (await request.json()) as { operation?: StellarOperation };
    if (!operation || !['transfer', 'deposit', 'claim', 'refund'].includes(operation.kind)) {
      return NextResponse.json({ error: 'A valid operation is required' }, { status: 400 });
    }
    // The sender is always the session wallet; never trust a client-supplied one.
    if (operation.kind === 'transfer' || operation.kind === 'deposit') {
      operation.sender = wallet;
    }
    if (operation.kind === 'claim' || operation.kind === 'refund') {
      const payment = await prisma.escrowPayment.findUnique({ where: { onchainId: BigInt(operation.paymentId) } });
      if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
      const allowed = operation.kind === 'claim'
        ? payment.phoneHash === session.user.phoneHash
        : payment.senderWallet === wallet;
      if (!allowed) return NextResponse.json({ error: 'Not permitted for this payment' }, { status: 403 });
    }
    return NextResponse.json({ success: true, ...(await prepareInvocation(wallet, operation)) });
  } catch (error) {
    console.error('Prepare error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare transaction' }, { status: 400 });
  }
}
