import { Hono } from 'hono';
import { cors } from 'hono/cors';
import puppeteer from '@cloudflare/puppeteer';
import Stripe from 'stripe';

const BASE_RPC = 'https://mainnet.base.org';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function stripeClient(secretKey: string) {
  return new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(), apiVersion: '2024-12-18.acacia' } as any);
}

// ---------- bindings ----------
export interface Env {
  CACHE: KVNamespace;
  WALLETS: KVNamespace;
  LEDGER: DurableObjectNamespace;
  MYBROWSER: Fetcher;
  PLATFORM_WALLET: string;
  PRICE_ORIGINATOR_USD: string;
  PRICE_CACHE_HIT_USD: string;
  ORIGINATOR_SHARE: string;
  CACHE_TTL_SECONDS: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

const VERSION = '1.0.0';

// ---------- helpers ----------
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
function newWallet() {
  const pubKey = '0x' + randomHex(20);
  const privKey = 'gd_sk_' + randomHex(24);
  return { wallet: pubKey, signing_key: privKey };
}
function usdToMicro(usd: string | number): number {
  return Math.round(Number(usd) * 1_000_000);
}
async function sha256Hex(s: string): Promise<string> {
  const b = new TextEncoder().encode(s);
  const d = await crypto.subtle.digest('SHA-256', b);
  return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ---------- errors ----------
const ERR: Record<string, { msg: string; fix: string; http: number }> = {
  missing_wallet: { msg: 'No wallet header. Every billable endpoint needs X-Wallet + X-Wallet-Key.', fix: 'POST /v1/wallets to mint one, then send X-Wallet: <addr> and X-Wallet-Key: <signing_key>.', http: 401 },
  invalid_wallet: { msg: 'Wallet + signing_key combination not found.', fix: 'POST /v1/wallets to mint a fresh wallet.', http: 401 },
  insufficient_funds: { msg: 'Wallet balance below required amount for this call.', fix: 'POST /v1/wallets/fund {"wallet":"<addr>","amount_usd":5} then complete the returned x402 payment_url.', http: 402 },
  missing_url: { msg: 'Request body must include "url".', fix: 'POST /render with {"url":"https://...","wait_for":"optional selector"}.', http: 400 },
  bad_url: { msg: 'URL must be absolute http(s).', fix: 'Use a full https:// URL.', http: 400 },
  blocked_host: { msg: 'Refused to render private/loopback/metadata target.', fix: 'ghostdom blocks 127/8, 10/8, 192.168/16, 169.254/16, metadata.internal. Use a public URL.', http: 400 },
  render_failed: { msg: 'Browser Rendering returned an error.', fix: 'Verify the URL loads in a normal browser; try again in 30s; or pass a broader wait_for selector.', http: 502 },
  not_found: { msg: 'No such endpoint.', fix: 'GET / for the endpoint map.', http: 404 },
};
function err(c: any, code: keyof typeof ERR, extra: Record<string, any> = {}) {
  const e = ERR[code];
  return c.json({ error: true, code, message: e.msg, fix: e.fix, docs: 'https://' + (c.req.header('host') || 'ghostdom.workers.dev') + '/v1/errors#' + code, http_status: e.http, ...extra }, e.http);
}

// ---------- SSRF guard ----------
function isBlockedHost(h: string): boolean {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h === 'metadata.google.internal' || h.endsWith('.compute.internal')) return true;
  return false;
}

// ==================================================================
// Durable Object: Ledger
// One instance per URL-hash. Holds the memorymarket state for that URL.
// ==================================================================
export class Ledger {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }
  async fetch(req: Request): Promise<Response> {
    const body = await req.json() as any;
    const op = body.op;
    const now = Math.floor(Date.now() / 1000);
    const TTL = Number(this.env.CACHE_TTL_SECONDS);

    if (op === 'get') {
      const row = await this.state.storage.get<any>('row');
      return Response.json({ row: row || null, now });
    }
    if (op === 'claim_originator') {
      const row = await this.state.storage.get<any>('row');
      const wallet: string = body.wallet;
      // If no originator OR TTL expired, this caller becomes originator
      if (!row || (now - row.set_at) > TTL) {
        const fresh = { originator: wallet, set_at: now, hits: 0, originator_earnings_micro: 0, platform_earnings_micro: 0 };
        await this.state.storage.put('row', fresh);
        return Response.json({ role: 'originator', row: fresh, now });
      }
      // Within TTL, this is a cache hit
      row.hits = (row.hits || 0) + 1;
      await this.state.storage.put('row', row);
      return Response.json({ role: 'cache_hit', row, now, age_s: now - row.set_at });
    }
    if (op === 'record_earnings') {
      const row = await this.state.storage.get<any>('row');
      if (!row) return Response.json({ ok: false, reason: 'no_row' });
      row.originator_earnings_micro = (row.originator_earnings_micro || 0) + (body.originator_micro || 0);
      row.platform_earnings_micro = (row.platform_earnings_micro || 0) + (body.platform_micro || 0);
      await this.state.storage.put('row', row);
      return Response.json({ ok: true, row });
    }
    return new Response('bad op', { status: 400 });
  }
}

