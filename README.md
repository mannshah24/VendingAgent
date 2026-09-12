# 🤖 VendingAgent – ETHOnline 2026

> **Decentralized, pay-per-call AI API proxy and confidential compute gateway.**  
> Autonomous agents consume premium Web2 APIs via Hedera x402 HBAR micropayments,  
> with upstream secrets protected inside a Chainlink CRE TEE enclave,  
> discoverable by any agent via Bazantic MCP.

[![Hedera](https://img.shields.io/badge/Hedera-x402%20%7C%20Blocky402-5D4DFF?style=flat-square)](https://hedera.com)
[![Chainlink](https://img.shields.io/badge/Chainlink-CRE%20TEE%20%7C%20handlerInTee-375BD2?style=flat-square)](https://chain.link)
[![Bazantic](https://img.shields.io/badge/Bazantic-MCP%20%7C%20vending__query-3DE0A4?style=flat-square)](https://bazantic.com)
[![ETHOnline 2026](https://img.shields.io/badge/ETHOnline-2026-FF6B6B?style=flat-square)](https://ethglobal.com)

---

## 🏆 Judge Compliance Quick-Reference

> **Judges:** This section maps each track requirement directly to specific files and line numbers.

### ✅ Hedera Track – AI & Agentic Payments on Hedera

| Requirement | File | What to Look For |
|---|---|---|
| HTTP 402 x402-gated endpoint | [`server/src/middleware/x402.ts`](server/src/middleware/x402.ts) | `reply.code(402)` + all `X-Payment-*` headers including `X-Payment-Amount-Tinybars: 50000000` |
| 402 body: network, amount (tinybars), facilitator, payee | [`server/src/middleware/x402.ts`](server/src/middleware/x402.ts) | `challengeBody.payment` → `amountTinybars: 50_000_000`, `facilitator: 'Blocky402'`, `payeeAccountId` |
| Blocky402 facilitator verification | [`server/src/middleware/x402.ts`](server/src/middleware/x402.ts) | `verifyWithBlocky402()` → POST to `BLOCKY402_URL/verify` → Mirror Node fallback |
| Consumer agent catches 402 | [`agent/client.ts`](agent/client.ts) | `if (initialResponse.status !== 402)` → parse headers → sign tx → retry |
| Hedera `TransferTransaction` via `@hashgraph/sdk` | [`agent/wallet.ts`](agent/wallet.ts) | `new TransferTransaction().addHbarTransfer(...)` |
| `Authorization: x402 <token>` retry | [`agent/client.ts`](agent/client.ts) | `headers: { 'Authorization': 'x402 ' + paymentToken.token }` |
| Print transaction ID and received payload | [`agent/client.ts`](agent/client.ts) | Phase 5 console output: Hedera Tx ID, settlement receipt, raw data |
| HBAR metering per call | [`server/src/index.ts`](server/src/index.ts) | `paymentTotal += parseFloat(...)` in `onResponse` hook |

**To verify live:** Start the server, then run `npx ts-node --transpile-only agent/client.ts` and observe:
```
━━━ Phase 2: Parsing x402 Payment Challenge ━━━
  💰 Amount:      0.5 HBAR
  🤝 Facilitator: Blocky402
  ⏰ X-Payment-Amount-Tinybars: 50000000
━━━ Phase 4: Retrying Request with x402 Authorization
  Status: HTTP 200 OK ⚡ Round-trip: ~1200ms
```

---

### ✅ Chainlink Track – Best Confidential Workflow

| Requirement | File | What to Look For |
|---|---|---|
| TypeScript CRE Confidential Workflow | [`cre/workflow.ts`](cre/workflow.ts) | Full file – `workflow.handlerInTee(...)` registration |
| `handlerInTee(async (secrets, input, runtime) => ...)` | [`cre/workflow.ts`](cre/workflow.ts) | Line 93: exact CRE SDK signature with `secrets` bag |
| `secrets.API_KEY` decrypted inside enclave | [`cre/workflow.ts`](cre/workflow.ts) | `const apiKey = secrets.API_KEY;` |
| Fetch upstream data inside TEE | [`cre/workflow.ts`](cre/workflow.ts) | `runtime.usingTheDons(async () => fetch(apiUrl, ...))` |
| Output sanitization (never expose key) | [`cre/workflow.ts`](cre/workflow.ts) | `SanitizedMarketData` type – API key omitted from all outputs |
| `runtime.setOutput()` for attested values | [`cre/workflow.ts`](cre/workflow.ts) | `runtime.setOutput('payload', sanitized)` etc. |
| Simulation script | [`cre/simulate.sh`](cre/simulate.sh) | Runs `cre workflow simulate` + local fallback |
| Simulation config with mock secrets | [`cre/config.json`](cre/config.json) | `mockSecrets.API_KEY`, `testInput`, `expectedOutputFields` |

**To verify:** Run `bash cre/simulate.sh`

---

### ✅ Bazantic Track – Agentify a New API

| Requirement | File | What to Look For |
|---|---|---|
| MCP server (stdio transport) | [`bazantic/mcp-server.ts`](bazantic/mcp-server.ts) | `StdioServerTransport` + `server.connect()` |
| Tool: `vending_query` | [`bazantic/mcp-server.ts`](bazantic/mcp-server.ts) | `name: 'vending_query'` in `TOOLS` array |
| Tool auto-handles x402 payment | [`bazantic/mcp-server.ts`](bazantic/mcp-server.ts) | `handleVendingQuery()` – full 402→sign→retry lifecycle |
| `recipe.json` with input/output schema | [`bazantic/recipe.json`](bazantic/recipe.json) | `inputSchema`, `outputSchema` with JSON Schema types |
| `recipe.json` payment preconditions | [`bazantic/recipe.json`](bazantic/recipe.json) | `llmGuidance.preconditions` and `stepByStepForLLM` |
| `recipe.json` x402/MPP gateway config | [`bazantic/recipe.json`](bazantic/recipe.json) | `gateway.type: "x402"`, `amountPerCallTinybars: 50000000` |
| `SKILL.md` agent discovery | [`bazantic/SKILL.md`](bazantic/SKILL.md) | When to use, trigger conditions, error handling table |

**To verify:** Run `npx ts-node --transpile-only bazantic/mcp-server.ts` – server starts on stdio.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       VendingAgent Flow                          │
│                                                                  │
│  AI Agent (MCP or direct HTTP)                                   │
│     │                                                            │
│     ├─ POST /api/v1/query ──────────────────────────────────►   │
│     │                               ◄─ 402 + x402 challenge ─   │
│     │    challenge body:                                         │
│     │      { amountTinybars: 50_000_000, facilitator: Blocky402  │
│     │        payeeAccountId, nonce, network: hedera-testnet }    │
│     │                                                            │
│     ├─ Sign Hedera TransferTransaction (@hashgraph/sdk)          │
│     │   Memo: "x402:<nonce>"  Amount: 50,000,000 tinybars        │
│     │                                                            │
│     ├─ POST /api/v1/query [Authorization: x402 <token>] ──────► │
│     │       Blocky402 Facilitator API verifies payment ───────   │
│     │       (Mirror Node fallback if Blocky402 unreachable)      │
│     │                                                            │
│     │            Chainlink CRE TEE Enclave (handlerInTee)        │
│     │            ┌────────────────────────────────────┐          │
│     │            │  secrets.API_KEY (sealed, injected) │          │
│     │            │  usingTheDons() → fetch AlphaVantage│          │
│     │            │  sanitize() + attest() output       │          │
│     │            └────────────────────────────────────┘          │
│     │                                                            │
│     ◄─ 200 OK { data, meta.hedgera.transactionId, attestation } │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
vending-agent/
├── package.json                    # @hashgraph/sdk, fastify, @modelcontextprotocol/sdk
├── tsconfig.json
├── .env.example                    # All required environment variables
│
├── cre/
│   ├── workflow.ts                 # ★ Chainlink CRE handlerInTee Confidential Workflow
│   ├── config.json                 # CRE simulation config + mock secrets
│   └── simulate.sh                 # cre workflow simulate script
│
├── server/src/
│   ├── index.ts                    # Fastify server: /api/v1/query, /health, /metrics
│   ├── middleware/
│   │   └── x402.ts                 # ★ Hedera x402 + Blocky402 verification middleware
│   ├── services/
│   │   └── upstream.ts             # CRE TEE interface + AlphaVantage data layer
│   ├── utils/
│   │   └── x402-utils.ts           # Token encode/decode, nonce generation
│   └── public/
│       └── index.html              # Live judge dashboard (animated flow visualizer)
│
├── agent/
│   ├── client.ts                   # ★ Autonomous agent: 402→sign→pay→200 lifecycle
│   └── wallet.ts                   # Hedera wallet + TransferTransaction builder
│
├── bazantic/
│   ├── mcp-server.ts               # ★ MCP server with vending_query tool (stdio)
│   ├── recipe.json                 # ★ Bazantic Recipe: schema, LLM guidance, x402 gateway
│   └── SKILL.md                    # Agent discovery: when/why/how to use VendingAgent
│
└── test/
    └── e2e.test.ts                 # 21 E2E tests: 402→pay→200, attestation, replay
```

---

## 🚀 Setup Guide

### Prerequisites

- Node.js 20+
- (Optional) Hedera Testnet account: https://portal.hedera.com/
- (Optional) AlphaVantage API key: https://www.alphavantage.co/support/#api-key

### Step 1: Install dependencies

```bash
cd vending-agent
npm install
```

### Step 2: Configure environment

```bash
cp .env.example .env
```

Edit `.env` – minimum required for MOCK mode:

```bash
# Leave these blank to run in demo/mock mode (no real Hedera txns)
HEDERA_OPERATOR_ID=
HEDERA_OPERATOR_PRIVATE_KEY=
AGENT_HEDERA_ACCOUNT_ID=
AGENT_HEDERA_PRIVATE_KEY=
X402_MERCHANT_ACCOUNT_ID=

# Set to true to skip real payment verification (development only)
MOCK_PAYMENTS=true

# Optional: AlphaVantage key for live data (TEE workflow uses this)
# Without it, simulated market data is returned
UPSTREAM_API_KEY=
```

For **live Hedera testnet** (full demo):

```bash
# Get testnet account at https://portal.hedera.com/
HEDERA_OPERATOR_ID=0.0.XXXXXXX
HEDERA_OPERATOR_PRIVATE_KEY=302e...
AGENT_HEDERA_ACCOUNT_ID=0.0.YYYYYYY
AGENT_HEDERA_PRIVATE_KEY=302e...
X402_MERCHANT_ACCOUNT_ID=0.0.XXXXXXX
MOCK_PAYMENTS=false
```

### Step 3: Start the server

```bash
# Mock mode (no real Hedera credentials needed)
$env:MOCK_PAYMENTS="true"; npx ts-node --transpile-only server/src/index.ts

# OR with npm script (add to package.json scripts: "dev": "ts-node server/src/index.ts")
npm run dev
```

Open **http://localhost:3000** → Live Judge Dashboard with animated x402 flow visualizer.

### Step 4: Run the autonomous agent

```bash
# With mock payments (no Hedera keys needed)
$env:MOCK_PAYMENTS="true"; npx ts-node --transpile-only agent/client.ts "What is the HBAR price?"

# With real Hedera testnet credentials (full demo)
npx ts-node --transpile-only agent/client.ts "Get me the current Bitcoin price"
```

Expected terminal output:

```
━━━ Phase 1: Sending Initial Request ━━━━━━━━━━━━━━━━━━━━━━
  Status: HTTP 402 Payment Required

━━━ Phase 2: Parsing x402 Payment Challenge ━━━━━━━━━━━━━━━
  💰 Amount:      0.5 HBAR
  📦 Tinybars:    50000000
  🤝 Facilitator: Blocky402
  🔗 Network:     hedera-testnet

━━━ Phase 3: Signing Hedera Micropayment ━━━━━━━━━━━━━━━━━━
  ✅ Transaction signed!  Tx ID: 0.0.XXXXX@1789119825-0

━━━ Phase 4: Retrying Request with x402 Authorization ━━━━━
  Status: HTTP 200 OK  ⚡ Round-trip: 1247ms

━━━ Phase 5: Processing Confidential TEE Response ━━━━━━━━━
  ✅ SUCCESS – Data Received
  { "Global Quote": { "05. price": "0.0831", ... } }
  🔒 Attestation: tee:enclave-abc123:sha256abc123...
```

### Step 5: Run Chainlink CRE simulation

```bash
bash cre/simulate.sh
# Or with CRE CLI installed:
cre workflow simulate --config cre/config.json cre/workflow.ts
```

### Step 6: Start the MCP server

```bash
npx ts-node --transpile-only bazantic/mcp-server.ts
```

Add to **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vending-agent": {
      "command": "npx",
      "args": ["ts-node", "--transpile-only", "bazantic/mcp-server.ts"],
      "cwd": "M:/ethonline/vending-agent"
    }
  }
}
```

Then in Claude: *"What is the current HBAR price?"* → Claude calls `vending_query` → auto-pays → returns attested data.

### Step 7: Run E2E tests

```bash
# Terminal 1
$env:MOCK_PAYMENTS="true"; npx ts-node --transpile-only server/src/index.ts

# Terminal 2
$env:MOCK_PAYMENTS="true"; npx ts-node --transpile-only test/e2e.test.ts
```

Expected: **21/21 tests passed**

---

## 🔐 x402 Protocol Details

### HTTP 402 Challenge (no auth header)

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: x402
X-Payment-Protocol: x402
X-Payment-Network: hedera-testnet
X-Payment-Amount: 0.5
X-Payment-Amount-Tinybars: 50000000
X-Payment-Denomination: HBAR
X-Payment-Address: 0.0.XXXXXXX
X-Payment-Payee-Account-Id: 0.0.XXXXXXX
X-Payment-Facilitator: Blocky402
X-Payment-Nonce: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
X-Payment-Expiry: 2026-09-12T22:00:00.000Z
```

Body:
```json
{
  "error": "Payment Required",
  "payment": {
    "protocol": "x402",
    "network": "hedera-testnet",
    "amount": 0.5,
    "amountTinybars": 50000000,
    "payeeAccountId": "0.0.XXXXXXX",
    "facilitator": "Blocky402",
    "nonce": "a1b2c3..."
  }
}
```

### Authorization Token (after payment)

```
Authorization: x402 <base64-encoded-JSON>
```

Decoded payload:

```json
{
  "version": "1",
  "protocol": "x402",
  "network": "hedera-testnet",
  "facilitator": "Blocky402",
  "transactionId": "0.0.12345@1789119825-0",
  "accountId": "0.0.67890",
  "merchantAccountId": "0.0.54321",
  "amount": 0.5,
  "denomination": "HBAR",
  "nonce": "a1b2c3...",
  "signedTransaction": "<base64-signed-bytes>"
}
```

---

## 🔒 Chainlink CRE Workflow

**File:** [`cre/workflow.ts`](cre/workflow.ts)

```typescript
workflow.handlerInTee(async (secrets: TeeSecrets, input: WorkflowInput, runtime: TeeRuntime) => {
  // secrets.API_KEY is decrypted ONLY inside the TEE enclave
  const apiKey = secrets.API_KEY;

  // Fetch upstream data via usingTheDons() – URL+key never leave enclave
  const data = await runtime.usingTheDons(async () => {
    return fetch(`https://www.alphavantage.co/query?apikey=${apiKey}&symbol=${symbol}`);
  });

  // Sanitize – strip all credentials before output exits enclave
  runtime.setOutput('payload', sanitized);   // attested, hardware-signed
  runtime.setOutput('enclaveExecuted', true);
});
```

---

## 🤖 MCP Tools

| Tool | Description |
|------|-------------|
| `vending_query` | **Primary.** Full x402 auto-payment + attested data fetch |
| `get_vending_pricing` | Returns HBAR/tinybar price per call, network, facilitator |
| `check_agent_wallet` | Hedera testnet balance + sufficiency check for query calls |

---

## 🧪 Test Coverage (21 tests)

| Group | Tests |
|---|---|
| Server Health | `/health` returns 200 with tracks, `/api/v1/info` returns TEE + pricing |
| x402 Challenge | HTTP 402 issued, all 8 required headers present, body spec correct |
| Payment Flow | Full 402→token→200, `success:true`, data present, Hedera `transactionId`, HBAR receipt |
| TEE Attestation | `executedInTee:true`, `attestation` starts with `tee:` |
| Security | Replay attack rejected, malformed token rejected |
| Observability | `/api/v1/metrics` returns live counters |

---

## 🔗 Resources

| Resource | URL |
|---|---|
| Hedera Portal (testnet account) | https://portal.hedera.com/ |
| HashScan Testnet Explorer | https://hashscan.io/testnet |
| Blocky402 Facilitator | https://blocky402.com |
| x402 Specification | https://x402.org |
| Chainlink CRE Docs | https://docs.chain.link/chainlink-runtime-environment |
| Bazantic Platform | https://bazantic.com |
| AlphaVantage (upstream API) | https://www.alphavantage.co |

---

## 📜 License

MIT © VendingAgent Team – ETHOnline 2026
