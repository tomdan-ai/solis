import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  try {
    const { paymentId, claimLink } = await request.json();

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

    // Update payment status to notified (SMS will be sent)
    await prisma.escrowPayment.update({
      where: { id: paymentId },
      data: { notifiedAt: new Date() },
    });

    // TODO: Send SMS with claim link
    // In production, integrate with SMS provider (Twilio, etc.)
    // The message should contain: claim link, no amount-sensitive secrets
    // Only a link to the app where they can complete the claim flow

    console.log(`Claim SMS would be sent for payment ${paymentId}: ${claimLink}`);

    return NextResponse.json({
      success: true,
      message: 'Claim SMS triggered',
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