import { PrismaClient } from '@/generated/prisma/client';

export async function getSessionFromRequest(
  prisma: PrismaClient,
  request: Request,
) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const sessionId = authHeader.slice('Bearer '.length).trim();
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date()) return null;

  return session;
}
