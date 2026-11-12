// Dev check of the passkey login gate. A script cannot do a real WebAuthn prompt, so this tests
// everything around it: pending sessions grant nothing, bad assertions are refused, OTPs are single use.
//   npx tsx --env-file=.env scripts/try-passkey-login.ts
import { createHash, randomBytes } from 'crypto';
import { Client } from 'pg';
import { hashPhone } from '../src/lib/server/phone';
import { challengeFor, toBase64Url } from '../src/lib/server/confirm';
import type { StellarOperation } from '../src/lib/server/stellar';

const APP = 'http://localhost:3000';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const phone = `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const hash = hashPhone(phone);
  const code = '424242';
  const hashCode = createHash('sha256').update(code).digest('hex');
  const newOtp = () => db.query(
    `insert into "OtpChallenge" (id,"phoneHash","codeHash","expiresAt",attempts) values (gen_random_uuid(),$1,$2,now()+interval '5 minutes',0)
     on conflict ("phoneHash") do update set "codeHash"=$2, "expiresAt"=now()+interval '5 minutes', attempts=0`, [hash, hashCode]);
  const post = (path: string, body: unknown, cookie = '') => fetch(`${APP}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

  console.log('\nPasskey login gate');

  // 1. A user without a passkey gets a normal session and is told to enroll one.
  await newOtp();
  const first = await post('/api/auth/otp/verify', { phone, code });
  const firstBody = await first.json();
  check('No passkey yet: full session + hasPasskey=false', first.status === 200 && Boolean(cookieOf(first, 'solis_session')) && firstBody.hasPasskey === false);
  check('Same OTP cannot be replayed', (await post('/api/auth/otp/verify', { phone, code })).status === 404);
  const userId = (await db.query(`select id from "User" where "phoneHash"=$1`, [hash])).rows[0].id as string;

  // 2. Give the user a stand-in passkey record, then log in again.
  await db.query(`insert into "Passkey" (id,"userId","credentialId","publicKey",counter) values (gen_random_uuid(),$1,$2,$3,0)`,
    [userId, randomBytes(16).toString('base64url'), randomBytes(65).toString('base64url')]);
  await newOtp();
  const second = await post('/api/auth/otp/verify', { phone, code });
  const secondBody = await second.json();
  const pending = cookieOf(second, 'solis_pending');
  check('With a passkey: OTP yields passkeyRequired and NO session cookie', second.status === 200 && secondBody.passkeyRequired === true && !cookieOf(second, 'solis_session'));
  check('A pending cookie is issued', Boolean(pending));

  // 3. The pending session must unlock nothing.
  const asSession = pending.replace('solis_pending', 'solis_session');
  const probe = (cookie: string) => fetch(`${APP}/api/payments`, { headers: { Cookie: cookie } }).then((r) => r.status);
  check('Pending cookie cannot read payments', (await probe(pending)) === 401);
  check('Pending id copied into the session cookie is refused (no bypass)', (await probe(asSession)) === 401);
  const pendingSessionRow = await db.query(`select "expiresAt" - now() as left from "Session" where id=$1`, [pending.split('=')[1]]);
  check('Pending session is short-lived (<= 5 min)', pendingSessionRow.rows[0].left.minutes <= 5 && !pendingSessionRow.rows[0].left.hours);

  // 4. Passkey login endpoints.
  check('Login options need the pending cookie', (await post('/api/auth/passkey/login/options', {})).status === 401);
  const opts = await post('/api/auth/passkey/login/options', {}, pending);
  const optsBody = await opts.json();
  check('Login options returns a challenge for this user\'s passkey', opts.status === 200 && Boolean(optsBody.challenge) && optsBody.allowCredentials?.length === 1);
  const bad = await post('/api/auth/passkey/login/verify', { id: 'not-a-real-credential', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} }, pending);
  check('A wrong/forged assertion is refused and gives no session', bad.status >= 400 && !cookieOf(bad, 'solis_session'), `status ${bad.status}`);

  // 5. Payment approval: with a passkey, no payment moves without an approval bound to that exact payment.
  console.log('\nPayment approval gate');
  const credentialId = (await db.query(`select "credentialId" from "Passkey" where "userId"=$1`, [userId])).rows[0].credentialId as string;
  await db.query(`update "User" set "walletAddress"=$2, "walletSecretEnc"='unused' where id=$1`, [userId, `G${randomBytes(27).toString('hex').toUpperCase().slice(0, 55)}`]);
  const full = await db.query(`insert into "Session" (id,"userId","expiresAt") values (gen_random_uuid(),$1,now()+interval '10 minutes') returning id`, [userId]);
  const fullCookie = `solis_session=${full.rows[0].id}`;
  const op: StellarOperation = { kind: 'transfer', sender: '', recipient: `G${'A'.repeat(55)}`, amount: '10000000' };
  const otherOp: StellarOperation = { ...op, amount: '90000000' };

  const noApproval = await post('/api/transactions/send', { operation: op }, fullCookie);
  check('Payment without approval is refused', noApproval.status === 400 && /Passkey confirmation required/.test((await noApproval.json()).error));

  const conf = await post('/api/auth/passkey/confirm/options', { operation: op }, fullCookie);
  const confBody = await conf.json();
  check('Confirm options need a real session', (await post('/api/auth/passkey/confirm/options', { operation: op })).status === 401);
  const expected = toBase64Url(challengeFor(op, confBody.nonce));
  check('Challenge is bound to this exact payment', conf.status === 200 && confBody.options.challenge === expected);

  const fake = { id: credentialId, rawId: credentialId, type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' }, clientExtensionResults: {} };
  const swapped = await post('/api/transactions/send', { operation: otherOp, approval: { assertion: fake, nonce: confBody.nonce } }, fullCookie);
  check('Approval for one payment cannot authorize another', swapped.status === 400 && /does not match/.test((await swapped.json()).error));

  const forged = await post('/api/transactions/send', { operation: op, approval: { assertion: fake, nonce: confBody.nonce } }, fullCookie);
  const forgedBody = await forged.json();
  check('Forged passkey signature is refused', forged.status === 400 && !forgedBody.hash && !forgedBody.success, forgedBody.error);

  await db.query(`delete from "Passkey" where "userId"=$1`, [userId]);
  await db.end();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
