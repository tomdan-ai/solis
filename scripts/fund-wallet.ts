/**
 * Sends test USDC from a funded Stellar account to a Solis smart wallet.
 *
 *   npx tsx --env-file=.env scripts/fund-wallet.ts <C...wallet> <amount in USDC>
 *
 * Needs in .env: FUNDER_SECRET (account holding the test USDC, or the asset's issuer,
 * in which case the transfer mints), SOLIS_USDC_CONTRACT_ID, STELLAR_RPC_URL.
 */
import {
  Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc,
} from '@stellar/stellar-sdk';

async function main() {
  const [wallet, amountArg] = process.argv.slice(2);
  const secret = process.env.FUNDER_SECRET;
  const token = process.env.SOLIS_USDC_CONTRACT_ID;
  if (!wallet?.startsWith('C') || !amountArg || !secret || !token) {
    throw new Error('Usage: fund-wallet.ts <C...wallet> <amount>; FUNDER_SECRET and SOLIS_USDC_CONTRACT_ID must be set');
  }
  if (!/^\d+(\.\d{1,7})?$/.test(amountArg)) throw new Error('Amount must be a number with up to 7 decimals');
  const [whole, frac = ''] = amountArg.split('.');
  const amount = BigInt(whole) * BigInt(10_000_000) + BigInt(frac.padEnd(7, '0'));

  const funder = Keypair.fromSecret(secret);
  const server = new rpc.Server(process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org');
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const account = await server.getAccount(funder.publicKey());

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(token).call(
      'transfer',
      Address.fromString(funder.publicKey()).toScVal(),
      Address.fromString(wallet).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(funder);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`Rejected: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') return console.log(`Sent ${amountArg} USDC to ${wallet}\ntx ${sent.hash}`);
    if (result.status === 'FAILED') throw new Error(`Transfer failed on-chain: ${sent.hash}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Not confirmed in time: ${sent.hash}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
