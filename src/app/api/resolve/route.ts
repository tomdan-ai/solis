import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';

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

    // Normalize to E.164 format
    const normalizedPhone = phone.replace(/^\+/, '').replace(/\D/g, '');
    const e164Phone = `+${normalizedPhone}`;

    // Verify authenticated session
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Authorization header required (Bearer token)' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    // Verify session token - in production, validate signed cookie/jwt
    // For now, check if user exists in DB

    const user = await prisma.user.findUnique({
      where: { phoneHash: e164Phone },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found. Complete onboarding first.' },
        { status: 404 }
      );
    }

    // Rate limit: check recent resolve requests
    const recentResolve = await prisma.rateLimit.findFirst({
      where: { key: `resolve:${e164Phone}` },
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
          key: `resolve:${e164Phone}`,
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