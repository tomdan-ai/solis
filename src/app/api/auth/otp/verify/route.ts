import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomUUID } from 'crypto';
import { phoneHashFromInput } from '@/lib/server/phone';
import { custodialEnabled } from '@/lib/server/custodial';
import { PENDING_COOKIE, PENDING_ID_PREFIX, PENDING_TTL_MS, SESSION_COOKIE, SESSION_TTL_MS, sessionCookieOptions } from '@/lib/server/auth';

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

    // Single use: a correct code can never be replayed.
    await prisma.otpChallenge.delete({ where: { id: otpChallenge.id } });

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

    // With server-held wallets a passkey is the second login factor. Users who already
    // have one get only a short-lived pending session until the passkey check succeeds.
    const hasPasskey = (await prisma.passkey.count({ where: { userId } })) > 0;
    const needsPasskey = custodialEnabled() && hasPasskey;

    const expiresAt = new Date(Date.now() + (needsPasskey ? PENDING_TTL_MS : SESSION_TTL_MS));
    const session = await prisma.session.create({
      data: {
        ...(needsPasskey ? { id: `${PENDING_ID_PREFIX}${randomUUID()}` } : {}),
        userId,
        expiresAt,
      },
    });

    if (needsPasskey) {
      const pending = NextResponse.json({ success: true, passkeyRequired: true, custodial: true });
      pending.cookies.set(PENDING_COOKIE, session.id, sessionCookieOptions(expiresAt));
      return pending;
    }

    const response = NextResponse.json({
      success: true,
      message: 'OTP verified successfully',
      userId,
      walletAddress: user?.walletAddress ?? null,
      custodial: custodialEnabled(),
      hasPasskey,
    });
    response.cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(expiresAt));
    return response;
  } catch (error) {
    console.error('OTP verify error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}