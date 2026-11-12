import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  try {
    const { phoneHash, walletAddress, signature } = await request.json();

    if (!phoneHash || !walletAddress) {
      return NextResponse.json(
        { error: 'phoneHash and walletAddress are required' },
        { status: 400 }
      );
    }

    // Verify the phone hash matches the wallet
    // In a full implementation, verify the signature from the passkey signer
    // For now, just bind the wallet to the phone hash

    // Check if phone hash already has a wallet
    const existingUser = await prisma.user.findUnique({
      where: { phoneHash },
    });

    if (existingUser && existingUser.walletAddress) {
      return NextResponse.json(
        { error: 'Phone number already has a wallet registered' },
        { status: 409 }
      );
    }

    // Update or create user with wallet address
    const user = await prisma.user.upsert({
      where: { phoneHash },
      update: {
        walletAddress,
      },
      create: {
        phoneHash,
        walletAddress,
      },
    });

    return NextResponse.json({
      success: true,
      userId: user.id,
      walletAddress: user.walletAddress,
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