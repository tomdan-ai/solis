import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomInt } from 'crypto';
import { hashPhone, isAllowedCountry, normalizePhone } from '@/lib/server/phone';
import { sendSms } from '@/lib/server/sms';
import { clientIp, consumeRateLimit } from '@/lib/server/rate-limit';

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

    let e164: string;
    let phoneHash: string;
    try {
      e164 = normalizePhone(phone);
      phoneHash = hashPhone(e164);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid phone number' },
        { status: 400 },
      );
    }

    if (!isAllowedCountry(e164)) {
      return NextResponse.json(
        { error: 'Solis is currently available for Nigerian phone numbers only' },
        { status: 400 },
      );
    }

    const [phoneOk, ipOk] = await Promise.all([
      consumeRateLimit(prisma, `otp:phone:${phoneHash}`, 3, 10 * 60 * 1000),
      consumeRateLimit(prisma, `otp:ip:${clientIp(request)}`, 10, 60 * 60 * 1000),
    ]);
    if (!phoneOk || !ipOk) {
      return NextResponse.json(
        { error: 'Too many code requests. Please wait a few minutes and try again.' },
        { status: 429 },
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

    let delivery;
    try {
      delivery = await sendSms(e164, `Your Solis code is ${code}. It expires in 5 minutes. Never share it.`);
    } catch {
      return NextResponse.json(
        { error: 'We could not send your code. Please try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'OTP sent successfully',
      // Only when no SMS provider is configured outside production.
      devOnly: delivery.provider === 'dev' ? { code } : undefined,
    });
  } catch (error) {
    console.error('OTP request error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}