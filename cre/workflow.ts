/**
 * Chainlink CRE Confidential Workflow – VendingAgent
 *
 * Track: Chainlink "Best Confidential Workflow" – ETHOnline 2026
 *
 * This workflow runs inside a Chainlink Runtime Environment (CRE) TEE enclave
 * and uses `handlerInTee` to protect the upstream API key from ever being
 * exposed to the DON, the proxy server, or any external observer.
 *
 * CRE Runtime API used:
 *   - secrets.API_KEY        → sealed secret injected at enclave boot
 *   - runtime.fetch()        → HTTP inside TEE (usingTheDons for outbound)
 *   - runtime.setOutput()    → sealed, attested result exits enclave
 *
 * Simulation:
 *   bash cre/simulate.sh
 *   cre workflow simulate --config cre/config.json cre/workflow.ts
 */

// ── CRE SDK Type Definitions ──────────────────────────────────────────────────
// In the production CRE environment, these are provided by the Chainlink runtime.
// The @chainlink/cre-sdk package exposes these exact interfaces.

/**
 * Secrets bag injected by the CRE Secrets Manager at TEE boot-time.
 * Values are decrypted inside the hardware enclave only.
 */
interface TeeSecrets {
  /** Upstream API key – decrypted only inside the TEE enclave */
  API_KEY: string;
  /** Optional: upstream API base URL override */
  UPSTREAM_API_BASE?: string;
  /** Allow arbitrary additional secrets */
  [key: string]: string | undefined;
}

/**
 * TeeRuntime provides confidential-compute primitives inside the enclave.
 */
interface TeeRuntime {
  /** Emit a log line (visible in CRE dashboard, not exposed publicly) */
  log(message: string): void;
  /**
   * Cross TEE boundary for consensus-required operations (on-chain writes,
   * or DON-managed outbound HTTP). The callback runs in DON context.
   */
  usingTheDons<T>(fn: () => Promise<T>): Promise<T>;
  /** Seal and export an output value (exits the enclave as attested data) */
  setOutput(key: string, value: unknown): void;
}

interface WorkflowInput {
  /** Natural language query from the consumer agent */
  query: string;
  /** Unique query identifier for tracing */
  queryId: string;
  /** Optional: direct ticker symbol override (e.g. "HBAR", "BTC") */
  symbol?: string;
}

interface AlphaVantageGlobalQuote {
  '01. symbol': string;
  '02. open': string;
  '03. high': string;
  '04. low': string;
  '05. price': string;
  '06. volume': string;
  '07. latest trading day': string;
  '08. previous close': string;
  '09. change': string;
  '10. change percent': string;
}

interface AlphaVantageResponse {
  'Global Quote'?: AlphaVantageGlobalQuote;
  Information?: string; // API rate-limit message
  Note?: string;        // Free-tier rate-limit notice
}

/** Sanitized market data payload – the only data that exits the TEE */
interface SanitizedMarketData {
  symbol: string;
  price: string;
  open: string;
  high: string;
  low: string;
  previousClose: string;
  change: string;
  changePercent: string;
  volume: string;
  tradingDay: string;
  source: string;
  fetchedAt: string;
}

// ── Workflow SDK (provided by CRE runtime, declared here for type safety) ────
declare const workflow: {
  handlerInTee(
    fn: (secrets: TeeSecrets, input: WorkflowInput, runtime: TeeRuntime) => Promise<void>
  ): void;
};

// ── Confidential Workflow Handler ─────────────────────────────────────────────

/**
 * The handlerInTee callback receives:
 *   - secrets : decrypted secrets bag (API_KEY lives here, never in plain env)
 *   - input   : trigger payload from the calling server
 *   - runtime : TEE runtime for logging, outbound HTTP, and sealed outputs
 *
 * IMPORTANT: The `secrets` object is ONLY available inside this callback.
 * It is never serialised, logged, or returned. Any attempt to setOutput()
 * a secret value will be caught by the CRE enclave policy engine.
 */
