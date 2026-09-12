/**
 * VendingAgent – Bazantic MCP Server
 *
 * Track: Bazantic "Agentify a New API" – ETHOnline 2026
 *
 * Exposes VendingAgent as a Model Context Protocol (MCP) tool server.
 * Any MCP-compatible LLM client (Claude Desktop, LangChain, etc.) can
 * call `vending_query` to autonomously pay for and receive attested
 * market intelligence via Hedera x402 micropayments.
 *
 * Transport: stdio (compatible with Claude Desktop, Bazantic gateway)
 *
 * Usage:
 *   npx ts-node --transpile-only bazantic/mcp-server.ts
 *
 * Claude Desktop config:
 *   { "mcpServers": { "vending-agent": { "command": "npx",
 *     "args": ["ts-node","--transpile-only","bazantic/mcp-server.ts"],
 *     "cwd": "/path/to/vending-agent" } } }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentWallet, createX402PaymentToken } from '../agent/wallet';
import dotenv from 'dotenv';

dotenv.config();

const SERVER_URL = process.env.SERVER_BASE_URL || 'http://localhost:3000';

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    /**
     * Primary tool: `vending_query`
     *
     * Handles the full x402 payment lifecycle transparently:
     *   1. POST /api/v1/query (no auth) → 402 challenge
     *   2. Sign Hedera HBAR micropayment via @hashgraph/sdk
     *   3. POST /api/v1/query [Authorization: x402 <token>] → 200 OK
     *   4. Return attested data + Hedera settlement receipt
     */
    name: 'vending_query',
    description: [
      'Query the VendingAgent confidential API gateway for premium market intelligence.',
      'This tool automatically handles the HTTP 402 x402 micropayment protocol:',
      'it signs a Hedera HBAR testnet transaction, verifies it via Blocky402,',
      'and returns data computed inside a Chainlink CRE TEE enclave with attestation.',
      'Use when the user needs: crypto prices (HBAR, BTC, ETH), stock quotes,',
      'or any market data that requires a verified, confidential data source.',
      'Payment: 0.5 HBAR (50,000,000 tinybars) per call on Hedera Testnet.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Natural language query. Examples: "What is the HBAR price?", ' +
            '"Get the AAPL stock quote", "Current price of Bitcoin".',
          minLength: 1,
          maxLength: 500,
        },
        symbol: {
          type: 'string',
          description:
            'Optional: ticker symbol override (e.g. "HBAR", "BTC", "AAPL", "TSLA"). ' +
            'When provided, overrides symbol detection from the query.',
          pattern: '^[A-Z]{1,10}$',
        },
      },
    },
  },
  {
    name: 'get_vending_pricing',
    description:
      'Retrieve current pricing, payment network, and capability details for VendingAgent. ' +
      'Call this first to understand the cost before calling vending_query.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'check_agent_wallet',
    description:
      'Check the agent Hedera testnet wallet balance and recent on-chain transactions. ' +
      'Useful to verify the agent has enough HBAR before calling vending_query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: {
          type: 'string',
          description:
            'Optional: Hedera account ID to check (e.g. "0.0.12345"). ' +
            'Defaults to the configured AGENT_HEDERA_ACCOUNT_ID.',
        },
      },
    },
  },
];

// ── MCP Server Initialization ─────────────────────────────────────────────────

const server = new Server(
  {
    name: 'vending-agent',
    version: '1.0.0',
  },
  {
    capabilities: { tools: {} },
  }
);

