import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomInt } from 'crypto';
import { phoneHashFromInput } from '@/lib/server/phone';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function POST(request: Request) {
  try {
    const { phone } = await request.json();

    if (!phone) {
      return NextResponse.json(
        { error: 'Phone number is required' },
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

    // Generate a 6-digit OTP code
    const code = randomInt(100000, 1000000).toString();
    const codeHash = hashCode(code);

    // Check if there's an existing OTP challenge for this phone
    const existingOtp = await prisma.otpChallenge.findFirst({
      where: { phoneHash },
    });

    if (existingOtp) {
      // Update existing OTP challenge
      await prisma.otpChallenge.update({
        where: { id: existingOtp.id },
        data: {
          codeHash,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
          attempts: 0,
        },
      });
    } else {
      // Create new OTP challenge
      await prisma.otpChallenge.create({
        data: {
          phoneHash,
          codeHash,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          attempts: 0,
        },
      });
    }

    // TODO: Send OTP via SMS provider (Twilio, etc.)
    // For now, log the code for development/testing
    console.log(`OTP generated for ${phoneHash}`);

    return NextResponse.json({
      success: true,
      message: 'OTP sent successfully',
      // In production, do not return the code
      devOnly: process.env.NODE_ENV !== 'production' ? { code } : undefined,
    });
  } catch (error) {
    console.error('OTP request error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}