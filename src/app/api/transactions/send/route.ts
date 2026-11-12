import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { custodialEnabled, signAndSubmitAsUser } from '@/lib/server/custodial';
import { evaluateSponsorPolicy } from '@/lib/server/sponsor-policy';
import { buildPreparedTransaction, StellarOperation } from '@/lib/server/stellar';
import { simCredit, simDebit, simEscrowExpirySeconds, simRecord, simUsdcEnabled } from '@/lib/server/sim-usdc';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });


/** DEMO ONLY: runs a payment action against the simulated USDC ledger instead of the chain. */
async function runSimulated(wallet: string, phoneHash: string, operation: StellarOperation) {
  if (operation.kind === 'transfer') {
    const amount = BigInt(operation.amount);
    if (amount <= BigInt(0)) throw new Error('Amount must be positive');
    if (operation.recipient === wallet) throw new Error('You cannot send to yourself');
    const recipient = await prisma.user.findUnique({ where: { walletAddress: operation.recipient } });
    if (!recipient) throw new Error('Recipient does not have a Solis wallet');
    await prisma.$transaction(async (tx) => {
      if (!(await simDebit(tx, wallet, amount))) throw new Error('Insufficient USDC balance');
      await simCredit(tx, operation.recipient, amount);
      await simRecord(tx, 'transfer', wallet, operation.recipient, amount);
    });
    return;
  }

  if (operation.kind === 'deposit') {
    const amount = BigInt(operation.amount);
    if (amount <= BigInt(0)) throw new Error('Amount must be positive');
    await prisma.$transaction(async (tx) => {
      if (!(await simDebit(tx, wallet, amount))) throw new Error('Insufficient USDC balance');
      // Negative ids can never collide with real on-chain escrow ids.
      const onchainId = -(BigInt(Date.now()) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000)));
      await tx.escrowPayment.create({
        data: {
          onchainId,
          senderWallet: wallet,
          phoneHash: operation.phoneHash,
          token: 'SIM',
          amount,
          expiresAt: new Date(Date.now() + simEscrowExpirySeconds() * 1000),
        },
      });
      await simRecord(tx, 'escrow_deposit', wallet, null, amount, onchainId.toString());
    });
    return;
  }

  const payment = await prisma.escrowPayment.findUnique({ where: { onchainId: BigInt(operation.paymentId) } });
  if (!payment || payment.token !== 'SIM') throw new Error('Payment not found');
  await prisma.$transaction(async (tx) => {
    if (operation.kind === 'claim') {
      if (payment.phoneHash !== phoneHash) throw new Error('Not permitted for this payment');
      if (payment.expiresAt.getTime() <= Date.now()) throw new Error('Payment expired');
      const moved = await tx.escrowPayment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'CLAIMED' } });
      if (moved.count === 0) throw new Error('Payment already settled');
      await simCredit(tx, wallet, payment.amount);
      await simRecord(tx, 'escrow_claim', null, wallet, payment.amount, payment.onchainId.toString());
    } else {
      if (payment.senderWallet !== wallet) throw new Error('Not permitted for this payment');
      if (payment.expiresAt.getTime() > Date.now()) throw new Error('Payment has not expired yet');
      const moved = await tx.escrowPayment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'REFUNDED' } });
      if (moved.count === 0) throw new Error('Payment already settled');
      await simCredit(tx, wallet, payment.amount);
      await simRecord(tx, 'escrow_refund', null, wallet, payment.amount, payment.onchainId.toString());
    }
  });
}

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

    if (simUsdcEnabled()) {
      await runSimulated(wallet, session.user.phoneHash, operation);
      return NextResponse.json({ success: true, hash: 'simulated', simulated: true });
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
    // Pass through simulation/chain messages, but never internal (database) errors.
    const message = error instanceof Error && !/prisma|invocation/i.test(error.message) && error.message.length < 300
      ? error.message
      : 'Transaction failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
