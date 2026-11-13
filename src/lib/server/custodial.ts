import { Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk';
import { decryptSecret, encryptSecret } from '@/lib/server/wallet-crypto';
import { registerPhoneOnChain, sendAndConfirm } from '@/lib/server/stellar';

const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

/**
 * DEMO ONLY. Server-held wallets break the "backend can never move user funds"
 * guarantee, so they are refused in production no matter what the flag says.
 */
export function custodialEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.CUSTODIAL_WALLETS === 'true';
}

async function addUsdcTrustline(server: rpc.Server, kp: Keypair) {
  const token = process.env.SOLIS_USDC_CONTRACT_ID;
  if (!token) return;
  const account = await server.getAccount(kp.publicKey());
  const readTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(token).call('name')).setTimeout(30).build();
  const sim = await server.simulateTransaction(readTx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return;
  // A classic-asset token contract reports its name as "CODE:ISSUER".
  const [code, issuer] = String(scValToNative(sim.result.retval)).split(':');
  if (!code || !issuer) return;
  const fresh = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(fresh, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) })).setTimeout(60).build();
  tx.sign(kp);
  await sendAndConfirm(server, tx);
}

/** Generates a keypair and its encrypted form. Nothing touches the network. */
export function newCustodialKey() {
  const kp = Keypair.random();
  return { kp, address: kp.publicKey(), secretEnc: encryptSecret(kp.secret()) };
}

export function keypairFromEncrypted(secretEnc: string): Keypair {
  return Keypair.fromSecret(decryptSecret(secretEnc));
}

/**
 * Funds (Friendbot), trusts USDC and registers the phone on-chain. Safe to repeat:
 * Friendbot on an already-funded account and a repeated trustline are no-ops, and on a
 * retry a registry error (normally "already registered") is logged rather than thrown.
 */
export async function setupCustodialWallet(phoneHash: string, kp: Keypair, firstTime: boolean) {
  const server = new rpc.Server(rpcUrl);
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!funded.ok && funded.status !== 400) throw new Error('Friendbot could not fund the new wallet');

  await addUsdcTrustline(server, kp);

  if (!process.env.SOLIS_ATTESTOR_SECRET) {
    console.warn('[custodial] SOLIS_ATTESTOR_SECRET not set: phone NOT registered on-chain (escrow claims will not work)');
    return { registryTxHash: null as string | null };
  }
  try {
    return { registryTxHash: await registerPhoneOnChain(phoneHash, kp.publicKey()) as string | null };
  } catch (error) {
    if (firstTime) throw error;
    console.warn('[custodial] registry write on retry failed (likely already registered):', error instanceof Error ? error.message : error);
    return { registryTxHash: null as string | null };
  }
}

/** Signs a prepared transaction XDR with the user's server-held key and submits it. */
export async function signAndSubmitAsUser(secretEnc: string, xdrString: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(xdrString, passphrase);
  tx.sign(Keypair.fromSecret(decryptSecret(secretEnc)));
  return sendAndConfirm(new rpc.Server(rpcUrl), tx);
}
