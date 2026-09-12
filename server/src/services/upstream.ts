import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

export interface UpstreamResult {
  queryId: string;
  payload: Record<string, unknown>;
  attestation: string;
  enclaveId: string;
  source: string;
  fetchedAt: string;
}

/**
 * Calls the Chainlink CRE Confidential Workflow (simulated locally).
 *
 * In production:
 *   - The CRE DON triggers the `handlerInTee` workflow inside a hardware TEE.
 *   - Secrets are injected via `runtime.getSecret()` – never exposed to this server.
 *   - The enclave produces an attestation proof alongside the sanitized data.
 *
 * In development/simulation:
 *   - Mimics the TEE boundary by calling the upstream API server-side.
 *   - Generates a simulated attestation proof for demonstration.
 *   - The CRE simulation (`cre workflow simulate`) exercises the real TypeScript workflow logic.
 */
export async function callConfidentialUpstream(
  query: string,
  context?: Record<string, unknown>
): Promise<UpstreamResult> {
  const queryId = crypto.randomUUID();
  const enclaveId = `enclave-${crypto.randomBytes(8).toString('hex')}`;

  console.log(`\n  🔒 [TEE Enclave ${enclaveId}] Entering confidential execution boundary...`);
  console.log(`  📡 Query: "${query}"`);

  // ── Fetch from upstream API with injected secret key ────────────────────
  const apiKey = process.env.UPSTREAM_API_KEY;
  const apiBase = process.env.UPSTREAM_API_BASE_URL || 'https://www.alphavantage.co/query';

  let rawPayload: Record<string, unknown>;

  if (!apiKey || apiKey === 'your-alphavantage-or-coingecko-api-key') {
    console.log('  ⚠️  No upstream API key configured – returning simulated data (TEE demo mode)');
    rawPayload = await fetchSimulatedData(query, queryId);
  } else {
    console.log('  🔑 [TEE] Secret API key injected – fetching real upstream data...');
    rawPayload = await fetchAlphaVantageData(query, apiKey, apiBase);
  }

  // ── Sanitize response (strip internal metadata, never expose API key) ───
  const sanitized = sanitizePayload(rawPayload);

  // ── Generate TEE Attestation ─────────────────────────────────────────────
  const attestation = generateTeeAttestation(queryId, enclaveId, sanitized);

  console.log(`  ✅ [TEE] Execution complete. Attestation: ${attestation.slice(0, 32)}...`);

  return {
    queryId,
    payload: sanitized,
    attestation,
    enclaveId,
    source: 'Chainlink CRE TEE (handlerInTee)',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch real financial intelligence from AlphaVantage.
 * API key is only available inside the TEE enclave.
 */
async function fetchAlphaVantageData(
  query: string,
  apiKey: string,
  apiBase: string
): Promise<Record<string, unknown>> {
  const symbol = extractTickerSymbol(query) || 'IBM';

  // AlphaVantage only supports stocks/ETFs — not native crypto like HBAR/BTC/ETH.
  // Fall back to simulated data for crypto so the dashboard always shows something.
  const cryptoSymbols = new Set(['HBAR', 'BTC', 'ETH', 'LINK', 'SOL', 'AVAX', 'MATIC', 'DOT']);
  if (cryptoSymbols.has(symbol)) {
    console.log(`  ℹ️  [TEE] ${symbol} is a crypto – AlphaVantage doesn't support it; using simulated data`);
    return fetchSimulatedData(query, crypto.randomUUID());
  }

  const url = `${apiBase}?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`AlphaVantage API error: HTTP ${resp.status}`);

  const data = await resp.json() as Record<string, unknown>;

  // If AlphaVantage returns empty Global Quote (unknown symbol), fall back to simulated
  const quote = (data['Global Quote'] as Record<string, unknown>) || {};
  if (!quote['05. price']) {
    console.log(`  ⚠️  [TEE] AlphaVantage returned no price for ${symbol} – using simulated data`);
    return fetchSimulatedData(query, crypto.randomUUID());
  }

  return data;
}

/**
 * Returns realistic simulated market data for demo/development mode.
 */
async function fetchSimulatedData(
  query: string,
  queryId: string
): Promise<Record<string, unknown>> {
  const symbol = extractTickerSymbol(query) || 'HBAR';
  const price = (0.08 + Math.random() * 0.04).toFixed(6);
  const change = (Math.random() > 0.5 ? 1 : -1) * (Math.random() * 5).toFixed(2);

  return {
    'Global Quote': {
      '01. symbol': symbol,
      '02. open': (parseFloat(price) * 0.98).toFixed(4),
      '03. high': (parseFloat(price) * 1.03).toFixed(4),
      '04. low': (parseFloat(price) * 0.97).toFixed(4),
      '05. price': price,
      '06. volume': Math.floor(Math.random() * 5_000_000 + 1_000_000).toString(),
      '07. latest trading day': new Date().toISOString().split('T')[0],
      '08. previous close': (parseFloat(price) * 0.995).toFixed(4),
      '09. change': change.toString(),
      '10. change percent': `${((parseFloat(change.toString()) / parseFloat(price)) * 100).toFixed(4)}%`,
    },
    _meta: {
      queryId,
      source: 'VendingAgent TEE Demo (simulated)',
      note: 'Set UPSTREAM_API_KEY in .env for live AlphaVantage data',
    },
  };
}

/**
 * Remove internal API keys, raw auth headers, and sensitive metadata.
 * Only sanitized fields exit the TEE boundary.
 */
function sanitizePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const forbidden = new Set(['apikey', 'api_key', 'authorization', 'x-api-key', 'token', 'secret']);

  function scrub(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([k]) => !forbidden.has(k.toLowerCase()))
        .map(([k, v]) => [k, scrub(v)])
    );
  }

  return scrub(raw) as Record<string, unknown>;
}

/**
 * Generates a simulated TEE attestation proof.
 *
 * In production Chainlink CRE, this is a hardware-signed ECDSA signature
 * over SHA-256 of the enclave's output, issued by the TEE hardware root of trust.
 */
function generateTeeAttestation(
  queryId: string,
  enclaveId: string,
  payload: Record<string, unknown>
): string {
  const attestationInput = JSON.stringify({ queryId, enclaveId, payload, ts: Date.now() });
  const hash = crypto.createHash('sha256').update(attestationInput).digest('hex');
  // Prefix with 'tee:' to identify attestation format
  return `tee:${enclaveId}:${hash}`;
}

/**
 * Attempts to extract a ticker symbol from a natural language query.
 * e.g. "What is the price of HBAR?" → "HBAR"
 */
function extractTickerSymbol(query: string): string | null {
  const lower = query.toLowerCase();
  const upper = query.toUpperCase();

  // Natural language aliases → ticker
  const aliases: Record<string, string> = {
    'bitcoin':   'BTC',
    'ethereum':  'ETH',
    'hedera':    'HBAR',
    'chainlink': 'LINK',
    'solana':    'SOL',
    'avalanche': 'AVAX',
    'polygon':   'MATIC',
    'polkadot':  'DOT',
    'apple':     'AAPL',
    'tesla':     'TSLA',
    'nvidia':    'NVDA',
    'microsoft': 'MSFT',
    'google':    'GOOGL',
    'amazon':    'AMZN',
    'meta':      'META',
    'netflix':   'NFLX',
  };
  for (const [word, ticker] of Object.entries(aliases)) {
    if (lower.includes(word)) return ticker;
  }

  // Exact uppercase ticker in the string (e.g. "HBAR price", "AAPL stock")
  const knownTickers = ['HBAR', 'BTC', 'ETH', 'LINK', 'IBM', 'AAPL', 'TSLA', 'SOL', 'AVAX', 'NVDA', 'MSFT', 'GOOGL'];
  for (const token of knownTickers) {
    if (upper.includes(token)) return token;
  }

  // Generic: find a 2-5 char all-caps word
  const match = query.match(/\b([A-Z]{2,5})\b/);
  return match ? match[1] : null;
}
