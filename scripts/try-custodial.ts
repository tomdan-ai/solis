// Dev check: signs in a fake number (no SMS) and creates a server-held wallet through the real API.
import { createHash } from 'crypto';
import { Client } from 'pg';
import { hashPhone } from '../src/lib/server/phone';
const APP = 'http://localhost:3000';
async function main() {
  const phone = `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const hash = hashPhone(phone);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`insert into "OtpChallenge" (id,"phoneHash","codeHash","expiresAt",attempts) values (gen_random_uuid(),$1,$2,now()+interval '5 minutes',0)`, [hash, createHash('sha256').update('424242').digest('hex')]);
  const v = await fetch(`${APP}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: '424242' }) });
  const verified = await v.json();
  console.log('verify:', v.status, 'custodial flag:', verified.custodial);
  const cookie = v.headers.getSetCookie().find((c) => c.startsWith('solis_session='))!.split(';')[0];
  const t0 = Date.now();
  const c = await fetch(`${APP}/api/wallets/create`, { method: 'POST', headers: { Cookie: cookie } });
  console.log('create wallet:', c.status, JSON.stringify(await c.json()), `${Date.now() - t0}ms`);
  const row = await db.query(`select "walletAddress", ("walletSecretEnc" is not null) as has_secret, length("walletSecretEnc") as len, "walletSecretEnc" like 'S%' as looks_plain from "User" where "phoneHash"=$1`, [hash]);
  console.log('db row:', JSON.stringify(row.rows[0]));
  const again = await fetch(`${APP}/api/wallets/create`, { method: 'POST', headers: { Cookie: cookie } });
  console.log('create again (idempotent):', again.status);
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