// ==================================================================
// Wallet helpers (KV-backed)
// ==================================================================
async function walletGet(env: Env, addr: string): Promise<{ addr: string; balance_micro: number; signing_key: string } | null> {
  const raw = await env.WALLETS.get('w:' + addr);
  return raw ? JSON.parse(raw) : null;
}
async function walletPut(env: Env, rec: any) {
  await env.WALLETS.put('w:' + rec.addr, JSON.stringify(rec));
}
async function walletCredit(env: Env, addr: string, micro: number) {
  const w = await walletGet(env, addr);
  if (!w) return; // platform wallet may not be pre-registered; create on the fly
  w.balance_micro += micro;
  await walletPut(env, w);
}
async function walletEnsurePlatform(env: Env) {
  const existing = await env.WALLETS.get('w:' + env.PLATFORM_WALLET);
  if (!existing) {
    await walletPut(env, { addr: env.PLATFORM_WALLET, balance_micro: 0, signing_key: 'platform' });
  }
}
function authWallet(c: any): { addr: string; key: string } | null {
  const addr = c.req.header('x-wallet');
  const key = c.req.header('x-wallet-key');
  if (!addr || !key) return null;
  return { addr, key };
}

// ==================================================================
// App router
// ==================================================================
const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

// Root manifest
app.get('/', (c) => {
  const host = c.req.header('host')!;
  const base = `https://${host}`;
  return c.json({
    service: 'ghostdom',
    version: VERSION,
    tagline: 'Headless-browser-as-JSON for AI agents, with memorymarket economics: first renderer gets paid when others cache-hit the same URL.',
    humans: false,
    stack: { compute: 'Cloudflare Workers', rendering: 'Cloudflare Browser Rendering API', ledger: 'Durable Objects', cache: 'Workers KV', settlement: 'x402 + USDC' },
    discovery: {
      ai_plugin: `${base}/.well-known/ai-plugin.json`,
      mcp: `${base}/.well-known/mcp.json`,
      openapi: `${base}/openapi.json`,
      llms_txt: `${base}/llms.txt`,
      pricing: `${base}/v1/pricing`,
      errors: `${base}/v1/errors`,
    },
    auth: { type: 'wallet', header: 'X-Wallet + X-Wallet-Key', issue: `POST ${base}/v1/wallets` },
    billing: {
      model: 'memorymarket',
      price_originator_usd: Number(c.env.PRICE_ORIGINATOR_USD),
      price_cache_hit_usd: Number(c.env.PRICE_CACHE_HIT_USD),
      originator_share: Number(c.env.ORIGINATOR_SHARE),
      cache_ttl_seconds: Number(c.env.CACHE_TTL_SECONDS),
      explainer: 'The FIRST agent to /render a URL pays the originator price. For the next 10 minutes, any agent hitting the same URL pays the cache-hit price — 90% of that goes to the originator wallet, 10% to platform. After TTL, the next agent becomes the new originator.',
      settlement: ['x402', 'prepaid_wallet_balance'],
    },
    endpoints: [
      { method: 'POST', path: '/render', purpose: 'Render a URL, return rendered_html + structured DOM + visible text + title + links + screenshot URL.' },
      { method: 'POST', path: '/v1/wallets', purpose: 'Mint a fresh wallet (0 balance).' },
      { method: 'GET',  path: '/v1/wallets/:addr', purpose: 'Public view of wallet balance + cumulative earnings.' },
      { method: 'POST', path: '/v1/wallets/fund', purpose: 'Start a funding intent, returns x402 payment_url.' },
      { method: 'GET',  path: '/v1/wallets/fund/complete/:intent', purpose: 'Test-mode: complete a funding intent (credits wallet).' },
      { method: 'GET',  path: '/v1/pricing', purpose: 'Machine-readable pricing.' },
      { method: 'GET',  path: '/v1/errors', purpose: 'Error code catalog.' },
    ],
  });
});

