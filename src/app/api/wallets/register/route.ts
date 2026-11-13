import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { StrKey } from '@stellar/stellar-sdk';
import { getSessionFromRequest } from '@/lib/server/auth';
import { registerPhoneOnChain } from '@/lib/server/stellar';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }

    const { walletAddress } = await request.json();

    if (typeof walletAddress !== 'string' || walletAddress.length === 0) {
      return NextResponse.json(
        { error: 'walletAddress is required' },
        { status: 400 }
      );
    }

    if (session.user.walletAddress) {
      return NextResponse.json(
        { error: 'Phone number already has a wallet registered' },
        { status: 409 }
      );
    }

    if (!StrKey.isValidContract(walletAddress)) {
      return NextResponse.json(
        { error: 'walletAddress must be a deployed smart account contract address' },
        { status: 400 },
      );
    }

    const taken = await prisma.user.findUnique({ where: { walletAddress } });
    if (taken) {
      return NextResponse.json({ error: 'Wallet is already registered' }, { status: 409 });
    }

    // Registry write first: if it fails, nothing is saved and the client can retry.
    let registryTxHash: string;
    try {
      registryTxHash = await registerPhoneOnChain(session.user.phoneHash, walletAddress);
    } catch (error) {
      console.error('Registry write failed:', error);
      return NextResponse.json({ error: 'Could not register phone on-chain' }, { status: 502 });
    }

    const user = await prisma.user.update({
      where: { id: session.userId },
      data: { walletAddress },
    });

    return NextResponse.json({
      success: true,
      userId: user.id,
      walletAddress: user.walletAddress,
      registryTxHash,
      message: 'Wallet registered successfully',
    });
  } catch (error) {
    console.error('Wallet register error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}