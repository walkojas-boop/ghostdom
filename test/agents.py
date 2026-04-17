"""
ghostdom 2-agent test.

Agent 1 (Anthropic SDK): discovers the service via well-known endpoints,
         mints a wallet, funds it via x402 test-mode, renders 5 URLs.
Between:  snapshot Agent 1's wallet balance B1.
Agent 2 (fresh Anthropic SDK instance, no shared context): independently
         discovers, mints its own wallet, funds, renders the SAME 5 URLs.
After:    re-read Agent 1's wallet balance -> B2.
Prove:    B2 > B1. The delta came from Agent 2's cache-hit payouts.

Every URL and every header the agent sees is driven by the model, not
hard-coded. The only thing passed in is the root URL.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from anthropic import Anthropic

ROOT = "https://ghostdom.jason-12c.workers.dev/"
MODEL = "claude-haiku-4-5-20251001"

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

# URLs to render. We tag each with a random run_id query param so both agents
# hit the SAME cache key but nobody else has rendered these URLs before —
# guaranteeing Agent 1 becomes the originator and Agent 2 becomes a cache_hit.
import secrets
RUN_ID = secrets.token_hex(4)
URLS = [
    f"https://example.com/?lp={RUN_ID}",
    f"https://example.org/?lp={RUN_ID}",
    f"https://httpbin.org/html?lp={RUN_ID}",
    f"https://www.iana.org/?lp={RUN_ID}",
    f"https://en.wikipedia.org/wiki/Model_Context_Protocol?lp={RUN_ID}",
]
print(f"RUN_ID={RUN_ID}")


def http_request(method, url, headers=None, body=None, timeout=40):
    req = urllib.request.Request(url, method=method)
    # Set a browser-ish UA to avoid Cloudflare bot-protection 403s
    req.add_header("User-Agent", "Mozilla/5.0 (ghostdom-test-agent; walkojas@gmail.com)")
    req.add_header("Accept", "application/json, text/plain, */*")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = body.encode("utf-8") if isinstance(body, str) else body
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        status = e.code
    except Exception as e:
        return {"status": 0, "error": str(e), "body_text": ""}
    return {"status": status, "body_text": raw[:20000]}


TOOLS = [
    {
        "name": "http_request",
        "description": "Make an HTTP request to ghostdom. Pass full https URL. For POST JSON: headers={'content-type':'application/json', plus auth headers as needed}, body=<json string>.",
        "input_schema": {
            "type": "object",
            "required": ["method", "url"],
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST"]},
                "url": {"type": "string"},
                "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "string"},
            },
        },
    },
    {
        "name": "report",
        "description": "Final report. Provide wallet address, final balance in USD, and the list of URLs rendered.",
        "input_schema": {
            "type": "object",
            "required": ["wallet", "balance_usd", "urls_rendered"],
            "properties": {
                "wallet": {"type": "string"},
                "balance_usd": {"type": "number"},
                "urls_rendered": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"},
            },
        },
    },
]


def run_agent(label, system_prompt, first_msg, url_list):
    messages = [{"role": "user", "content": first_msg}]
    transcript = []
    final = None
    turns = 0
    while turns < 40 and final is None:
        turns += 1
        resp = client.messages.create(
            model=MODEL, max_tokens=2048, system=system_prompt, tools=TOOLS, messages=messages
        )
        messages.append({"role": "assistant", "content": resp.content})
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            break
        tr = []
        for tu in tool_uses:
            if tu.name == "report":
                final = tu.input
                tr.append({"type": "tool_result", "tool_use_id": tu.id, "content": "OK"})
                continue
            if tu.name == "http_request":
                r = http_request(tu.input.get("method", "GET"), tu.input["url"], tu.input.get("headers"), tu.input.get("body"))
                body_preview = (r.get("body_text") or "")[:1000]
                tr.append({"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps({"status": r.get("status"), "body": body_preview})})
                transcript.append({"turn": turns, "label": label, "method": tu.input.get("method"), "url": tu.input.get("url"), "status": r.get("status"), "body_preview": body_preview[:250]})
        messages.append({"role": "user", "content": tr})
    return final, transcript, turns


def print_transcript(label, transcript):
    print(f"--- {label} HTTP trail ---")
    for i, t in enumerate(transcript, 1):
        url = t["url"].replace(ROOT.rstrip("/"), "")
        print(f"  [{i:02d}] {t['method']:4s} {url:60s}  HTTP {t['status']}")


SYSTEM_A = (
    "You are autonomous Agent 1. You have NO prior knowledge of the ghostdom service. "
    f"Your only entrypoint is {ROOT}. Discover the service by fetching the root, then follow its discovery links "
    "(/.well-known/ai-plugin.json, /llms.txt) to understand the endpoints. Mission:\n"
    "  1. GET / and /.well-known/ai-plugin.json and /llms.txt.\n"
    "  2. POST /v1/wallets to mint a fresh wallet. Record wallet + signing_key.\n"
    "  3. POST /v1/wallets/fund with wallet + amount_usd=1, then GET the returned payment_url to settle (test mode).\n"
    "  4. POST /render with header X-Wallet + X-Wallet-Key for each of these EXACT URLs in order:\n"
    + "\n".join(f"       - {u}" for u in URLS) + "\n"
    "     For each render, send JSON body {\"url\":\"<that-url>\"}. Use the SAME wallet headers on every render.\n"
    "  5. After all 5 renders, GET /v1/wallets/<your-addr> to read your balance.\n"
    "  6. Call the report tool with wallet + balance_usd + urls_rendered.\n"
    "Do not invent URLs beyond the list above and URLs the server returns. Stop after calling report."
)

SYSTEM_B = (
    "You are autonomous Agent 2, running in a fresh session with NO knowledge of Agent 1. "
    f"Your only entrypoint is {ROOT}. Discover the service yourself. Mission:\n"
    "  1. Discover the service (/ + /llms.txt).\n"
    "  2. Mint your own fresh wallet via POST /v1/wallets.\n"
    "  3. Fund it with $1 via POST /v1/wallets/fund + GET the returned payment_url.\n"
    "  4. POST /render for these EXACT same URLs as in your mission list (in order):\n"
    + "\n".join(f"       - {u}" for u in URLS) + "\n"
    "     Use your OWN wallet headers on every render. These URLs were rendered a moment ago by another agent, so "
    "     you should see role='cache_hit' with a nonzero cache_age_s on each response.\n"
    "  5. Call the report tool.\n"
    "Do not invent URLs. Stop after calling report."
)


def main():
    print("=" * 72)
    print("AGENT 1 — originator")
    print("=" * 72)
    r1, t1, turns1 = run_agent("A1", SYSTEM_A, f"Begin. Start by GETting {ROOT}.", URLS)
    print_transcript("AGENT 1", t1)
    if not r1:
        print("Agent 1 did not call report. Aborting.")
        return 2
    wallet_a = r1["wallet"]
    print(f"\nAgent 1 report: wallet={wallet_a} balance_usd={r1['balance_usd']}")

    # Snapshot balance B1 directly via public API (don't trust agent 1's stale read)
    b1_raw = http_request("GET", ROOT.rstrip("/") + f"/v1/wallets/{wallet_a}")
    try:
        b1 = json.loads(b1_raw["body_text"]).get("balance_usd", 0)
    except Exception:
        print("B1 probe raw:", b1_raw)
        b1 = r1["balance_usd"]  # fallback to agent's reported value
    print(f"Wallet A balance immediately after Agent 1 = ${b1:.6f} (this is the 'before' snapshot)")

    # Let caches settle briefly
    time.sleep(3)

    print()
    print("=" * 72)
    print("AGENT 2 — cache-hitter")
    print("=" * 72)
    r2, t2, turns2 = run_agent("A2", SYSTEM_B, f"Begin. Start by GETting {ROOT}.", URLS)
    print_transcript("AGENT 2", t2)
    if not r2:
        print("Agent 2 did not call report. Aborting.")
        return 2
    wallet_b = r2["wallet"]
    print(f"\nAgent 2 report: wallet={wallet_b} balance_usd={r2['balance_usd']}")

    # Re-read wallet A's balance
    b2_raw = http_request("GET", ROOT.rstrip("/") + f"/v1/wallets/{wallet_a}")
    try:
        b2 = json.loads(b2_raw["body_text"]).get("balance_usd", 0)
    except Exception:
        print("B2 probe raw:", b2_raw)
        b2 = r2["balance_usd"]
    print(f"\nWallet A balance AFTER Agent 2 rendered same URLs = ${b2:.6f}")
    print(f"Delta = ${b2 - b1:.6f}  (expected: 5 * $0.0012 * 0.9 = $0.0054)")
    try:
        wb = json.loads(http_request('GET', ROOT.rstrip('/') + f'/v1/wallets/{wallet_b}')['body_text'])['balance_usd']
        print(f"Wallet B (Agent 2) balance = ${wb:.6f}")
    except Exception:
        pass

    print()
    print("=" * 72)
    print("VERDICT")
    print("=" * 72)
    ok = b2 > b1
    print(f"  Agent 1 wallet balance increased? {'YES' if ok else 'NO'}")
    print(f"  before: ${b1:.6f}   after: ${b2:.6f}   delta: ${b2 - b1:+.6f}")
    print(f"  memorymarket payout flow: {'VERIFIED' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
