import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { Address, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { RelayerClient } from 'smart-account-kit';
import { getSessionFromRequest } from '@/lib/server/auth';
import {
  DEPLOY_CONTRACT_ID,
  DEPLOY_FUNCTION,
  evaluateSponsorPolicy,
} from '@/lib/server/sponsor-policy';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

function describeHostFunction(hostFn: xdr.HostFunction) {
  if (hostFn.type === 'hostFunctionTypeInvokeContract') {
    const call = hostFn.invokeContract;
    return {
      contractId: Address.fromScAddress(call.contractAddress).toString(),
      functionName: String(call.functionName),
    };
  }
  if (hostFn.type === 'hostFunctionTypeCreateContract' || hostFn.type === 'hostFunctionTypeCreateContractV2') {
    return { contractId: DEPLOY_CONTRACT_ID, functionName: DEPLOY_FUNCTION };
  }
  return null;
}

/**
 * Relayer proxy for Smart Account Kit (`relayerUrl`). The contract and function
 * are decoded from the signed payload itself, never taken from client claims,
 * and run through the sponsor policy before reaching the real relayer.
 */
export async function POST(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Session is invalid or expired' }, { status: 401 });
    }
    const relayerUrl = process.env.RELAYER_URL?.trim();
    if (!relayerUrl) {
      return NextResponse.json({ success: false, error: 'RELAYER_URL is not configured' }, { status: 503 });
    }

    const body = (await request.json()) as { func?: unknown; auth?: unknown; xdr?: unknown };
    let hostFn: xdr.HostFunction | null = null;
    if (typeof body.func === 'string' && Array.isArray(body.auth)) {
      hostFn = xdr.HostFunction.fromXDR(body.func, 'base64');
    } else if (typeof body.xdr === 'string') {
      const tx = TransactionBuilder.fromXDR(body.xdr, passphrase);
      const op = 'operations' in tx ? tx.operations[0] : undefined;
      if (op && op.type === 'invokeHostFunction') {
        hostFn = (op as Operation.InvokeHostFunction).func;
      }
    }
    const target = hostFn ? describeHostFunction(hostFn) : null;
    if (!target) {
      return NextResponse.json({ success: false, error: 'Unsupported transaction' }, { status: 400 });
    }

    const feeStroops = BigInt(process.env.SPONSOR_ESTIMATED_FEE_STROOPS ?? '100000');
    const policy = await evaluateSponsorPolicy({
      prisma,
      userId: session.userId,
      walletAddress: session.user.walletAddress,
      request: { ...target, feeStroops, simulationSucceeded: true },
    });
    const record = await prisma.sponsoredTx.create({
      data: {
        userId: session.userId,
        fn: `${target.contractId}:${target.functionName}`,
        feeStroops,
        decision: policy.approved ? 'APPROVED' : 'REJECTED',
        reason: policy.reason,
      },
    });
    if (!policy.approved) {
      return NextResponse.json({ success: false, error: policy.reason, errorCode: policy.reason }, { status: 403 });
    }

    const relayer = new RelayerClient(relayerUrl);
    const result = typeof body.xdr === 'string'
      ? await relayer.sendXdr(body.xdr)
      : await relayer.send(body.func as string, body.auth as string[]);
    if (!result.success) {
      await prisma.sponsoredTx.update({
        where: { id: record.id },
        data: { decision: 'FAILED', reason: result.errorCode ?? 'RELAY_FAILED' },
      });
      return NextResponse.json(
        { success: false, error: result.error ?? 'Relayer rejected the transaction', errorCode: result.errorCode },
        { status: 502 },
      );
    }

    const hash = result.hash ?? result.transactionId;
    await prisma.sponsoredTx.update({ where: { id: record.id }, data: { txHash: hash, reason: 'SUBMITTED' } });
    return NextResponse.json({ success: true, data: { hash, transactionId: result.transactionId, status: result.status } });
  } catch (error) {
    console.error('Relay proxy error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
