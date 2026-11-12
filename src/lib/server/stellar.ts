import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { phoneHashToHex } from '@/lib/server/phone';

const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

export type StellarOperation =
  | {
      kind: 'transfer';
      sender: string;
      recipient: string;
      amount: string;
    }
  | {
      kind: 'deposit';
      sender: string;
      phoneHash: string;
      amount: string;
      expiresAt: number;
    }
  | { kind: 'claim'; paymentId: string }
  | { kind: 'refund'; paymentId: string };

function buildContractCall(source: string, operation: StellarOperation) {
  const operationContract = operation.kind === 'transfer'
    ? process.env.SOLIS_USDC_CONTRACT_ID
    : process.env.SOLIS_ESCROW_CONTRACT_ID;
  if (!operationContract) {
    throw new Error('Required Stellar contract ID is not configured');
  }

  const contract = new Contract(operationContract);
  const sourceValue = Address.fromString(source).toScVal();
  let contractCall;

  if (operation.kind === 'transfer') {
    contractCall = contract.call(
      'transfer',
      sourceValue,
      Address.fromString(operation.recipient).toScVal(),
      nativeToScVal(BigInt(operation.amount), { type: 'i128' }),
    );
  } else if (operation.kind === 'deposit') {
    const token = process.env.SOLIS_USDC_CONTRACT_ID;
    if (!token) throw new Error('SOLIS_USDC_CONTRACT_ID is not configured');
    const hash = Buffer.from(phoneHashToHex(operation.phoneHash), 'hex');
    if (hash.length !== 32) throw new Error('phoneHash must contain 32 bytes');
    contractCall = contract.call(
      'deposit',
      sourceValue,
      nativeToScVal(hash, { type: 'bytes' }),
      Address.fromString(token).toScVal(),
      nativeToScVal(BigInt(operation.amount), { type: 'i128' }),
      nativeToScVal(operation.expiresAt, { type: 'u64' }),
    );
  } else {
    contractCall = contract.call(
      operation.kind,
      nativeToScVal(BigInt(operation.paymentId), { type: 'u64' }),
    );
  }

  return contractCall;
}

export async function buildPreparedTransaction(
  source: string,
  operation: StellarOperation,
) {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(source);
  const transactionBuilder = new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE_STROOPS ?? BASE_FEE,
    networkPassphrase,
  }).setTimeout(60);

  const contractCall = buildContractCall(source, operation);
  transactionBuilder.addOperation(contractCall);
  const transaction = transactionBuilder.build();
  const simulation = await server.simulateTransaction(transaction);
  if ('error' in simulation && simulation.error) {
    throw new Error(`Soroban simulation failed: ${simulation.error}`);
  }

  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  return {
    xdr: prepared.toXDR(),
    feeStroops: prepared.fee,
    networkPassphrase,
  };
}

export async function sendAndConfirm(server: rpc.Server, rawTx: Parameters<rpc.Server['sendTransaction']>[0]) {
  const sent = await server.sendTransaction(rawTx);
  if (sent.status === 'ERROR') {
    throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }
  const hash = sent.hash;
  for (let i = 0; i < 20; i++) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return hash;
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${hash} failed on-chain`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Transaction ${hash} was not confirmed in time`);
}

/**
 * Binds a phone hash to a wallet in PhoneRegistry, signed by the attestor key.
 * The attestor can only write registry entries; it cannot move user funds.
 */
export async function registerPhoneOnChain(phoneHash: string, wallet: string) {
  const registryId = process.env.SOLIS_REGISTRY_CONTRACT_ID;
  const attestorSecret = process.env.SOLIS_ATTESTOR_SECRET;
  if (!registryId || !attestorSecret) {
    throw new Error('SOLIS_REGISTRY_CONTRACT_ID and SOLIS_ATTESTOR_SECRET must be configured');
  }

  const attestor = Keypair.fromSecret(attestorSecret);
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(attestor.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE_STROOPS ?? BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      new Contract(registryId).call(
        'register',
        nativeToScVal(Buffer.from(phoneHashToHex(phoneHash), 'hex'), { type: 'bytes' }),
        Address.fromString(wallet).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(attestor);
  return sendAndConfirm(server, prepared);
}

/**
 * Simulates an invocation on behalf of a smart wallet and returns the host
 * function plus its unsigned auth entries as base64 XDR, ready for the client
 * to sign with the passkey and send through /api/relay/proxy.
 */
export async function prepareInvocation(wallet: string, operation: StellarOperation) {
  const attestorSecret = process.env.SOLIS_ATTESTOR_SECRET;
  if (!attestorSecret) throw new Error('SOLIS_ATTESTOR_SECRET must be configured');
  const server = new rpc.Server(rpcUrl);
  // Simulation-only source; it never signs or pays for the user's transaction.
  const account = await server.getAccount(Keypair.fromSecret(attestorSecret).publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE_STROOPS ?? BASE_FEE,
    networkPassphrase,
  })
    .addOperation(buildContractCall(wallet, operation))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Soroban simulation failed: ${simulation.error}`);
  }
  const op = transaction.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error('Unexpected operation type');
  const latest = await server.getLatestLedger();
  return {
    func: op.func.toXDR('base64'),
    auth: (simulation.result?.auth ?? []).map((entry) => entry.toXDR('base64')),
    latestLedger: latest.sequence,
  };
}

/** USDC balance (7-decimal stroop units as a string) for a wallet via a read-only simulation. */
export async function getUsdcBalance(wallet: string): Promise<string> {
  const token = process.env.SOLIS_USDC_CONTRACT_ID;
  if (!token) return '0';
  const server = new rpc.Server(rpcUrl);
  // Read-only simulation only needs *some* funded account as the source. A classic (G...)
  // wallet can use itself; smart-account (C...) wallets fall back to the attestor key.
  let sourceAddress: string | null = null;
  if (wallet.startsWith('G')) {
    sourceAddress = wallet;
  } else if (process.env.SOLIS_ATTESTOR_SECRET) {
    sourceAddress = Keypair.fromSecret(process.env.SOLIS_ATTESTOR_SECRET).publicKey();
  }
  if (!sourceAddress) return '0';
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(token).call('balance', Address.fromString(wallet).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return '0';
  return String(scValToNative(sim.result.retval));
}

/**
 * DEV ONLY: submits a signed host function straight to RPC, paying fees from a
 * server-side deployer account. Used when no relayer is available; it proves the
 * protocol end to end but not the final gasless experience.
 */
export function directRpcEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_DIRECT_RPC === 'true' &&
    Boolean(process.env.STELLAR_DEPLOYER_SECRET)
  );
}

export async function submitHostFunctionDirect(funcXdr: string, authXdrs: string[]): Promise<string> {
  if (!directRpcEnabled()) throw new Error('Direct RPC submission is disabled');
  const deployer = Keypair.fromSecret(process.env.STELLAR_DEPLOYER_SECRET!);
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(deployer.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE_STROOPS ?? BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.fromXDR(funcXdr, 'base64'),
        auth: authXdrs.map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')),
      }),
    )
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(deployer);
  return sendAndConfirm(server, prepared);
}