// Well-known manifests
app.get('/.well-known/ai-plugin.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    schema_version: 'v1',
    name_for_human: 'ghostdom',
    name_for_model: 'ghostdom',
    description_for_human: 'Headless browser as JSON for AI agents.',
    description_for_model:
      'Use ghostdom to render a URL with a real headless browser and get back the rendered DOM, visible text, title, links, and a screenshot URL — all as JSON. Billing uses a memorymarket: the first agent to render a URL pays the originator price; within a 10-minute TTL, subsequent agents pay a cache-hit price and 90% flows to the originator wallet. POST /v1/wallets to mint a wallet, POST /v1/wallets/fund to top it up via x402, then POST /render with {"url":"https://...","wait_for":"optional css selector"}.',
    auth: { type: 'user_http', authorization_type: 'custom', instructions: 'Mint a wallet: POST /v1/wallets. Send X-Wallet and X-Wallet-Key headers on every /render call.' },
    api: { type: 'openapi', url: `${base}/openapi.json` },
    logo_url: `${base}/logo`,
    contact_email: 'agents-only@ghostdom.dev',
    legal_info_url: `${base}/legal`,
  });
});

app.get('/.well-known/mcp.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    mcp_version: '2024-11-05',
    name: 'ghostdom',
    version: VERSION,
    description: 'Headless browser as JSON with memorymarket economics.',
    transport: { type: 'http', endpoint: `${base}/mcp` },
    capabilities: { tools: { listChanged: false } },
    tools: [
      {
        name: 'ghostdom_render',
        description: 'Render a URL with a real headless browser. Returns rendered_html, structured_dom, title, visible_text, links, screenshot_url, render_time_ms, cache_hit, cache_age_s, originator_wallet.',
        inputSchema: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            wait_for: { type: 'string', description: 'Optional CSS selector to wait for before capturing. Default: networkidle0.' },
            viewport_width: { type: 'integer', default: 1280 },
            viewport_height: { type: 'integer', default: 800 },
          },
        },
      },
      {
        name: 'ghostdom_wallet_info',
        description: 'Get current balance + earnings for a wallet.',
        inputSchema: { type: 'object', required: ['wallet'], properties: { wallet: { type: 'string' } } },
      },
    ],
    auth: { type: 'custom', headers: ['X-Wallet', 'X-Wallet-Key'], provision_url: `${base}/v1/wallets` },
    pricing_url: `${base}/v1/pricing`,
  });
});

app.get('/llms.txt', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.text(`# ghostdom

> Headless-browser-as-JSON for AI agents. First agent to render a URL becomes the originator and earns 90% of cache-hit fees from every subsequent agent within a 10-minute TTL.

## Discovery
- OpenAPI: ${base}/openapi.json
- ai-plugin: ${base}/.well-known/ai-plugin.json
- MCP manifest: ${base}/.well-known/mcp.json
- Pricing: ${base}/v1/pricing
- Errors: ${base}/v1/errors

## Auth (wallet, not bearer)
POST ${base}/v1/wallets -> { wallet, signing_key, balance_usd: 0 }
Send on every /render: X-Wallet: <wallet> + X-Wallet-Key: <signing_key>

## Funding
POST ${base}/v1/wallets/fund { "wallet": "<addr>", "amount_usd": 5 } -> { payment_url, x402: { ... } }
Agent follows payment_url to complete autonomously. x402 stablecoin settlement emitted.

## Render
POST ${base}/render { "url": "https://...", "wait_for": "optional CSS selector" }
Returns: { rendered_html, structured_dom, title, visible_text, screenshot_url, links, status, render_time_ms, cache_hit, cache_age_s, originator_wallet }

## Memorymarket pricing
- Originator (first to render a URL in the 10-minute window): $0.003
- Cache hit (subsequent renders within TTL): $0.0012
  - 90% ($0.00108) -> originator's wallet
  - 10% ($0.00012) -> platform wallet
- After TTL expires, next /render re-pays the originator price and becomes the new originator.

## Error contract
Every 4xx/5xx: { error: true, code, message, fix, docs, http_status }.

## Humans
None. This is an agent-only service.
`);
});

app.get('/openapi.json', (c) => {
  const base = `https://${c.req.header('host')}`;
  return c.json({
    openapi: '3.1.0',
    info: { title: 'ghostdom', version: VERSION, description: 'Headless browser as JSON with memorymarket economics.' },
    servers: [{ url: base }],
    paths: {
      '/v1/wallets': { post: { summary: 'Mint a wallet' } },
      '/v1/wallets/fund': { post: { summary: 'Start funding intent, returns x402 payment_url' } },
      '/render': {
        post: {
          summary: 'Render a URL',
          parameters: [
            { name: 'X-Wallet', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'X-Wallet-Key', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, wait_for: { type: 'string' }, viewport_width: { type: 'integer' }, viewport_height: { type: 'integer' } } } } } },
          responses: { '200': { description: 'Rendered payload' }, '402': { description: 'Insufficient wallet balance' } },
        },
      },
    },
  });
});

