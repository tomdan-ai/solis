import { PrismaClient } from '@/generated/prisma/client';

/**
 * Fixed-window counter backed by the RateLimit table, using one atomic upsert so
 * concurrent requests cannot slip past the limit. Returns true if allowed.
 */
export async function consumeRateLimit(
  prisma: PrismaClient,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const windowSeconds = Math.ceil(windowMs / 1000);
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimit" ("key", "count", "windowStart")
    VALUES (${key}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimit"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}) THEN 1
        ELSE "RateLimit"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimit"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}) THEN NOW()
        ELSE "RateLimit"."windowStart"
      END
    RETURNING "count"`;
  return (rows[0]?.count ?? 1) <= limit;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}
