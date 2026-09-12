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
 * Parses a Hedera private key from any format the Hedera portal might export:
 *
 *  - DER encoded : "302e020100300506032b6570..."  (portal default, 64+ hex chars)
 *  - Hex + 0x    : "0xfc432a83e109ad91..."        (MetaMask / some wallets)
 *  - Raw hex     : "fc432a83e109ad91..."           (64 lowercase hex chars)
 *
 * Always prefer DER (302e...) — that's what portal.hedera.com gives you.
 */
function parsePrivateKey(raw: string): PrivateKey {
  const key = raw.trim();

  // DER format: ASN.1 header 302e / 3026 / 302a for ED25519
  if (key.startsWith('302e') || key.startsWith('3026') || key.startsWith('302a')) {
    return PrivateKey.fromStringDer(key);
  }

  // Hex with 0x prefix → strip prefix, treat as raw ED25519 seed bytes
  if (key.startsWith('0x') || key.startsWith('0X')) {
    return PrivateKey.fromStringED25519(key.slice(2));
  }

  // Plain 64-char hex → raw ED25519 private key seed
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return PrivateKey.fromStringED25519(key);
  }

  // Fallback: let the SDK try both formats
  try { return PrivateKey.fromStringDer(key); } catch (_) {}
  try { return PrivateKey.fromStringED25519(key); } catch (_) {}

  throw new Error(
    `❌ Cannot parse private key. Expected DER (302e...) or 64-char hex.\n` +
    `   Got: "${key.slice(0, 20)}..."\n` +
    `   Export your key from https://portal.hedera.com/ → DER format.`
  );
}

/**
 * Creates and returns a configured Hedera testnet client for the AGENT consumer wallet.
 * Accepts AGENT_HEDERA_ACCOUNT_ID + AGENT_HEDERA_PRIVATE_KEY from .env.
 *
 * TIP: If you only have one Hedera account, you can use the same account for
 * both HEDERA_OPERATOR_ID and AGENT_HEDERA_ACCOUNT_ID (the server and agent
 * will just transfer HBAR to themselves on testnet — valid for demo purposes).
 */
export function createAgentWallet(): WalletConfig {
  const accountIdStr = process.env.AGENT_HEDERA_ACCOUNT_ID;
  const privateKeyStr = process.env.AGENT_HEDERA_PRIVATE_KEY;

  if (
    !accountIdStr || !privateKeyStr ||
    accountIdStr.includes('Y') || accountIdStr.includes('X') ||
    privateKeyStr.includes('...')
  ) {
    throw new Error(
      '❌ Missing or placeholder AGENT_HEDERA_ACCOUNT_ID / AGENT_HEDERA_PRIVATE_KEY\n' +
      '   Fix in .env:\n' +
      '     AGENT_HEDERA_ACCOUNT_ID=0.0.10503208       ← your account ID\n' +
      '     AGENT_HEDERA_PRIVATE_KEY=302e020100...     ← DER private key\n' +
      '   (You can reuse HEDERA_OPERATOR_ID / HEDERA_OPERATOR_PRIVATE_KEY if you only have one account)\n' +
      '   Create accounts at: https://portal.hedera.com/'
    );
  }

  const accountId = AccountId.fromString(accountIdStr);
  const privateKey = parsePrivateKey(privateKeyStr);

  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);
  client.setRequestTimeout(30_000);
  client.setMaxAttempts(3);

  return { accountId, privateKey, client };
}

/**
 * Creates an x402-compliant Hedera micropayment authorization token.
 *
 * Builds a TransferTransaction that sends HBAR to the merchant account with
 * memo "x402:<nonce>", signs it with the agent key, and encodes as a
 * base64 JSON token for the Authorization: x402 <token> header.
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

  // ── Submit to Hedera network (REAL mode) ──────────────────────────────────
  // In real mode (MOCK_PAYMENTS=false) we execute the transaction so it lands
  // on-chain and is visible on HashScan / Mirror Node.
  if (process.env.MOCK_PAYMENTS !== 'true') {
    console.log(`  📡 Submitting transaction to Hedera Testnet...`);
    try {
      const response = await signedTx.execute(wallet.client);
      const receipt = await response.getReceipt(wallet.client);
      console.log(`  ✅ On-chain! Status: ${receipt.status.toString()}`);
      console.log(`  🔍 HashScan: https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`);
    } catch (err) {
      console.warn(`  ⚠️  Submit failed: ${(err as Error).message}`);
      console.warn(`  ℹ️  Continuing with signed bytes — Mirror Node may not verify immediately`);
    }
  } else {
    console.log(`  🔧 MOCK MODE: Skipping on-chain submission`);
  }

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