app.get('/v1/pricing', (c) => c.json({
  currency: 'USD',
  memorymarket: {
    price_originator_usd: Number(c.env.PRICE_ORIGINATOR_USD),
    price_cache_hit_usd: Number(c.env.PRICE_CACHE_HIT_USD),
    originator_share: Number(c.env.ORIGINATOR_SHARE),
    platform_share: 1 - Number(c.env.ORIGINATOR_SHARE),
    cache_ttl_seconds: Number(c.env.CACHE_TTL_SECONDS),
  },
  settlement: ['x402', 'prepaid_wallet_balance'],
}));

app.get('/v1/errors', (c) => c.json({
  schema: { example: { error: true, code: 'insufficient_funds', message: 'Wallet balance below required amount.', fix: 'POST /v1/wallets/fund ...', http_status: 402 } },
  codes: Object.fromEntries(Object.entries(ERR).map(([k, v]) => [k, { message: v.msg, fix: v.fix, http_status: v.http }])),
}));

// ---------- wallets ----------
app.post('/v1/wallets', async (c) => {
  const { wallet, signing_key } = newWallet();
  await walletPut(c.env, { addr: wallet, balance_micro: 0, signing_key });
  return c.json({
    wallet,
    signing_key,
    balance_usd: 0,
    usage: 'Send both headers on every /render: X-Wallet: ' + wallet + ' and X-Wallet-Key: <signing_key>',
    next_step: 'POST /v1/wallets/fund {"wallet":"' + wallet + '","amount_usd":5} to top up.',
  });
});

app.get('/v1/wallets/:addr', async (c) => {
  const addr = c.req.param('addr');
  const w = await walletGet(c.env, addr);
  if (!w) return c.json({ error: true, code: 'not_found', http_status: 404 }, 404);
  return c.json({ wallet: w.addr, balance_usd: w.balance_micro / 1_000_000, balance_micro: w.balance_micro });
});

// ---------- fund wallet (LIVE: Stripe Checkout + x402 USDC) ----------
app.post('/v1/wallets/fund', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const addr = body.wallet;
  const amount = Number(body.amount_usd || 5);
  const w = await walletGet(c.env, addr);
  if (!w) return err(c, 'invalid_wallet');
  const intent = 'pi_' + randomHex(12);
  const base = `https://${c.req.header('host')}`;

  // Create Stripe Checkout Session
  let session: Stripe.Checkout.Session;
  try {
    const stripe = stripeClient(c.env.STRIPE_SECRET_KEY);
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: `ghostdom wallet top-up`,
            description: `Fund ghostdom wallet ${addr} with $${amount.toFixed(2)}`,
          },
        },
        quantity: 1,
      }],
      success_url: `${base}/v1/wallets/fund/success?session_id={CHECKOUT_SESSION_ID}&intent=${intent}`,
      cancel_url: `${base}/v1/wallets/fund/cancel`,
      metadata: { service: 'ghostdom', intent, addr, amount_micro: String(usdToMicro(amount)) },
    });
  } catch (e: any) {
    return c.json({ error: true, code: 'stripe_error', message: e?.message || 'stripe_failed', http_status: 502 }, 502);
  }

  await c.env.WALLETS.put('intent:' + intent, JSON.stringify({ addr, amount_micro: usdToMicro(amount), paid: false, session_id: session.id }), { expirationTtl: 3600 });

  return c.json({
    intent,
    session_id: session.id,
    amount_usd: amount,
    payment_url: session.url,
    x402: {
      version: '0.1',
      scheme: 'exact',
      network: 'base',
      max_amount_required: String(amount),
      asset: 'USDC',
      asset_contract: USDC_BASE,
      resource: `${base}/v1/payments/verify`,
      description: `Fund ghostdom wallet ${addr} with $${amount}`,
      pay_to: c.env.PLATFORM_WALLET,
      verify_endpoint: `${base}/v1/payments/verify`,
    },
    expires_at: session.expires_at,
    live_mode: true,
  });
});

