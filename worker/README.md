# Tastytrade MCP: Cloudflare Worker

One file, no dependencies. It exposes a Tastytrade account as an MCP server over streamable HTTP, so Claude on desktop, web or mobile can reach it as a custom connector.

Why one file: the Worker started life pasted into the Cloudflare dashboard editor, and keeping it as a single dependency-free script means there's no build step and nothing in `node_modules` to audit before it touches a brokerage account.

```powershell
npm install        # no runtime deps; validates the package
npm run build      # node --check on the worker
npm test           # offline tests against a fake Tastytrade API
npm run demo       # MCP session over synthetic fixtures, no credentials
```

## Safety model

Before any tool runs, the `/mcp` endpoint checks the caller. It fails closed: if `MCP_AUTH_TOKEN` is unset or shorter than 32 characters, every request gets `503`. Otherwise the request needs `Authorization: Bearer <token>`, compared in constant time (both sides hashed with SHA-256, then every byte checked), or it gets `401`. There is no query-string token.

`safePlace()` is the only function that can send a live order. In order:

1. Dry-run the order (`POST /accounts/{acct}/orders/dry-run`). A broker rejection stops here.
2. `LIVE_TRADING_ENABLED` must be the string `true`, or the result is `DRY_RUN_ONLY`.
3. `MCP_AUTH_TOKEN` must be set, or the result is `BLOCKED`. The endpoint check above already refuses in that case; this is a second line in case `safePlace` is ever called some other way.
4. The call must carry `confirm: "CONFIRM"`, or the result is `NEEDS_CONFIRMATION`. In practice Claude shows you the dry-run in the chat and only sends `CONFIRM` after you say yes.
5. Only then is the identical order body posted live.

`preview_*` tools call the dry-run endpoint directly and have no live path. `cancel_order` and the watchlist writes are not gated: they reduce risk or move no money. A source-level test (`tests/test_chokepoint.py`) fails if a second live-order POST appears anywhere in the file.

## Tools (42)

| Group | Tools |
|---|---|
| Account | `get_balances`, `get_positions`, `get_position_greeks`, `list_orders`, `cancel_order` |
| History | `get_transaction_history`, `get_realized_pnl` (open/close matching, fee-inclusive) |
| Watchlists | `list_watchlists`, `get_watchlist`, `update_watchlist`, `create_watchlist` |
| Scans | `scan_watchlist`, `scan_symbols` (IV rank), `scan_watchlist_for_csp` (wheel entries by annualized ROR), `scan_watchlist_bb_csp` (lower-band CSPs), `leaps_finder` |
| Options data | `get_option_expirations`, `get_option_strikes`, `get_chain_with_greeks`, `get_strike_by_delta`, `expected_move`, `options_sentiment` (25-delta skew), `get_gamma_exposure` (GEX, gamma flip, call/put walls, max pain) |
| Technicals | `get_bollinger`, `get_swing_structure` ([docs](docs/swing-structure.md)), `instant_analyzer` (rule-based pass/fail) |
| Research | `get_analyst_targets`, `get_seasonality`, `get_earnings_history`, `get_stock_stats`, `get_fundamentals`, `get_financials`, `price_calculator` |
| Macro | `get_index_trends`, `get_fear_greed`, `get_fed_watch` |
| Orders, dry-run | `preview_order`, `preview_option_order`, `preview_spread` |
| Orders, gated | `place_order`, `place_option_order`, `place_spread` |

Research and macro tools use free public endpoints (Yahoo Finance, CNN Fear & Greed). They are unofficial and can change or rate-limit without notice.

## Deploy

```powershell
npx wrangler login
npx wrangler deploy
npx wrangler secret put TASTY_CLIENT_SECRET
npx wrangler secret put TASTY_REFRESH_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN    # 32+ chars, e.g. openssl rand -hex 32
# LIVE_TRADING_ENABLED stays "false" in wrangler.toml [vars]
```

The endpoint is `https://tastytrade-mcp.<your-subdomain>.workers.dev/mcp`. Clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`. Until that secret is set, the endpoint answers `503` to everyone.

Go-live test: set `LIVE_TRADING_ENABLED=true`, place one 1-share limit order far from the market with `confirm="CONFIRM"`, check `list_orders`, then `cancel_order`.

## Local dev

`npx wrangler dev` reads `.dev.vars` (gitignored); copy `.dev.vars.example`. Save it without a byte-order mark: PowerShell's `Set-Content -Encoding utf8` adds one and corrupts the first variable name.

## Implementation notes

- OAuth2 personal grant: `POST /oauth/token` with the refresh token returns a 15-minute access token, cached per isolate.
- Every request needs a `User-Agent` header. Without one the API's WAF answers with a bare nginx 401.
- Orders use a positive `price` plus `price-effect` (`Debit` for buys, `Credit` for sells). Spreads take an explicit `DEBIT`/`CREDIT`.
- Greeks and quotes come from DXLink (WebSocket), not REST. Per request: `GET /api-quote-tokens`, open the socket, SETUP, AUTH, CHANNEL_REQUEST, FEED_SETUP, FEED_SUBSCRIPTION, collect, close. Outbound WebSockets from a Worker need the `wss://` URL rewritten to `https://` with an `Upgrade` header. Subscribe with the chain's streamer symbols, not OCC symbols.