// ── List Tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── Call Tool Dispatcher ──────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'vending_query':
        return await handleVendingQuery(args as { query: string; symbol?: string });

      case 'get_vending_pricing':
        return await handleGetPricing();

      case 'check_agent_wallet':
        return await handleCheckWallet(args as { account_id?: string });

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: "${name}". Available tools: ${TOOLS.map(t => t.name).join(', ')}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Tool "${name}" error: ${message}` }],
      isError: true,
    };
  }
});

// ── Tool: vending_query ───────────────────────────────────────────────────────

async function handleVendingQuery(args: { query: string; symbol?: string }) {
  const endpoint = `${SERVER_URL}/api/v1/query`;
  const body = JSON.stringify({ query: args.query, context: { symbol: args.symbol } });

  // ── Phase 1: Probe (expect 402 with x402 challenge) ────────────────────
  const probe = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (probe.status === 200) {
    // Endpoint is open (no payment required)
    const data = await probe.json();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (probe.status !== 402) {
    const responseText = await probe.text();
    return {
      content: [{ type: 'text' as const, text: `Unexpected server response ${probe.status}: ${responseText}` }],
      isError: true,
    };
  }

  // ── Phase 2: Parse x402 challenge headers ────────────────────────────
  const challengeAmount    = parseFloat(probe.headers.get('x-payment-amount') || '0.5');
  const merchantAccount    = probe.headers.get('x-payment-address') || '';
  const nonce              = probe.headers.get('x-payment-nonce') || '';
  const network            = probe.headers.get('x-payment-network') || 'hedera-testnet';
  const facilitator        = probe.headers.get('x-payment-facilitator') || 'Blocky402';
  const amountTinybars     = probe.headers.get('x-payment-amount-tinybars') || '50000000';

  if (!merchantAccount || !nonce) {
    return {
      content: [{
        type: 'text' as const,
        text: 'Server returned 402 but is missing required x402 headers (x-payment-address, x-payment-nonce).',
      }],
      isError: true,
    };
  }

  // ── Phase 3: Sign Hedera micropayment ────────────────────────────────
  let wallet;
  try {
    wallet = createAgentWallet();
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `Cannot create agent wallet: ${(err as Error).message}\n` +
              'Set AGENT_HEDERA_ACCOUNT_ID and AGENT_HEDERA_PRIVATE_KEY in .env',
      }],
      isError: true,
    };
  }

  const paymentToken = await createX402PaymentToken(wallet, merchantAccount, challengeAmount, nonce);

  // ── Phase 4: Retry with x402 authorization ───────────────────────────
  const paid = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `x402 ${paymentToken.token}`,
    },
    body,
  });

  if (!paid.ok) {
    const errBody = await paid.json() as any;
    return {
      content: [{
        type: 'text' as const,
        text: `Payment rejected (HTTP ${paid.status}): ${JSON.stringify(errBody)}`,
      }],
      isError: true,
    };
  }

  // ── Phase 5: Format result ───────────────────────────────────────────
  const result = await paid.json() as any;

  const output = [
    `✅ VendingAgent Query Complete`,
    ``,
    `📊 Market Data (Chainlink CRE TEE):`,
    JSON.stringify(result.data, null, 2),
    ``,
    `💰 Hedera Settlement Receipt:`,
    `  Transaction ID : ${result.meta?.hedgera?.transactionId ?? paymentToken.transactionId}`,
    `  Amount Paid    : ${result.meta?.hedgera?.amountPaid ?? challengeAmount + ' HBAR'}`,
    `  Tinybars       : ${amountTinybars}`,
    `  Network        : ${network}`,
    `  Facilitator    : ${facilitator}`,
    `  HashScan       : https://hashscan.io/testnet/transaction/${encodeURIComponent(paymentToken.transactionId)}`,
    ``,
    `🔒 Chainlink CRE TEE Attestation:`,
    `  Provider    : ${result.meta?.confidentialCompute?.provider ?? 'Chainlink CRE'}`,
    `  Enclave ID  : ${result.meta?.confidentialCompute?.enclaveId ?? 'n/a'}`,
    `  In TEE      : ${result.meta?.confidentialCompute?.executedInTee ?? true}`,
    `  Attestation : ${result.meta?.confidentialCompute?.attestation ?? 'n/a'}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text: output }] };
}

// ── Tool: get_vending_pricing ─────────────────────────────────────────────────

async function handleGetPricing() {
  try {
    const resp = await fetch(`${SERVER_URL}/api/v1/info`, { signal: AbortSignal.timeout(5_000) });
    if (resp.ok) {
      const info = await resp.json() as any;
      const text = [
        `VendingAgent Pricing & Capabilities`,
        ``,
        `Cost per API call : ${info.pricePerCall?.amount ?? '0.5'} HBAR`,
        `In tinybars       : ${Math.round((info.pricePerCall?.amount ?? 0.5) * 1e8)} tinybars`,
        `Payment network   : ${info.pricePerCall?.network ?? 'hedera-testnet'}`,
        `Facilitator       : ${info.pricePerCall?.facilitator ?? 'Blocky402'}`,
        `Merchant account  : ${info.pricePerCall?.merchantAccount ?? 'see .env'}`,
        ``,
        `Confidential Compute:`,
        `  Provider    : ${info.confidentialCompute?.provider ?? 'Chainlink CRE'}`,
        `  Mode        : ${info.confidentialCompute?.mode ?? 'handlerInTee'}`,
        `  Attestation : ${info.confidentialCompute?.attestation ?? true}`,
        ``,
        `Available endpoints: POST /api/v1/query  |  GET /api/v1/info  |  GET /api/v1/metrics`,
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  } catch {}

  // Fallback to env defaults if server is unreachable
  const priceHbar = parseFloat(process.env.X402_PRICE_HBAR || '0.5');
  return {
    content: [{
      type: 'text' as const,
      text: [
        `VendingAgent pricing (from config):`,
        `Cost: ${priceHbar} HBAR (${Math.round(priceHbar * 1e8)} tinybars) per call`,
        `Network: hedera-testnet | Facilitator: Blocky402`,
        `Server: ${SERVER_URL} (currently unreachable)`,
      ].join('\n'),
    }],
  };
}

// ── Tool: check_agent_wallet ──────────────────────────────────────────────────

async function handleCheckWallet(args: { account_id?: string }) {
  const accountId = args.account_id || process.env.AGENT_HEDERA_ACCOUNT_ID || '';

  if (!accountId) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No account ID provided and AGENT_HEDERA_ACCOUNT_ID is not set in .env.',
      }],
      isError: true,
    };
  }

  try {
    const resp = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    if (resp.ok) {
      const data = await resp.json() as any;
      const balanceTinybars: number = data.balance?.balance ?? 0;
      const balanceHbar = (balanceTinybars / 1e8).toFixed(8);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Hedera Testnet Wallet`,
            `Account ID  : ${accountId}`,
            `Balance     : ${balanceHbar} HBAR`,
            `Tinybars    : ${balanceTinybars}`,
            `Network     : hedera-testnet`,
            `HashScan    : https://hashscan.io/testnet/account/${accountId}`,
            ``,
            balanceTinybars < 50_000_000
              ? `⚠️  Low balance! Need ≥50,000,000 tinybars (0.5 HBAR) per query call.`
              : `✅ Sufficient balance for ${Math.floor(balanceTinybars / 50_000_000)} query calls.`,
          ].join('\n'),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Mirror node returned HTTP ${resp.status} for account ${accountId}. Is the account ID correct?`,
      }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to query Hedera Mirror Node: ${(err as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[VendingAgent MCP] Server started on stdio');
  console.error(`[VendingAgent MCP] Tools: ${TOOLS.map((t) => t.name).join(', ')}`);
  console.error(`[VendingAgent MCP] Gateway: ${SERVER_URL}`);
}

main().catch((err) => {
  console.error('[VendingAgent MCP] Fatal error:', err);
  process.exit(1);
});