// Stripe webhook — credits wallet on checkout.session.completed
app.post('/stripe/webhook', async (c) => {
  const sig = c.req.header('stripe-signature') || '';
  const raw = await c.req.text();
  let event: Stripe.Event;
  try {
    const stripe = stripeClient(c.env.STRIPE_SECRET_KEY);
    event = await stripe.webhooks.constructEventAsync(raw, sig, c.env.STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    return c.json({ error: 'invalid signature', detail: e?.message }, 400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.service !== 'ghostdom') return c.json({ received: true, ignored: 'not_ghostdom' });
    const intent = session.metadata?.intent;
    if (!intent) return c.json({ received: true, ignored: 'no_intent' });
    const intentRaw = await c.env.WALLETS.get('intent:' + intent);
    if (!intentRaw) return c.json({ received: true, ignored: 'intent_expired' });
    const row = JSON.parse(intentRaw);
    if (row.paid) return c.json({ received: true, already: true });
    row.paid = true;
    row.paid_via = 'stripe';
    row.stripe_session = session.id;
    await c.env.WALLETS.put('intent:' + intent, JSON.stringify(row), { expirationTtl: 3600 });
    const wallet = await walletGet(c.env, row.addr);
    if (wallet) {
      wallet.balance_micro += row.amount_micro;
      await walletPut(c.env, wallet);
    }
  }
  return c.json({ received: true });
});

// Client-driven verify (alternative to webhook)
app.post('/v1/wallets/fund/verify', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const sessionId = body.session_id;
  if (!sessionId) return c.json({ error: true, code: 'missing_session_id', fix: 'Pass {"session_id":"cs_..."}', http_status: 400 }, 400);
  try {
    const stripe = stripeClient(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.service !== 'ghostdom') return c.json({ error: true, code: 'wrong_service', http_status: 400 }, 400);
    if (session.payment_status !== 'paid') return c.json({ error: true, code: 'not_paid', session_status: session.payment_status, http_status: 402 }, 402);
    const intent = session.metadata?.intent;
    const intentRaw = intent ? await c.env.WALLETS.get('intent:' + intent) : null;
    if (!intentRaw) return c.json({ error: true, code: 'intent_expired', http_status: 404 }, 404);
    const row = JSON.parse(intentRaw);
    if (row.paid) return c.json({ status: 'already_credited', intent });
    row.paid = true;
    row.paid_via = 'stripe_verify';
    await c.env.WALLETS.put('intent:' + intent!, JSON.stringify(row), { expirationTtl: 3600 });
    const wallet = await walletGet(c.env, row.addr);
    if (wallet) {
      wallet.balance_micro += row.amount_micro;
      await walletPut(c.env, wallet);
    }
    return c.json({ status: 'paid', intent, credited_usd: row.amount_micro / 1_000_000, balance_usd: (wallet?.balance_micro || 0) / 1_000_000, live_mode: true });
  } catch (e: any) {
    return c.json({ error: true, code: 'stripe_error', message: e?.message, http_status: 502 }, 502);
  }
});

// x402 on-chain USDC verify
app.post('/v1/payments/verify', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const addr = body.wallet;
  const txHash = body.tx_hash;
  if (!addr || !txHash) return c.json({ error: true, code: 'missing_input', fix: 'Pass {"wallet":"0x...","tx_hash":"0x..."}', http_status: 400 }, 400);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return c.json({ error: true, code: 'bad_tx_hash', http_status: 400 }, 400);
  const w = await walletGet(c.env, addr);
  if (!w) return c.json({ error: true, code: 'invalid_wallet', http_status: 400 }, 400);
  try {
    const rpcRes = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [txHash], id: 1 }) });
    const rpc = await rpcRes.json() as any;
    if (!rpc.result) return c.json({ error: true, code: 'tx_not_found', http_status: 404 }, 404);
    const receipt = rpc.result;
    if (receipt.status !== '0x1') return c.json({ error: true, code: 'tx_failed', http_status: 400 }, 400);
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const logs = (receipt.logs || []).filter((l: any) => l.address?.toLowerCase() === USDC_BASE.toLowerCase() && l.topics?.[0] === TRANSFER_TOPIC);
    if (!logs.length) return c.json({ error: true, code: 'no_usdc_transfer', fix: 'Send USDC to ' + c.env.PLATFORM_WALLET + ' on Base then retry.', http_status: 400 }, 400);
    const toPadded = '0x' + c.env.PLATFORM_WALLET.slice(2).toLowerCase().padStart(64, '0');
    const matching = logs.find((l: any) => l.topics[2]?.toLowerCase() === toPadded);
    if (!matching) return c.json({ error: true, code: 'wrong_recipient', fix: 'Send to ' + c.env.PLATFORM_WALLET + '.', http_status: 400 }, 400);
    const amountUsd = Number(BigInt(matching.data)) / 1_000_000;
    // Idempotency: check a KV set of consumed tx hashes for this wallet
    const consumedKey = 'tx:' + txHash.toLowerCase();
    const existing = await c.env.WALLETS.get(consumedKey);
    if (existing) return c.json({ status: 'already_credited', tx_hash: txHash, credited_to: existing });
    await c.env.WALLETS.put(consumedKey, addr, { expirationTtl: 86400 * 30 });
    w.balance_micro += usdToMicro(amountUsd);
    await walletPut(c.env, w);
    return c.json({ status: 'paid', tx_hash: txHash, amount_usd: amountUsd, balance_usd: w.balance_micro / 1_000_000, pay_to: c.env.PLATFORM_WALLET, network: 'base', live_mode: true });
  } catch (e: any) {
    return c.json({ error: true, code: 'rpc_error', message: e?.message, http_status: 502 }, 502);
  }
});

