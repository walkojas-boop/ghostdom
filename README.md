# ghostdom

> Headless-browser-as-JSON for AI agents, with memorymarket economics:
> the first agent to render a URL gets paid every time another agent
> cache-hits the same URL during the 10-minute TTL.

**Live endpoint:** <https://ghostdom.jason-12c.workers.dev/>

`curl https://ghostdom.jason-12c.workers.dev/` returns a full machine-readable manifest. Zero HTML. Agents only.

## Stack

- **Compute:** Cloudflare Workers
- **Rendering:** Cloudflare Browser Rendering API (real Chromium)
- **Ledger:** Durable Objects (one instance per URL hash, atomic originator claim)
- **Cache:** Workers KV (rendered payloads + screenshots, 10-min TTL)
- **Settlement:** x402 headers + in-wallet USDC micro-balances

## Memorymarket

| Event | Price | Flow |
|---|---|---|
| First agent to `/render` URL X (no prior render in 10 min) | **$0.003** | To platform wallet. Caller recorded as **originator** of X. |
| Subsequent `/render` of X within 10-min TTL | **$0.0012** | 90% → originator wallet, 10% → platform |
| TTL expires, next `/render` | **$0.003** | New originator for the next window |

## Core endpoint

```
POST /render
Headers: X-Wallet: <wallet>, X-Wallet-Key: <signing_key>, Content-Type: application/json
Body:    { "url": "https://...", "wait_for": "optional CSS selector" }

Response:
{
  "rendered_html": "...",
  "structured_dom": { tag, id, cls, text, children },
  "title": "...",
  "visible_text": "...",
  "screenshot_url": "https://.../v1/screenshot/<hash>",
  "links": [ { href, text }, ... ],
  "status": 200,
  "render_time_ms": 3425,
  "cache_hit": true/false,
  "cache_age_s": 172,
  "originator_wallet": "0x...",
  "role": "originator" | "cache_hit",
  "cost_usd": 0.0012,
  "payout": { "to_originator_usd": 0.00108, "to_platform_usd": 0.00012 },
  "wallet_balance_usd": 0.9904
}
```

## Discovery

- `GET /.well-known/ai-plugin.json`
- `GET /.well-known/mcp.json`
- `GET /llms.txt`
- `GET /openapi.json`
- `GET /v1/pricing`
- `GET /v1/errors`

## Auth

```bash
# 1. Mint a wallet
curl -X POST https://ghostdom.jason-12c.workers.dev/v1/wallets

# 2. Fund it ($1 via x402 test-mode)
curl -X POST https://ghostdom.jason-12c.workers.dev/v1/wallets/fund \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0x...", "amount_usd": 1}'
# Follow the returned payment_url to complete

# 3. Render
curl -X POST https://ghostdom.jason-12c.workers.dev/render \
  -H "X-Wallet: 0x..." -H "X-Wallet-Key: gd_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## MCP

HTTP/JSON-RPC 2.0 at `/mcp`, protocol `2024-11-05`. Tools: `ghostdom_render`, `ghostdom_wallet_info`.

## Safety

- SSRF protection: 127/8, 10/8, 192.168/16, 172.16/12, 169.254/16, metadata.internal all refused.
- Max 1.5 MB rendered HTML surfaced. Browser timeout 20s.
- Screenshot TTL = cache TTL = 10 minutes.

## License

Apache 2.0.
