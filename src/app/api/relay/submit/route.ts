import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { evaluateSponsorPolicy } from '@/lib/server/sponsor-policy';
import { RelayerClient } from 'smart-account-kit';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

type SubmitBody = {
  contractId?: unknown;
  functionName?: unknown;
  signedXdr?: unknown;
  relayerFunc?: unknown;
  relayerAuth?: unknown;
  feeStroops?: unknown;
  simulationSucceeded?: unknown;
};

function parseFee(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Authorization header required (Bearer token)' },
        { status: 401 },
      );
    }

    const sessionId = authHeader.slice('Bearer '.length).trim();
    if (!sessionId) {
      return NextResponse.json({ error: 'Session token is required' }, { status: 401 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }

    let body: SubmitBody;
    try {
      body = (await request.json()) as SubmitBody;
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
    }

    const contractId = body.contractId;
    const functionName = body.functionName;
    const signedXdr = body.signedXdr;
    const relayerFunc = body.relayerFunc;
    const relayerAuth = body.relayerAuth;
    const feeStroops = parseFee(body.feeStroops);

    if (!isString(contractId, 128) || !isString(functionName, 64)) {
      return NextResponse.json(
        { error: 'contractId and functionName are required' },
        { status: 400 },
      );
    }
    const hasSignedXdr = isString(signedXdr, 500_000);
    const hasRelayerPayload =
      isString(relayerFunc, 500_000) &&
      Array.isArray(relayerAuth) &&
      relayerAuth.every((entry) => isString(entry, 500_000));
    if (!hasSignedXdr && !hasRelayerPayload) {
      return NextResponse.json(
        { error: 'A signedXdr or relayerFunc and relayerAuth payload is required' },
        { status: 400 },
      );
    }
    if (feeStroops === null) {
      return NextResponse.json(
        { error: 'feeStroops must be a non-negative integer' },
        { status: 400 },
      );
    }
    if (typeof body.simulationSucceeded !== 'boolean') {
      return NextResponse.json(
        { error: 'simulationSucceeded must be a boolean' },
        { status: 400 },
      );
    }

    const policy = await evaluateSponsorPolicy({
      prisma,
      userId: session.userId,
      walletAddress: session.user.walletAddress,
      request: {
        contractId,
        functionName,
        feeStroops,
        simulationSucceeded: body.simulationSucceeded,
      },
    });

    const sponsoredTx = await prisma.sponsoredTx.create({
      data: {
        userId: session.userId,
        fn: `${contractId}:${functionName}`,
        feeStroops,
        decision: policy.approved ? 'APPROVED' : 'REJECTED',
        reason: policy.reason,
      },
    });

    if (!policy.approved) {
      return NextResponse.json(
        {
          success: false,
          status: 'rejected',
          sponsoredTxId: sponsoredTx.id,
          reason: policy.reason,
        },
        { status: 403 },
      );
    }

    const relayerUrl = process.env.RELAYER_URL?.trim();
    if (relayerUrl) {
      const relayer = new RelayerClient(relayerUrl);
      const result = hasSignedXdr
        ? await relayer.sendXdr(signedXdr as string)
        : await relayer.send(relayerFunc as string, relayerAuth as string[]);

      if (!result.success) {
        await prisma.sponsoredTx.update({
          where: { id: sponsoredTx.id },
          data: { decision: 'FAILED', reason: result.errorCode ?? 'RELAY_FAILED' },
        });
        return NextResponse.json(
          {
            success: false,
            status: 'failed',
            sponsoredTxId: sponsoredTx.id,
            reason: result.errorCode ?? 'RELAY_FAILED',
            error: result.error ?? 'Relayer rejected the transaction',
          },
          { status: 502 },
        );
      }

      await prisma.sponsoredTx.update({
        where: { id: sponsoredTx.id },
        data: { txHash: result.hash ?? result.transactionId, reason: 'SUBMITTED' },
      });
      return NextResponse.json(
        {
          success: true,
          status: 'submitted',
          sponsoredTxId: sponsoredTx.id,
          txHash: result.hash ?? result.transactionId,
        },
        { status: 202 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        status: 'pending',
        sponsoredTxId: sponsoredTx.id,
        message: 'Transaction approved and queued; configure RELAYER_URL to submit it',
      },
      { status: 202 },
    );
  } catch (error) {
    console.error('Relay submit error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