// Withdrawal request (queued for manual processing)
app.post('/v1/wallets/withdraw', async (c) => {
  const w = authWallet(c);
  if (!w) return err(c, 'missing_wallet');
  const wrec = await walletGet(c.env, w.addr);
  if (!wrec || wrec.signing_key !== w.key) return err(c, 'invalid_wallet');
  const body = await c.req.json().catch(() => ({} as any));
  const toAddr = body.to_usdc_address;
  if (!toAddr || !/^0x[0-9a-fA-F]{40}$/.test(toAddr)) return c.json({ error: true, code: 'bad_address', fix: 'Pass {"to_usdc_address":"0x... (40 hex chars, Base mainnet)"}', http_status: 400 }, 400);
  const MIN_WITHDRAWAL_MICRO = 1_000_000; // $1 minimum
  if (wrec.balance_micro < MIN_WITHDRAWAL_MICRO) return c.json({ error: true, code: 'below_minimum', message: 'Minimum withdrawal is $1.00 USD.', fix: 'Accumulate more earnings or continue using the balance.', http_status: 400, balance_usd: wrec.balance_micro / 1_000_000 }, 400);
  const requestId = 'wd_' + randomHex(10);
  const request = {
    request_id: requestId,
    wallet: w.addr,
    to_usdc_address: toAddr,
    amount_micro: wrec.balance_micro,
    amount_usd: wrec.balance_micro / 1_000_000,
    requested_at: Math.floor(Date.now() / 1000),
    status: 'pending',
    network: 'base',
    asset: 'USDC',
  };
  await c.env.WALLETS.put('withdrawal:' + requestId, JSON.stringify(request));
  // Zero the wallet balance (held in escrow until processed)
  wrec.balance_micro = 0;
  await walletPut(c.env, wrec);
  // Also store in a pending-list for operator review
  const pending = await c.env.WALLETS.get('withdrawals:pending');
  const list = pending ? JSON.parse(pending) : [];
  list.push(requestId);
  await c.env.WALLETS.put('withdrawals:pending', JSON.stringify(list));
  return c.json({
    status: 'queued',
    request_id: requestId,
    to_usdc_address: toAddr,
    amount_usd: request.amount_usd,
    network: 'base',
    asset: 'USDC',
    eta: '1-3 business days (manual operator review)',
    note: 'Your wallet balance is held in escrow (set to $0.00) until this withdrawal is processed. If rejected, balance will be restored.',
  });
});

app.get('/v1/wallets/withdraw/:request_id', async (c) => {
  const id = c.req.param('request_id');
  const raw = await c.env.WALLETS.get('withdrawal:' + id);
  if (!raw) return c.json({ error: true, code: 'not_found', http_status: 404 }, 404);
  return c.json(JSON.parse(raw));
});

// Stripe redirect landing pages
app.get('/v1/wallets/fund/success', (c) => c.json({ status: 'stripe_redirect', session_id: c.req.query('session_id'), intent: c.req.query('intent'), next: 'Wallet will be credited automatically once Stripe webhook fires, or POST /v1/wallets/fund/verify with {"session_id":"..."} to force credit.' }));
app.get('/v1/wallets/fund/cancel', (c) => c.json({ status: 'cancelled', next: 'Retry POST /v1/wallets/fund.' }));

// ---------- logo ----------
app.get('/logo', () => {
  const hex = '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA6364F80F0000010101005B36CAF10000000049454E44AE426082';
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new Response(out.buffer as ArrayBuffer, { headers: { 'content-type': 'image/png' } });
});

app.get('/legal', (c) => c.json({ service: 'ghostdom', terms: 'Agent-only. No warranty. Screenshots deleted after cache TTL. No PII stored.' }));

