import type { FastifyRequest, FastifyReply } from 'fastify';
import { decodeX402Token, generateNonce } from '../utils/x402-utils';
import dotenv from 'dotenv';

dotenv.config();

export class X402ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402ChallengeError';
  }
}

// In-memory nonce store (use Redis in production)
const usedNonces = new Set<string>();
const nonceTTL = new Map<string, number>();

// Clean up expired nonces every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of nonceTTL.entries()) {
    if (now > expiry) {
      usedNonces.delete(nonce);
      nonceTTL.delete(nonce);
    }
  }
}, 5 * 60 * 1000);

const PRICE_HBAR = parseFloat(process.env.X402_PRICE_HBAR || '0.5');
// 1 HBAR = 100,000,000 tinybars (Hedera's smallest denomination)
const PRICE_TINYBARS = Math.round(PRICE_HBAR * 100_000_000); // default: 50_000_000
const MERCHANT_ACCOUNT = process.env.X402_MERCHANT_ACCOUNT_ID || '0.0.0000000';
const BLOCKY402_URL = process.env.BLOCKY402_FACILITATOR_URL || 'https://api.blocky402.com/v1';


/**
 * Hedera x402 Middleware
 *
 * Intercepts all requests to protected endpoints and:
 * 1. If no Authorization header → issues an HTTP 402 challenge with payment details.
 * 2. If Authorization: x402 <token> is present → verifies with Blocky402 facilitator
 *    and attaches payment info to the request for downstream handlers.
 */
export async function x402Middleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers['authorization'];

  // ── Step 1: No payment presented → issue 402 challenge ──────────────────
  if (!authHeader || !authHeader.startsWith('x402 ')) {
    const nonce = generateNonce();
    const challengeExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

    const challengeBody = {
      error: 'Payment Required',
      message: 'This endpoint requires an x402 micropayment to proceed.',
      payment: {
        protocol: 'x402',
        version: '1',
        facilitator: 'Blocky402',
        network: 'hedera-testnet',
        // Amount expressed in both HBAR (human-readable) and tinybars (Hedera native)
        amount: PRICE_HBAR,
        amountTinybars: PRICE_TINYBARS,
        denomination: 'HBAR',
        denominationUnit: 'tinybar',
        merchantAccount: MERCHANT_ACCOUNT,
        payeeAccountId: MERCHANT_ACCOUNT,
        nonce,
        challengeExpiry,
        instructions: [
          '1. Send HBAR transfer to payeeAccountId with memo "x402:<nonce>"',
          '2. Amount: ' + PRICE_TINYBARS + ' tinybars (' + PRICE_HBAR + ' HBAR)',
          '3. Encode signed transaction bytes as base64 JSON token',
          '4. Retry with header: Authorization: x402 <token>',
        ],
        links: {
          hedera_portal: 'https://portal.hedera.com/',
          sdk: 'https://www.npmjs.com/package/@hashgraph/sdk',
          blocky402: 'https://blocky402.com',
          x402_spec: 'https://x402.org',
        },
      },
    };


    reply
      .code(402)
      .header('WWW-Authenticate', 'x402')
      .header('X-Payment-Protocol', 'x402')
      .header('X-Payment-Network', 'hedera-testnet')
      .header('X-Payment-Amount', PRICE_HBAR.toString())
      .header('X-Payment-Amount-Tinybars', PRICE_TINYBARS.toString())
      .header('X-Payment-Denomination', 'HBAR')
      .header('X-Payment-Address', MERCHANT_ACCOUNT)
      .header('X-Payment-Payee-Account-Id', MERCHANT_ACCOUNT)
      .header('X-Payment-Facilitator', 'Blocky402')
      .header('X-Payment-Nonce', nonce)
      .header('X-Payment-Expiry', challengeExpiry)
      .header('X-VendingAgent-Version', '1.0.0')
      .send(challengeBody);


    throw new X402ChallengeError('402 issued to client');
  }

  // ── Step 2: Payment token provided → verify with Blocky402 ───────────────
  const rawToken = authHeader.slice('x402 '.length).trim();

  let tokenPayload: Record<string, unknown>;
  try {
    tokenPayload = decodeX402Token(rawToken);
  } catch (err) {
    return reply.code(400).send({
      error: 'Invalid Payment Token',
      message: 'The x402 token could not be decoded. Ensure it is properly base64-encoded JSON.',
    });
  }

  // Validate required fields
  const requiredFields = ['transactionId', 'accountId', 'amount', 'nonce', 'signedTransaction'];
  for (const field of requiredFields) {
    if (!tokenPayload[field]) {
      return reply.code(400).send({
        error: 'Malformed Payment Token',
        message: `Missing required field: ${field}`,
      });
    }
  }

  const nonce = tokenPayload['nonce'] as string;
  const transactionId = tokenPayload['transactionId'] as string;
  const amount = tokenPayload['amount'] as number;
  const accountId = tokenPayload['accountId'] as string;
  const facilitator = (tokenPayload['facilitator'] as string) || 'Blocky402';

  // Replay attack prevention
  if (usedNonces.has(nonce)) {
    return reply.code(402).send({
      error: 'Payment Replay Detected',
      message: 'This nonce has already been used. Please initiate a new request for a fresh challenge.',
    });
  }

  // Validate amount – accept either HBAR float or tinybar integer
  const amountInTinybars = amount >= 1
    ? amount                            // already tinybars
    : Math.round(amount * 100_000_000); // convert from HBAR

  if (amountInTinybars < PRICE_TINYBARS) {
    return reply.code(402).send({
      error: 'Insufficient Payment',
      message: `Payment of ${amountInTinybars} tinybars is less than required ${PRICE_TINYBARS} tinybars (${PRICE_HBAR} HBAR).`,
    });
  }


  // ── Step 3: Verify with Blocky402 facilitator (or Hedera Mirror Node) ───
  const verified = await verifyWithBlocky402(transactionId, accountId, MERCHANT_ACCOUNT, amount, nonce);

  if (!verified.success) {
    return reply.code(402).send({
      error: 'Payment Verification Failed',
      message: verified.reason,
      details: {
        transactionId,
        facilitator,
      },
    });
  }

  // Mark nonce as used (TTL = 1 hour)
  usedNonces.add(nonce);
  nonceTTL.set(nonce, Date.now() + 60 * 60 * 1000);

  // Attach payment info to request for downstream handlers
  (request as any).x402Payment = {
    transactionId,
    accountId,
    amount,
    denomination: 'HBAR',
    facilitator,
    nonce,
    verifiedAt: new Date().toISOString(),
  };

  request.log.info({ transactionId, accountId, amount }, '✅ x402 payment verified via Blocky402');
}

