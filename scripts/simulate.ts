/**
 * End-to-end simulation of Solis against the running app, a real Postgres DB and the real Stellar testnet.
 *
 *   npm run dev            # in one terminal
 *   npx tsx --env-file=.env scripts/simulate.ts
 *
 * Real:      HTTP API, sessions, DB, sponsor policy, indexer, every contract call on testnet.
 * Simulated: SMS (an OTP challenge with a known code is written straight to the DB) and
 *            passkey smart wallets (plain funded Stellar accounts stand in for them, since a
 *            script cannot drive a browser passkey). Steps needing a missing secret are skipped.
 */
import { createHash } from 'crypto';
import { Client } from 'pg';
import {
  Account, Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { hashPhone } from '../src/lib/server/phone';

const APP = process.env.SIM_APP_URL ?? 'http://localhost:3000';
const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const REGISTRY = process.env.SOLIS_REGISTRY_CONTRACT_ID!;
const ESCROW = process.env.SOLIS_ESCROW_CONTRACT_ID!;
const USDC = process.env.SOLIS_USDC_CONTRACT_ID!;
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const server = new rpc.Server(RPC_URL);
const usdc = (n: number) => BigInt(Math.round(n * 10_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ name: string; status: 'PASS' | 'FAIL' | 'SKIP'; note?: string }> = [];
async function step(name: string, fn: () => Promise<string | void>, skipReason?: string) {
  if (skipReason) {
    results.push({ name, status: 'SKIP', note: skipReason });
    console.log(`  SKIP  ${name} (${skipReason})`);
    return;
  }
  try {
    const note = (await fn()) ?? undefined;
    results.push({ name, status: 'PASS', note });
    console.log(`  PASS  ${name}${note ? ` - ${note}` : ''}`);
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    results.push({ name, status: 'FAIL', note });
    console.log(`  FAIL  ${name} - ${note}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function validSecret(value?: string): string | null {
  try {
    if (!value) return null;
    Keypair.fromSecret(value);
    return value;
  } catch {
    return null;
  }
}

// ---------- chain helpers (real testnet) ----------
async function friendbot(addr: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${addr}`);
  assert(res.ok || res.status === 400, `friendbot failed (${res.status})`); // 400 = already funded
}
async function newFundedAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbot(kp.publicKey());
  return kp;
}
const addr = (a: string) => Address.fromString(a).toScVal();
const bytes32 = (hashHex: string) => nativeToScVal(Buffer.from(hashHex, 'hex'), { type: 'bytes' });
const hex = (phoneHash: string) => phoneHash.replace('hmac_v1:', '');

/** Read-only call via simulation. */
async function read(source: Keypair, contract: string, method: string, ...args: xdr.ScVal[]) {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contract).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}
/** State-changing call. The actor is the tx source, so its own require_auth is satisfied. */
async function invoke(actor: Keypair, contract: string, method: string, ...args: xdr.ScVal[]) {
  const account = await server.getAccount(actor.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contract).call(method, ...args)).setTimeout(60).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(actor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === 'SUCCESS') return { hash: sent.hash, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
    if (r.status === 'FAILED') throw new Error(`${method} failed on-chain (${sent.hash})`);
    await sleep(1000);
  }
  throw new Error(`${method} not confirmed in time (${sent.hash})`);
}

