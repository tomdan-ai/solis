import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';

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
    const hash = Buffer.from(operation.phoneHash.replace(/^0x/, ''), 'hex');
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
