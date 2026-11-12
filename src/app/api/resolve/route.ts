import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { phoneHashFromInput } from '@/lib/server/phone';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const phone = searchParams.get('phone');

    if (!phone) {
      return NextResponse.json(
        { error: 'Phone number is required' },
        { status: 400 }
      );
    }

    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }

    let phoneHash: string;
    try {
      phoneHash = phoneHashFromInput(phone);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid phone number' },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { phoneHash },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found. Complete onboarding first.' },
        { status: 404 }
      );
    }

    // Rate limit: check recent resolve requests
    const recentResolve = await prisma.rateLimit.findFirst({
      where: { key: `resolve:${session.userId}:${phoneHash}` },
    });

    if (recentResolve && recentResolve.count >= 10) {
      return NextResponse.json(
        { error: 'Too many resolve requests. Please wait before trying again.' },
        { status: 429 }
      );
    }

    // Update rate limit
    if (recentResolve) {
      await prisma.rateLimit.update({
        where: { key: recentResolve.key },
        data: { count: recentResolve.count + 1 },
      });
    } else {
      await prisma.rateLimit.create({
        data: {
          key: `resolve:${session.userId}:${phoneHash}`,
          count: 1,
          windowStart: new Date(),
        },
      });
    }

    return NextResponse.json({
      success: true,
      walletAddress: user.walletAddress,
      phoneHash: user.phoneHash,
    });
  } catch (error) {
    console.error('Resolve error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}