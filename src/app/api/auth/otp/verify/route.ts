import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash } from 'crypto';
import { phoneHashFromInput } from '@/lib/server/phone';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function POST(request: Request) {
  try {
    const { phone, code } = await request.json();

    if (!phone || !code) {
      return NextResponse.json(
        { error: 'Phone number and OTP code are required' },
        { status: 400 }
      );
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

    // Find the OTP challenge
    const otpChallenge = await prisma.otpChallenge.findFirst({
      where: { phoneHash },
    });

    if (!otpChallenge) {
      return NextResponse.json(
        { error: 'No OTP challenge found. Request a new OTP.' },
        { status: 404 }
      );
    }

    // Check if expired
    if (new Date() > otpChallenge.expiresAt) {
      return NextResponse.json(
        { error: 'OTP has expired. Request a new one.' },
        { status: 410 }
      );
    }

    // Check attempt limit
    if (otpChallenge.attempts >= 3) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Request a new OTP.' },
        { status: 429 }
      );
    }

    // Verify the code
    const inputHash = hashCode(code);
    if (inputHash !== otpChallenge.codeHash) {
      // Increment attempts
      await prisma.otpChallenge.update({
        where: { id: otpChallenge.id },
        data: { attempts: otpChallenge.attempts + 1 },
      });

      return NextResponse.json(
        { error: 'Invalid OTP code. Please try again.' },
        { status: 400 }
      );
    }

    // OTP verified - create or update user session
    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { phoneHash },
    });

    let userId: string;

    if (user) {
      userId = user.id;
    } else {
      // Create new user
      const newUser = await prisma.user.create({
        data: {
          phoneHash,
          walletAddress: null, // Will be set during onboarding
        },
      });
      userId = newUser.id;
    }

    // Create session
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const session = await prisma.session.create({
      data: {
        userId,
        expiresAt,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'OTP verified successfully',
      sessionId: session.id,
      userId,
      // In a real app, set a signed cookie here
      // setSessionCookie(session.id),
    });
  } catch (error) {
    console.error('OTP verify error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}