import { IndexedDBStorage, SmartAccountKit } from 'smart-account-kit';

let kit: SmartAccountKit | null = null;

/** Browser-only Smart Account Kit instance; all sponsorship goes through our policy proxy. */
export function getKit(): SmartAccountKit {
  if (kit) return kit;
  const accountWasmHash = process.env.NEXT_PUBLIC_SMART_ACCOUNT_WASM_HASH;
  const webauthnVerifierAddress = process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ID;
  if (!accountWasmHash || !webauthnVerifierAddress) {
    throw new Error('Smart account is not configured (WASM hash / WebAuthn verifier)');
  }
  kit = new SmartAccountKit({
    rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    networkPassphrase: process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
    accountWasmHash,
    webauthnVerifierAddress,
    relayerUrl: `${window.location.origin}/api/relay/proxy`,
    rpName: 'Solis',
    storage: new IndexedDBStorage(),
  });
  return kit;
}

/** USDC has 7 decimals on Stellar. Returns null for invalid input. */
export function toStroops(amount: string): string | null {
  if (!/^\d+(\.\d{1,7})?$/.test(amount.trim())) return null;
  const [whole, frac = ''] = amount.trim().split('.');
  const value = BigInt(whole) * BigInt(10_000_000) + BigInt(frac.padEnd(7, '0'));
  return value > BigInt(0) ? value.toString() : null;
}

export function formatUsdc(stroops: string): string {
  const v = BigInt(stroops || '0');
  const whole = v / BigInt(10_000_000);
  const frac = (v % BigInt(10_000_000)).toString().padStart(7, '0').slice(0, 2);
  return `${whole}.${frac}`;
}
