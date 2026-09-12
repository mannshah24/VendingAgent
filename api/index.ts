/**
 * Vercel Serverless Entry Point for VendingAgent
 * Wraps the Fastify app as a Vercel function handler.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { x402Middleware, X402ChallengeError } from '../server/src/middleware/x402';
import { callConfidentialUpstream } from '../server/src/services/upstream';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let requestCount = 0;
let paymentTotal = 0;

interface TxRecord {
  id: string; transactionId: string; hashscanUrl: string;
  amount: string; from: string; to: string; query: string;
  attestation: string; timestamp: string; status: 'confirmed';
}
const recentTransactions: TxRecord[] = [];
function addTxRecord(r: TxRecord) {
  recentTransactions.unshift(r);
  if (recentTransactions.length > 20) recentTransactions.pop();
}

const app = Fastify({ logger: false });
let ready = false;

async function build() {
  if (ready) return app;

  await app.register(fastifyCors, { origin: '*' });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../server/src/public'),
    prefix: '/',
  });

  app.get('/health', async () => ({
    status: 'ok', service: 'VendingAgent', version: '1.0.0',
    timestamp: new Date().toISOString(),
    tracks: ['Hedera x402', 'Chainlink CRE TEE', 'Bazantic MCP'],
  }));

  app.get('/api/v1/info', async () => ({
    service: 'VendingAgent',
    description: 'Pay-per-call confidential AI API proxy – ETHOnline 2026',
    pricePerCall: {
      amount: parseFloat(process.env.X402_PRICE_HBAR || '0.5'),
      denomination: 'HBAR', network: 'hedera-testnet',
      facilitator: 'Blocky402',
      merchantAccount: process.env.X402_MERCHANT_ACCOUNT_ID,
    },
    confidentialCompute: { provider: 'Chainlink CRE', mode: 'handlerInTee', attestation: true },
  }));

  app.post<{ Body: { query: string; context?: Record<string, unknown> } }>(
    '/api/v1/query',
    { schema: { body: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, context: { type: 'object' } } } }, preHandler: x402Middleware },
    async (request, reply) => {
      const { query, context } = request.body;
      const paymentInfo = (request as any).x402Payment;
      const result = await callConfidentialUpstream(query, context);
      const txId: string = paymentInfo?.transactionId ?? '';
      const priceHbar = process.env.X402_PRICE_HBAR || '0.5';
      const hashscanId = txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
      const isMock = process.env.MOCK_PAYMENTS === 'true';
      addTxRecord({ id: result.queryId, transactionId: txId, hashscanUrl: isMock ? '#' : `https://hashscan.io/testnet/transaction/${hashscanId}`, amount: `${priceHbar} HBAR`, from: paymentInfo?.accountId ?? 'agent', to: process.env.X402_MERCHANT_ACCOUNT_ID ?? 'merchant', query: query.slice(0, 80), attestation: result.attestation, timestamp: new Date().toISOString(), status: 'confirmed' });
      return reply.code(200).send({ success: true, data: result.payload, meta: { queryId: result.queryId, hedgera: { transactionId: txId, hashscanUrl: isMock ? null : `https://hashscan.io/testnet/transaction/${hashscanId}`, settlementStatus: 'confirmed', amountPaid: `${priceHbar} HBAR` }, confidentialCompute: { provider: 'Chainlink CRE', attestation: result.attestation, executedInTee: true, enclaveId: result.enclaveId }, timestamp: new Date().toISOString() } });
    }
  );

  app.addHook('onResponse', async (request) => {
    if (request.url === '/api/v1/query') { requestCount++; paymentTotal += parseFloat(process.env.X402_PRICE_HBAR || '0.5'); }
  });

  app.get('/api/v1/metrics', async () => ({ totalRequests: requestCount, totalHBARSettled: paymentTotal, uptime: process.uptime(), teeExecutions: requestCount, facilitator: 'Blocky402', network: 'hedera-testnet', mockMode: process.env.MOCK_PAYMENTS === 'true' }));
  app.get('/api/v1/transactions', async () => ({ transactions: recentTransactions, total: recentTransactions.length, mockMode: process.env.MOCK_PAYMENTS === 'true' }));

  app.post<{ Body: { query: string } }>('/api/v1/demo-query', { schema: { body: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } } }, async (request, reply) => {
    const { query } = request.body;
    const priceHbar = process.env.X402_PRICE_HBAR || '0.5';
    const result = await callConfidentialUpstream(query, {});
    const demoTxId = `web-demo@${Date.now()}`;
    addTxRecord({ id: result.queryId, transactionId: demoTxId, hashscanUrl: null as any, amount: `${priceHbar} HBAR (demo)`, from: 'web-browser', to: process.env.X402_MERCHANT_ACCOUNT_ID ?? 'demo', query: query.slice(0, 80), attestation: result.attestation, timestamp: new Date().toISOString(), status: 'confirmed' });
    requestCount++; paymentTotal += parseFloat(priceHbar);
    return reply.code(200).send({ success: true, data: result.payload, meta: { queryId: result.queryId, hedgera: { transactionId: demoTxId, hashscanUrl: null, settlementStatus: 'demo', amountPaid: `${priceHbar} HBAR` }, confidentialCompute: { provider: 'Chainlink CRE', attestation: result.attestation, executedInTee: true, enclaveId: result.enclaveId }, timestamp: new Date().toISOString() } });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof X402ChallengeError) return;
    return reply.code(500).send({ error: 'Internal Server Error', message: error.message });
  });

  await app.ready();
  ready = true;
  return app;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const fastify = await build();
  fastify.server.emit('request', req, res);
}
