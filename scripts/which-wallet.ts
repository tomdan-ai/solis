// Shows which stored wallet belongs to a phone number. Phone numbers are stored only as hashes,
// so this tests numbers you give it; it cannot recover a number from a wallet.
//   npx tsx --env-file=.env scripts/which-wallet.ts 09161061559 [more numbers...]
import { Client } from 'pg';
import { hashPhone, normalizePhone } from '../src/lib/server/phone';

async function main() {
  const numbers = process.argv.slice(2);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = (await db.query(`select "walletAddress" w, "phoneHash" h, "createdAt" c from "User" where "walletAddress" is not null order by "createdAt"`)).rows;
  for (const raw of numbers) {
    const hit = rows.find((r) => r.h === hashPhone(normalizePhone(raw)));
    console.log(`${raw} -> ${hit ? hit.w : 'no wallet'}`);
  }
  console.log('\nwallets, oldest first:');
  for (const r of rows) console.log(' ', r.w, r.c.toISOString());
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
