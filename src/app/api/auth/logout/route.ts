import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, readSessionId } from '@/lib/server/auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function POST(request: Request) {
  const sessionId = readSessionId(request);
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
