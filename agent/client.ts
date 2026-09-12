import 'dotenv/config';
import { createAgentWallet, createX402PaymentToken } from './wallet';

const SERVER_URL = process.env.SERVER_BASE_URL || 'http://localhost:3000';
const ENDPOINT = `${SERVER_URL}/api/v1/query`;

interface QueryResponse {
  success: boolean;
  data: Record<string, unknown>;
  meta: {
    queryId: string;
    hedgera: { transactionId: string; settlementStatus: string; amountPaid: string };
    confidentialCompute: { provider: string; attestation: string; executedInTee: boolean; enclaveId: string };
    timestamp: string;
  };
}

/**
 * VendingAgent Autonomous Consumer Agent
 *
 * This script demonstrates a fully autonomous AI agent that:
 * 1. Discovers a pay-gated API service.
 * 2. Handles the HTTP 402 (x402) challenge automatically.
 * 3. Constructs and signs a Hedera micropayment transaction.
 * 4. Retries the request with an Authorization: x402 <token> header.
 * 5. Receives and processes the confidential compute result.
 *
 * This is the reference implementation for the Hedera ETHOnline 2026 track.
 */
async function runAutonomousAgent(query: string): Promise<void> {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  🤖 VendingAgent – Autonomous AI Consumer Agent          │');
  console.log('│  Hedera x402 Micropayment Protocol (ETHOnline 2026)     │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  console.log(`📋 Query: "${query}"`);
  console.log(`🌐 Endpoint: ${ENDPOINT}\n`);

  // ── Phase 1: Initial request (expect 402) ────────────────────────────────
  console.log('━━━ Phase 1: Sending Initial Request ━━━━━━━━━━━━━━━━━━━━━━');
  const startTime = Date.now();

  const initialResponse = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  console.log(`  Status: HTTP ${initialResponse.status} ${initialResponse.statusText}`);

  if (initialResponse.status !== 402) {
    const body = await initialResponse.json();
    console.log('  ✅ Unexpectedly received non-402 response:', body);
    return;
  }

  // ── Phase 2: Parse x402 Challenge ───────────────────────────────────────
  console.log('\n━━━ Phase 2: Parsing x402 Payment Challenge ━━━━━━━━━━━━━━━');

  const challengeHeaders = {
    wwwAuthenticate: initialResponse.headers.get('www-authenticate'),
    protocol: initialResponse.headers.get('x-payment-protocol'),
    network: initialResponse.headers.get('x-payment-network'),
    amount: initialResponse.headers.get('x-payment-amount'),
    denomination: initialResponse.headers.get('x-payment-denomination'),
    merchantAccount: initialResponse.headers.get('x-payment-address'),
    facilitator: initialResponse.headers.get('x-payment-facilitator'),
    nonce: initialResponse.headers.get('x-payment-nonce'),
    expiry: initialResponse.headers.get('x-payment-expiry'),
  };

  const challengeBody = await initialResponse.json() as any;

  console.log(`  🔔 Payment required!`);
  console.log(`  💰 Amount:     ${challengeHeaders.amount} ${challengeHeaders.denomination}`);
  console.log(`  🏦 Merchant:   ${challengeHeaders.merchantAccount}`);
  console.log(`  🔗 Network:    ${challengeHeaders.network}`);
  console.log(`  🤝 Facilitator: ${challengeHeaders.facilitator}`);
  console.log(`  🎲 Nonce:      ${challengeHeaders.nonce}`);
  console.log(`  ⏰ Expires:    ${challengeHeaders.expiry}`);

  if (!challengeHeaders.merchantAccount || !challengeHeaders.amount || !challengeHeaders.nonce) {
    throw new Error('Incomplete x402 challenge headers received from server');
  }

  // ── Phase 3: Initialize Hedera Wallet & Sign Payment ─────────────────────
  console.log('\n━━━ Phase 3: Signing Hedera Micropayment ━━━━━━━━━━━━━━━━━━');

  const wallet = createAgentWallet();
  console.log(`  👛 Agent Wallet: ${wallet.accountId.toString()}`);
  console.log(`  🔑 Key type:     ED25519`);

  const paymentToken = await createX402PaymentToken(
    wallet,
    challengeHeaders.merchantAccount,
    parseFloat(challengeHeaders.amount),
    challengeHeaders.nonce
  );

  console.log(`  ✅ Payment signed!`);
  console.log(`  📜 Transaction ID: ${paymentToken.transactionId}`);
  console.log(`  🎫 Token (first 64 chars): ${paymentToken.token.slice(0, 64)}...`);

  // ── Phase 4: Retry with Payment Token ────────────────────────────────────
  console.log('\n━━━ Phase 4: Retrying Request with x402 Authorization ━━━━━');

  const paidResponse = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `x402 ${paymentToken.token}`,
    },
    body: JSON.stringify({ query }),
  });

  const latencyMs = Date.now() - startTime;
  console.log(`  Status: HTTP ${paidResponse.status} ${paidResponse.statusText}`);
  console.log(`  ⚡ Round-trip latency: ${latencyMs}ms`);

  if (!paidResponse.ok) {
    const errBody = await paidResponse.json();
    console.error('\n  ❌ Payment verification failed:', errBody);
    return;
  }

  // ── Phase 5: Process Confidential Response ────────────────────────────────
  console.log('\n━━━ Phase 5: Processing Confidential TEE Response ━━━━━━━━━');

  const result = await paidResponse.json() as QueryResponse;

  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║           ✅ SUCCESS – Data Received              ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('\n  📊 QUERY RESULT:');
  console.log(JSON.stringify(result.data, null, 4).split('\n').map((l) => '  ' + l).join('\n'));

  console.log('\n  📋 SETTLEMENT RECEIPT:');
  console.log(`  ├─ Hedera Tx ID:   ${result.meta.hedgera.transactionId}`);
  console.log(`  ├─ Settlement:     ${result.meta.hedgera.settlementStatus}`);
  console.log(`  └─ Amount Paid:    ${result.meta.hedgera.amountPaid}`);

  console.log('\n  🔒 TEE ATTESTATION:');
  console.log(`  ├─ Provider:       ${result.meta.confidentialCompute.provider}`);
  console.log(`  ├─ Enclave ID:     ${result.meta.confidentialCompute.enclaveId}`);
  console.log(`  ├─ In TEE:         ${result.meta.confidentialCompute.executedInTee}`);
  console.log(`  └─ Attestation:    ${result.meta.confidentialCompute.attestation}`);

  console.log('\n  🎉 Agent task completed successfully!');
  console.log(`  Total time: ${latencyMs}ms | Query ID: ${result.meta.queryId}\n`);
}

// ── Entry point ─────────────────────────────────────────────────────────────
const userQuery = process.argv[2] || 'What is the current price of HBAR token?';
runAutonomousAgent(userQuery).catch((err) => {
  console.error('\n❌ Agent encountered an error:', err.message);
  process.exit(1);
});
