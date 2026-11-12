import { PrismaClient } from '@/generated/prisma/client';

const DEFAULT_MAX_USER_TRANSACTIONS = 20;
const DEFAULT_MAX_USER_FEE_STROOPS = BigInt('1000000');
const DEFAULT_GLOBAL_FEE_STROOPS = BigInt('10000000');

type SponsorRequest = {
  contractId: string;
  functionName: string;
  feeStroops: bigint;
  simulationSucceeded: boolean;
};

type PolicyContext = {
  prisma: PrismaClient;
  userId: string;
  walletAddress: string | null;
  request: SponsorRequest;
};

export type SponsorDecision = {
  approved: boolean;
  reason: string;
};

function configuredAddress(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function configuredLimit(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;

  try {
    const parsed = BigInt(value);
    return parsed > BigInt(0) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function configuredNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function allowedContractFunction(
  request: SponsorRequest,
  walletAddress: string | null,
): boolean {
  const escrowId = configuredAddress('SOLIS_ESCROW_CONTRACT_ID');
  const usdcId = configuredAddress('SOLIS_USDC_CONTRACT_ID');
  const smartAccountId = configuredAddress('SOLIS_SMART_ACCOUNT_CONTRACT_ID');

  if (
    escrowId &&
    request.contractId === escrowId &&
    ['deposit', 'claim', 'refund'].includes(request.functionName)
  ) {
    return true;
  }

  if (usdcId && request.contractId === usdcId && request.functionName === 'transfer') {
    return true;
  }

  const isUserSmartAccount = walletAddress && request.contractId === walletAddress;
  const isConfiguredSmartAccount = smartAccountId && request.contractId === smartAccountId;
  return Boolean(
    (isUserSmartAccount || isConfiguredSmartAccount) &&
      ['init', 'add_signer'].includes(request.functionName),
  );
}

export async function evaluateSponsorPolicy({
  prisma,
  userId,
  walletAddress,
  request,
}: PolicyContext): Promise<SponsorDecision> {
  if (!allowedContractFunction(request, walletAddress)) {
    return { approved: false, reason: 'FUNCTION_NOT_ALLOWED' };
  }

  if (!request.simulationSucceeded) {
    return { approved: false, reason: 'SIMULATION_FAILED' };
  }

  const maxFee = configuredLimit('SPONSOR_MAX_FEE_STROOPS', BigInt('100000'));
  if (request.feeStroops <= BigInt(0) || request.feeStroops > maxFee) {
    return { approved: false, reason: 'FEE_CAP_EXCEEDED' };
  }

  const since = startOfUtcDay();
  const [userCount, userFees, globalFees] = await Promise.all([
    prisma.sponsoredTx.count({
      where: { userId, createdAt: { gte: since } },
    }),
    prisma.sponsoredTx.aggregate({
      where: { userId, createdAt: { gte: since }, decision: 'APPROVED' },
      _sum: { feeStroops: true },
    }),
    prisma.sponsoredTx.aggregate({
      where: { createdAt: { gte: since }, decision: 'APPROVED' },
      _sum: { feeStroops: true },
    }),
  ]);

  const maxUserTransactions = configuredNumber(
    'SPONSOR_MAX_USER_TRANSACTIONS_PER_DAY',
    DEFAULT_MAX_USER_TRANSACTIONS,
  );
  if (userCount >= maxUserTransactions) {
    return { approved: false, reason: 'USER_TRANSACTION_LIMIT' };
  }

  const maxUserFees = configuredLimit(
    'SPONSOR_MAX_USER_FEE_STROOPS_PER_DAY',
    DEFAULT_MAX_USER_FEE_STROOPS,
  );
  const currentUserFees = userFees._sum.feeStroops ?? BigInt(0);
  if (currentUserFees + request.feeStroops > maxUserFees) {
    return { approved: false, reason: 'USER_FEE_LIMIT' };
  }

  const globalBudget = configuredLimit(
    'SPONSOR_GLOBAL_FEE_STROOPS_PER_DAY',
    DEFAULT_GLOBAL_FEE_STROOPS,
  );
  const currentGlobalFees = globalFees._sum.feeStroops ?? BigInt(0);
  if (currentGlobalFees + request.feeStroops > globalBudget) {
    return { approved: false, reason: 'GLOBAL_FEE_LIMIT' };
  }

  return { approved: true, reason: 'APPROVED' };
}
