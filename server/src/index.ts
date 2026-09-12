import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { x402Middleware, X402ChallengeError } from './middleware/x402';
import { callConfidentialUpstream } from './services/upstream';

let requestCount = 0;
let paymentTotal = 0;

// ── Recent Transactions Store (last 20, shown on dashboard) ───────────────────
interface TxRecord {
  id: string;
  transactionId: string;
  hashscanUrl: string;
  amount: string;
  from: string;
  to: string;
  query: string;
  attestation: string;
  timestamp: string;
  status: 'confirmed';
}
const recentTransactions: TxRecord[] = [];
function addTxRecord(r: TxRecord) {
  recentTransactions.unshift(r);       // newest first
  if (recentTransactions.length > 20) recentTransactions.pop();
}

async function start(): Promise<void> {
  const server = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await server.register(fastifyCors, { origin: '*' });
  await server.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
  });

  // ── Health Check ───────────────────────────────────────────────────────────
  server.get('/health', async () => ({
    status: 'ok',
    service: 'VendingAgent',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    tracks: ['Hedera x402', 'Chainlink CRE TEE', 'Bazantic MCP'],
  }));

  // ── Service Info (x402 discovery) ─────────────────────────────────────────
  server.get('/api/v1/info', async () => ({
    service: 'VendingAgent',
    description: 'Pay-per-call confidential AI API proxy – ETHOnline 2026',
    pricePerCall: {
      amount: parseFloat(process.env.X402_PRICE_HBAR || '0.5'),
      denomination: 'HBAR',
      network: 'hedera-testnet',
      facilitator: 'Blocky402',
      merchantAccount: process.env.X402_MERCHANT_ACCOUNT_ID,
    },
    endpoints: {
      query: 'POST /api/v1/query',
      info: 'GET /api/v1/info',
      metrics: 'GET /api/v1/metrics',
      transactions: 'GET /api/v1/transactions',
    },
    confidentialCompute: {
      provider: 'Chainlink CRE',
      mode: 'handlerInTee',
      attestation: true,
    },
    mcp: {
      server: `${process.env.SERVER_BASE_URL || 'http://localhost:3001'}/mcp`,
      recipe: 'bazantic/recipe.json',
    },
  }));

  // ── Core Pay-gated Query Endpoint ─────────────────────────────────────────
  server.post<{
    Body: { query: string; context?: Record<string, unknown> };
  }>('/api/v1/query', {
    schema: {
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 2000 },
          context: { type: 'object' },
        },
      },
    },
    preHandler: x402Middleware,
  }, async (request, reply) => {
    const { query, context } = request.body;
    const paymentInfo = (request as any).x402Payment;

    server.log.info({ query, paymentInfo }, '✅ Payment verified – routing to TEE enclave');

    const result = await callConfidentialUpstream(query, context);

    const txId: string = paymentInfo?.transactionId ?? '';
    const priceHbar = process.env.X402_PRICE_HBAR || '0.5';

    // ── Record real transaction for the dashboard ──────────────────────────
    // Build the correct HashScan URL:
    // SDK format  : 0.0.ACCT@SECS.NANOS
    // HashScan URL: 0.0.ACCT-SECS-NANOS
    const hashscanId = txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
    const isMock = process.env.MOCK_PAYMENTS === 'true';

    addTxRecord({
      id: result.queryId,
      transactionId: txId,
      hashscanUrl: isMock
        ? '#'
        : `https://hashscan.io/testnet/transaction/${hashscanId}`,
      amount: `${priceHbar} HBAR`,
      from: paymentInfo?.accountId ?? 'agent',
      to: process.env.X402_MERCHANT_ACCOUNT_ID ?? 'merchant',
      query: query.slice(0, 80),
      attestation: result.attestation,
      timestamp: new Date().toISOString(),
      status: 'confirmed',
    });

    return reply.code(200).send({
      success: true,
      data: result.payload,
      meta: {
        queryId: result.queryId,
        hedgera: {
          transactionId: txId,
          hashscanUrl: isMock ? null : `https://hashscan.io/testnet/transaction/${hashscanId}`,
          settlementStatus: 'confirmed',
          amountPaid: `${priceHbar} HBAR`,
          mock: isMock,
        },
        confidentialCompute: {
          provider: 'Chainlink CRE',
          attestation: result.attestation,
          executedInTee: true,
          enclaveId: result.enclaveId,
        },
        timestamp: new Date().toISOString(),
      },
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────
  server.addHook('onResponse', async (request) => {
    if (request.url === '/api/v1/query') {
      requestCount++;
      paymentTotal += parseFloat(process.env.X402_PRICE_HBAR || '0.5');
    }
  });

  server.get('/api/v1/metrics', async () => ({
    totalRequests: requestCount,
    totalHBARSettled: paymentTotal,
    uptime: process.uptime(),
    teeExecutions: requestCount,
    facilitator: 'Blocky402',
    network: 'hedera-testnet',
    mockMode: process.env.MOCK_PAYMENTS === 'true',
  }));

  // ── Real Transactions Feed (for dashboard) ────────────────────────────────
  server.get('/api/v1/transactions', async () => ({
    transactions: recentTransactions,
    total: recentTransactions.length,
    mockMode: process.env.MOCK_PAYMENTS === 'true',
  }));

  // ── Demo Query (browser-initiated, no payment cycle) ──────────────────────
  // Called by the web dashboard's "Live Query" panel. Calls the real TEE
  // upstream and records the result as a transaction — no client wallet needed.
  server.post<{ Body: { query: string } }>(
    '/api/v1/demo-query',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { query } = request.body;
      const priceHbar = process.env.X402_PRICE_HBAR || '0.5';
      const isMock    = process.env.MOCK_PAYMENTS === 'true';
      const merchantId = process.env.X402_MERCHANT_ACCOUNT_ID || 'demo';

      server.log.info({ query }, '🌐 Demo query from dashboard');

      const result = await callConfidentialUpstream(query, {});

      // Record as a "web-demo" transaction in the live feed
      const demoTxId   = `web-demo@${Date.now()}`;
      const hashscanId = null; // no real Hedera tx for browser demo
      addTxRecord({
        id: result.queryId,
        transactionId: demoTxId,
        hashscanUrl: isMock ? '#' : null as any,
        amount: `${priceHbar} HBAR (demo)`,
        from: 'web-browser',
        to: merchantId,
        query: query.slice(0, 80),
        attestation: result.attestation,
        timestamp: new Date().toISOString(),
        status: 'confirmed',
      });

      requestCount++;
      paymentTotal += parseFloat(priceHbar);

      return reply.code(200).send({
        success: true,
        data: result.payload,
        meta: {
          queryId: result.queryId,
          hedgera: {
            transactionId: demoTxId,
            hashscanUrl: null,
            settlementStatus: 'demo',
            amountPaid: `${priceHbar} HBAR`,
            note: 'Browser demo query — run agent/client.ts for real on-chain Hedera payment',
          },
          confidentialCompute: {
            provider: 'Chainlink CRE',
            attestation: result.attestation,
            executedInTee: true,
            enclaveId: result.enclaveId,
          },
          timestamp: new Date().toISOString(),
        },
      });
    }
  );

  // ── Error Handling ─────────────────────────────────────────────────────────
  server.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof X402ChallengeError) return;
    server.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred',
    });
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  const PORT = parseInt(process.env.PORT || '3000', 10);
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    const mode = process.env.MOCK_PAYMENTS === 'true' ? '🔧 MOCK' : '⛓️  REAL';
    console.log(`
  ╔══════════════════════════════════════════════════╗
  ║          🤖 VendingAgent – ETHOnline 2026        ║
  ║  Decentralized Pay-Per-Call AI API Gateway       ║
  ╠══════════════════════════════════════════════════╣
  ║  Server   → http://localhost:${PORT}              ║
  ║  Gateway  → x402 / Hedera Testnet / Blocky402   ║
  ║  Compute  → Chainlink CRE TEE (handlerInTee)    ║
  ║  Agent    → MCP + Bazantic Recipe               ║
  ║  Mode     → ${mode} payments                    ║
  ╚══════════════════════════════════════════════════╝
    `);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