// ==================================================================
// RENDER (the main act)
// ==================================================================
app.post('/render', async (c) => {
  const w = authWallet(c);
  if (!w) return err(c, 'missing_wallet');
  const wrec = await walletGet(c.env, w.addr);
  if (!wrec || wrec.signing_key !== w.key) return err(c, 'invalid_wallet');

  const body = await c.req.json().catch(() => null) as any;
  if (!body || typeof body.url !== 'string') return err(c, 'missing_url');
  let u: URL;
  try { u = new URL(body.url); } catch { return err(c, 'bad_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return err(c, 'bad_url');
  if (isBlockedHost(u.hostname)) return err(c, 'blocked_host');

  const urlNorm = u.toString();
  const urlHash = await sha256Hex(urlNorm);
  const ledgerId = c.env.LEDGER.idFromName(urlHash);
  const ledgerStub = c.env.LEDGER.get(ledgerId);

  // Claim originator role (atomic inside DO)
  const claimRes = await ledgerStub.fetch('https://do/claim', { method: 'POST', body: JSON.stringify({ op: 'claim_originator', wallet: w.addr }) }).then(r => r.json() as Promise<any>);
  const role: 'originator' | 'cache_hit' = claimRes.role;
  const ledgerRow = claimRes.row;

  // Pricing
  const origMicro = usdToMicro(c.env.PRICE_ORIGINATOR_USD);
  const hitMicro = usdToMicro(c.env.PRICE_CACHE_HIT_USD);
  const costMicro = role === 'originator' ? origMicro : hitMicro;
  if (wrec.balance_micro < costMicro) return err(c, 'insufficient_funds', { needed_usd: costMicro / 1_000_000, balance_usd: wrec.balance_micro / 1_000_000 });

  // Charge the caller
  wrec.balance_micro -= costMicro;
  await walletPut(c.env, wrec);

  // Split if cache_hit
  let payoutToOriginatorMicro = 0;
  let payoutToPlatformMicro = 0;
  if (role === 'cache_hit') {
    payoutToOriginatorMicro = Math.floor(hitMicro * Number(c.env.ORIGINATOR_SHARE));
    payoutToPlatformMicro = hitMicro - payoutToOriginatorMicro;
    await walletEnsurePlatform(c.env);
    await walletCredit(c.env, ledgerRow.originator, payoutToOriginatorMicro);
    await walletCredit(c.env, c.env.PLATFORM_WALLET, payoutToPlatformMicro);
    await ledgerStub.fetch('https://do/rec', { method: 'POST', body: JSON.stringify({ op: 'record_earnings', originator_micro: payoutToOriginatorMicro, platform_micro: payoutToPlatformMicro }) });
  } else {
    // originator keeps whole fee as platform income (no one to split with yet) — note in spec: originator price is pure platform revenue
    await walletEnsurePlatform(c.env);
    await walletCredit(c.env, c.env.PLATFORM_WALLET, origMicro);
  }

  // Cache lookup
  let rendered: any = null;
  let cacheHit = false;
  let cacheAge = 0;
  if (role === 'cache_hit') {
    const raw = await c.env.CACHE.get('render:' + urlHash);
    if (raw) {
      rendered = JSON.parse(raw);
      cacheHit = true;
      cacheAge = Math.max(0, Math.floor(Date.now() / 1000) - ledgerRow.set_at);
    }
  }

  if (!rendered) {
    // Fresh render via Cloudflare Browser Rendering
    const t0 = Date.now();
    let browser: any = null;
    try {
      // Reuse an existing browser session if available to stay under concurrency limits
      const sessions = await (puppeteer as any).sessions(c.env.MYBROWSER as any).catch(() => []);
      const free = (sessions || []).find((s: any) => !s.connectionId);
      if (free) {
        try { browser = await (puppeteer as any).connect(c.env.MYBROWSER as any, free.sessionId); } catch { browser = null; }
      }
      if (!browser) browser = await puppeteer.launch(c.env.MYBROWSER as any);
      const page = await browser.newPage();
      const vw = Math.min(1920, Math.max(320, Number(body.viewport_width) || 1280));
      const vh = Math.min(1200, Math.max(240, Number(body.viewport_height) || 800));
      await page.setViewport({ width: vw, height: vh });
      const resp = await page.goto(urlNorm, { waitUntil: 'networkidle0', timeout: 20000 });
      if (body.wait_for && typeof body.wait_for === 'string') {
        try { await page.waitForSelector(body.wait_for, { timeout: 5000 }); } catch {}
      }
      const title = await page.title();
      const html = await page.content();
      const visibleText = await (page as any).evaluate(
        `(() => { const b = document.body; return b ? (b.innerText || '').slice(0, 20000) : ''; })()`
      );
      const links = await (page as any).evaluate(
        `(() => { const out = []; document.querySelectorAll('a[href]').forEach(a => { if (out.length < 300) out.push({ href: a.href, text: (a.textContent || '').trim().slice(0, 120) }); }); return out; })()`
      );
      const structured = await (page as any).evaluate(
        `(() => {
          const walk = (el, depth) => {
            if (!el || depth > 4) return null;
            const children = [];
            const kids = el.children || [];
            for (let i = 0; i < kids.length && children.length < 8; i++) {
              const w = walk(kids[i], depth + 1);
              if (w) children.push(w);
            }
            const text = (el.textContent || '').trim().slice(0, 200);
            const cls = el.className && typeof el.className === 'string' ? el.className.slice(0, 80) : undefined;
            return { tag: el.tagName ? el.tagName.toLowerCase() : '?', id: el.id || undefined, cls, text: text || undefined, children: children.length ? children : undefined };
          };
          return document.body ? walk(document.body, 0) : null;
        })()`
      );
      const screenshotBuf = await page.screenshot({ type: 'png', fullPage: false });
      const screenshotKey = 'shot:' + urlHash;
      await c.env.CACHE.put(screenshotKey, screenshotBuf, { expirationTtl: Number(c.env.CACHE_TTL_SECONDS) });
      const screenshot_url = `https://${c.req.header('host')}/v1/screenshot/${urlHash}`;
      const status = resp?.status() || 0;
      // Close just the page; leave the browser session alive for reuse (saves concurrency quota)
      try { await page.close(); } catch {}
      try { await (browser as any).disconnect?.(); } catch {}
      rendered = {
        rendered_html: html.slice(0, 200000),
        structured_dom: structured,
        title,
        visible_text: visibleText,
        screenshot_url,
        links: links.slice(0, 100),
        status,
        render_time_ms: Date.now() - t0,
      };
      await c.env.CACHE.put('render:' + urlHash, JSON.stringify(rendered), { expirationTtl: Number(c.env.CACHE_TTL_SECONDS) });
    } catch (e: any) {
      try { await (browser as any)?.close?.(); } catch {}
      return err(c, 'render_failed', { detail: (e && e.message) || 'unknown' });
    }
  }

  return c.json({
    ...rendered,
    cache_hit: cacheHit,
    cache_age_s: cacheAge,
    originator_wallet: ledgerRow?.originator || w.addr,
    role,
    cost_usd: costMicro / 1_000_000,
    payout: role === 'cache_hit' ? {
      to_originator_usd: payoutToOriginatorMicro / 1_000_000,
      to_platform_usd: payoutToPlatformMicro / 1_000_000,
    } : { to_originator_usd: 0, to_platform_usd: origMicro / 1_000_000, note: 'First-ever render for this URL within current TTL — full fee is platform revenue since there is no prior originator to pay.' },
    wallet_balance_usd: wrec.balance_micro / 1_000_000,
  });
});

// Screenshot serve
app.get('/v1/screenshot/:hash', async (c) => {
  const hash = c.req.param('hash');
  const buf = await c.env.CACHE.get('shot:' + hash, 'arrayBuffer');
  if (!buf) return c.json({ error: true, code: 'not_found', http_status: 404 }, 404);
  return new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' } });
});

// MCP transport
app.post('/mcp', async (c) => {
  const body = await c.req.json().catch(() => null) as any;
  if (!body || !body.method) return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid JSON-RPC' }, id: null });
  const id = body.id ?? null;
  if (body.method === 'initialize') {
    return c.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ghostdom', version: VERSION } } });
  }
  if (body.method === 'tools/list') {
    const m = await fetch(`https://${c.req.header('host')}/.well-known/mcp.json`).then(r => r.json()).catch(() => null) as any;
    return c.json({ jsonrpc: '2.0', id, result: { tools: m?.tools || [] } });
  }
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    if (name === 'ghostdom_render') {
      const auth = { 'x-wallet': c.req.header('x-wallet') || '', 'x-wallet-key': c.req.header('x-wallet-key') || '' };
      const r = await fetch(`https://${c.req.header('host')}/render`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(args) });
      const data = await r.json();
      return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: !r.ok } });
    }
    if (name === 'ghostdom_wallet_info') {
      const r = await fetch(`https://${c.req.header('host')}/v1/wallets/${args.wallet}`);
      const data = await r.json();
      return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: !r.ok } });
    }
    return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
  }
  return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});

app.notFound((c) => err(c, 'not_found', { path: c.req.path }));

export default app;
