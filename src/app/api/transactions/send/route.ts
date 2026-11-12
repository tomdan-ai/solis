import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { custodialEnabled, signAndSubmitAsUser } from '@/lib/server/custodial';
import { evaluateSponsorPolicy } from '@/lib/server/sponsor-policy';
import { buildPreparedTransaction, StellarOperation } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** DEMO ONLY: builds, policy-checks, signs (server-held key) and submits a payment action. */
export async function POST(request: Request) {
  if (!custodialEnabled()) return NextResponse.json({ error: 'Server-held wallets are disabled' }, { status: 404 });
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    const wallet = session.user.walletAddress;
    if (!wallet || !session.user.walletSecretEnc) {
      return NextResponse.json({ error: 'Wallet has not been created yet' }, { status: 409 });
    }

    const { operation } = (await request.json()) as { operation?: StellarOperation };
    if (!operation || !['transfer', 'deposit', 'claim', 'refund'].includes(operation.kind)) {
      return NextResponse.json({ error: 'A valid operation is required' }, { status: 400 });
    }
    if (operation.kind === 'transfer' || operation.kind === 'deposit') operation.sender = wallet;
    if (operation.kind === 'claim' || operation.kind === 'refund') {
      const payment = await prisma.escrowPayment.findUnique({ where: { onchainId: BigInt(operation.paymentId) } });
      if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
      const allowed = operation.kind === 'claim' ? payment.phoneHash === session.user.phoneHash : payment.senderWallet === wallet;
      if (!allowed) return NextResponse.json({ error: 'Not permitted for this payment' }, { status: 403 });
    }

    const prepared = await buildPreparedTransaction(wallet, operation);
    const contractId = operation.kind === 'transfer' ? process.env.SOLIS_USDC_CONTRACT_ID! : process.env.SOLIS_ESCROW_CONTRACT_ID!;
    const policy = await evaluateSponsorPolicy({
      prisma,
      userId: session.userId,
      walletAddress: wallet,
      request: { contractId, functionName: operation.kind, feeStroops: BigInt(prepared.feeStroops), simulationSucceeded: true },
    });
    const record = await prisma.sponsoredTx.create({
      data: {
        userId: session.userId,
        fn: `${contractId}:${operation.kind}`,
        feeStroops: BigInt(prepared.feeStroops),
        decision: policy.approved ? 'APPROVED' : 'REJECTED',
        reason: policy.reason,
      },
    });
    if (!policy.approved) return NextResponse.json({ error: policy.reason }, { status: 403 });

    try {
      const hash = await signAndSubmitAsUser(session.user.walletSecretEnc, prepared.xdr);
      await prisma.sponsoredTx.update({ where: { id: record.id }, data: { txHash: hash, reason: 'SUBMITTED_CUSTODIAL' } });
      return NextResponse.json({ success: true, hash });
    } catch (error) {
      await prisma.sponsoredTx.update({ where: { id: record.id }, data: { decision: 'FAILED', reason: 'SUBMIT_FAILED' } });
      throw error;
    }
  } catch (error) {
    console.error('Custodial send error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Transaction failed' }, { status: 400 });
  }
}