/**
 * Verifies a Hedera payment transaction via the Blocky402 facilitator API.
 *
 * In production: calls Blocky402's REST API to confirm on-chain finality.
 * In simulation: falls back to Hedera Testnet Mirror Node REST API.
 */
async function verifyWithBlocky402(
  transactionId: string,
  senderAccountId: string,
  recipientAccountId: string,
  expectedAmountHbar: number,
  nonce: string
): Promise<{ success: boolean; reason?: string }> {
  // --- PRODUCTION: Call Blocky402 Facilitator API ---
  try {
    const response = await fetch(`${BLOCKY402_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionId,
        senderAccountId,
        recipientAccountId,
        expectedAmountHbar,
        nonce,
        network: 'testnet',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const result = await response.json() as { verified: boolean; reason?: string };
      return { success: result.verified, reason: result.reason };
    }
    // Fall through to mirror node check if Blocky402 is unreachable
  } catch {
    console.warn('⚠️  Blocky402 facilitator unreachable, falling back to Hedera Mirror Node...');
  }

  // --- FALLBACK: Verify directly via Hedera Testnet Mirror Node REST API ---
  return verifyViaMirrorNode(transactionId, recipientAccountId, expectedAmountHbar);
}

/**
 * Fallback verification via Hedera Testnet Mirror Node REST API.
 * Checks that the transfer transaction is confirmed and sent the correct amount.
 */
async function verifyViaMirrorNode(
  transactionId: string,
  recipientAccountId: string,
  expectedAmountHbar: number
): Promise<{ success: boolean; reason?: string }> {
  try {
    // Normalize Hedera tx ID for Mirror Node REST API:
    // SDK format  : 0.0.10503208@1789235210.444516744
    // Mirror Node : 0.0.10503208-1789235210-444516744
    const normalizedId = transactionId
      .replace('@', '-')          // @ → -  (separates account from timestamp)
      .replace(/\.(\d+)$/, '-$1'); // final .NANOS → -NANOS  (keeps shard.realm.num intact)
    const mirrorUrl = `https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(normalizedId)}`;


    const resp = await fetch(mirrorUrl, { signal: AbortSignal.timeout(15_000) });

    if (!resp.ok) {
      // In dev/test mode without real Hedera accounts, simulate success
      if (process.env.NODE_ENV === 'test' || process.env.MOCK_PAYMENTS === 'true') {
        console.log('🔧 MOCK MODE: Simulating payment verification success');
        return { success: true };
      }
      return { success: false, reason: `Mirror node returned HTTP ${resp.status} for transaction ${transactionId}` };
    }

    const data = await resp.json() as any;
    const tx = data.transactions?.[0];

    if (!tx) {
      return { success: false, reason: 'Transaction not found on Hedera Testnet Mirror Node' };
    }

    if (tx.result !== 'SUCCESS') {
      return { success: false, reason: `Transaction status: ${tx.result}` };
    }

    // Verify the HBAR transfer amount to our merchant account
    const expectedTinybars = Math.round(expectedAmountHbar * 100_000_000);
    const transfers: Array<{ account: string; amount: number }> = tx.transfers || [];
    const matchingTransfer = transfers.find(
      (t) => t.account === recipientAccountId && t.amount >= expectedTinybars
    );

    if (!matchingTransfer) {
      return {
        success: false,
        reason: `No transfer of ≥${expectedAmountHbar} HBAR to ${recipientAccountId} found in transaction`,
      };
    }

    return { success: true };
  } catch (err) {
    if (process.env.NODE_ENV === 'test' || process.env.MOCK_PAYMENTS === 'true') {
      console.log('🔧 MOCK MODE: Simulating payment verification success');
      return { success: true };
    }
    return { success: false, reason: `Mirror node verification error: ${(err as Error).message}` };
  }
}
