import {
  Client,
  AccountId,
  PrivateKey,
  TransferTransaction,
  Hbar,
} from '@hashgraph/sdk';
import dotenv from 'dotenv';

dotenv.config();

// Re-export shared utilities so agent/client.ts can import from one place
export { generateNonce, decodeX402Token } from '../server/src/utils/x402-utils';



export interface WalletConfig {
  accountId: AccountId;
  privateKey: PrivateKey;
  client: Client;
}

export interface PaymentToken {
  token: string;
  transactionId: string;
  accountId: string;
  amount: number;
  denomination: string;
  timestamp: string;
  nonce: string;
}

/**
 * Creates and returns a configured Hedera testnet client for the AGENT consumer wallet.
 * This is a separate account from the merchant/operator that runs the server.
 */
export function createAgentWallet(): WalletConfig {
  const accountIdStr = process.env.AGENT_HEDERA_ACCOUNT_ID;
  const privateKeyStr = process.env.AGENT_HEDERA_PRIVATE_KEY;

  if (!accountIdStr || !privateKeyStr) {
    throw new Error(
      '❌ Missing AGENT_HEDERA_ACCOUNT_ID or AGENT_HEDERA_PRIVATE_KEY in .env\n' +
        '   Get a free testnet account at: https://portal.hedera.com/'
    );
  }

  const accountId = AccountId.fromString(accountIdStr);
  const privateKey = PrivateKey.fromStringDer(privateKeyStr);

  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);

  // Set reasonable timeouts
  client.setRequestTimeout(30_000);
  client.setMaxAttempts(3);

  return { accountId, privateKey, client };
}

/**
 * Creates an x402-compliant Hedera micropayment authorization token.
 *
 * Builds a TransferTransaction that sends the specified HBAR amount to
 * the merchant/gateway account with a memo embedding the challenge nonce.
 * Serializes and encodes the signed transaction bytes as a base64 token.
 */
export async function createX402PaymentToken(
  wallet: WalletConfig,
  merchantAccountId: string,
  amountHbar: number,
  challengeNonce: string
): Promise<PaymentToken> {
  const merchant = AccountId.fromString(merchantAccountId);
  const memo = `x402:${challengeNonce}`;

  console.log(`  💸 Building Hedera transfer: ${amountHbar} HBAR → ${merchantAccountId}`);
  console.log(`  📝 Memo: ${memo}`);

  const transaction = await new TransferTransaction()
    .addHbarTransfer(wallet.accountId, new Hbar(-amountHbar))
    .addHbarTransfer(merchant, new Hbar(amountHbar))
    .setTransactionMemo(memo)
    .setMaxTransactionFee(new Hbar(2))
    .freezeWith(wallet.client);

  const signedTx = await transaction.sign(wallet.privateKey);
  const txBytes = signedTx.toBytes();
  const txId = transaction.transactionId?.toString() ?? `${wallet.accountId}@${Date.now()}`;

  // Build x402 token: base64(JSON payload with signed tx bytes)
  const tokenPayload = {
    version: '1',
    protocol: 'x402',
    network: 'hedera-testnet',
    facilitator: 'Blocky402',
    transactionId: txId,
    accountId: wallet.accountId.toString(),
    merchantAccountId,
    amount: amountHbar,
    denomination: 'HBAR',
    nonce: challengeNonce,
    timestamp: new Date().toISOString(),
    signedTransaction: Buffer.from(txBytes).toString('base64'),
  };

  const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');

  return {
    token,
    transactionId: txId,
    accountId: wallet.accountId.toString(),
    amount: amountHbar,
    denomination: 'HBAR',
    timestamp: tokenPayload.timestamp,
    nonce: challengeNonce,
  };
}

