import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // Check authentication
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Authorization header required (Bearer token)' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    // In production, validate the session token/JWT

    // Get user ID from token - for now, get all payments (will be filtered by user in prod)
    const userId = searchParams.get('userId') || '';

    // Build where clause for payments
    const where: any = {};

    if (userId) {
      where.phoneHash = userId; // Simplified: filter by phone hash
    }

    // Get escrow payments with their status
    const payments = await prisma.escrowPayment.findMany({
      where,
      take: 50, // Limit to 50 most recent
    });

    // Format response
    const formattedPayments = payments.map((payment) => ({
      id: payment.id,
      onchainId: payment.onchainId,
      senderWallet: payment.senderWallet,
      phoneHash: payment.phoneHash,
      token: payment.token,
      amount: payment.amount.toString(),
      status: payment.status,
      expiresAt: payment.expiresAt,
      notifiedAt: payment.notifiedAt,
    }));

    return NextResponse.json({
      success: true,
      payments: formattedPayments,
      total: formattedPayments.length,
    });
  } catch (error) {
    console.error('Payments error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}