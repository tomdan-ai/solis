import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function GET(request: Request) {
  try {
    const session = await getSessionFromRequest(prisma, request);
    if (!session) {
      return NextResponse.json({ error: 'Session is invalid or expired' }, { status: 401 });
    }

    const visiblePayments: Array<{ phoneHash: string } | { senderWallet: string }> = [
      { phoneHash: session.user.phoneHash },
    ];
    if (session.user.walletAddress) {
      visiblePayments.push({ senderWallet: session.user.walletAddress });
    }

    const payments = await prisma.escrowPayment.findMany({
      where: { OR: visiblePayments },
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