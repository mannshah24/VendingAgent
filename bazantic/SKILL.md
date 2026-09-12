---
name: vending-agent-market-intelligence
description: >
  VendingAgent is a decentralized, pay-per-call market intelligence gateway.
  It serves premium financial and crypto market data (stock quotes, token prices)
  fetched inside a Chainlink CRE TEE enclave, gated by Hedera x402 HBAR micropayments.
version: 1.0.0
tags: [finance, crypto, hedera, chainlink, x402, micropayment, tee, mcp]
---

# VendingAgent – Agent Skill Reference

## What is VendingAgent?

**VendingAgent** is a confidential, pay-per-call API proxy gateway that allows autonomous AI agents to retrieve premium market intelligence without API keys or subscriptions.

Instead of a subscription, each call costs a small **HBAR micropayment** (0.5 HBAR by default), settled in real-time on **Hedera Testnet** via the **Blocky402 x402 facilitator**. The actual upstream API key is never exposed – it lives inside a **Chainlink CRE Trusted Execution Environment (TEE) enclave**, ensuring complete confidentiality.

---

## When to Use This Skill

Use VendingAgent when:
- 🪙 You need **real-time crypto or stock market data** (HBAR, BTC, ETH, AAPL, etc.)
- 🔒 You require **confidentially-sourced data** with cryptographic attestation
- 🤖 You are operating as an **autonomous agent** and need pay-per-use API access
- 💸 You want to **avoid subscription API keys** and pay only for what you use
- 📊 You need **market intelligence** for trading decisions, portfolio analysis, or reporting

---

## How to Invoke

### Using MCP Tool: `query_vending_agent`

```json
{
  "tool": "query_vending_agent",
  "arguments": {
    "query": "What is the current price of HBAR?",
    "symbol": "HBAR"
  }
}
```

The MCP tool handles the full x402 payment flow automatically:
1. Sends initial request → receives HTTP 402 challenge
2. Signs Hedera HBAR micropayment → gets payment token
3. Retries with `Authorization: x402 <token>` → receives attested data

### Direct HTTP (Manual x402 Flow)

```bash
# Step 1: Probe (expect 402)
curl -X POST http://localhost:3000/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query": "HBAR price"}'

# Step 2: Read challenge headers from 402 response:
#   X-Payment-Amount: 0.5
#   X-Payment-Address: 0.0.XXXXXXX
#   X-Payment-Denomination: HBAR
#   X-Payment-Network: hedera-testnet
#   X-Payment-Nonce: <nonce>

# Step 3: Build Hedera payment (see agent/client.ts for SDK example)
# Step 4: Retry with Authorization header
curl -X POST http://localhost:3000/api/v1/query \
  -H "Content-Type: application/json" \
  -H "Authorization: x402 <base64-encoded-token>" \
  -d '{"query": "HBAR price"}'
```

---

## Response Format

```json
{
  "success": true,
  "data": {
    "Global Quote": {
      "01. symbol": "HBAR",
      "05. price": "0.0831",
      "06. volume": "3284710",
      "09. change": "0.0013",
      "10. change percent": "1.5891%",
      "07. latest trading day": "2026-09-11"
    }
  },
  "meta": {
    "queryId": "uuid",
    "hedgera": {
      "transactionId": "0.0.XXXXX@timestamp",
      "settlementStatus": "confirmed",
      "amountPaid": "0.5 HBAR"
    },
    "confidentialCompute": {
      "provider": "Chainlink CRE",
      "attestation": "tee:enclave-abc123:sha256...",
      "executedInTee": true,
      "enclaveId": "enclave-abc123def456"
    }
  }
}
```

---

## Supported Symbols

| Symbol | Description         |
|--------|---------------------|
| HBAR   | Hedera Hashgraph    |
| BTC    | Bitcoin             |
| ETH    | Ethereum            |
| LINK   | Chainlink           |
| SOL    | Solana              |
| AVAX   | Avalanche           |
| AAPL   | Apple Inc.          |
| TSLA   | Tesla Inc.          |
| IBM    | IBM Corp.           |

---

## Architecture & Trust Model

```
Agent → POST /api/v1/query
      ← 402 + x402 Challenge (nonce, merchant, amount, network)
Agent → Signs Hedera TransferTransaction (HBAR → merchant, memo: x402:<nonce>)
      → POST /api/v1/query [Authorization: x402 <token>]
Server → Verifies token via Blocky402 Facilitator / Hedera Mirror Node
       → Invokes Chainlink CRE TEE Enclave (handlerInTee)
TEE    → getSecret("UPSTREAM_API_KEY") [sealed, never exposed]
       → fetch(AlphaVantage API) via usingTheDons()
       → Sanitize + Attest output
Server ← 200 OK + sanitized data + TEE attestation
```

---

## Pricing & Limits

| Parameter          | Value                    |
|--------------------|--------------------------|
| Cost per call      | 0.5 HBAR                 |
| Payment network    | Hedera Testnet           |
| Settlement time    | ~3 seconds               |
| Max query length   | 2,000 characters         |
| Rate limit         | 100 calls/minute         |
| Attestation        | Chainlink CRE TEE        |

---

## Fallback & Error Handling

| HTTP Status | Meaning                              | Agent Action                         |
|-------------|--------------------------------------|--------------------------------------|
| 402         | Payment required                     | Parse challenge, sign, retry         |
| 400         | Malformed token or missing fields    | Re-encode payment token              |
| 402 (replay)| Nonce already used                  | Initiate fresh request for new nonce |
| 500         | Server/TEE error                     | Retry after 30 seconds               |

---

## Related Resources

- [Hedera Portal (get testnet account)](https://portal.hedera.com/)
- [Blocky402 Facilitator](https://blocky402.com)
- [x402 Payment Standard](https://x402.org)
- [Chainlink CRE Docs](https://docs.chain.link/chainlink-runtime-environment)
- [Bazantic Platform](https://bazantic.com)
- [VendingAgent Recipe](./recipe.json)
- [VendingAgent MCP Server](./mcp-server.ts)