// ---------- app helpers (real HTTP) ----------
async function http(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  const res = await fetch(`${APP}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(rest.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { res, status: res.status, body: body as Record<string, any> };
}

function randomPhone() {
  return `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

async function main() {
  const attestorSecret = validSecret(process.env.SOLIS_ATTESTOR_SECRET);
  const funderSecret = validSecret(process.env.FUNDER_SECRET);
  const attestor = attestorSecret ? Keypair.fromSecret(attestorSecret) : null;
  const funder = funderSecret ? Keypair.fromSecret(funderSecret) : null;
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log(`\nSolis simulation against ${APP} + Stellar testnet\n`);
  console.log(`attestor key: ${attestor ? 'present' : 'MISSING'} | funder key: ${funder ? 'present' : 'MISSING'} | cron secret: ${CRON_SECRET ? 'present' : 'MISSING'}\n`);

  console.log('1. Preflight');
  await step('App is reachable', async () => {
    const { status } = await http('/api/auth/session');
    assert(status === 401, `expected 401 when logged out, got ${status}`);
  });
  await step('Database is reachable', async () => { await db.query('select 1'); });

  console.log('\n2. Real testnet reads');
  let probe!: Keypair;
  await step('Fund a throwaway account (Friendbot)', async () => { probe = await newFundedAccount(); return probe.publicKey().slice(0, 8) + '…'; });
  await step('PhoneRegistry.resolve(unknown hash) -> none', async () => {
    const v = await read(probe, REGISTRY, 'resolve', bytes32('00'.repeat(32)));
    assert(v === undefined || v === null, `expected none, got ${String(v)}`);
  });
  await step('USDC token responds (decimals)', async () => `decimals=${await read(probe, USDC, 'decimals')}`);
  await step('PayEscrow responds (get_payment)', async () => { await read(probe, ESCROW, 'get_payment', nativeToScVal(0n, { type: 'u64' })); });

  console.log('\n3. Auth + API (real HTTP, simulated SMS)');
  const phoneA = randomPhone(), phoneB = randomPhone(), phoneC = randomPhone(), phoneD = randomPhone();
  const hashA = hashPhone(phoneA), hashB = hashPhone(phoneB), hashC = hashPhone(phoneC), hashD = hashPhone(phoneD);
  const code = '424242';
  async function signIn(phone: string, phoneHash: string): Promise<string> {
    await db.query(
      `insert into "OtpChallenge" (id, "phoneHash", "codeHash", "expiresAt", attempts)
       values (gen_random_uuid(), $1, $2, now() + interval '5 minutes', 0)
       on conflict ("phoneHash") do update set "codeHash" = $2, "expiresAt" = now() + interval '5 minutes', attempts = 0`,
      [phoneHash, createHash('sha256').update(code).digest('hex')],
    );
    const { res, status } = await http('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code }) });
    assert(status === 200, `verify returned ${status}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('solis_session='));
    assert(cookie, 'no session cookie set');
    return cookie.split(';')[0];
  }
  let cookieA = '', cookieB = '';
  await step('Wrong OTP is rejected', async () => {
    await db.query(
      `insert into "OtpChallenge" (id, "phoneHash", "codeHash", "expiresAt", attempts)
       values (gen_random_uuid(), $1, $2, now() + interval '5 minutes', 0)
       on conflict ("phoneHash") do update set "codeHash" = $2, attempts = 0`,
      [hashD, createHash('sha256').update(code).digest('hex')],
    );
    const { status } = await http('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone: phoneD, code: '000000' }) });
    assert(status === 400, `expected 400, got ${status}`);
  });
  await step('Sender signs in (OTP -> httpOnly session cookie)', async () => { cookieA = await signIn(phoneA, hashA); });
  await step('Recipient signs in', async () => { cookieB = await signIn(phoneB, hashB); });
  await step('Session endpoint restores the session', async () => {
    const { status, body } = await http('/api/auth/session', { cookie: cookieA });
    assert(status === 200 && body.authenticated === true, `got ${status}`);
  });
  await step('Local-format number (0803…) normalizes to the same user', async () => {
    const local = '0' + phoneA.slice(4);
    const ck = await signIn(local, hashA);
    assert(ck.startsWith('solis_session='), 'no cookie');
  });
  await step('Logged-out requests are rejected (payments, prepare, proxy)', async () => {
    for (const [path, init] of [['/api/payments', {}], ['/api/transactions/prepare', { method: 'POST', body: '{}' }], ['/api/relay/proxy', { method: 'POST', body: '{}' }]] as const) {
      const { status } = await http(path, init as RequestInit);
      assert(status === 401, `${path} returned ${status}`);
    }
  });
  await step('Resolve: unregistered number is reported unregistered', async () => {
    const { status, body } = await http(`/api/resolve?phone=${encodeURIComponent(phoneC)}`, { cookie: cookieA });
    assert(status === 200 && body.registered === false && body.phoneHash === hashC, `got ${status} ${JSON.stringify(body)}`);
  });
  await step('Sponsor policy rejects a non-allow-listed contract call', async () => {
    const dummy = new Account(probe.publicKey(), '0');
    const tx = new TransactionBuilder(dummy, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(REGISTRY).call('register', bytes32('11'.repeat(32)), addr(probe.publicKey()))).setTimeout(30).build();
    const op = tx.operations[0];
    assert(op.type === 'invokeHostFunction', 'unexpected op');
    const { status, body } = await http('/api/relay/proxy', { method: 'POST', cookie: cookieA, body: JSON.stringify({ func: op.func.toXDR('base64'), auth: [] }) });
    assert(status === 403 && body.errorCode === 'FUNCTION_NOT_ALLOWED', `got ${status} ${JSON.stringify(body)}`);
    return 'FUNCTION_NOT_ALLOWED';
  });

  console.log('\n4. Real on-chain protocol (classic accounts stand in for passkey wallets)');
  const needChain = !attestor ? 'SOLIS_ATTESTOR_SECRET missing/invalid' : !funder ? 'FUNDER_SECRET missing/invalid' : undefined;
  let wA!: Keypair, wB!: Keypair, wC!: Keypair;
  const amount = usdc(10);
  let claimId = -1n, refundId = -1n;
  await step('Create + fund 3 testnet wallets (Friendbot)', async () => { [wA, wB, wC] = await Promise.all([newFundedAccount(), newFundedAccount(), newFundedAccount()]); }, needChain);
  await step('Fund sender wallet with 50 test USDC', async () => {
    await invoke(funder!, USDC, 'transfer', addr(funder!.publicKey()), addr(wA.publicKey()), nativeToScVal(usdc(50), { type: 'i128' }));
    const bal = await read(probe, USDC, 'balance', addr(wA.publicKey()));
    assert(BigInt(bal) === usdc(50), `balance ${bal}`);
  }, needChain);
  await step('Register recipient phone on-chain (attestor) and resolve it', async () => {
    await invoke(attestor!, REGISTRY, 'register', bytes32(hex(hashB)), addr(wB.publicKey()));
    const v = await read(probe, REGISTRY, 'resolve', bytes32(hex(hashB)));
    assert(v === wB.publicKey(), `resolved ${v}`);
    await db.query(`update "User" set "walletAddress" = $1 where "phoneHash" = $2`, [wB.publicKey(), hashB]);
    await db.query(`update "User" set "walletAddress" = $1 where "phoneHash" = $2`, [wA.publicKey(), hashA]);
  }, needChain);
  await step('Resolve API now reports recipient registered', async () => {
    const { body } = await http(`/api/resolve?phone=${encodeURIComponent(phoneB)}`, { cookie: cookieA });
    assert(body.registered === true && body.walletAddress === wB.publicKey(), JSON.stringify(body));
  }, needChain);
  await step('Direct USDC transfer to registered recipient (5 USDC)', async () => {
    await invoke(wA, USDC, 'transfer', addr(wA.publicKey()), addr(wB.publicKey()), nativeToScVal(usdc(5), { type: 'i128' }));
    const bal = await read(probe, USDC, 'balance', addr(wB.publicKey()));
    assert(BigInt(bal) === usdc(5), `recipient balance ${bal}`);
  }, needChain);
  await step('Escrow deposit to an UNREGISTERED number', async () => {
    const exp = BigInt(Math.floor(Date.now() / 1000) + 600);
    const r = await invoke(wA, ESCROW, 'deposit', addr(wA.publicKey()), bytes32(hex(hashC)), addr(USDC), nativeToScVal(amount, { type: 'i128' }), nativeToScVal(exp, { type: 'u64' }));
    claimId = BigInt(r.value);
    return `payment id ${claimId}`;
  }, needChain);
  await step('Claim before the recipient registers is rejected', async () => {
    let failed = false;
    try { await invoke(wC, ESCROW, 'claim', nativeToScVal(claimId, { type: 'u64' })); } catch { failed = true; }
    assert(failed, 'claim unexpectedly succeeded');
  }, needChain);
  await step('Recipient registers, then claims the escrow', async () => {
    await invoke(attestor!, REGISTRY, 'register', bytes32(hex(hashC)), addr(wC.publicKey()));
    await invoke(wC, ESCROW, 'claim', nativeToScVal(claimId, { type: 'u64' }));
    const bal = await read(probe, USDC, 'balance', addr(wC.publicKey()));
    assert(BigInt(bal) === amount, `recipient balance ${bal}`);
  }, needChain);
  await step('Double-claim is rejected', async () => {
    let failed = false;
    try { await invoke(wC, ESCROW, 'claim', nativeToScVal(claimId, { type: 'u64' })); } catch { failed = true; }
    assert(failed, 'second claim unexpectedly succeeded');
  }, needChain);
  await step('Escrow deposit that will expire (30s), refund too early is rejected', async () => {
    const exp = BigInt(Math.floor(Date.now() / 1000) + 30);
    const r = await invoke(wA, ESCROW, 'deposit', addr(wA.publicKey()), bytes32(hex(hashD)), addr(USDC), nativeToScVal(amount, { type: 'i128' }), nativeToScVal(exp, { type: 'u64' }));
    refundId = BigInt(r.value);
    let failed = false;
    try { await invoke(wA, ESCROW, 'refund', nativeToScVal(refundId, { type: 'u64' })); } catch { failed = true; }
    assert(failed, 'early refund unexpectedly succeeded');
    return `payment id ${refundId}`;
  }, needChain);
  await step('After expiry the sender refunds (waits ~45s)', async () => {
    await sleep(45_000);
    const before = BigInt(await read(probe, USDC, 'balance', addr(wA.publicKey())));
    await invoke(wA, ESCROW, 'refund', nativeToScVal(refundId, { type: 'u64' }));
    const after = BigInt(await read(probe, USDC, 'balance', addr(wA.publicKey())));
    assert(after - before === amount, `refund delta ${after - before}`);
  }, needChain);

  console.log('\n5. Indexer + feed (real)');
  const needIndexer = needChain ?? (!CRON_SECRET ? 'CRON_SECRET missing (restart the dev server after adding it)' : undefined);
  await step('Indexer ingests deposit/claim/refund events into the DB', async () => {
    let rows: Array<{ onchainId: string; status: string }> = [];
    for (let i = 0; i < 6; i++) {
      const { status } = await http('/api/cron/index', { headers: { 'x-cron-secret': CRON_SECRET } });
      assert(status === 200, `indexer returned ${status}`);
      const r = await db.query(`select "onchainId"::text as "onchainId", status::text as status from "EscrowPayment" where "onchainId" in ($1, $2)`, [claimId.toString(), refundId.toString()]);
      rows = r.rows;
      const c = rows.find((x) => x.onchainId === claimId.toString())?.status === 'CLAIMED';
      const f = rows.find((x) => x.onchainId === refundId.toString())?.status === 'REFUNDED';
      if (c && f) return 'claim=CLAIMED refund=REFUNDED';
      await sleep(5000);
    }
    throw new Error(`DB state after polling: ${JSON.stringify(rows)}`);
  }, needIndexer);
  await step('Payments API shows the sender its escrow payments', async () => {
    const { body } = await http('/api/payments', { cookie: cookieA });
    const ids = (body.payments ?? []).map((p: { onchainId: string }) => String(p.onchainId));
    assert(ids.includes(claimId.toString()) && ids.includes(refundId.toString()), `ids: ${ids.join(',')}`);
  }, needIndexer);
  await step('Balance API reads the sender USDC balance from chain', async () => {
    const { status, body } = await http('/api/balance', { cookie: cookieA });
    assert(status === 200, `got ${status}`);
    return `balance=${Number(BigInt(body.balance)) / 1e7} USDC`;
  }, needChain);

  await db.end();
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${results.length - fail - skip} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
