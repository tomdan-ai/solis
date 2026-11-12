// Dev check for SIMULATE_USDC mode against the running app. Uses temporary sessions for two existing wallets.
//   npx tsx --env-file=.env scripts/try-sim-usdc.ts
import { Client } from 'pg';

const APP = 'http://localhost:3000';
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const users = (await db.query(
    `select id, "phoneHash", "walletAddress" from "User" where "walletAddress" is not null and "walletSecretEnc" is not null order by "createdAt" limit 2`,
  )).rows as Array<{ id: string; phoneHash: string; walletAddress: string }>;
  if (users.length < 2) throw new Error('Need two users with server-held wallets');
  const [a, b] = users;

  const sessions: string[] = [];
  async function session(userId: string) {
    const r = await db.query(`insert into "Session" (id,"userId","expiresAt") values (gen_random_uuid(), $1, now()+interval '10 minutes') returning id`, [userId]);
    sessions.push(r.rows[0].id);
    return `solis_session=${r.rows[0].id}`;
  }
  const ca = await session(a.id);
  const cb = await session(b.id);
  const call = async (cookie: string, path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${APP}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const bal = async (cookie: string) => BigInt((await call(cookie, '/api/balance')).body.balance);
  const U = (n: number) => BigInt(n) * BigInt(10_000_000);

  try {
    const startA = await bal(ca), startB = await bal(cb);
    console.log(`\nSimulated USDC check (A=${a.walletAddress.slice(0, 6)}…, B=${b.walletAddress.slice(0, 6)}…)`);

    const f = await call(ca, '/api/sim/faucet', {});
    check('Faucet credits 100 USDC to A', f.status === 200 && (await bal(ca)) === startA + U(100), `status ${f.status}`);

    const t = await call(ca, '/api/transactions/send', { operation: { kind: 'transfer', recipient: b.walletAddress, amount: U(25).toString() } });
    check('Transfer A -> B (25)', t.status === 200 && (await bal(ca)) === startA + U(75) && (await bal(cb)) === startB + U(25), `status ${t.status} ${t.body.error ?? ''}`);

    const over = await call(ca, '/api/transactions/send', { operation: { kind: 'transfer', recipient: b.walletAddress, amount: U(1_000_000).toString() } });
    check('Overspend is rejected', over.status === 400 && /Insufficient/.test(over.body.error), over.body.error);

    const self = await call(ca, '/api/transactions/send', { operation: { kind: 'transfer', recipient: a.walletAddress, amount: U(1).toString() } });
    check('Send to self is rejected', self.status === 400, self.body.error);

    const dep = await call(ca, '/api/transactions/send', { operation: { kind: 'deposit', phoneHash: b.phoneHash, amount: U(10).toString(), expiresAt: 0 } });
    check('Escrow deposit locks 10 from A', dep.status === 200 && (await bal(ca)) === startA + U(65), `status ${dep.status} ${dep.body.error ?? ''}`);

    const pay = (await call(cb, '/api/payments')).body.payments.find((p: { token: string; status: string; amount: string }) => p.token === 'SIM' && p.status === 'PENDING' && p.amount === U(10).toString());
    check('Recipient B sees the pending payment', Boolean(pay));

    const wrong = await call(ca, '/api/transactions/send', { operation: { kind: 'claim', paymentId: String(pay.onchainId) } });
    check('Sender cannot claim it', wrong.status === 403, `status ${wrong.status}`);

    const claim = await call(cb, '/api/transactions/send', { operation: { kind: 'claim', paymentId: String(pay.onchainId) } });
    check('B claims: balance +10', claim.status === 200 && (await bal(cb)) === startB + U(35), `status ${claim.status} ${claim.body.error ?? ''}`);

    const again = await call(cb, '/api/transactions/send', { operation: { kind: 'claim', paymentId: String(pay.onchainId) } });
    check('Double claim is rejected', again.status === 400, again.body.error);

    await call(ca, '/api/transactions/send', { operation: { kind: 'deposit', phoneHash: b.phoneHash, amount: U(5).toString(), expiresAt: 0 } });
    const pay2 = (await call(ca, '/api/payments')).body.payments.find((p: { token: string; status: string; amount: string }) => p.token === 'SIM' && p.status === 'PENDING' && p.amount === U(5).toString());
    const early = await call(ca, '/api/transactions/send', { operation: { kind: 'refund', paymentId: String(pay2.onchainId) } });
    check('Refund before expiry is rejected', early.status === 400 && /not expired/.test(early.body.error), early.body.error);

    await db.query(`update "EscrowPayment" set "expiresAt" = now() - interval '1 minute' where "onchainId" = $1`, [String(pay2.onchainId)]); // fast-forward time
    const before = await bal(ca);
    const refund = await call(ca, '/api/transactions/send', { operation: { kind: 'refund', paymentId: String(pay2.onchainId) } });
    check('Refund after expiry returns 5 to A', refund.status === 200 && (await bal(ca)) === before + U(5), `status ${refund.status} ${refund.body.error ?? ''}`);

    const feed = (await call(ca, '/api/payments')).body.transfers as Array<{ kind: string }>;
    check('Activity feed lists transfers', feed.some((x) => x.kind === 'transfer') && feed.some((x) => x.kind === 'faucet'));
  } finally {
    await db.query(`delete from "Session" where id = any($1::text[])`, [sessions]);
    await db.end();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
