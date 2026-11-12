import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { rpc, scValToNative } from '@stellar/stellar-sdk';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function eventName(event: { topic: unknown[] }): string {
  return asString(scValToNative(event.topic[0] as never));
}

function eventTopic(event: { topic: unknown[] }, index: number): unknown {
  return event.topic[index] ? scValToNative(event.topic[index] as never) : undefined;
}

function eventData(event: { value: unknown }): Record<string, unknown> {
  return asRecord(scValToNative(event.value as never));
}

function parseHash(value: unknown): string {
  if (value instanceof Uint8Array) return `hmac_v1:${Buffer.from(value).toString('hex')}`;
  return `hmac_v1:${asString(value).replace(/^0x/, '')}`;
}

export async function GET(request: Request) {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret || request.headers.get('x-cron-secret') !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const escrowId = process.env.SOLIS_ESCROW_CONTRACT_ID;
  if (!escrowId) {
    return NextResponse.json({ error: 'SOLIS_ESCROW_CONTRACT_ID is not configured' }, { status: 500 });
  }

  try {
    const server = new rpc.Server(process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org');
    const latest = await server.getLatestLedger();
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    const startLedger = state?.lastLedger
      ? state.lastLedger + 1
      : Number(process.env.STELLAR_INDEXER_START_LEDGER ?? latest.sequence);
    const endLedger = latest.sequence;

    if (startLedger > endLedger) {
      return NextResponse.json({ success: true, processed: 0, lastLedger: endLedger });
    }

    const response = await server.getEvents({
      startLedger,
      endLedger,
      filters: [{ type: 'contract', contractIds: [escrowId] }],
      limit: 100,
    });
    let processed = 0;

    for (const event of response.events) {
      const name = eventName(event);
      const idValue = eventTopic(event, 1);
      if (typeof idValue !== 'bigint' && typeof idValue !== 'number' && typeof idValue !== 'string') continue;
      const onchainId = BigInt(idValue);
      const data = eventData(event);

      if (name === 'deposited') {
        const sender = asString(eventTopic(event, 2));
        const hash = parseHash(eventTopic(event, 3));
        const token = asString(eventTopic(event, 4));
        const amount = BigInt(asString(data.amount));
        const expiresAt = Number(data.expires_at);
        await prisma.escrowPayment.upsert({
          where: { onchainId },
          update: { senderWallet: sender, phoneHash: hash, token, amount, expiresAt: new Date(expiresAt * 1000) },
          create: {
            onchainId,
            senderWallet: sender,
            phoneHash: hash,
            token,
            amount,
            expiresAt: new Date(expiresAt * 1000),
          },
        });
        processed += 1;
      } else if (name === 'claimed') {
        await prisma.escrowPayment.updateMany({
          where: { onchainId, status: 'PENDING' },
          data: { status: 'CLAIMED' },
        });
        processed += 1;
      } else if (name === 'refunded') {
        await prisma.escrowPayment.updateMany({
          where: { onchainId, status: 'PENDING' },
          data: { status: 'REFUNDED' },
        });
        processed += 1;
      }
    }

    await prisma.indexerState.upsert({
      where: { id: 1 },
      update: { lastLedger: endLedger },
      create: { id: 1, lastLedger: endLedger },
    });

    return NextResponse.json({ success: true, processed, fromLedger: startLedger, lastLedger: endLedger });
  } catch (error) {
    console.error('Indexer error:', error);
    return NextResponse.json({ error: 'Indexer failed' }, { status: 500 });
  }
}