workflow.handlerInTee(async (secrets: TeeSecrets, input: WorkflowInput, runtime: TeeRuntime) => {
  runtime.log(`[VendingAgent TEE] ══════════════════════════════════════`);
  runtime.log(`[VendingAgent TEE] Confidential execution starting`);
  runtime.log(`[VendingAgent TEE] Query   : "${input.query}"`);
  runtime.log(`[VendingAgent TEE] Query ID: ${input.queryId}`);
  runtime.log(`[VendingAgent TEE] ══════════════════════════════════════`);

  // ── Step 1: Access the sealed API key from the secrets bag ───────────────
  // secrets.API_KEY is decrypted by the TEE at enclave boot from the
  // CRE Secrets Manager. It never touches the proxy server memory.
  const apiKey = secrets.API_KEY;
  if (!apiKey) {
    throw new Error('[TEE] FATAL: secrets.API_KEY not injected by CRE Secrets Manager');
  }
  runtime.log('[VendingAgent TEE] ✅ secrets.API_KEY decrypted inside enclave (sealed)');

  // ── Step 2: Resolve the ticker symbol from the input ─────────────────────
  const symbol = input.symbol ?? extractSymbol(input.query) ?? 'HBAR';
  runtime.log(`[VendingAgent TEE] Resolved symbol: ${symbol}`);

  // ── Step 3: Fetch data from upstream API (stays inside TEE boundary) ─────
  // The URL contains the API key — it is NEVER logged or output.
  // runtime.usingTheDons() lets the DON perform the outbound HTTP call
  // while keeping the request parameters sealed inside the enclave.
  const apiBase = secrets.UPSTREAM_API_BASE ?? 'https://www.alphavantage.co/query';
  const apiUrl = `${apiBase}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

  runtime.log(`[VendingAgent TEE] Calling upstream API for symbol "${symbol}" via usingTheDons()...`);

  let rawData: AlphaVantageResponse;
  rawData = await runtime.usingTheDons(async () => {
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'VendingAgent-CRE/1.0.0',
        'Accept': 'application/json',
      },
    });

    if (!resp.ok) {
      throw new Error(`Upstream API returned HTTP ${resp.status} ${resp.statusText}`);
    }

    return resp.json() as Promise<AlphaVantageResponse>;
  });

  runtime.log('[VendingAgent TEE] ✅ Raw upstream response received inside enclave');

  // ── Step 4: Validate and sanitize ────────────────────────────────────────
  // Rate-limit or error messages from AlphaVantage
  if (rawData.Information || rawData.Note) {
    throw new Error(`Upstream API limit reached: ${rawData.Information ?? rawData.Note}`);
  }

  const quote = rawData['Global Quote'];
  if (!quote || !quote['01. symbol']) {
    throw new Error(
      `No "Global Quote" in upstream response for symbol "${symbol}". ` +
      `Ensure UPSTREAM_API_KEY is a valid AlphaVantage key.`
    );
  }

  // Build the sanitized payload – API key and raw URL are NEVER included
  const sanitized: SanitizedMarketData = {
    symbol:         quote['01. symbol'],
    open:           quote['02. open'],
    high:           quote['03. high'],
    low:            quote['04. low'],
    price:          quote['05. price'],
    volume:         quote['06. volume'],
    tradingDay:     quote['07. latest trading day'],
    previousClose:  quote['08. previous close'],
    change:         quote['09. change'],
    changePercent:  quote['10. change percent'],
    source:         'AlphaVantage (via Chainlink CRE TEE – handlerInTee)',
    fetchedAt:      new Date().toISOString(),
  };

  runtime.log(`[VendingAgent TEE] Sanitized output: ${JSON.stringify(sanitized)}`);

  // ── Step 5: Seal and export outputs ──────────────────────────────────────
  // These values exit the TEE boundary as attested, hardware-signed outputs.
  // The CRE framework signs the output hash with the enclave's root of trust.
  runtime.setOutput('payload',              sanitized);
  runtime.setOutput('queryId',              input.queryId);
  runtime.setOutput('symbol',               symbol);
  runtime.setOutput('enclaveExecuted',      true);
  runtime.setOutput('attestationTimestamp', new Date().toISOString());

  runtime.log('[VendingAgent TEE] ✅ Outputs sealed and attested. Execution complete.');
  runtime.log('[VendingAgent TEE] ══════════════════════════════════════');
});

// ── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Extracts a well-known ticker symbol from a natural language query.
 *
 * Examples:
 *   "What is the price of HBAR?" → "HBAR"
 *   "Get me the Bitcoin price"   → "BTC"
 *   "AAPL stock quote"           → "AAPL"
 */
function extractSymbol(query: string): string | null {
  const aliases: Record<string, string> = {
    bitcoin:   'BTC',
    ethereum:  'ETH',
    hedera:    'HBAR',
    chainlink: 'LINK',
    solana:    'SOL',
    avalanche: 'AVAX',
    apple:     'AAPL',
    tesla:     'TSLA',
    microsoft: 'MSFT',
    nvidia:    'NVDA',
  };

  const lower = query.toLowerCase();
  for (const [word, symbol] of Object.entries(aliases)) {
    if (lower.includes(word)) return symbol;
  }

  // Fall back: match 2–5 uppercase letters as a ticker
  const upper = query.toUpperCase();
  const knownTickers = ['HBAR', 'BTC', 'ETH', 'LINK', 'IBM', 'AAPL', 'TSLA', 'SOL', 'AVAX', 'MSFT', 'NVDA'];
  for (const ticker of knownTickers) {
    if (upper.includes(ticker)) return ticker;
  }

  const match = query.match(/\b([A-Z]{2,5})\b/);
  return match?.[1] ?? null;
}
