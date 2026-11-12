import { PrismaClient } from '@/generated/prisma/client';

/**
 * DEMO ONLY. While no testnet USDC is available, USDC balances and movements live in a
 * database ledger instead of on-chain. Wallets, XLM, trustlines and phone lookups stay real.
 * Refused in production no matter what the flag says.
 */
export function simUsdcEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SIMULATE_USDC === 'true';
}

export function simEscrowExpirySeconds(): number {
  const value = Number(process.env.SIM_ESCROW_EXPIRY_SECONDS);
  return Number.isInteger(value) && value > 0 ? value : 120;
}

export const SIM_FAUCET_AMOUNT = BigInt(100) * BigInt(10_000_000);
const SIM_FAUCET_CAP = BigInt(1000) * BigInt(10_000_000);

/** Anything that can run raw SQL: the client itself or an interactive transaction. */
type Sql = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export async function simBalance(db: Sql, wallet: string): Promise<bigint> {
  const rows = await db.$queryRaw<Array<{ balance: bigint }>>`SELECT "balance" FROM "SimBalance" WHERE "wallet" = ${wallet}`;
  return rows[0]?.balance ?? BigInt(0);
}

export async function simCredit(db: Sql, wallet: string, amount: bigint) {
  await db.$executeRaw`
    INSERT INTO "SimBalance" ("wallet", "balance", "updatedAt") VALUES (${wallet}, ${amount}::bigint, NOW())
    ON CONFLICT ("wallet") DO UPDATE SET "balance" = "SimBalance"."balance" + ${amount}::bigint, "updatedAt" = NOW()`;
}

/** Atomic debit; false when the balance is too low. */
export async function simDebit(db: Sql, wallet: string, amount: bigint): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ balance: bigint }>>`
    UPDATE "SimBalance" SET "balance" = "balance" - ${amount}::bigint, "updatedAt" = NOW()
    WHERE "wallet" = ${wallet} AND "balance" >= ${amount}::bigint RETURNING "balance"`;
  return rows.length === 1;
}

export async function simRecord(db: Sql, kind: string, from: string | null, to: string | null, amount: bigint, refId?: string) {
  await db.$executeRaw`
    INSERT INTO "SimTransfer" ("id", "kind", "fromWallet", "toWallet", "amount", "refId")
    VALUES (gen_random_uuid()::text, ${kind}, ${from}, ${to}, ${amount}::bigint, ${refId ?? null})`;
}

export async function simTransfers(db: Sql, wallet: string) {
  return db.$queryRaw<Array<{ id: string; kind: string; fromWallet: string | null; toWallet: string | null; amount: bigint; createdAt: Date }>>`
    SELECT "id", "kind", "fromWallet", "toWallet", "amount", "createdAt" FROM "SimTransfer"
    WHERE "fromWallet" = ${wallet} OR "toWallet" = ${wallet} ORDER BY "createdAt" DESC LIMIT 50`;
}

export async function simFaucet(prisma: PrismaClient, wallet: string): Promise<'ok' | 'cap'> {
  return prisma.$transaction(async (tx) => {
    if ((await simBalance(tx, wallet)) >= SIM_FAUCET_CAP) return 'cap';
    await simCredit(tx, wallet, SIM_FAUCET_AMOUNT);
    await simRecord(tx, 'faucet', null, wallet, SIM_FAUCET_AMOUNT);
    return 'ok';
  });
}
