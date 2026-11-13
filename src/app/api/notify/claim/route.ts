import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';
import { hashPhone, isAllowedCountry, normalizePhone } from '@/lib/server/phone';
import { sendSms } from '@/lib/server/sms';
import { consumeRateLimit } from '@/lib/server/rate-limit';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }

    const { paymentId, phone } = await request.json();

    if (!paymentId) {
      return NextResponse.json(
        { error: 'paymentId is required' },
        { status: 400 }
      );
    }

    // Find the escrow payment
    const payment = await prisma.escrowPayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      return NextResponse.json(
        { error: 'Payment not found' },
        { status: 404 }
      );
    }

    if (!session.user.walletAddress || payment.senderWallet !== session.user.walletAddress) {
      return NextResponse.json({ error: 'You cannot notify this payment' }, { status: 403 });
    }

    // Check if payment is already claimed or refunded
    if (payment.status !== 'PENDING') {
      return NextResponse.json(
        { error: 'Payment is not in a claimable state' },
        { status: 400 }
      );
    }

    // Check if payment is expired
    if (new Date() > payment.expiresAt) {
      // Auto-refund expired payment
      await prisma.escrowPayment.update({
        where: { id: paymentId },
        data: { status: 'REFUNDED' },
      });
      return NextResponse.json({
        success: false,
        error: 'Payment expired and auto-refunded',
      });
    }

    // Only the hash is stored, so the sender supplies the number and it must match.
    let e164: string;
    try {
      e164 = normalizePhone(phone);
    } catch {
      return NextResponse.json({ error: 'A valid recipient phone is required' }, { status: 400 });
    }
    if (hashPhone(e164) !== payment.phoneHash || !isAllowedCountry(e164)) {
      return NextResponse.json({ error: 'Phone does not match this payment' }, { status: 400 });
    }

    if (!(await consumeRateLimit(prisma, `claim-sms:${paymentId}`, 2, 24 * 60 * 60 * 1000))) {
      return NextResponse.json({ error: 'Claim SMS already sent for this payment' }, { status: 429 });
    }

    // Link is built server-side so a sender cannot put an arbitrary URL in a Solis SMS.
    const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    try {
      await sendSms(e164, `Someone sent you money on Solis. Sign up with this number to claim it: ${appUrl}`);
    } catch {
      return NextResponse.json({ error: 'Could not send the claim SMS' }, { status: 502 });
    }

    await prisma.escrowPayment.update({
      where: { id: paymentId },
      data: { notifiedAt: new Date() },
    });

    return NextResponse.json({
      success: true,
      message: 'Claim SMS sent',
      paymentId,
    });
  } catch (error) {
    console.error('Notify claim error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}