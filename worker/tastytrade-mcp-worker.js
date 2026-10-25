// Tastytrade MCP Server — Cloudflare Worker (single-file, no dependencies)
// Hand-rolled MCP 2025-03-26 streamable-http transport (no SDK, no build step).
// Deploy: paste into Cloudflare dashboard Workers editor (or `wrangler deploy`),
//         then set secrets via Settings > Variables & Secrets.
//
// Required secrets/vars:
//   TASTY_CLIENT_SECRET   (secret)  OAuth application client secret
//   TASTY_REFRESH_TOKEN   (secret)  Personal OAuth grant refresh token
//   LIVE_TRADING_ENABLED  (var)     "true" to allow live orders; anything else = dry-run only
//   MCP_AUTH_TOKEN        (secret)  REQUIRED bearer token for the /mcp endpoint (32+ chars).
//                                   Unset or short -> every /mcp request gets 503.
//
// Auth model: OAuth2 personal grant. We exchange the refresh token for a 15-min
// access token (POST /oauth/token) and cache it in the isolate.

const MCP_SERVER_NAME = "tastytrade";
const MCP_SERVER_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_ENDPOINT = "/mcp";

const API_URL = "https://api.tastyworks.com";
const API_VERSION = "20251101"; // sent as Accept-Version; required or nginx returns 401
const ORDER_SOURCE = "tastytrade-mcp/1.0";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ACTION_ENUM = ["BUY_TO_OPEN", "SELL_TO_OPEN", "BUY_TO_CLOSE", "SELL_TO_CLOSE"];

const TOOLS = [
  {
    name: "get_balances",
    description: "Get account balances: net liquidating value, cash, and derivative buying power.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_positions",
    description: "Get all open positions in the Tastytrade account.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_watchlists",
    description: "List the user's private watchlists with their symbol counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_watchlist",
    description: "Get the symbols in a specific private watchlist by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact watchlist name" } },
      required: ["name"],
    },
  },
  {
    name: "scan_watchlist",
    description:
      "Scan a watchlist for symbols with IV rank >= min_iv_rank (0-100), sorted high to low. Returns iv_rank, liquidity, beta.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact watchlist name" },
        min_iv_rank: { type: "number", description: "Minimum IV rank 0-100 (default 50)", default: 50 },
      },
      required: ["name"],
    },
  },
  {
    name: "scan_symbols",
    description: "Scan an arbitrary list of symbols for IV rank >= min_iv_rank (0-100), sorted high to low.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Ticker symbols" },
        min_iv_rank: { type: "number", description: "Minimum IV rank 0-100 (default 50)", default: 50 },
      },
      required: ["symbols"],
    },
  },
  {
    name: "get_option_expirations",
    description: "List available option expiration dates (YYYY-MM-DD) for an underlying.",
    inputSchema: {
      type: "object",
      properties: { underlying: { type: "string", description: "Underlying symbol, e.g. SPY" } },
      required: ["underlying"],
    },
  },
  {
    name: "get_option_strikes",
    description: "List strikes (with call/put availability) for an underlying + expiration.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["underlying", "expiration"],
    },
  },
  {
    name: "get_chain_with_greeks",
    description:
      "Live option chain slice for an expiration, enriched with bid/ask/mid + delta/gamma/theta/vega + IV per strike (via DXLink streaming). option_type: C, P, or BOTH (default BOTH). Use for browsing a chain with greeks; for delta-targeting use get_strike_by_delta.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD" },
        option_type: { type: "string", description: "C, P, or BOTH (default BOTH)" },
      },
      required: ["underlying", "expiration"],
    },
  },
  {
    name: "get_strike_by_delta",
    description:
      "For the wheel/CSP workflow: given a target delta (e.g. -0.30 for a 30-delta put), returns the strike whose live delta is closest, plus premium (bid/ask/mid), IV, and ROR (return on risk = mid/(strike-mid)) and annualized ROR. option_type: C/CALL or P/PUT.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD" },
        target_delta: { type: "number", description: "e.g. -0.30 for a 30-delta put, 0.30 for a 30-delta call" },
        option_type: { type: "string", description: "C/CALL or P/PUT" },
      },
      required: ["underlying", "expiration", "target_delta", "option_type"],
    },
  },
  {
    name: "preview_order",
    description: "DRY-RUN a stock limit order. Returns buying-power effect + fees. Places nothing.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        quantity: { type: "number" },
        limit_price: { type: "number", description: "Positive price per share" },
        action: { type: "string", enum: ACTION_ENUM, default: "BUY_TO_OPEN" },
      },
      required: ["symbol", "quantity", "limit_price"],
    },
  },
  {
    name: "place_order",
    description:
      "Place a REAL stock limit order. Requires LIVE_TRADING_ENABLED=true, MCP_AUTH_TOKEN set, AND confirm='CONFIRM'. Otherwise returns a dry-run summary.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        quantity: { type: "number" },
        limit_price: { type: "number" },
        action: { type: "string", enum: ACTION_ENUM, default: "BUY_TO_OPEN" },
        confirm: { type: "string", description: "Pass 'CONFIRM' to place live" },
      },
      required: ["symbol", "quantity", "limit_price"],
    },
  },
  {
    name: "preview_option_order",
    description:
      "DRY-RUN a single-leg option order. option_type: C/CALL or P/PUT. expiration: YYYY-MM-DD. limit_price: positive premium per contract. Places nothing.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD" },
        strike: { type: "number" },
        option_type: { type: "string", description: "C/CALL or P/PUT" },
        quantity: { type: "number" },
        limit_price: { type: "number" },
        action: { type: "string", enum: ACTION_ENUM, default: "BUY_TO_OPEN" },
      },
      required: ["underlying", "expiration", "strike", "option_type", "quantity", "limit_price"],
    },
  },
  {
    name: "place_option_order",
    description:
      "Place a REAL single-leg option order. Requires LIVE_TRADING_ENABLED=true, MCP_AUTH_TOKEN set, AND confirm='CONFIRM'. Otherwise returns a dry-run summary.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD" },
        strike: { type: "number" },
        option_type: { type: "string", description: "C/CALL or P/PUT" },
        quantity: { type: "number" },
        limit_price: { type: "number" },
        action: { type: "string", enum: ACTION_ENUM, default: "BUY_TO_OPEN" },
        confirm: { type: "string", description: "Pass 'CONFIRM' to place live" },
      },
      required: ["underlying", "expiration", "strike", "option_type", "quantity", "limit_price"],
    },
  },
  {
    name: "preview_spread",
    description:
      "DRY-RUN a multi-leg option spread (vertical, iron condor, calendar, etc.) as ONE net-priced order. Places nothing. net_price is positive; price_effect is DEBIT (you pay) or CREDIT (you collect). Each leg: {strike, option_type (C/P), action, quantity, expiration?}. Pass a top-level expiration for same-expiry spreads; legs may override it (e.g. calendars).",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string", description: "YYYY-MM-DD applied to any leg without its own expiration" },
        net_price: { type: "number", description: "Positive net price of the whole spread" },
        price_effect: { type: "string", enum: ["DEBIT", "CREDIT"] },
        legs: {
          type: "array",
          description: "2+ legs",
          items: {
            type: "object",
            properties: {
              expiration: { type: "string", description: "YYYY-MM-DD (optional if top-level expiration given)" },
              strike: { type: "number" },
              option_type: { type: "string", description: "C/CALL or P/PUT" },
              action: { type: "string", enum: ACTION_ENUM },
              quantity: { type: "number" },
            },
            required: ["strike", "option_type", "action", "quantity"],
          },
        },
      },
      required: ["underlying", "net_price", "price_effect", "legs"],
    },
  },
  {
    name: "place_spread",
    description:
      "Place a REAL multi-leg option spread as one net-priced order. Requires LIVE_TRADING_ENABLED=true, MCP_AUTH_TOKEN set, AND confirm='CONFIRM'. Otherwise returns a dry-run summary. Same args as preview_spread plus confirm.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string" },
        expiration: { type: "string" },
        net_price: { type: "number" },
        price_effect: { type: "string", enum: ["DEBIT", "CREDIT"] },
        legs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              expiration: { type: "string" },
              strike: { type: "number" },
              option_type: { type: "string" },
              action: { type: "string", enum: ACTION_ENUM },
              quantity: { type: "number" },
            },
            required: ["strike", "option_type", "action", "quantity"],
          },
        },
        confirm: { type: "string", description: "Pass 'CONFIRM' to place live" },
      },
      required: ["underlying", "net_price", "price_effect", "legs"],
    },
  },
  {
    name: "list_orders",
    description: "List currently working (live) orders on the account.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_order",
    description: "Cancel a working order by its order id.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "get_transaction_history",
    description:
      "Transaction/fill history (REST). Unlike list_orders (working orders only), this shows filled + closed trades: entry/exit fills with price, value, and fee-inclusive net-value. Filter by underlying, date range (YYYY-MM-DD), and action.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string", description: "Underlying symbol filter, e.g. AAPL" },
        start_date: { type: "string", description: "YYYY-MM-DD (inclusive)" },
        end_date: { type: "string", description: "YYYY-MM-DD (inclusive)" },
        action: { type: "string", description: "e.g. 'Sell to Open', 'Buy to Close'" },
        limit: { type: "number", description: "Max rows (default 100, max 250)", default: 100 },
      },
      required: [],
    },
  },
  {
    name: "get_realized_pnl",
    description:
      "Realized P&L for closed trades on an underlying. Matches opening and closing fills per contract/stock symbol and returns entry/exit price, quantity, realized_pnl (fee-inclusive), holding period, and return %. Only fully-closed symbols are reported.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: { type: "string", description: "Underlying symbol, e.g. AAPL" },
        opened_after: { type: "string", description: "Optional YYYY-MM-DD to bound history" },
      },
      required: ["underlying"],
    },
  },
  {
    name: "get_position_greeks",
    description:
      "Per-position greeks (delta/gamma/theta/vega) for all open option positions plus portfolio-level net greek totals (delta in share-equivalents, including stock). Uses DXLink live greeks.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "scan_watchlist_for_csp",
    description:
      "Screen a whole watchlist (or symbol list) for the best cash-secured-put entries. Pre-filters by IV rank, then for each name finds the put nearest target_delta in the DTE window and computes premium + ROR + annualized ROR. Returns a table ranked by annualized ROR — the wheel-entry screener.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Watchlist name (or pass symbols instead)" },
        symbols: { type: "array", items: { type: "string" }, description: "Explicit symbols (alternative to name)" },
        target_delta: { type: "number", description: "Put delta target (default -0.30)", default: -0.3 },
        dte_min: { type: "number", description: "Min days to expiration (default 21)", default: 21 },
        dte_max: { type: "number", description: "Max days to expiration (default 31)", default: 31 },
        min_iv_rank: { type: "number", description: "Only screen names with IV rank >= this (0-100, default 20)", default: 20 },
        max_symbols: { type: "number", description: "Cap names screened after IV-rank filter (default 20, max 25)", default: 20 },
        top: { type: "number", description: "Return top N by annualized ROR (default 15)", default: 15 },
      },
      required: [],
    },
  },
  {
    name: "get_bollinger",
    description:
      "Bollinger Bands (20, 2) for a symbol from daily candles: price, lower/mid/upper band, %B (0 = at lower band, 1 = at upper), and a zone label. Uses DXLink candle history.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "scan_watchlist_bb_csp",
    description:
      "Wheel screener combining technicals + premium: finds names in a watchlist sitting AT/NEAR the lower Bollinger Band (oversold), then for each returns the ~target_delta cash-secured put with premium + ROR. Ranked most-oversold first (lowest %B). Great for 'sell puts on the dip' entries.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Watchlist name (or pass symbols)" },
        symbols: { type: "array", items: { type: "string" } },
        max_pct_b: { type: "number", description: "Only include names with %B <= this (default 0.25 = near/below lower band)", default: 0.25 },
        target_delta: { type: "number", description: "Put delta target (default -0.30)", default: -0.3 },
        dte_min: { type: "number", default: 21 },
        dte_max: { type: "number", default: 31 },
        top: { type: "number", default: 15 },
      },
      required: [],
    },
  },
  {
    name: "update_watchlist",
    description:
      "Add and/or remove symbols in an existing private watchlist. Reads the current entries, merges the changes, and writes the full list back (the API replaces the whole list — this tool handles that safely and preserves each existing entry's instrument-type). New symbols are added as Equity.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact watchlist name" },
        symbols_to_add: { type: "array", items: { type: "string" }, description: "Tickers to add (Equity)" },
        symbols_to_remove: { type: "array", items: { type: "string" }, description: "Tickers to remove" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_watchlist",
    description: "Create a new private watchlist from a list of symbols (added as Equity).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        symbols: { type: "array", items: { type: "string" } },
      },
      required: ["name", "symbols"],
    },
  },
  {
    name: "get_analyst_targets",
    description:
      "Analyst consensus for a stock (via Yahoo, free): mean/high/low 12-month price target, implied upside %, recommendation, number of analysts, and the buy/hold/sell breakdown.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_seasonality",
    description:
      "Seasonality for a stock (via Yahoo, free): dividend-adjusted average monthly return + win-rate by calendar month, a strongest/weakest/next-month summary, and a year-by-year grid. lookback_years limits the window (default 20).",
    inputSchema: { type: "object", properties: { symbol: { type: "string" }, lookback_years: { type: "number", description: "Years of history to use (default 20)", default: 20 } }, required: ["symbol"] },
  },
  {
    name: "get_earnings_history",
    description:
      "Last 4 quarters of earnings (via Yahoo): EPS actual vs estimate and the beat/miss surprise %, plus revenue actual + YoY per quarter. Shows the earnings track record. (Per-quarter revenue *estimates* aren't available free, so revenue shows actual/growth, not beat-vs-estimate.)",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_stock_stats",
    description:
      "Snapshot stats for a stock: IV rank/percentile (cheap/rich), beta, % off 52-week high, 52w high/low, market cap, volume vs average, institutional & insider ownership %, and next earnings. Combines TastyTrade market-metrics + Yahoo.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_fundamentals",
    description:
      "Fundamental + value metrics for rule-based screening (via Yahoo financial statements + TT): 3Y revenue/EPS/FCF growth (CAGR), current ratio, trailing/forward P/E, P/FCF, profit margin, dividend yield, IV rank/percentile, beta, analyst upside. Returns a metric bundle you can evaluate pass/fail rules against.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_index_trends",
    description:
      "Market-sentiment index trends (free via Yahoo): VIX, S&P 500, QQQ, and the Nasdaq Composite — each with last price, day/1-week/1-month/3-month % change, and a 90-day close sparkline series.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_fear_greed",
    description:
      "CNN Fear & Greed Index (free): current 0-100 score + rating, values from previous close / 1 week / 1 month / 1 year ago, the 7 sub-indicators (momentum, strength, breadth, put/call, volatility, junk-bond & safe-haven demand), and a ~1-year historical series for a trend line.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_fed_watch",
    description:
      "Market-implied Fed rate expectations (free via Yahoo 30-Day Fed Funds futures / ZQ). Returns the implied current policy rate and, for the next ~6 FOMC meetings, the estimated probability of a rate CUT / HOLD / HIKE plus the implied rate. Estimate (marginal-implied method) — not the official CME FedWatch feed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_swing_structure",
    description:
      "Market-structure swing analysis (Indication -> Correction -> Continuation) on live daily + 1H bars (TastyTrade DXLink). Detects swing highs/lows and classifies the instrument into exactly one state (No Trade Zone / Indication / Correction / Continuation / Invalidated); computes entry/stop/target + R:R ONLY on Continuation. Adds session and volatility flags. Read-only analysis, never a trade instruction.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" }, swing_n: { type: "number", description: "Swing pivot lookback bars each side (default 3)." } }, required: ["symbol"] },
  },
  {
    name: "get_financials",
    description:
      "Multi-year financial statements for a stock (free via Yahoo fundamentals-timeseries): annual revenue, gross profit, operating income, net income, diluted EPS, and free cash flow for the last ~4 fiscal years, with year-over-year growth. Powers the Financials section of the stock analyzer.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_gamma_exposure",
    description:
      "Dealer gamma exposure (GEX) for a ticker (free via Yahoo option open-interest + Black-Scholes gamma). Returns net dealer gamma per strike (scaled to a 1% move), total Net GEX, the gamma-flip level, the call wall (largest positive-gamma strike above spot) and put wall (largest negative-gamma strike below spot), across the next few monthly expirations. Dealers assumed long calls / short puts.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" }, expirations: { type: "number", description: "How many monthly expirations to include (default 3)." } }, required: ["symbol"] },
  },
  {
    name: "expected_move",
    description:
      "Options-implied expected move for a stock (from TastyTrade ATM straddle): the ~1 standard-deviation up/down range by an expiration. Pass expiration (YYYY-MM-DD) or it uses the nearest.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, expiration: { type: "string", description: "YYYY-MM-DD (optional)" } },
      required: ["symbol"],
    },
  },
  {
    name: "leaps_finder",
    description:
      "Score a watchlist for LEAPS long-call candidates. Gates: price at/near the bottom of the Bollinger band (%B <= max_pct_b) AND beta >= min_beta. Survivors are scored on BB position, revenue/EPS growth, analyst upside, CHEAP options (low IV percentile) and healthy RSI, and each gets the ~target_delta call >365 DTE with cost, breakeven and leverage. Ranked by composite score (higher = better). Pass a watchlist name or symbols.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Watchlist name (or pass symbols)" },
        symbols: { type: "array", items: { type: "string" } },
        target_delta: { type: "number", description: "Call delta target (default 0.70)", default: 0.7 },
        max_pct_b: { type: "number", description: "Max Bollinger %B gate (default 0.35)", default: 0.35 },
        min_beta: { type: "number", description: "Min beta gate (default 2)", default: 2 },
        top: { type: "number", default: 15 },
      },
      required: [],
    },
  },
  {
    name: "price_calculator",
    description:
      "Given a desired return, back-solve the entry price for a stock using the analyst target (or forward-earnings fair value): entry = anchor / (1 + return). Returns the entry price and how far below current it is.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        target_return_pct: { type: "number", description: "Desired return % (default 20)", default: 20 },
      },
      required: ["symbol"],
    },
  },
  {
    name: "options_sentiment",
    description:
      "Options sentiment for a stock from IV skew: ATM IV, 25-delta put IV vs 25-delta call IV, and the skew in IV points (positive = downside fear / put-skewed). Uses TastyTrade greeks on a ~30 DTE expiration.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "instant_analyzer",
    description:
      "Rule-based pass/fail screen for a symbol. Pass rules as [{metric, op, value}] where op is >,>=,<,<=,==. Available metrics: iv_rank, pct_b, analyst_upside_pct, forward_pe, beta, price. Returns each metric's value, per-rule pass/fail, and overall pass.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: { metric: { type: "string" }, op: { type: "string" }, value: { type: "number" } },
            required: ["metric", "op", "value"],
          },
        },
      },
      required: ["symbol", "rules"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tastytrade auth + fetch helpers
// ---------------------------------------------------------------------------

// Cached per-isolate; refreshes on cold start or expiry.
let tokenCache = { token: null, exp: 0 };
let cachedAccount = null;

async function getAccessToken(env) {
  const now = Date.now() / 1000;
  if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;
  const res = await fetch(`${API_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Version": API_VERSION,
      "User-Agent": ORDER_SOURCE, // Tastytrade WAF returns nginx 401 without a User-Agent
    },
    body: JSON.stringify({
      "grant_type": "refresh_token",
      "client_secret": env.TASTY_CLIENT_SECRET,
      "refresh_token": env.TASTY_REFRESH_TOKEN,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth token refresh failed ${res.status}: ${text}`);
  const data = JSON.parse(text);
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 900) };
  return tokenCache.token;
}

async function ttFetch(env, method, path, body) {
  const token = await getAccessToken(env);
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Version": API_VERSION,
      "User-Agent": ORDER_SOURCE,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tastytrade ${res.status} on ${method} ${path}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getAccountNumber(env) {
  if (cachedAccount) return cachedAccount;
  const data = await ttFetch(env, "GET", "/customers/me/accounts");
  const items = data?.data?.items || [];
  if (!items.length) throw new Error("No accounts found for this login.");
  cachedAccount = items[0].account["account-number"];
  return cachedAccount;
}

// ---------------------------------------------------------------------------
// Order helpers
// ---------------------------------------------------------------------------

const ACTION_STR = {
  BUY_TO_OPEN: "Buy to Open",
  SELL_TO_OPEN: "Sell to Open",
  BUY_TO_CLOSE: "Buy to Close",
  SELL_TO_CLOSE: "Sell to Close",
};

function normAction(action) {
  const k = String(action || "BUY_TO_OPEN").toUpperCase();
  if (!ACTION_STR[k]) throw new Error(`Unknown action '${action}'. Use one of ${ACTION_ENUM.join(", ")}.`);
  return k;
}

function priceEffect(actionKey) {
  return actionKey.startsWith("BUY") ? "Debit" : "Credit";
}

function buildOrder(leg, actionKey, limitPrice, tif = "Day") {
  return {
    "time-in-force": tif,
    "source": ORDER_SOURCE,
    "order-type": "Limit",
    "legs": [leg],
    "price": String(Math.abs(Number(limitPrice))),
    "price-effect": priceEffect(actionKey),
  };
}

function equityLeg(symbol, quantity, actionKey) {
  return {
    "instrument-type": "Equity",
    symbol: String(symbol).toUpperCase(),
    action: ACTION_STR[actionKey],
    quantity: String(quantity),
  };
}

function optionLeg(occSymbol, quantity, actionKey) {
  return {
    "instrument-type": "Equity Option",
    symbol: occSymbol,
    action: ACTION_STR[actionKey],
    quantity: String(quantity),
  };
}

async function optionOccSymbol(env, underlying, expiration, strike, optionType) {
  const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(underlying)}/nested`);
  const chain = data?.data?.items || [];
  const exp = (chain[0]?.expirations || []).find((e) => e["expiration-date"] === expiration);
  if (!exp) {
    const avail = (chain[0]?.expirations || []).map((e) => e["expiration-date"]).slice(0, 8);
    throw new Error(`No expiration ${expiration} for ${underlying}. Available (first 8): ${avail.join(", ")}`);
  }
  const s = exp.strikes.find((x) => parseFloat(x["strike-price"]) === parseFloat(strike));
  if (!s) throw new Error(`No strike ${strike} for ${underlying} ${expiration}.`);
  const isCall = String(optionType).toUpperCase().startsWith("C");
  const sym = isCall ? s.call : s.put;
  if (!sym) throw new Error(`No ${optionType} contract at strike ${strike}.`);
  return sym;
}

function buildSpreadOrder(legs, netPrice, priceEffect, tif = "Day") {
  const eff = String(priceEffect).toUpperCase();
  if (eff !== "DEBIT" && eff !== "CREDIT") throw new Error("price_effect must be DEBIT or CREDIT.");
  return {
    "time-in-force": tif,
    "source": ORDER_SOURCE,
    "order-type": "Limit",
    "legs": legs,
    "price": String(Math.abs(Number(netPrice))),
    "price-effect": eff === "DEBIT" ? "Debit" : "Credit",
  };
}

// Resolve all spread legs against a single nested-chain fetch. Each input leg:
// {strike, option_type, action, quantity, expiration?}. defaultExp fills legs
// that omit their own expiration (same-expiry spreads).
async function resolveSpreadLegs(env, underlying, legs, defaultExp) {
  if (!Array.isArray(legs) || legs.length < 2) throw new Error("A spread needs at least 2 legs.");
  const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(underlying)}/nested`);
  const chain = (data?.data?.items || [])[0];
  if (!chain) throw new Error(`No option chain for ${underlying}.`);
  const byExp = new Map();
  for (const e of chain.expirations || []) byExp.set(e["expiration-date"], e);

  return legs.map((leg) => {
    const exp = leg.expiration || defaultExp;
    if (!exp) throw new Error("Each leg needs an expiration (or pass a top-level expiration).");
    const e = byExp.get(exp);
    if (!e) throw new Error(`No expiration ${exp} for ${underlying}. Available: ${[...byExp.keys()].slice(0, 8).join(", ")}`);
    const strike = e.strikes.find((x) => parseFloat(x["strike-price"]) === parseFloat(leg.strike));
    if (!strike) throw new Error(`No strike ${leg.strike} for ${underlying} ${exp}.`);
    const isCall = String(leg.option_type).toUpperCase().startsWith("C");
    const sym = isCall ? strike.call : strike.put;
    if (!sym) throw new Error(`No ${leg.option_type} at strike ${leg.strike} for ${exp}.`);
    return optionLeg(sym, leg.quantity, normAction(leg.action));
  });
}

function dryRunSummary(data) {
  const bpe = data["buying-power-effect"] || {};
  const warnings = (data.warnings || []).map((w) => (w && w.message ? w.message : String(w)));
  return {
    buying_power_change: bpe["change-in-buying-power"] ?? null,
    buying_power_effect: bpe["change-in-buying-power-effect"] ?? null,
    warnings,
  };
}

function liveEnabled(env) {
  return String(env.LIVE_TRADING_ENABLED || "false").toLowerCase() === "true";
}

async function safePlace(env, order, confirm) {
  const acct = await getAccountNumber(env);
  const dry = (await ttFetch(env, "POST", `/accounts/${acct}/orders/dry-run`, order)).data;
  const summary = dryRunSummary(dry);

  if (!liveEnabled(env)) {
    return { status: "DRY_RUN_ONLY", note: "LIVE_TRADING_ENABLED is false. Nothing was placed.", ...summary };
  }
  if (!env.MCP_AUTH_TOKEN) {
    return {
      status: "BLOCKED",
      note: "Live trading requires MCP_AUTH_TOKEN to be set (endpoint auth). Refusing to place on an unauthenticated server.",
      ...summary,
    };
  }
  if (confirm !== "CONFIRM") {
    return { status: "NEEDS_CONFIRMATION", note: "Re-call with confirm='CONFIRM' to place this live order.", ...summary };
  }
  const placed = (await ttFetch(env, "POST", `/accounts/${acct}/orders`, order)).data;
  return { status: "PLACED", order_id: placed.order ? placed.order.id : null, ...summary };
}

// ---------------------------------------------------------------------------
// DXLink streaming (live greeks + quotes)
// ---------------------------------------------------------------------------

const DXLINK_VERSION = "0.1-DXF-JS/0.3.0";
let quoteTokenCache = { url: null, token: null, exp: 0 };

async function getQuoteToken(env) {
  const now = Date.now() / 1000;
  if (quoteTokenCache.token && now < quoteTokenCache.exp - 30) return quoteTokenCache;
  const d = (await ttFetch(env, "GET", "/api-quote-tokens")).data;
  quoteTokenCache = { url: d["dxlink-url"], token: d["token"], exp: now + 300 };
  return quoteTokenCache;
}

function num(v) {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Open DXLink, subscribe Quote+Greeks for the given streamer symbols, collect
// until every symbol has what we need (or timeout), then close. Per-request
// lifecycle — no persistent connection (Workers are stateless).
async function dxlinkCollect(env, symbols, { greeks = true, quote = true, timeoutMs = 8000 } = {}) {
  if (!symbols.length) return {};
  const { url, token } = await getQuoteToken(env);
  // Cloudflare outbound WebSocket wants an http(s) scheme + Upgrade header, not ws(s)://.
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const upgraded = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = upgraded.webSocket;
  if (!ws) throw new Error(`DXLink websocket upgrade failed (status ${upgraded.status}).`);
  ws.accept();
  const CH = 1;
  const results = {};
  const send = (o) => ws.send(JSON.stringify(o));

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const finish = () => { clearTimeout(timer); resolve(); };
    const haveAll = () =>
      symbols.every((s) => {
        const r = results[s];
        return r && (!quote || r.bid !== undefined) && (!greeks || r.delta !== undefined);
      });
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "AUTH_STATE") {
        if (m.state === "UNAUTHORIZED") send({ type: "AUTH", channel: 0, token });
        else if (m.state === "AUTHORIZED")
          send({ type: "CHANNEL_REQUEST", channel: CH, service: "FEED", parameters: { contract: "AUTO" } });
      } else if (m.type === "CHANNEL_OPENED" && m.channel === CH) {
        send({
          type: "FEED_SETUP",
          channel: CH,
          acceptAggregationPeriod: 0.1,
          acceptDataFormat: "FULL",
          acceptEventFields: {
            Quote: ["eventType", "eventSymbol", "bidPrice", "askPrice"],
            Greeks: ["eventType", "eventSymbol", "price", "volatility", "delta", "gamma", "theta", "vega"],
          },
        });
        const add = [];
        for (const s of symbols) {
          if (quote) add.push({ symbol: s, type: "Quote" });
          if (greeks) add.push({ symbol: s, type: "Greeks" });
        }
        // chunk so a big watchlist scan doesn't exceed the max frame size (1009)
        for (let i = 0; i < add.length; i += 200) send({ type: "FEED_SUBSCRIPTION", channel: CH, add: add.slice(i, i + 200) });
      } else if (m.type === "FEED_DATA" && m.channel === CH) {
        for (const e of m.data || []) {
          const sym = e.eventSymbol;
          if (!sym) continue;
          const r = results[sym] || (results[sym] = { symbol: sym });
          if (e.bidPrice !== undefined || e.askPrice !== undefined) {
            r.bid = num(e.bidPrice);
            r.ask = num(e.askPrice);
          }
          if (e.delta !== undefined) {
            r.delta = num(e.delta);
            r.gamma = num(e.gamma);
            r.theta = num(e.theta);
            r.vega = num(e.vega);
            r.iv = num(e.volatility);
          }
        }
        if (haveAll()) finish();
      } else if (m.type === "ERROR") {
        finish();
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
    // kick off the handshake
    send({ type: "SETUP", channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: DXLINK_VERSION });
  });

  try { ws.close(); } catch (e) { /* ignore */ }
  return results;
}

async function chainSlice(env, underlying, expiration) {
  const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(underlying)}/nested`);
  const chain = (data?.data?.items || [])[0];
  if (!chain) throw new Error(`No option chain for ${underlying}.`);
  const exp = (chain.expirations || []).find((e) => e["expiration-date"] === expiration);
  if (!exp) {
    const avail = (chain.expirations || []).map((e) => e["expiration-date"]).slice(0, 8);
    throw new Error(`No expiration ${expiration} for ${underlying}. Available (first 8): ${avail.join(", ")}`);
  }
  return exp;
}

function mid(bid, ask) {
  if (bid != null && ask != null) return Math.round(((bid + ask) / 2) * 100) / 100;
  return bid ?? ask ?? null;
}

// Collect daily candles (OHLC) for tickers via DXLink Candle events. Per-request
// open/collect/close, like dxlinkCollect. Returns { ticker: [{time, close}, ...] }.
async function dxlinkCandles(env, tickers, { days = 55, minCandles = 22, timeoutMs = 13000, period = "1d", tho = true } = {}) {
  if (!tickers.length) return {};
  const { url, token } = await getQuoteToken(env);
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const upgraded = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = upgraded.webSocket;
  if (!ws) throw new Error(`DXLink websocket upgrade failed (status ${upgraded.status}).`);
  ws.accept();
  const CH = 1;
  const fromTime = Date.now() - days * 86400000;
  const results = {};
  const send = (o) => ws.send(JSON.stringify(o));
  const suffix = tho ? `{=${period},tho=true}` : `{=${period}}`;

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const finish = () => { clearTimeout(timer); resolve(); };
    const haveAll = () => tickers.every((t) => (results[t] || []).length >= minCandles);
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "AUTH_STATE") {
        if (m.state === "UNAUTHORIZED") send({ type: "AUTH", channel: 0, token });
        else if (m.state === "AUTHORIZED") send({ type: "CHANNEL_REQUEST", channel: CH, service: "FEED", parameters: { contract: "AUTO" } });
      } else if (m.type === "CHANNEL_OPENED" && m.channel === CH) {
        send({
          type: "FEED_SETUP", channel: CH, acceptAggregationPeriod: 0.1, acceptDataFormat: "FULL",
          acceptEventFields: { Candle: ["eventType", "eventSymbol", "time", "open", "high", "low", "close"] },
        });
        const add = tickers.map((t) => ({ symbol: `${t}${suffix}`, type: "Candle", fromTime }));
        for (let i = 0; i < add.length; i += 100) send({ type: "FEED_SUBSCRIPTION", channel: CH, add: add.slice(i, i + 100) });
      } else if (m.type === "FEED_DATA" && m.channel === CH) {
        for (const e of m.data || []) {
          const es = e.eventSymbol;
          if (!es || e.close == null) continue;
          const t = es.split("{")[0];
          (results[t] || (results[t] = [])).push({ time: e.time, open: num(e.open), high: num(e.high), low: num(e.low), close: num(e.close) });
        }
        if (haveAll()) finish();
      } else if (m.type === "ERROR") {
        finish();
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
    send({ type: "SETUP", channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: DXLINK_VERSION });
  });

  try { ws.close(); } catch (e) { /* ignore */ }
  return results;
}

// Bollinger Bands (20, 2) from candle rows. Returns price/lower/mid/upper/pct_b.
function bollinger(rows) {
  const closes = (rows || []).slice().sort((a, b) => a.time - b.time).map((r) => r.close).filter((c) => c != null);
  if (closes.length < 20) return null;
  const win = closes.slice(-20);
  const mean = win.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(win.reduce((a, c) => a + (c - mean) ** 2, 0) / 20);
  const upper = mean + 2 * sd;
  const lower = mean - 2 * sd;
  const price = closes[closes.length - 1];
  const pctB = upper !== lower ? (price - lower) / (upper - lower) : null;
  return {
    price: Math.round(price * 100) / 100,
    lower: Math.round(lower * 100) / 100,
    mid: Math.round(mean * 100) / 100,
    upper: Math.round(upper * 100) / 100,
    pct_b: pctB != null ? Math.round(pctB * 1000) / 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// Indication -> Correction -> Continuation market-structure engine.
// Terminology per docs/swing-structure.md: swing high/low, No Trade Zone,
// Indication, Correction, Continuation, Reaction, Invalidated. Structure on
// 1H/4H only. Read-only analysis — never an order/auto-trade. Unit-tested
// against fixtures in worker/test (bullish, bearish mirror, invalidation, R:R).
// ---------------------------------------------------------------------------

// Confirmed fractal swing pivots: bar i is a swing high if its high is strictly
// greater than N bars on both sides (inverted for lows). Confirmed N bars later.
function detectPivots(bars, N) {
  const piv = [];
  for (let i = N; i < bars.length - N; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= N; k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h > bars[i + k].h)) isHigh = false;
      if (!(bars[i].l < bars[i - k].l && bars[i].l < bars[i + k].l)) isLow = false;
    }
    if (isHigh) piv.push({ idx: i, price: bars[i].h, type: "high" });
    if (isLow) piv.push({ idx: i, price: bars[i].l, type: "low" });
  }
  return piv;
}

function iccAtr(bars, period) {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    sum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  return sum / period;
}

// Aggregate N consecutive OHLC bars into coarser bars (e.g. 1H -> 4H context).
function aggregateBars(bars, factor) {
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const grp = bars.slice(i, i + factor);
    if (!grp.length) break;
    out.push({ t: grp[0].t, o: grp[0].o, h: Math.max(...grp.map((b) => b.h)), l: Math.min(...grp.map((b) => b.l)), c: grp[grp.length - 1].c });
  }
  return out;
}

function iccAnalyze(bars, opts = {}) {
  const N = opts.n || 2;
  const rnd = (x) => (x == null ? null : Math.round(x * 100) / 100);
  if (!bars || bars.length < 2 * N + 4) return { state: "UNCLEAR", reason: "not enough bars for structure" };
  const piv = detectPivots(bars, N);
  const highs = piv.filter((p) => p.type === "high"), lows = piv.filter((p) => p.type === "low");
  if (!highs.length || !lows.length) return { state: "UNCLEAR", reason: "no clean swing structure", swings: piv };

  let state = "NO_TRADE_ZONE", dir = null, brokenLevel = null, oppLevel = null, peak = null, contLevel = null, corrExt = null, refHigh = null, refLow = null, resets = 0;
  for (let j = 0; j < bars.length; j++) {
    const kH = highs.filter((p) => p.idx <= j - N), kL = lows.filter((p) => p.idx <= j - N);
    refHigh = kH.length ? kH[kH.length - 1] : null;
    refLow = kL.length ? kL[kL.length - 1] : null;
    const c = bars[j].c, h = bars[j].h, l = bars[j].l;
    // Terminal states resolve into a fresh No Trade Zone; re-scan THIS bar for a new break.
    if (state === "CONTINUATION" || state === "INVALIDATED") { state = "NO_TRADE_ZONE"; resets++; }
    if (state === "NO_TRADE_ZONE") {
      if (refHigh && refLow && refHigh.price > refLow.price) {
        if (c > refHigh.price) { state = "INDICATION"; dir = "bullish"; brokenLevel = refHigh.price; oppLevel = refLow.price; peak = h; corrExt = null; contLevel = null; }
        else if (c < refLow.price) { state = "INDICATION"; dir = "bearish"; brokenLevel = refLow.price; oppLevel = refHigh.price; peak = l; corrExt = null; contLevel = null; }
      }
      continue;
    }
    const bull = dir === "bullish";
    // Invalidation applies only to an ACTIVE sequence (indication/correction).
    if ((bull && c < oppLevel) || (!bull && c > oppLevel)) { state = "INVALIDATED"; continue; }
    if (state === "INDICATION") {
      if (bull) { if (h > peak) peak = h; if (l <= brokenLevel) { state = "CORRECTION"; corrExt = l; contLevel = peak; } }
      else { if (l < peak) peak = l; if (h >= brokenLevel) { state = "CORRECTION"; corrExt = h; contLevel = peak; } }
    } else if (state === "CORRECTION") {
      if (bull) { if (l < corrExt) corrExt = l; if (c > contLevel) state = "CONTINUATION"; }
      else { if (h > corrExt) corrExt = h; if (c < contLevel) state = "CONTINUATION"; }
    }
  }

  const out = {
    state, direction: dir,
    reference: { swing_high: refHigh ? rnd(refHigh.price) : null, swing_low: refLow ? rnd(refLow.price) : null },
    broken_level: rnd(brokenLevel), opposite_level: rnd(oppLevel), correction_extreme: rnd(corrExt), continuation_level: rnd(contLevel),
    swings: piv, resets,
  };
  if (state === "CONTINUATION") {
    const bull = dir === "bullish", entry = contLevel, stop = corrExt;
    let target = null, targetSrc = null;
    if (bull) {
      const above = highs.map((p) => p.price).filter((p) => p > entry).sort((a, b) => a - b);
      if (above.length) { target = above[0]; targetSrc = "1H swing high"; }
      else if (opts.higherSwings) { const h4 = opts.higherSwings.filter((p) => p.type === "high" && p.price > entry).map((p) => p.price).sort((a, b) => a - b); if (h4.length) { target = h4[0]; targetSrc = "4H swing high"; } }
    } else {
      const below = lows.map((p) => p.price).filter((p) => p < entry).sort((a, b) => b - a);
      if (below.length) { target = below[0]; targetSrc = "1H swing low"; }
      else if (opts.higherSwings) { const l4 = opts.higherSwings.filter((p) => p.type === "low" && p.price < entry).map((p) => p.price).sort((a, b) => b - a); if (l4.length) { target = l4[0]; targetSrc = "4H swing low"; } }
    }
    const risk = Math.abs(entry - stop), reward = target != null ? Math.abs(target - entry) : null;
    const rr = reward != null && risk > 0 ? Math.round((reward / risk) * 10) / 10 : null;
    out.trade = { direction: dir, entry: rnd(entry), stop: rnd(stop), target: target != null ? rnd(target) : null, target_source: targetSrc, risk: rnd(risk), reward: reward != null ? rnd(reward) : null, rr, rr_below_target: rr != null ? rr < 3 : null };
  }
  out.plan = iccPlan(highs, lows, opts.higherSwings, bars[bars.length - 1].c, iccAtr(bars, 14));
  out.narration = iccNarrate(out);
  return out;
}

// Two-sided game plan from the current structure: where a LONG triggers (break of
// the swing high, stop below the swing low) and where a SHORT triggers (break of the
// swing low, stop above the swing high) — each with a target (next opposing swing,
// then 4H, then a measured move). Both sides are marked so you know your buys and shorts.
function iccPlan(highs, lows, higherSwings, cur, atr) {
  const hi = highs.map((p) => p.price), lo = lows.map((p) => p.price);
  if (!hi.length || !lo.length || cur == null) return null;
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const rr = (rew, risk) => (risk > 0 && rew > 0 ? Math.round((rew / risk) * 10) / 10 : null);
  const h4 = higherSwings || [];
  // Levels relative to CURRENT price (avoids stale swings lagging price in a trend).
  const res = hi.filter((p) => p > cur).sort((a, b) => a - b)[0];                  // nearest resistance above price
  const sup = lo.filter((p) => p < cur).sort((a, b) => b - a)[0];                  // nearest support below price
  const maxH = Math.max(...hi);
  const res4 = h4.filter((p) => p.type === "high" && p.price > cur).map((p) => p.price).sort((a, b) => a - b)[0];
  const sup4 = h4.filter((p) => p.type === "low" && p.price < cur).map((p) => p.price).sort((a, b) => b - a)[0];
  // A target must be a MEANINGFUL distance away (≥ 1 ATR or 0.3%) — skip trivially-close pivots.
  const minGap = Math.max(atr || 0, cur * 0.003);
  // LONG: continuation above nearest resistance (stop below support); target = next swing high a
  // meaningful distance BEYOND the entry. At new highs there's no fixed trigger — buy pullbacks.
  const lEntry = res ?? null, lStop = sup ?? sup4 ?? null, lRef = lEntry != null ? lEntry : cur;
  const lTarget = (hi.filter((p) => p > lRef + minGap).sort((a, b) => a - b)[0]) ?? (h4.filter((p) => p.type === "high" && p.price > lRef + minGap).map((p) => p.price).sort((a, b) => a - b)[0]) ?? null;
  const long = { entry: r2(lEntry), stop: r2(lStop), target: r2(lTarget), note: res == null ? "at new highs — buy pullbacks holding support" : "continuation above " + r2(res), rr: lEntry != null && lTarget != null && lStop != null ? rr(lTarget - lEntry, lEntry - lStop) : null };
  // SHORT: continuation below nearest support (stop above resistance); target = next swing low beyond entry.
  const sEntry = sup ?? null, sStop = res ?? res4 ?? maxH, sRef = sEntry != null ? sEntry : cur;
  const sTarget = (lo.filter((p) => p < sRef - minGap).sort((a, b) => b - a)[0]) ?? (h4.filter((p) => p.type === "low" && p.price < sRef - minGap).map((p) => p.price).sort((a, b) => b - a)[0]) ?? null;
  const short = { entry: r2(sEntry), stop: r2(sStop), target: r2(sTarget), note: sup == null ? "at new lows — sell rallies below resistance" : "continuation below " + r2(sup), rr: sEntry != null && sTarget != null && sStop != null ? rr(sEntry - sTarget, sStop - sEntry) : null };
  // Tight-range guard: a support/resistance band narrower than one ATR is likely noise (inflated R:R).
  const bandRange = res != null && sup != null ? res - sup : null;
  return { support: r2(sup), resistance: r2(res), range: r2(bandRange), range_tight: bandRange != null && atr ? bandRange < atr : false, long, short };
}

// Multi-timeframe entry: the DAILY defines the setup (bias + levels); the 1H times the entry.
// An entry is only "armed" when the 1H prints a Continuation in the SAME direction as the daily
// bias — then the entry/stop come from the tight 1H sequence and the target from the daily level.
function iccEntry(daily, hourly, dailyPlan) {
  const active = daily.state === "INDICATION" || daily.state === "CORRECTION" || daily.state === "CONTINUATION";
  const bias = active ? daily.direction : null;
  if (!bias) return { status: "no_setup", armed: false, direction: null, narration: "Daily is in a No Trade Zone (no indication yet) — stand aside until the daily breaks structure." };
  const word = bias === "bullish" ? "long" : "short";
  const hs = hourly.state, hd = hourly.direction;
  if (hs === "CONTINUATION" && hd === bias) {
    const t = hourly.trade || {};
    const target = bias === "bullish" ? (dailyPlan && dailyPlan.long ? dailyPlan.long.target : null) : (dailyPlan && dailyPlan.short ? dailyPlan.short.target : null);
    const entry = t.entry ?? null, stop = t.stop ?? null;
    const risk = entry != null && stop != null ? Math.abs(entry - stop) : null;
    const reward = target != null && entry != null ? Math.abs(target - entry) : null;
    const rr = risk && reward ? Math.round((reward / risk) * 10) / 10 : null;
    return { status: "armed", armed: true, direction: bias, entry, stop, target, rr, rr_below_target: rr != null ? rr < 3 : null,
      narration: `ARMED — daily ${bias} structure + a 1H continuation. Timed ${word} entry ~${entry}, stop ${stop} (1H reaction), target ${target != null ? target : "the daily level"} (daily).${rr != null ? " R:R 1:" + rr + (rr < 3 ? " — below the 1:3 baseline, likely pass." : ".") : ""}` };
  }
  if ((hs === "INDICATION" || hs === "CORRECTION") && hd === bias) {
    return { status: "forming", armed: false, direction: bias, narration: `Daily ${bias} setup in play; the 1H is ${hs.toLowerCase()} in the same direction — waiting for the 1H continuation to time the ${word} entry. No entry yet.` };
  }
  return { status: "wait", armed: false, direction: bias, narration: `Daily ${bias} setup, but the 1H isn't aligned yet (1H ${hs ? hs.toLowerCase() : "unclear"}${hd ? " " + hd : ""}). Wait for a 1H ${bias} continuation near the daily level.` };
}

// US/Eastern session state — the analysis is built around the New York session.
// DST-correct via Intl; weekend-aware.
function etSession() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (k) => { const p = parts.find((x) => x.type === k); return p ? p.value : ""; };
  const wd = g("weekday"); let hr = parseInt(g("hour"), 10); const mn = parseInt(g("minute"), 10);
  if (hr === 24) hr = 0;
  const t = hr + mn / 60, weekend = wd === "Sat" || wd === "Sun";
  let label, open = false;
  if (weekend) label = "Weekend — US market closed";
  else if (t >= 9.5 && t < 16) { label = "US regular hours (open)"; open = true; }
  else if (t >= 4 && t < 9.5) label = "US pre-market";
  else if (t >= 16 && t < 20) label = "US after-hours";
  else label = "Overnight — US market closed";
  return { label, open, et_time: String(hr).padStart(2, "0") + ":" + String(mn).padStart(2, "0") + " ET", weekend };
}

function iccNarrate(o) {
  const d = o.direction, lvl = o.broken_level, opp = o.opposite_level;
  switch (o.state) {
    case "NO_TRADE_ZONE": return `No Trade Zone — price sits between the last swing low (${o.reference.swing_low}) and swing high (${o.reference.swing_high}), neither broken. Do nothing; wait for an Indication.`;
    case "INDICATION": return `Indication confirmed (${d} break of ${lvl}). Information only — a breakout gets faded. Correction not yet in — no entry yet.`;
    case "CORRECTION": return `Correction in progress — after the ${d} indication (broke ${lvl}), price is pulling back toward the broken level (the liquidity grab). Waiting for the Continuation; still no entry. Invalidates on a close beyond ${opp}.`;
    case "CONTINUATION": return `Continuation confirmed (${d}) — price resumed past the correction's reaction level. Entry / stop / target below.`;
    case "INVALIDATED": return `Invalidated — price closed back beyond the old level (${opp}) during the correction. Failed setup / possible reversal, NOT a new continuation. Stand aside unless a fresh opposite structure break confirms.`;
    default: return o.reason || "Structure unclear — no clean swings; stand aside.";
  }
}

// OCC option symbol -> dxfeed streamer symbol.
// "AAPL  260724C00320000" -> ".AAPL260724C320"  (strike = int/1000, trailing zeros dropped)
function occToStreamer(occ) {
  const root = occ.slice(0, 6).trim();
  const rest = occ.slice(6);
  const date = rest.slice(0, 6);
  const cp = rest[6];
  const strike = parseInt(rest.slice(7), 10) / 1000;
  return `.${root}${date}${cp}${strike}`;
}

// ---------------------------------------------------------------------------
// Transactions helpers
// ---------------------------------------------------------------------------

async function fetchTransactions(env, { underlying, start, end, action, perPage = 250 } = {}) {
  const acct = await getAccountNumber(env);
  const qs = new URLSearchParams();
  qs.set("sort", "Desc");
  qs.set("per-page", String(Math.min(perPage, 250)));
  if (underlying) qs.set("underlying-symbol", String(underlying).toUpperCase());
  if (start) qs.set("start-date", start);
  if (end) qs.set("end-date", end);
  if (action) qs.set("action", action);
  const data = await ttFetch(env, "GET", `/accounts/${acct}/transactions?${qs.toString()}`);
  return { items: data?.data?.items || [], pagination: data?.pagination || {} };
}

function cleanTx(t) {
  return {
    executed_at: t["executed-at"],
    action: t.action,
    symbol: t.symbol,
    underlying: t["underlying-symbol"],
    type: t["instrument-type"],
    quantity: t.quantity,
    price: t.price,
    value: t.value,
    value_effect: t["value-effect"],
    net_value: t["net-value"],
    net_value_effect: t["net-value-effect"],
    order_id: t["order-id"],
    transaction_type: t["transaction-type"],
    sub_type: t["transaction-sub-type"],
  };
}

// signed cash impact of a transaction: Credit = +, Debit = - (fee-inclusive net)
function signedNet(t) {
  const v = num(t["net-value"]);
  if (v == null) return 0;
  return t["net-value-effect"] === "Credit" ? v : -v;
}

// Realized P&L: group Trade transactions by contract/stock symbol, sum the
// fee-inclusive signed net cash of opens and closes, and report only symbols
// that are fully closed (closing qty >= opening qty). Pure — unit-tested.
function matchRealizedPnl(items) {
  const trades = items.filter((t) => t["transaction-type"] === "Trade");
  const groups = {};
  for (const t of trades) {
    (groups[t.symbol] || (groups[t.symbol] = [])).push(t);
  }
  const closed = [];
  let totalRealized = 0;
  for (const sym in groups) {
    let openQty = 0, closeQty = 0, openCash = 0, closeCash = 0, openPxQty = 0, closePxQty = 0;
    let firstOpen = null, lastClose = null, underlying = null, type = null;
    for (const t of groups[sym]) {
      const qty = num(t.quantity) || 0;
      underlying = t["underlying-symbol"];
      type = t["instrument-type"];
      if (/Open/.test(t.action)) {
        openQty += qty; openCash += signedNet(t); openPxQty += (num(t.price) || 0) * qty;
        if (!firstOpen || t["executed-at"] < firstOpen) firstOpen = t["executed-at"];
      } else if (/Close/.test(t.action)) {
        closeQty += qty; closeCash += signedNet(t); closePxQty += (num(t.price) || 0) * qty;
        if (!lastClose || t["executed-at"] > lastClose) lastClose = t["executed-at"];
      }
    }
    if (openQty > 0 && closeQty >= openQty) {
      const realized = Math.round((openCash + closeCash) * 100) / 100;
      totalRealized += realized;
      const days = Math.round(((Date.parse(lastClose) - Date.parse(firstOpen)) / 86400000) * 10) / 10;
      closed.push({
        symbol: sym,
        underlying,
        type,
        quantity: openQty,
        entry_price: Math.round((openPxQty / openQty) * 100) / 100,
        exit_price: Math.round((closePxQty / closeQty) * 100) / 100,
        opened_at: firstOpen,
        closed_at: lastClose,
        holding_period_days: days,
        realized_pnl: realized,
        ror_pct: (() => {
          const mult = type === "Equity Option" ? 100 : 1;
          const basis = openPxQty * mult; // entry_price * quantity * multiplier
          return basis > 0 ? Math.round((realized / basis) * 10000) / 100 : null;
        })(),
      });
    }
  }
  closed.sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1));
  return { closed, totalRealized: Math.round(totalRealized * 100) / 100 };
}

function rsiOf(closes, p) {
  p = p || 14;
  if (closes.length < p + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= p; al /= p;
  for (let i = p + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; }
  return al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
}
function macdHistOf(closes) {
  if (closes.length < 26) return null;
  const macd = [];
  let e12 = closes[0], e26 = closes[0];
  for (let i = 1; i < closes.length; i++) { e12 = closes[i] * (2 / 13) + e12 * (11 / 13); e26 = closes[i] * (2 / 27) + e26 * (25 / 27); macd.push(e12 - e26); }
  let sig = macd[0];
  for (let i = 1; i < macd.length; i++) sig = macd[i] * (2 / 10) + sig * (8 / 10);
  return Math.round((macd[macd.length - 1] - sig) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Scanner helpers
// ---------------------------------------------------------------------------

async function fetchMetrics(env, symbols) {
  const out = [];
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const q = encodeURIComponent(batch.join(","));
    const data = await ttFetch(env, "GET", `/market-metrics?symbols=${q}`);
    out.push(...(data?.data?.items || []));
  }
  return out;
}

function scanRows(items, minIvRank) {
  const rows = [];
  for (const m of items) {
    const raw = m["implied-volatility-index-rank"];
    if (raw == null || raw === "") continue;
    const ivr = Math.round(parseFloat(raw) * 1000) / 10; // 0..1 -> 0..100, 1dp
    if (!Number.isFinite(ivr) || ivr < minIvRank) continue;
    rows.push({ symbol: m.symbol, iv_rank: ivr, liquidity: m["liquidity-rating"] ?? null, beta: m.beta ?? null });
  }
  rows.sort((a, b) => b.iv_rank - a.iv_rank);
  return rows;
}

// ---------------------------------------------------------------------------
// Yahoo Finance (free: analyst targets, fundamentals, long history/seasonality)
// Unofficial — needs a cookie + crumb handshake. Cached per isolate.
// ---------------------------------------------------------------------------

const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
let yfAuth = { cookie: null, crumb: null, exp: 0 };

async function yahooAuth() {
  const now = Date.now() / 1000;
  if (yfAuth.crumb && now < yfAuth.exp) return yfAuth;
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YF_UA } });
  let jar = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : (r1.headers.get("set-cookie") ? [r1.headers.get("set-cookie")] : []);
  let cookie = jar.map((s) => s.split(";")[0]).join("; ");
  if (!cookie) {
    const r1b = await fetch("https://finance.yahoo.com", { headers: { "User-Agent": YF_UA } });
    jar = typeof r1b.headers.getSetCookie === "function" ? r1b.headers.getSetCookie() : (r1b.headers.get("set-cookie") ? [r1b.headers.get("set-cookie")] : []);
    cookie = jar.map((s) => s.split(";")[0]).join("; ");
  }
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": YF_UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error(`Yahoo crumb fetch failed (got '${crumb.slice(0, 40)}'). Yahoo may be blocking this IP.`);
  yfAuth = { cookie, crumb, exp: now + 1800 };
  return yfAuth;
}

async function yahooQuoteSummary(symbol, modules) {
  const { cookie, crumb } = await yahooAuth();
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { "User-Agent": YF_UA, Cookie: cookie } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Yahoo quoteSummary ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

async function yahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { "User-Agent": YF_UA } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Yahoo chart ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

// Annual financial statement lines via Yahoo's fundamentals-timeseries endpoint
// (the balanceSheetHistory/cashflowStatementHistory quoteSummary modules are dead).
// Returns { <type>: [{date, v}, ...] } oldest-first for each requested type.
async function yahooTimeseries(symbol, types) {
  const { cookie } = await yahooAuth();
  const now = Math.floor(Date.now() / 1000);
  const p1 = now - 6 * 365 * 86400;
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${p1}&period2=${now}&merge=false`;
  const r = await fetch(url, { headers: { "User-Agent": YF_UA, Cookie: cookie } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Yahoo timeseries ${r.status}: ${text.slice(0, 120)}`);
  const j = JSON.parse(text);
  const out = {};
  for (const res of j?.timeseries?.result || []) {
    const t = res.meta?.type?.[0];
    if (!t || !Array.isArray(res[t])) continue;
    out[t] = res[t].filter((x) => x && x.reportedValue != null).map((x) => ({ date: x.asOfDate, v: x.reportedValue.raw }));
  }
  return out;
}

// Yahoo option chain (free) — includes open interest + IV per strike. Needs cookie + crumb.
async function yahooOptions(symbol, dateEpoch) {
  const { cookie, crumb } = await yahooAuth();
  const u = "https://query1.finance.yahoo.com/v7/finance/options/" + encodeURIComponent(symbol) + "?crumb=" + encodeURIComponent(crumb) + (dateEpoch ? "&date=" + dateEpoch : "");
  const r = await fetch(u, { headers: { "User-Agent": YF_UA, Cookie: cookie } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Yahoo options ${r.status}: ${text.slice(0, 80)}`);
  return JSON.parse(text);
}

// Black-Scholes gamma (per share). Same for calls & puts at a given strike/IV.
function bsGamma(S, K, T, sig) {
  if (!(S > 0 && K > 0 && T > 0 && sig > 0)) return 0;
  const d1 = (Math.log(S / K) + (0.04 + (sig * sig) / 2) * T) / (sig * Math.sqrt(T));
  const npd = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  return npd / (S * sig * Math.sqrt(T));
}

// CNN Fear & Greed Index (free JSON). Akamai bot-check needs a browser UA + Origin + Referer.
async function cnnFearGreed() {
  const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: { "User-Agent": YF_UA, Accept: "application/json, text/plain, */*", Origin: "https://www.cnn.com", Referer: "https://www.cnn.com/" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`CNN Fear & Greed ${r.status}: ${text.slice(0, 80)}`);
  return JSON.parse(text);
}

// FOMC rate-decision dates [year, monthIndex0, dayOfMonth] (decision = day 2 of each meeting).
const FOMC = [
  [2026, 0, 28], [2026, 2, 18], [2026, 3, 29], [2026, 5, 17], [2026, 6, 29], [2026, 8, 16], [2026, 9, 28], [2026, 11, 9],
  [2027, 0, 27], [2027, 2, 17], [2027, 3, 28], [2027, 5, 9], [2027, 6, 28], [2027, 8, 15], [2027, 9, 27], [2027, 11, 8],
];
const FUT_MONTH_CODE = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(name, args, env) {
  switch (name) {
    case "get_balances": {
      const acct = await getAccountNumber(env);
      const resp = (await ttFetch(env, "GET", `/accounts/${acct}/balances`)).data;
      const d = resp && resp.items && resp.items[0] ? resp.items[0] : resp; // plain /balances nests in items[0]
      return JSON.stringify(
        {
          net_liq: d["net-liquidating-value"],
          cash: d["cash-balance"],
          derivative_buying_power: d["derivative-buying-power"],
          equity_buying_power: d["equity-buying-power"],
        },
        null,
        2,
      );
    }

    case "get_positions": {
      const acct = await getAccountNumber(env);
      const items = (await ttFetch(env, "GET", `/accounts/${acct}/positions`)).data.items || [];
      return JSON.stringify(
        items.map((p) => ({
          symbol: p.symbol,
          quantity: p.quantity,
          direction: p["quantity-direction"],
          type: p["instrument-type"],
          avg_price: p["average-open-price"],
        })),
        null,
        2,
      );
    }

    case "list_watchlists": {
      const items = (await ttFetch(env, "GET", "/watchlists")).data.items || [];
      return JSON.stringify(
        items.map((w) => ({ name: w.name, symbol_count: (w["watchlist-entries"] || []).length })),
        null,
        2,
      );
    }

    case "get_watchlist": {
      const w = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(args.name)}`)).data;
      const symbols = (w["watchlist-entries"] || []).map((e) => e.symbol);
      return JSON.stringify({ name: w.name, symbols }, null, 2);
    }

    case "scan_symbols": {
      const symbols = (args.symbols || []).map((s) => String(s).toUpperCase());
      const rows = scanRows(await fetchMetrics(env, symbols), args.min_iv_rank ?? 50);
      return JSON.stringify(rows, null, 2);
    }

    case "scan_watchlist": {
      const w = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(args.name)}`)).data;
      const symbols = (w["watchlist-entries"] || []).map((e) => e.symbol);
      const rows = scanRows(await fetchMetrics(env, symbols), args.min_iv_rank ?? 50);
      return JSON.stringify(rows, null, 2);
    }

    case "get_option_expirations": {
      const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(args.underlying)}/nested`);
      const chain = data?.data?.items || [];
      const exps = (chain[0]?.expirations || []).map((e) => e["expiration-date"]);
      return JSON.stringify(exps, null, 2);
    }

    case "get_option_strikes": {
      const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(args.underlying)}/nested`);
      const chain = data?.data?.items || [];
      const exp = (chain[0]?.expirations || []).find((e) => e["expiration-date"] === args.expiration);
      if (!exp) throw new Error(`No expiration ${args.expiration} for ${args.underlying}.`);
      const strikes = exp.strikes.map((s) => ({
        strike: s["strike-price"],
        call: !!s.call,
        put: !!s.put,
      }));
      return JSON.stringify(strikes, null, 2);
    }

    case "get_chain_with_greeks": {
      const exp = await chainSlice(env, args.underlying, args.expiration);
      const t = (args.option_type ? String(args.option_type).toUpperCase() : "BOTH");
      const wantCall = t === "BOTH" || t.startsWith("C");
      const wantPut = t === "BOTH" || t.startsWith("P");
      const meta = {};
      const syms = [];
      for (const s of exp.strikes) {
        if (wantCall && s["call-streamer-symbol"]) { meta[s["call-streamer-symbol"]] = { strike: num(s["strike-price"]), type: "CALL" }; syms.push(s["call-streamer-symbol"]); }
        if (wantPut && s["put-streamer-symbol"]) { meta[s["put-streamer-symbol"]] = { strike: num(s["strike-price"]), type: "PUT" }; syms.push(s["put-streamer-symbol"]); }
      }
      if (syms.length > 250) throw new Error(`${syms.length} contracts is too many for one call — pass option_type "C" or "P", or use a nearer expiration.`);
      const data = await dxlinkCollect(env, syms, { greeks: true, quote: true });
      const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
      const rows = syms
        .map((sym) => {
          const r = data[sym] || {};
          return {
            strike: meta[sym].strike, type: meta[sym].type,
            bid: r.bid ?? null, ask: r.ask ?? null, mid: mid(r.bid ?? null, r.ask ?? null),
            delta: r4(r.delta), gamma: r4(r.gamma), theta: r4(r.theta), vega: r4(r.vega), iv: r4(r.iv),
          };
        })
        .sort((a, b) => (a.type === b.type ? a.strike - b.strike : a.type < b.type ? -1 : 1));
      return JSON.stringify(rows, null, 2);
    }

    case "get_strike_by_delta": {
      const exp = await chainSlice(env, args.underlying, args.expiration);
      const isCall = String(args.option_type).toUpperCase().startsWith("C");
      const field = isCall ? "call-streamer-symbol" : "put-streamer-symbol";
      const meta = {};
      const syms = [];
      for (const s of exp.strikes) {
        const sym = s[field];
        if (sym) { meta[sym] = num(s["strike-price"]); syms.push(sym); }
      }
      const data = await dxlinkCollect(env, syms, { greeks: true, quote: true });
      const target = Number(args.target_delta);
      let best = null;
      for (const sym of syms) {
        const r = data[sym];
        if (!r || r.delta == null) continue;
        const diff = Math.abs(r.delta - target);
        if (!best || diff < best.diff) best = { diff, strike: meta[sym], delta: r.delta, bid: r.bid ?? null, ask: r.ask ?? null, iv: r.iv ?? null };
      }
      if (!best) {
        return JSON.stringify({ error: "No live greeks available (DXLink returned no data — market data may be down). REST tools are unaffected." }, null, 2);
      }
      const m = mid(best.bid, best.ask);
      const ror = m != null && best.strike - m > 0 ? Math.round((m / (best.strike - m)) * 10000) / 100 : null;
      const dte = exp["days-to-expiration"];
      return JSON.stringify(
        {
          underlying: String(args.underlying).toUpperCase(),
          expiration: args.expiration, dte,
          option_type: isCall ? "CALL" : "PUT", target_delta: target,
          strike: best.strike, delta: Math.round(best.delta * 1000) / 1000,
          bid: best.bid, ask: best.ask, mid: m, iv: best.iv != null ? Math.round(best.iv * 1000) / 1000 : null,
          ror_pct: ror,
          ror_annualized_pct: ror != null && dte ? Math.round((ror * 365 / dte) * 100) / 100 : null,
        },
        null,
        2,
      );
    }

    case "preview_order": {
      const k = normAction(args.action);
      const leg = equityLeg(args.symbol, args.quantity, k);
      const order = buildOrder(leg, k, args.limit_price);
      const acct = await getAccountNumber(env);
      const dry = (await ttFetch(env, "POST", `/accounts/${acct}/orders/dry-run`, order)).data;
      return JSON.stringify({ status: "DRY_RUN_ONLY", ...dryRunSummary(dry) }, null, 2);
    }

    case "place_order": {
      const k = normAction(args.action);
      const leg = equityLeg(args.symbol, args.quantity, k);
      const order = buildOrder(leg, k, args.limit_price);
      return JSON.stringify(await safePlace(env, order, args.confirm), null, 2);
    }

    case "preview_option_order": {
      const k = normAction(args.action);
      const occ = await optionOccSymbol(env, args.underlying, args.expiration, args.strike, args.option_type);
      const leg = optionLeg(occ, args.quantity, k);
      const order = buildOrder(leg, k, args.limit_price);
      const acct = await getAccountNumber(env);
      const dry = (await ttFetch(env, "POST", `/accounts/${acct}/orders/dry-run`, order)).data;
      return JSON.stringify({ status: "DRY_RUN_ONLY", contract: occ, ...dryRunSummary(dry) }, null, 2);
    }

    case "place_option_order": {
      const k = normAction(args.action);
      const occ = await optionOccSymbol(env, args.underlying, args.expiration, args.strike, args.option_type);
      const leg = optionLeg(occ, args.quantity, k);
      const order = buildOrder(leg, k, args.limit_price);
      const result = await safePlace(env, order, args.confirm);
      return JSON.stringify({ contract: occ, ...result }, null, 2);
    }

    case "preview_spread": {
      const legs = await resolveSpreadLegs(env, args.underlying, args.legs, args.expiration);
      const order = buildSpreadOrder(legs, args.net_price, args.price_effect);
      const acct = await getAccountNumber(env);
      const dry = (await ttFetch(env, "POST", `/accounts/${acct}/orders/dry-run`, order)).data;
      const contracts = legs.map((l) => `${l.action} ${l.quantity} ${l.symbol}`);
      return JSON.stringify({ status: "DRY_RUN_ONLY", contracts, ...dryRunSummary(dry) }, null, 2);
    }

    case "place_spread": {
      const legs = await resolveSpreadLegs(env, args.underlying, args.legs, args.expiration);
      const order = buildSpreadOrder(legs, args.net_price, args.price_effect);
      const contracts = legs.map((l) => `${l.action} ${l.quantity} ${l.symbol}`);
      const result = await safePlace(env, order, args.confirm);
      return JSON.stringify({ contracts, ...result }, null, 2);
    }

    case "list_orders": {
      const acct = await getAccountNumber(env);
      const items = (await ttFetch(env, "GET", `/accounts/${acct}/orders/live`)).data.items || [];
      return JSON.stringify(
        items.map((o) => ({
          id: o.id,
          status: o.status,
          type: o["order-type"],
          price: o.price,
          legs: (o.legs || []).map((l) => `${l.action} ${l.quantity} ${l.symbol}`),
        })),
        null,
        2,
      );
    }

    case "cancel_order": {
      const acct = await getAccountNumber(env);
      await ttFetch(env, "DELETE", `/accounts/${acct}/orders/${encodeURIComponent(args.order_id)}`);
      return JSON.stringify({ status: "CANCELLED", order_id: args.order_id }, null, 2);
    }

    case "get_bollinger": {
      const sym = String(args.symbol).toUpperCase();
      const data = await dxlinkCandles(env, [sym], {});
      const b = bollinger(data[sym] || []);
      if (!b) return JSON.stringify({ symbol: sym, error: "Not enough daily candle history to compute BB(20)." }, null, 2);
      const zone =
        b.pct_b == null ? "unknown"
        : b.pct_b <= 0.15 ? "at/below lower band"
        : b.pct_b < 0.33 ? "lower third"
        : b.pct_b > 0.85 ? "at/above upper band"
        : b.pct_b > 0.67 ? "upper third"
        : "middle";
      return JSON.stringify({ symbol: sym, ...b, zone }, null, 2);
    }

    case "scan_watchlist_bb_csp": {
      const maxPctB = args.max_pct_b ?? 0.25;
      const target = args.target_delta != null ? Number(args.target_delta) : -0.30;
      const dteMin = args.dte_min ?? 21;
      const dteMax = args.dte_max ?? 31;
      const dteMid = (dteMin + dteMax) / 2;
      const top = args.top ?? 15;

      let symbols;
      if (Array.isArray(args.symbols) && args.symbols.length) symbols = args.symbols.map((s) => String(s).toUpperCase());
      else if (args.name) {
        const w = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(args.name)}`)).data;
        symbols = (w["watchlist-entries"] || []).map((e) => e.symbol);
      } else throw new Error("Pass a watchlist `name` or a `symbols` array.");

      // 1) candles -> Bollinger %B, keep names near/below lower band
      const candleData = await dxlinkCandles(env, symbols, { timeoutMs: 14000 });
      const nearLower = [];
      for (const sym of symbols) {
        const rows2 = candleData[sym] || [];
        const b = bollinger(rows2);
        if (b && b.pct_b != null && b.pct_b <= maxPctB) {
          const closes = rows2.slice().sort((a, b2) => a.time - b2.time).map((r) => r.close).filter((c) => c != null);
          nearLower.push({ sym, bb: b, rsi: rsiOf(closes, 14), macd_hist: macdHistOf(closes) });
        }
      }
      nearLower.sort((a, b) => a.bb.pct_b - b.bb.pct_b);
      const cand = nearLower.slice(0, 25);
      if (!cand.length) {
        return JSON.stringify({ note: `No names at/below %B ${maxPctB} in this list right now.`, screened: symbols.length, results: [] }, null, 2);
      }

      // 2) CSP delta-target for the oversold names (spot -> chain band -> greeks)
      const candSyms = cand.map((c) => c.sym);
      const spotData = await dxlinkCollect(env, candSyms, { greeks: false, quote: true, timeoutMs: 6000 });
      const meta = {};
      const allPuts = [];
      await Promise.all(
        candSyms.map(async (sym) => {
          try {
            const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(sym)}/nested`);
            const chain = (data?.data?.items || [])[0];
            if (!chain) return;
            const c = (chain.expirations || []).filter((e) => e["days-to-expiration"] >= dteMin && e["days-to-expiration"] <= dteMax);
            if (!c.length) return;
            c.sort((a, b) => Math.abs(a["days-to-expiration"] - dteMid) - Math.abs(b["days-to-expiration"] - dteMid));
            const exp = c[0];
            const spot = mid(spotData[sym]?.bid ?? null, spotData[sym]?.ask ?? null);
            let strikes = exp.strikes.filter((s) => s["put-streamer-symbol"]);
            if (spot) strikes = strikes.filter((s) => { const k = num(s["strike-price"]); return k >= spot * 0.65 && k <= spot * 1.0; });
            for (const s of strikes) {
              const st = s["put-streamer-symbol"];
              meta[st] = { sym, strike: num(s["strike-price"]), dte: exp["days-to-expiration"], exp: exp["expiration-date"] };
              allPuts.push(st);
            }
          } catch (e) { /* skip */ }
        }),
      );
      const gdata = allPuts.length ? await dxlinkCollect(env, allPuts, { greeks: true, quote: true, timeoutMs: 13000 }) : {};
      const best = {};
      for (const st of allPuts) {
        const r = gdata[st];
        if (!r || r.delta == null) continue;
        const mm = meta[st];
        const diff = Math.abs(r.delta - target);
        if (!best[mm.sym] || diff < best[mm.sym].diff) best[mm.sym] = { diff, ...mm, delta: r.delta, bid: r.bid ?? null, ask: r.ask ?? null, iv: r.iv ?? null };
      }
      const em2 = await fetchMetrics(env, candSyms);
      const earnBy = {};
      for (const mm of em2) { const e = mm.earnings && mm.earnings["expected-report-date"]; if (e) earnBy[mm.symbol] = { date: e, days: Math.round((Date.parse(e) - Date.now()) / 86400000) }; }
      const results = cand
        .map((c) => {
          const bb = c.bb;
          const b = best[c.sym];
          const earn = earnBy[c.sym] || {};
          if (!b) return { symbol: c.sym, pct_b: bb.pct_b, price: bb.price, lower_bb: bb.lower, mid_bb: bb.mid, upper_bb: bb.upper, rsi: c.rsi, macd_hist: c.macd_hist, earnings_date: earn.date ?? null, earnings_in_days: earn.days ?? null, note: "no put in DTE window" };
          const premium = mid(b.bid, b.ask);
          const ror = premium && b.strike - premium > 0 ? Math.round((premium / (b.strike - premium)) * 10000) / 100 : null;
          const annual = ror != null && b.dte ? Math.round((ror * 365 / b.dte) * 100) / 100 : null;
          return {
            symbol: c.sym, pct_b: bb.pct_b, price: bb.price, lower_bb: bb.lower, mid_bb: bb.mid, upper_bb: bb.upper,
            rsi: c.rsi, macd_hist: c.macd_hist, earnings_date: earn.date ?? null, earnings_in_days: earn.days ?? null,
            expiration: b.exp, dte: b.dte, strike: b.strike, delta: Math.round(b.delta * 1000) / 1000,
            bid: b.bid, ask: b.ask, premium, iv: b.iv != null ? Math.round(b.iv * 1000) / 10 : null,
            ror_pct: ror, ror_annualized_pct: annual,
          };
        })
        .slice(0, top);

      const priced = results.filter((r) => r.premium != null);
      return JSON.stringify(
        {
          filter: `%B <= ${maxPctB} (at/near lower Bollinger band)`, target_delta: target, dte_window: `${dteMin}-${dteMax}`,
          screened: symbols.length, near_lower_band: nearLower.length,
          below_band: nearLower.filter((x) => x.bb.pct_b < 0).length, priced: priced.length,
          dte_used: priced.length ? priced[0].dte : null,
          best_ann_ror: priced.reduce((m, r) => Math.max(m, r.ror_annualized_pct || 0), 0),
          ranked_by: "pct_b (most oversold first)", results,
        },
        null,
        2,
      );
    }

    case "update_watchlist": {
      const name = args.name;
      const wl = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(name)}`)).data;
      let entries = (wl["watchlist-entries"] || []).map((e) => ({ symbol: e.symbol, "instrument-type": e["instrument-type"] }));
      const have = new Set(entries.map((e) => e.symbol.toUpperCase()));
      const added = [];
      const skipped = [];
      for (const raw of args.symbols_to_add || []) {
        const sym = String(raw).toUpperCase();
        if (have.has(sym)) { skipped.push(sym); continue; }
        entries.push({ symbol: sym, "instrument-type": "Equity" });
        have.add(sym);
        added.push(sym);
      }
      const removeSet = new Set((args.symbols_to_remove || []).map((s) => String(s).toUpperCase()));
      const beforeCount = entries.length;
      const removed = [];
      entries = entries.filter((e) => {
        if (removeSet.has(e.symbol.toUpperCase())) { removed.push(e.symbol); return false; }
        return true;
      });
      await ttFetch(env, "PUT", `/watchlists/${encodeURIComponent(name)}`, { name, "watchlist-entries": entries });
      return JSON.stringify(
        { status: "UPDATED", name, total_symbols: entries.length, added, removed, skipped_already_present: skipped },
        null,
        2,
      );
    }

    case "create_watchlist": {
      const name = args.name;
      const entries = (args.symbols || []).map((s) => ({ symbol: String(s).toUpperCase(), "instrument-type": "Equity" }));
      await ttFetch(env, "POST", "/watchlists", { name, "watchlist-entries": entries });
      return JSON.stringify({ status: "CREATED", name, total_symbols: entries.length, symbols: entries.map((e) => e.symbol) }, null, 2);
    }

    case "get_analyst_targets": {
      const sym = String(args.symbol).toUpperCase();
      const j = await yahooQuoteSummary(sym, "financialData,recommendationTrend,price");
      const r = j?.quoteSummary?.result?.[0];
      if (!r) return JSON.stringify({ symbol: sym, error: "No analyst data from Yahoo." }, null, 2);
      const f = r.financialData || {};
      const p = r.price || {};
      const price = f.currentPrice?.raw ?? p.regularMarketPrice?.raw ?? null;
      const mean = f.targetMeanPrice?.raw ?? null;
      const t0 = (r.recommendationTrend?.trend || [])[0] || {};
      return JSON.stringify(
        {
          symbol: sym,
          price,
          target_mean: mean,
          target_high: f.targetHighPrice?.raw ?? null,
          target_low: f.targetLowPrice?.raw ?? null,
          implied_upside_pct: mean && price ? Math.round((mean / price - 1) * 1000) / 10 : null,
          recommendation: f.recommendationKey ?? null,
          num_analysts: f.numberOfAnalystOpinions?.raw ?? null,
          ratings: { strong_buy: t0.strongBuy, buy: t0.buy, hold: t0.hold, sell: t0.sell, strong_sell: t0.strongSell },
        },
        null,
        2,
      );
    }

    case "get_seasonality": {
      const sym = String(args.symbol).toUpperCase();
      const lookback = args.lookback_years != null ? Number(args.lookback_years) : 20;
      const j = await yahooChart(sym, "max", "1mo");
      const res = j?.chart?.result?.[0];
      if (!res) return JSON.stringify({ symbol: sym, error: "No history from Yahoo." }, null, 2);
      const ts = res.timestamp || [];
      const adj = res.indicators?.adjclose?.[0]?.adjclose;
      const closes = adj && adj.length === ts.length ? adj : res.indicators?.quote?.[0]?.close || [];
      const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const nowY = new Date().getUTCFullYear();
      const nowM = new Date().getUTCMonth();
      const minYear = nowY - lookback;
      const byMonth = Array.from({ length: 12 }, () => []);
      const byYear = {};
      let curRet = null, curLabel = null;
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] == null || closes[i - 1] == null) continue;
        const dt = new Date(ts[i] * 1000), y = dt.getUTCFullYear(), m = dt.getUTCMonth();
        const ret = (closes[i] / closes[i - 1] - 1) * 100;
        if (y >= minYear) byMonth[m].push(ret);
        if (!byYear[y]) byYear[y] = Array(12).fill(null);
        byYear[y][m] = Math.round(ret * 100) / 100;
        if (i === closes.length - 1) { curRet = Math.round(ret * 100) / 100; curLabel = names[m] + " " + y; }
      }
      const months = byMonth.map((arr, m) => ({ month: names[m], years: arr.length, avg_return_pct: arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null, win_rate_pct: arr.length ? Math.round((arr.filter((x) => x > 0).length / arr.length) * 1000) / 10 : null }));
      const valid = months.filter((m) => m.avg_return_pct != null);
      const strongest = valid.length ? valid.reduce((a, b) => (b.avg_return_pct > a.avg_return_pct ? b : a)) : null;
      const weakest = valid.length ? valid.reduce((a, b) => (b.avg_return_pct < a.avg_return_pct ? b : a)) : null;
      const years = Object.keys(byYear).map(Number).filter((y) => y >= minYear).sort((a, b) => b - a).map((y) => {
        let p = 1, any = false; for (const r of byYear[y]) if (r != null) { p *= 1 + r / 100; any = true; }
        return { year: y, months: byYear[y], year_total: any ? Math.round((p - 1) * 10000) / 100 : null };
      });
      return JSON.stringify({ symbol: sym, lookback_years: lookback, note: "Monthly TOTAL returns (dividend-adjusted).", summary: { strongest, weakest, next_month: months[(nowM + 1) % 12], this_month: months[nowM], current_month_so_far: { label: curLabel, return_pct: curRet } }, months, years }, null, 2);
    }

    case "get_earnings_history": {
      const sym = String(args.symbol).toUpperCase();
      const j = await yahooQuoteSummary(sym, "earnings");
      const r = j?.quoteSummary?.result?.[0];
      if (!r) return JSON.stringify({ symbol: sym, error: "No earnings data from Yahoo." }, null, 2);
      const eq = r.earnings?.earningsChart?.quarterly || [];
      const fq = r.earnings?.financialsChart?.quarterly || [];
      const revBy = {}; for (const q of fq) revBy[q.date] = q.revenue?.raw ?? null;
      const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
      const hist = eq.map((q) => {
        const act = q.actual?.raw ?? null, est = q.estimate?.raw ?? null;
        return {
          quarter: q.date, reported: q.reportedDate?.fmt ?? null,
          eps_estimate: r2(est), eps_actual: r2(act),
          surprise_pct: act != null && est != null && est !== 0 ? Math.round(((act - est) / Math.abs(est)) * 1000) / 10 : null,
          beat: act != null && est != null ? act >= est : null,
          revenue: revBy[q.date] ?? null,
        };
      });
      return JSON.stringify({ symbol: sym, note: "EPS estimate vs actual + surprise% (beat/miss); revenue is actual (per-quarter revenue estimates aren't in Yahoo's free data).", eps_history: hist.slice(-4).reverse() }, null, 2);
    }

    case "get_stock_stats": {
      const sym = String(args.symbol).toUpperCase();
      const [mmArr, j] = await Promise.all([fetchMetrics(env, [sym]), yahooQuoteSummary(sym, "summaryDetail,defaultKeyStatistics,price")]);
      const mm = mmArr[0] || {};
      const r = j?.quoteSummary?.result?.[0] || {};
      const sd = r.summaryDetail || {}, k = r.defaultKeyStatistics || {}, p = r.price || {};
      const price = p.regularMarketPrice?.raw ?? null;
      const hi52 = sd.fiftyTwoWeekHigh?.raw ?? null, lo52 = sd.fiftyTwoWeekLow?.raw ?? null;
      const ivRank = mm["implied-volatility-index-rank"] != null ? Math.round(parseFloat(mm["implied-volatility-index-rank"]) * 1000) / 10 : null;
      const ivPct = mm["implied-volatility-percentile"] != null ? Math.round(parseFloat(mm["implied-volatility-percentile"]) * 1000) / 10 : null;
      let ernDate = null, ernDays = null; const ern = mm.earnings && mm.earnings["expected-report-date"]; if (ern) { ernDate = ern; ernDays = Math.round((Date.parse(ern) - Date.now()) / 86400000); }
      return JSON.stringify({
        symbol: sym, price,
        iv_rank: ivRank, iv_percentile: ivPct, iv_premium: ivPct == null ? null : ivPct <= 30 ? "cheap" : ivPct >= 70 ? "rich" : "fair",
        beta: mm.beta != null ? Math.round(parseFloat(mm.beta) * 100) / 100 : (k.beta?.raw ?? null),
        off_52w_high_pct: price && hi52 ? Math.round((price / hi52 - 1) * 1000) / 10 : null,
        week52_high: hi52, week52_low: lo52,
        market_cap: p.marketCap?.raw ?? sd.marketCap?.raw ?? null,
        volume: p.regularMarketVolume?.raw ?? sd.volume?.raw ?? null,
        avg_volume: sd.averageVolume?.raw ?? null,
        held_pct_institutions: k.heldPercentInstitutions?.raw != null ? Math.round(k.heldPercentInstitutions.raw * 1000) / 10 : null,
        held_pct_insiders: k.heldPercentInsiders?.raw != null ? Math.round(k.heldPercentInsiders.raw * 1000) / 10 : null,
        earnings_date: ernDate, earnings_in_days: ernDays,
      }, null, 2);
    }

    case "get_fundamentals": {
      const sym = String(args.symbol).toUpperCase();
      const [mmArr, j, ts] = await Promise.all([
        fetchMetrics(env, [sym]),
        yahooQuoteSummary(sym, "defaultKeyStatistics,summaryDetail,price,financialData"),
        yahooTimeseries(sym, "annualTotalRevenue,annualDilutedEPS,annualFreeCashFlow,annualCurrentAssets,annualCurrentLiabilities").catch(() => ({})),
      ]);
      const mm = mmArr[0] || {};
      const r = j?.quoteSummary?.result?.[0] || {};
      const sd = r.summaryDetail || {}, k = r.defaultKeyStatistics || {}, p = r.price || {}, fd = r.financialData || {};
      const price = p.regularMarketPrice?.raw ?? null;
      const mcap = p.marketCap?.raw ?? sd.marketCap?.raw ?? null;
      const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
      const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
      // 3Y CAGR from an oldest->newest series (needs >=2 points, endpoints positive)
      const cagr = (arr) => {
        const a = arr.filter((x) => x != null && Number.isFinite(x));
        if (a.length < 2) return null;
        const first = a[0], last = a[a.length - 1];
        if (first <= 0 || last <= 0) return null;
        return r1((Math.pow(last / first, 1 / (a.length - 1)) - 1) * 100);
      };
      const vals = (t) => (ts[t] || []).map((x) => x.v);
      const revs = vals("annualTotalRevenue");
      const eps = vals("annualDilutedEPS");
      const fcf = vals("annualFreeCashFlow");
      const ca = vals("annualCurrentAssets"), cl = vals("annualCurrentLiabilities");
      const rev_growth_3y = cagr(revs);
      const eps_growth_3y = cagr(eps); // real diluted EPS CAGR
      const fcf_growth_3y = cagr(fcf);
      const latestFcf = fcf.length ? fcf[fcf.length - 1] : null;
      const lca = ca.length ? ca[ca.length - 1] : null, lcl = cl.length ? cl[cl.length - 1] : null;
      const current_ratio = lca != null && lcl ? r2(lca / lcl) : null;
      const pe = sd.trailingPE?.raw ?? k.trailingPE?.raw ?? null;
      const fpe = sd.forwardPE?.raw ?? k.forwardPE?.raw ?? null;
      const p_fcf = mcap && latestFcf && latestFcf > 0 ? r2(mcap / latestFcf) : null;
      const tgt = fd.targetMeanPrice?.raw;
      return JSON.stringify({
        symbol: sym, price, market_cap: mcap,
        revenue_growth_3y: rev_growth_3y,
        eps_growth_3y,
        fcf_growth_3y,
        current_ratio,
        pe: r2(pe), forward_pe: r2(fpe), p_fcf,
        profit_margin_pct: fd.profitMargins?.raw != null ? r1(fd.profitMargins.raw * 100) : null,
        gross_margin_pct: fd.grossMargins?.raw != null ? r1(fd.grossMargins.raw * 100) : null,
        roe_pct: fd.returnOnEquity?.raw != null ? r1(fd.returnOnEquity.raw * 100) : null,
        debt_to_equity: fd.debtToEquity?.raw != null ? r2(fd.debtToEquity.raw) : null,
        dividend_yield_pct: sd.dividendYield?.raw != null ? r1(sd.dividendYield.raw * 100) : null,
        analyst_upside_pct: tgt && price ? r1((tgt / price - 1) * 100) : null,
        iv_rank: mm["implied-volatility-index-rank"] != null ? r1(parseFloat(mm["implied-volatility-index-rank"]) * 100) : null,
        iv_percentile: mm["implied-volatility-percentile"] != null ? r1(parseFloat(mm["implied-volatility-percentile"]) * 100) : null,
        beta: mm.beta != null ? r2(parseFloat(mm.beta)) : (k.beta?.raw ?? null),
        years_of_data: revs.length,
      }, null, 2);
    }

    case "get_index_trends": {
      const map = [
        { sym: "^VIX", label: "VIX", name: "Volatility (CBOE)" },
        { sym: "^GSPC", label: "S&P 500", name: "SPX index" },
        { sym: "QQQ", label: "QQQ", name: "Nasdaq-100 ETF" },
        { sym: "^IXIC", label: "Nasdaq", name: "Composite" },
      ];
      const WINDOW = 63; // ~3 months of daily candles shown
      const indexes = await Promise.all(map.map(async (m) => {
        try {
          const j = await yahooChart(m.sym, "8mo", "1d");
          const res = j?.chart?.result?.[0] || {};
          const meta = res.meta || {};
          const q = res.indicators?.quote?.[0] || {};
          const O = q.open || [], H = q.high || [], L = q.low || [], C = q.close || [];
          const rows = [];
          for (let i = 0; i < C.length; i++) { if (C[i] == null) continue; rows.push({ o: O[i] ?? C[i], h: H[i] ?? C[i], l: L[i] ?? C[i], c: C[i] }); }
          if (rows.length < 2) return { symbol: m.label, name: m.name, error: "no data" };
          const closes = rows.map((r) => r.c);
          const last = closes[closes.length - 1];
          const price = meta.regularMarketPrice ?? last;
          const ago = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
          const pct = (a, b) => (a != null && b ? Math.round((a / b - 1) * 1000) / 10 : null);
          const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
          // Bollinger Bands(20, 2) over the full series
          const P = 20, Kb = 2, bu = [], bm = [], bl = [];
          for (let i = 0; i < closes.length; i++) {
            if (i < P - 1) { bu.push(null); bm.push(null); bl.push(null); continue; }
            let s = 0; for (let k = i - P + 1; k <= i; k++) s += closes[k];
            const mean = s / P; let v = 0; for (let k = i - P + 1; k <= i; k++) { const d = closes[k] - mean; v += d * d; }
            const sd = Math.sqrt(v / P); bm.push(r2(mean)); bu.push(r2(mean + Kb * sd)); bl.push(r2(mean - Kb * sd));
          }
          const st = Math.max(0, rows.length - WINDOW);
          const candles = [];
          for (let i = st; i < rows.length; i++) candles.push({ o: r2(rows[i].o), h: r2(rows[i].h), l: r2(rows[i].l), c: r2(rows[i].c), bu: bu[i], bm: bm[i], bl: bl[i] });
          return {
            symbol: m.label, name: m.name, price: Math.round(price * 100) / 100,
            chg_pct: pct(price, ago(1)), w1_pct: pct(last, ago(5)), m1_pct: pct(last, ago(21)), m3_pct: pct(last, ago(63)),
            candles, range_label: "3-mo daily · BB(20,2)",
          };
        } catch (e) { return { symbol: m.label, name: m.name, error: String(e) }; }
      }));
      return JSON.stringify({ indexes }, null, 2);
    }

    case "get_fear_greed": {
      const d = await cnnFearGreed();
      const fg = d.fear_and_greed || {};
      const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
      const comp = [
        ["Market Momentum", "market_momentum_sp500"],
        ["Stock Price Strength", "stock_price_strength"],
        ["Stock Price Breadth", "stock_price_breadth"],
        ["Put/Call Options", "put_call_options"],
        ["Market Volatility", "market_volatility_vix"],
        ["Junk Bond Demand", "junk_bond_demand"],
        ["Safe Haven Demand", "safe_haven_demand"],
      ].map(([label, key]) => ({ label, score: d[key] ? r1(d[key].score) : null, rating: d[key] ? d[key].rating : null }));
      const histRaw = (d.fear_and_greed_historical?.data || []);
      const step = Math.max(1, Math.floor(histRaw.length / 120));
      const history = histRaw.filter((_, i) => i % step === 0).map((p) => ({ t: p.x, y: r1(p.y) }));
      return JSON.stringify({
        score: r1(fg.score), rating: fg.rating, updated: fg.timestamp || null,
        previous_close: r1(fg.previous_close), week_ago: r1(fg.previous_1_week), month_ago: r1(fg.previous_1_month), year_ago: r1(fg.previous_1_year),
        components: comp, history,
      }, null, 2);
    }

    case "get_fed_watch": {
      const nowD = new Date();
      const y0 = nowD.getUTCFullYear(), m0 = nowD.getUTCMonth(), today = nowD.getUTCDate();
      // Build a rolling window of (year, month) pairs ~11 months out (spans the year boundary).
      const win = []; for (let k = 0; k < 11; k++) { const t = m0 + k; win.push([y0 + Math.floor(t / 12), t % 12]); }
      const priceOf = {}; // key "y-m" -> futures price
      await Promise.all(win.map(async ([y, m]) => {
        const sym = "ZQ" + FUT_MONTH_CODE[m] + String(y % 100).padStart(2, "0") + ".CBT";
        try { const j = await yahooChart(sym, "5d", "1d"); const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p != null) priceOf[y + "-" + m] = p; } catch (e) {}
      }));
      const impRate = (y, m) => (priceOf[y + "-" + m] != null ? 100 - priceOf[y + "-" + m] : null);
      const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
      const clamp01 = (x) => Math.max(0, Math.min(1, x));

      const curRate = impRate(y0, m0);
      const bandLow = curRate != null ? Math.round((curRate - 0.083) / 0.25) * 0.25 : null;

      // Upcoming FOMC meetings within the window. Post-meeting rate ≈ implied rate of the
      // month AFTER the meeting month; per-meeting change vs the prior meeting's post-rate
      // gives cut/hold/hike (two-bucket around the current rate). Estimate, not the CME tree.
      const upcoming = FOMC.filter((f) => f[0] > y0 || (f[0] === y0 && (f[1] > m0 || (f[1] === m0 && f[2] >= today))));
      const meetings = []; let prevPost = curRate;
      for (const f of upcoming) {
        const [fy, fm, fd] = f;
        let ny = fy, nm = fm + 1; if (nm > 11) { nm = 0; ny += 1; }
        const post = impRate(ny, nm);
        if (post == null || prevPost == null) continue;
        const incUnits = (post - prevPost) / 0.25; // >0 = hike priced at this meeting
        const a = Math.abs(incUnits);
        let cut = 0, hold = 0, hike = 0;
        if (a <= 1) { hold = 1 - a; if (incUnits > 0) hike = a; else cut = a; }
        else if (incUnits > 0) { hike = 1; } else { cut = 1; }
        meetings.push({
          date: fy + "-" + String(fm + 1).padStart(2, "0") + "-" + String(fd).padStart(2, "0"),
          implied_rate: r2(post),
          prob_cut_pct: Math.round(clamp01(cut) * 100),
          prob_hold_pct: Math.round(clamp01(hold) * 100),
          prob_hike_pct: Math.round(clamp01(hike) * 100),
          bias: incUnits > 0.05 ? "hike" : incUnits < -0.05 ? "cut" : "hold",
        });
        prevPost = post;
        if (meetings.length >= 6) break;
      }
      const yearEnd = meetings.length ? meetings[Math.min(meetings.length - 1, meetings.filter((mm) => mm.date.startsWith(String(y0))).length - 1)] : null;
      const decMeet = meetings.filter((mm) => mm.date.startsWith(String(y0))).slice(-1)[0] || null;
      return JSON.stringify({
        implied_current_rate: r2(curRate),
        target_range: bandLow != null ? { low: r2(bandLow), high: r2(bandLow + 0.25) } : null,
        meetings,
        year_end_rate: decMeet ? decMeet.implied_rate : null,
        net_bps_by_year_end: curRate != null && decMeet ? Math.round((decMeet.implied_rate - curRate) * 100) : null,
        note: "Market-implied from 30-Day Fed Funds futures (ZQ). Per-meeting cut/hold/hike is an estimate (marginal-implied method), not the official CME FedWatch tree.",
      }, null, 2);
    }

    case "get_swing_structure": {
      const sym = String(args.symbol).toUpperCase();
      const N = args.swing_n != null ? Math.max(2, Math.min(5, Number(args.swing_n))) : 3;
      const rr2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
      // Live candles from TastyTrade DXLink: DAILY defines the structure/setup, 1H times entries.
      const [cdD, cdH] = await Promise.all([
        dxlinkCandles(env, [sym], { period: "1d", days: 400, minCandles: 80, timeoutMs: 16000 }),
        dxlinkCandles(env, [sym], { period: "1h", days: 30, minCandles: 40, timeoutMs: 16000 }),
      ]);
      const toBars = (arr) => (arr || []).slice().sort((a, b) => a.time - b.time).filter((c) => c.close != null && c.high != null && c.low != null).map((c) => ({ t: c.time, o: c.open ?? c.close, h: c.high, l: c.low, c: c.close }));
      const dBars = toBars(cdD[sym]), hBars = toBars(cdH[sym]);
      if (dBars.length < 2 * N + 6) return JSON.stringify({ symbol: sym, state: "UNCLEAR", reason: `Only ${dBars.length} daily bars returned — not enough live structure.`, daily_bars: dBars.length }, null, 2);
      const daily = iccAnalyze(dBars, { n: N });
      const hourly = hBars.length >= 2 * N + 6 ? iccAnalyze(hBars, { n: N, higherSwings: daily.swings }) : { state: "UNCLEAR", reason: "not enough 1H bars", swings: [] };
      const entry = iccEntry(daily, hourly, daily.plan);
      const cur = hBars.length ? hBars[hBars.length - 1].c : dBars[dBars.length - 1].c;

      // Badges (flags, not blockers): US/Eastern session + 1H volatility vs its own baseline.
      const session = etSession();
      const atrNow = iccAtr(hBars, 14);
      let trSum = 0, trN = 0;
      for (let i = 1; i < hBars.length; i++) { trSum += Math.max(hBars[i].h - hBars[i].l, Math.abs(hBars[i].h - hBars[i - 1].c), Math.abs(hBars[i].l - hBars[i - 1].c)); trN++; }
      const atrBase = trN ? trSum / trN : null;
      const volRatio = atrNow != null && atrBase ? Math.round((atrNow / atrBase) * 100) / 100 : null;
      const volFlag = volRatio == null ? "unknown" : volRatio < 0.7 ? "low — choppy/thin, stand aside" : volRatio > 1.6 ? "elevated" : "normal";

      const bmap = (b) => ({ t: b.t, o: rr2(b.o), h: rr2(b.h), l: rr2(b.l), c: rr2(b.c) });
      const marks = (swings, total, win) => { const off = Math.max(0, total - win); return (swings || []).filter((p) => p.idx >= off).map((p) => ({ i: p.idx - off, price: rr2(p.price), type: p.type })); };
      const DWIN = 120, HWIN = 140;
      return JSON.stringify({
        symbol: sym, last_price: rr2(cur), swing_n: N, timeframe: "Daily structure · 1H entry",
        daily: { state: daily.state, direction: daily.direction, narration: daily.narration, reason: daily.reason, plan: daily.plan, broken_level: daily.broken_level, correction_extreme: daily.correction_extreme, bars_returned: dBars.length, bars: dBars.slice(-DWIN).map(bmap), swing_markers: marks(daily.swings, dBars.length, DWIN) },
        hourly: { state: hourly.state, direction: hourly.direction, narration: hourly.narration, broken_level: hourly.broken_level, correction_extreme: hourly.correction_extreme, bars_returned: hBars.length, bars: hBars.slice(-HWIN).map(bmap), swing_markers: marks(hourly.swings, hBars.length, HWIN) },
        entry,
        badges: { session, volatility: { atr_1h: atrNow != null ? rr2(atrNow) : null, ratio_vs_baseline: volRatio, flag: volFlag } },
        disclaimer: "Read-only structure analysis (swing structure). Daily = setup, 1H = entry timing. Automated detection is a heuristic aid, not a signal service — verify on the chart. No orders are placed.",
      }, null, 2);
    }

    case "get_financials": {
      const sym = String(args.symbol).toUpperCase();
      const ts = await yahooTimeseries(sym, "annualTotalRevenue,annualGrossProfit,annualOperatingIncome,annualNetIncome,annualDilutedEPS,annualFreeCashFlow").catch(() => ({}));
      const specs = [
        ["Revenue", "annualTotalRevenue", "$"],
        ["Gross Profit", "annualGrossProfit", "$"],
        ["Operating Income", "annualOperatingIncome", "$"],
        ["Net Income", "annualNetIncome", "$"],
        ["Diluted EPS", "annualDilutedEPS", "eps"],
        ["Free Cash Flow", "annualFreeCashFlow", "$"],
      ];
      // union of all reported fiscal years (by year), most recent last
      const yearSet = {};
      for (const [, key] of specs) for (const p of ts[key] || []) if (p.date) yearSet[p.date.slice(0, 4)] = true;
      const years = Object.keys(yearSet).sort().slice(-4);
      const rows = specs.map(([label, key, unit]) => {
        const byYear = {}; for (const p of ts[key] || []) if (p.date) byYear[p.date.slice(0, 4)] = p.v;
        const values = years.map((y) => (byYear[y] != null ? byYear[y] : null));
        const last = values[values.length - 1], prev = values[values.length - 2];
        const yoy = last != null && prev != null && prev !== 0 && prev > 0 ? Math.round((last / prev - 1) * 1000) / 10 : null;
        return { label, unit, values, yoy };
      });
      return JSON.stringify({ symbol: sym, years, rows, note: "Annual figures from Yahoo financial statements. YoY = latest fiscal year vs prior." }, null, 2);
    }

    case "get_gamma_exposure": {
      const sym = String(args.symbol).toUpperCase();
      const nExp = Math.max(1, Math.min(6, args.expirations ? Number(args.expirations) : 3));
      const first = await yahooOptions(sym);
      const res = first?.optionChain?.result?.[0];
      if (!res) throw new Error(`No option data for ${sym}.`);
      const spot = res.quote?.regularMarketPrice;
      if (!spot) throw new Error(`No spot price for ${sym}.`);
      const nowSec = Math.floor(Date.now() / 1000);
      const allExp = (res.expirationDates || []).filter((e) => e > nowSec);
      const isMonthly = (ep) => { const d = new Date(ep * 1000); return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21; };
      let chosen = allExp.filter(isMonthly).slice(0, nExp);
      if (!chosen.length) chosen = allExp.slice(0, nExp);
      const chains = await Promise.all(chosen.map(async (e) => {
        if (res.options?.[0]?.expirationDate === e) return res;
        try { const j = await yahooOptions(sym, e); return j?.optionChain?.result?.[0]; } catch (err) { return null; }
      }));
      const byStrike = {};
      const oiAgg = {}; // strike -> {c: call OI, p: put OI} aggregated across the chosen expiries
      for (const ch of chains) {
        const o = ch?.options?.[0]; if (!o) continue;
        const T = Math.max((o.expirationDate - nowSec) / 31557600, 0.5 / 365);
        const acc = (arr, sign, side) => { for (const c of arr || []) { const K = c.strike, OI = c.openInterest || 0, iv = c.impliedVolatility; if (!K || OI <= 0) continue; oiAgg[K] = oiAgg[K] || { c: 0, p: 0 }; oiAgg[K][side] += OI; if (!iv) continue; const g = bsGamma(spot, K, T, iv); byStrike[K] = (byStrike[K] || 0) + sign * g * OI * 100 * spot * spot * 0.01; } };
        acc(o.calls, 1, "c"); acc(o.puts, -1, "p");
      }
      let strikes = Object.keys(byStrike).map((k) => ({ strike: Number(k), net_gamma: Math.round(byStrike[k]) }));
      strikes.sort((a, b) => a.strike - b.strike);
      const net_gex = strikes.reduce((s, x) => s + x.net_gamma, 0);
      // window around spot for display (keeps the chart readable)
      const win = strikes.filter((x) => x.strike >= spot * 0.6 && x.strike <= spot * 1.4);
      const disp = win.length > 8 ? win : strikes;
      // gamma flip: strike where cumulative net gamma crosses zero (interpolated)
      let cum = 0, prevStrike = null, prevCum = 0, flip = null;
      for (const x of strikes) { const nc = cum + x.net_gamma; if (prevStrike != null && ((prevCum < 0 && nc >= 0) || (prevCum > 0 && nc <= 0))) { const t = Math.abs(prevCum) / (Math.abs(prevCum) + Math.abs(nc) || 1); flip = Math.round((prevStrike + t * (x.strike - prevStrike)) * 100) / 100; } prevStrike = x.strike; prevCum = nc; cum = nc; }
      let callWall = null, putWall = null;
      for (const x of strikes) {
        if (x.strike >= spot && x.net_gamma > 0 && (!callWall || x.net_gamma > callWall.net_gamma)) callWall = x;
        if (x.strike <= spot && x.net_gamma < 0 && (!putWall || x.net_gamma < putWall.net_gamma)) putWall = x;
      }
      if (callWall) callWall = { ...callWall, call_oi: oiAgg[callWall.strike]?.c ?? null };
      if (putWall) putWall = { ...putWall, put_oi: oiAgg[putWall.strike]?.p ?? null };

      // --- Open-interest positioning from the NEAREST expiration (max pain, OI-by-strike, put/call) ---
      const nearO = chains[0]?.options?.[0];
      const nearOI = {}; let totCall = 0, totPut = 0;
      if (nearO) {
        for (const c of nearO.calls || []) { if (c.strike && c.openInterest > 0) { nearOI[c.strike] = nearOI[c.strike] || { c: 0, p: 0 }; nearOI[c.strike].c += c.openInterest; totCall += c.openInterest; } }
        for (const p of nearO.puts || []) { if (p.strike && p.openInterest > 0) { nearOI[p.strike] = nearOI[p.strike] || { c: 0, p: 0 }; nearOI[p.strike].p += p.openInterest; totPut += p.openInterest; } }
      }
      const nearStrikes = Object.keys(nearOI).map(Number).sort((a, b) => a - b);
      // Max pain = settlement strike that minimizes total in-the-money payout to option holders
      let maxPain = null, minPay = Infinity;
      for (const K of nearStrikes) {
        let pay = 0;
        for (const s of nearStrikes) { const o = nearOI[s]; pay += o.c * Math.max(0, K - s) + o.p * Math.max(0, s - K); }
        if (pay < minPay) { minPay = pay; maxPain = K; }
      }
      const oi_strikes = nearStrikes.filter((s) => s >= spot * 0.75 && s <= spot * 1.25).map((s) => ({ strike: s, call_oi: nearOI[s].c, put_oi: nearOI[s].p }));
      return JSON.stringify({
        symbol: sym, spot: Math.round(spot * 100) / 100,
        expirations: chosen.map((e) => new Date(e * 1000).toISOString().slice(0, 10)),
        net_gex, gamma_flip: flip,
        call_wall: callWall, put_wall: putWall,
        strikes: disp,
        near_expiration: chosen[0] ? new Date(chosen[0] * 1000).toISOString().slice(0, 10) : null,
        max_pain: maxPain,
        put_call_ratio: totCall ? Math.round((totPut / totCall) * 100) / 100 : null,
        total_call_oi: totCall, total_put_oi: totPut,
        oi_strikes,
      }, null, 2);
    }

    case "expected_move": {
      const sym = String(args.symbol).toUpperCase();
      const spotData = await dxlinkCollect(env, [sym], { greeks: false, quote: true, timeoutMs: 5000 });
      const spot = mid(spotData[sym]?.bid ?? null, spotData[sym]?.ask ?? null);
      const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(sym)}/nested`);
      const chain = (data?.data?.items || [])[0];
      if (!chain) throw new Error(`No option chain for ${sym}.`);
      const exps = (chain.expirations || []).slice().sort((a, b) => a["days-to-expiration"] - b["days-to-expiration"]);
      const exp = args.expiration ? exps.find((e) => e["expiration-date"] === args.expiration) : exps.find((e) => e["days-to-expiration"] >= 1);
      if (!exp) throw new Error("No suitable expiration.");
      const strikes = exp.strikes.map((s) => ({ k: num(s["strike-price"]), c: s["call-streamer-symbol"], p: s["put-streamer-symbol"] }));
      const atm = spot != null ? strikes.reduce((best, s) => (Math.abs(s.k - spot) < Math.abs(best.k - spot) ? s : best), strikes[0]) : strikes[Math.floor(strikes.length / 2)];
      const q = await dxlinkCollect(env, [atm.c, atm.p].filter(Boolean), { greeks: false, quote: true, timeoutMs: 6000 });
      const callMid = mid(q[atm.c]?.bid ?? null, q[atm.c]?.ask ?? null);
      const putMid = mid(q[atm.p]?.bid ?? null, q[atm.p]?.ask ?? null);
      const straddle = callMid != null && putMid != null ? callMid + putMid : null;
      const em = straddle != null ? Math.round(straddle * 0.85 * 100) / 100 : null;
      return JSON.stringify(
        {
          symbol: sym, spot, expiration: exp["expiration-date"], dte: exp["days-to-expiration"], atm_strike: atm.k,
          straddle_mid: straddle, expected_move: em, expected_move_pct: em != null && spot ? Math.round((em / spot) * 1000) / 10 : null,
          range_low: spot != null && em != null ? Math.round((spot - em) * 100) / 100 : null,
          range_high: spot != null && em != null ? Math.round((spot + em) * 100) / 100 : null,
        },
        null,
        2,
      );
    }

    case "leaps_finder": {
      const top = args.top ?? 15;
      const targetDelta = args.target_delta != null ? Number(args.target_delta) : 0.7;
      let symbols;
      if (Array.isArray(args.symbols) && args.symbols.length) symbols = args.symbols.map((s) => String(s).toUpperCase());
      else if (args.name) {
        const w = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(args.name)}`)).data;
        symbols = (w["watchlist-entries"] || []).map((e) => e.symbol);
      } else throw new Error("Pass a watchlist `name` or a `symbols` array.");
      symbols = symbols.slice(0, 40);

      const metrics = await fetchMetrics(env, symbols);
      const mBy = {};
      for (const mm of metrics) mBy[mm.symbol] = mm;

      const cd = await dxlinkCandles(env, symbols, { days: 380, minCandles: 180, timeoutMs: 16000 });
      const sma = (a, n) => { if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; };
      const rsi = (a, p) => { if (a.length < p + 1) return null; let ag = 0, al = 0; for (let i = 1; i <= p; i++) { const d = a[i] - a[i - 1]; if (d > 0) ag += d; else al -= d; } ag /= p; al /= p; for (let i = p + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); };
      const stoch = (rows2, p) => { if (rows2.length < p) return null; const w = rows2.slice(-p); const hi = Math.max(...w.map((r) => r.high).filter((x) => x != null)); const lo = Math.min(...w.map((r) => r.low).filter((x) => x != null)); const c = rows2[rows2.length - 1].close; return hi > lo ? Math.round(((c - lo) / (hi - lo)) * 1000) / 10 : null; };

      const maxPctB = args.max_pct_b != null ? Number(args.max_pct_b) : 0.35; // gate: near the bottom of the Bollinger band
      const minBeta = args.min_beta != null ? Number(args.min_beta) : 2;      // gate: high-beta names only

      // Phase 1: compute BB %B + beta, apply the screen gates BEFORE the expensive lookups
      const survivors = [], excluded = [];
      for (const sym of symbols) {
        const rows2 = (cd[sym] || []).slice().sort((a, b) => a.time - b.time);
        const closes = rows2.map((r) => r.close).filter((c) => c != null);
        const bb = bollinger(rows2);
        const beta = mBy[sym]?.beta != null ? Math.round(parseFloat(mBy[sym].beta) * 100) / 100 : null;
        const inf = { price: closes.length ? closes[closes.length - 1] : null, bb, beta, sma50: sma(closes, 50), rsi14: rsi(closes, 14), stochK: stoch(rows2, 14), high52: rows2.length ? Math.max(...rows2.slice(-252).map((r) => r.high).filter((x) => x != null)) : null };
        const reasons = [];
        if (!(bb && bb.pct_b != null && bb.pct_b <= maxPctB)) reasons.push("not at bottom of BB (%B " + (bb ? bb.pct_b : "?") + " > " + maxPctB + ")");
        if (!(beta != null && beta >= minBeta)) reasons.push("beta " + (beta == null ? "?" : beta) + " < " + minBeta);
        if (reasons.length) excluded.push({ symbol: sym, pct_b: bb ? bb.pct_b : null, beta, reasons });
        else survivors.push({ sym, inf });
      }
      const survSyms = survivors.map((s) => s.sym);
      const infBy = {}; survivors.forEach((s) => (infBy[s.sym] = s.inf));

      // Phase 2 (survivors only): LEAPS contract + Yahoo fundamentals
      const meta = {}, callSyms = [], expBy = {};
      await Promise.all(survSyms.map(async (sym) => { try {
        const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(sym)}/nested`);
        const chain = (data?.data?.items || [])[0]; if (!chain) return;
        const leaps = (chain.expirations || []).filter((e) => e["days-to-expiration"] > 365);
        if (!leaps.length) return;
        leaps.sort((a, b) => Math.abs(a["days-to-expiration"] - 450) - Math.abs(b["days-to-expiration"] - 450));
        const exp = leaps[0]; expBy[sym] = exp;
        const spot = infBy[sym]?.price;
        for (const s of exp.strikes) { const k = num(s["strike-price"]); if (spot && (k < spot * 0.5 || k > spot * 1.05)) continue; const cs = s["call-streamer-symbol"]; if (cs) { meta[cs] = { sym, k }; callSyms.push(cs); } }
      } catch (e) {} }));
      const g = callSyms.length ? await dxlinkCollect(env, callSyms, { greeks: true, quote: true, timeoutMs: 14000 }) : {};
      const best = {};
      for (const cs of callSyms) { const r = g[cs]; if (!r || r.delta == null) continue; const m = meta[cs]; const diff = Math.abs(r.delta - targetDelta); if (!best[m.sym] || diff < best[m.sym].diff) best[m.sym] = { diff, strike: m.k, delta: r.delta, gamma: r.gamma ?? null, theta: r.theta ?? null, bid: r.bid ?? null, ask: r.ask ?? null }; }
      const fundBy = {};
      await Promise.all(survSyms.map(async (sym) => { try { const j = await yahooQuoteSummary(sym, "financialData,defaultKeyStatistics"); const rr = j?.quoteSummary?.result?.[0]; const f = rr?.financialData || {}, k = rr?.defaultKeyStatistics || {}; const price = infBy[sym]?.price; const t = f.targetMeanPrice?.raw; fundBy[sym] = { upside: t && price ? Math.round((t / price - 1) * 1000) / 10 : null, reco: f.recommendationKey, rev_growth: f.revenueGrowth?.raw != null ? Math.round(f.revenueGrowth.raw * 1000) / 10 : null, earn_growth: f.earningsGrowth?.raw != null ? Math.round(f.earningsGrowth.raw * 1000) / 10 : (k.earningsQuarterlyGrowth?.raw != null ? Math.round(k.earningsQuarterlyGrowth.raw * 1000) / 10 : null) }; } catch (e) { fundBy[sym] = {}; } }));

      // Phase 3: score + assemble
      const rows = [];
      for (const s of survivors) {
        const sym = s.sym, inf = s.inf, mm = mBy[sym] || {}, b = best[sym], exp = expBy[sym], fu = fundBy[sym] || {};
        const price = inf.price, pctB = inf.bb ? inf.bb.pct_b : null;
        const ivRank = mm["implied-volatility-index-rank"] != null ? Math.round(parseFloat(mm["implied-volatility-index-rank"]) * 1000) / 10 : null;
        const ivPct = mm["implied-volatility-percentile"] != null ? Math.round(parseFloat(mm["implied-volatility-percentile"]) * 1000) / 10 : null;
        const off52 = price != null && inf.high52 ? Math.round((price / inf.high52 - 1) * 1000) / 10 : null;
        let ernDate = null, ernDays = null; const ern = mm.earnings && mm.earnings["expected-report-date"]; if (ern) { ernDate = ern; ernDays = Math.round((Date.parse(ern) - Date.now()) / 86400000); }
        let contract = null;
        if (b && exp) {
          const midp = mid(b.bid, b.ask);
          const intrinsic = price != null ? Math.max(0, price - b.strike) : null;
          const extr = midp != null && intrinsic != null ? Math.round((midp - intrinsic) * 100) / 100 : null;
          const extrPct = extr != null && midp ? Math.round((extr / midp) * 1000) / 10 : null;
          const be = midp != null ? Math.round((b.strike + midp) * 100) / 100 : null;
          const bePct = be != null && price ? Math.round((be / price - 1) * 1000) / 10 : null;
          const lev = midp && price ? Math.round((price * b.delta / midp) * 10) / 10 : null;
          const exitT = (pct) => {
            if (midp == null || b.delta == null || b.delta <= 0 || price == null) return null;
            const gain = midp * pct; // required option-value gain (theta over a couple weeks is minor for a LEAP)
            // solve delta*dS + 0.5*gamma*dS^2 = gain (gamma accelerates gains as the stock rises)
            let dS;
            if (b.gamma != null && b.gamma > 0) dS = (-b.delta + Math.sqrt(b.delta * b.delta + 2 * b.gamma * gain)) / b.gamma;
            else dS = gain / b.delta;
            return { stock: Math.round((price + dS) * 100) / 100, move_pct: Math.round((dS / price) * 1000) / 10 };
          };
          contract = { expiration: exp["expiration-date"], dte: exp["days-to-expiration"], strike: b.strike, delta: Math.round(b.delta * 100) / 100, cost: midp, intrinsic: intrinsic != null ? Math.round(intrinsic * 100) / 100 : null, extrinsic: extr, extrinsic_pct: extrPct, breakeven: be, breakeven_pct: bePct, leverage: lev, exit_10_15: exitT(0.1), exit_20_30: exitT(0.2) };
        }
        let score = 0;
        if (pctB != null) score += pctB <= 0.05 ? 30 : pctB <= 0.15 ? 24 : pctB <= 0.25 ? 16 : pctB <= 0.35 ? 8 : 0; // bottom of BB = primary
        const fg = fu.earn_growth, rg = fu.rev_growth;
        if (fg != null || rg != null) { let fs = 0; if (fg != null) fs += fg > 25 ? 14 : fg > 0 ? 8 : 0; if (rg != null) fs += rg > 15 ? 11 : rg > 0 ? 6 : 0; score += Math.min(25, fs); }
        if (fu.upside != null) score += fu.upside >= 25 ? 20 : fu.upside >= 10 ? 13 : fu.upside > 0 ? 6 : 0;
        if (ivPct != null) score += ivPct <= 30 ? 15 : ivPct <= 50 ? 9 : ivPct <= 70 ? 4 : 0;
        if (inf.rsi14 != null) score += (inf.rsi14 >= 35 && inf.rsi14 <= 60) ? 10 : (inf.rsi14 >= 30 && inf.rsi14 < 70) ? 5 : 0;
        rows.push({ symbol: sym, score, price: price != null ? Math.round(price * 100) / 100 : null, pct_b: pctB, bb_zone: pctB == null ? null : pctB <= 0.15 ? "at bottom" : pctB <= 0.35 ? "lower/mid" : "upper", lower_bb: inf.bb ? inf.bb.lower : null, mid_bb: inf.bb ? inf.bb.mid : null, upper_bb: inf.bb ? inf.bb.upper : null, beta: inf.beta, off_52w_high_pct: off52, iv_rank: ivRank, iv_percentile: ivPct, premium: ivPct == null ? null : ivPct <= 30 ? "cheap" : ivPct >= 70 ? "rich" : "fair", rsi: inf.rsi14 != null ? Math.round(inf.rsi14 * 10) / 10 : null, stoch_k: inf.stochK, eps_growth_pct: fu.earn_growth ?? null, rev_growth_pct: fu.rev_growth ?? null, analyst_upside_pct: fu.upside ?? null, recommendation: fu.reco ?? null, earnings_date: ernDate, earnings_in_days: ernDays, leaps: contract });
      }
      rows.sort((a, b) => b.score - a.score);
      return JSON.stringify({ target_delta: targetDelta, rules: { max_pct_b: maxPctB, min_beta: minBeta }, note: "Screen rules: LEAPS only at/near the BOTTOM of the Bollinger band (%B <= " + maxPctB + ") AND beta >= " + minBeta + ", favoring strong revenue/EPS growth. Each row has the ~" + targetDelta + "-delta call >365 DTE. Names failing the gates are in 'excluded' with reasons.", ranked: rows.slice(0, top), excluded: excluded.slice(0, 25) }, null, 2);
    }

    case "price_calculator": {
      const sym = String(args.symbol).toUpperCase();
      const tr = args.target_return_pct != null ? Number(args.target_return_pct) : 20;
      const j = await yahooQuoteSummary(sym, "financialData,defaultKeyStatistics,price");
      const r = j?.quoteSummary?.result?.[0];
      if (!r) return JSON.stringify({ symbol: sym, error: "No Yahoo data." }, null, 2);
      const f = r.financialData || {}, k = r.defaultKeyStatistics || {}, p = r.price || {};
      const price = f.currentPrice?.raw ?? p.regularMarketPrice?.raw ?? null;
      const target = f.targetMeanPrice?.raw ?? null;
      const fwdEps = k.forwardEps?.raw ?? null, fwdPe = k.forwardPE?.raw ?? null;
      const fairValue = fwdEps != null && fwdPe != null ? Math.round(fwdEps * fwdPe * 100) / 100 : null;
      const anchor = target != null ? target : fairValue;
      const entry = anchor != null ? Math.round((anchor / (1 + tr / 100)) * 100) / 100 : null;
      const discount = entry != null && price ? Math.round((1 - entry / price) * 1000) / 10 : null;
      return JSON.stringify({ symbol: sym, current_price: price, analyst_target: target, fair_value_fwd: fairValue, target_return_pct: tr, projection_anchor: anchor, entry_price_for_target: entry, discount_to_current_pct: discount, note: "entry = anchor/(1+return). Positive discount = the entry is below current price (a dip to wait for); negative = current price already below the entry." }, null, 2);
    }

    case "options_sentiment": {
      const sym = String(args.symbol).toUpperCase();
      const spotData = await dxlinkCollect(env, [sym], { greeks: false, quote: true, timeoutMs: 5000 });
      const spot = mid(spotData[sym]?.bid ?? null, spotData[sym]?.ask ?? null);
      const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(sym)}/nested`);
      const chain = (data?.data?.items || [])[0];
      if (!chain) throw new Error(`No option chain for ${sym}.`);
      const exps = (chain.expirations || []).slice().sort((a, b) => a["days-to-expiration"] - b["days-to-expiration"]);
      const exp = exps.find((e) => e["days-to-expiration"] >= 20) || exps[exps.length - 1];
      const meta = {}, syms = [];
      for (const s of exp.strikes) {
        const kk = num(s["strike-price"]);
        if (spot && (kk < spot * 0.8 || kk > spot * 1.2)) continue;
        if (s["call-streamer-symbol"]) { meta[s["call-streamer-symbol"]] = { k: kk, t: "C" }; syms.push(s["call-streamer-symbol"]); }
        if (s["put-streamer-symbol"]) { meta[s["put-streamer-symbol"]] = { k: kk, t: "P" }; syms.push(s["put-streamer-symbol"]); }
      }
      const g = await dxlinkCollect(env, syms, { greeks: true, quote: false, timeoutMs: 12000 });
      let put25 = null, call25 = null, atm = null;
      for (const s of syms) {
        const rr = g[s];
        if (!rr || rr.delta == null || rr.iv == null) continue;
        const mm = meta[s];
        if (mm.t === "P") { if (!put25 || Math.abs(Math.abs(rr.delta) - 0.25) < Math.abs(Math.abs(put25.d) - 0.25)) put25 = { d: rr.delta, iv: rr.iv }; }
        else { if (!call25 || Math.abs(rr.delta - 0.25) < Math.abs(call25.d - 0.25)) call25 = { d: rr.delta, iv: rr.iv }; }
        if (spot && (!atm || Math.abs(mm.k - spot) < Math.abs(atm.k - spot))) atm = { k: mm.k, iv: rr.iv };
      }
      const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
      const skew = put25 && call25 ? Math.round((put25.iv - call25.iv) * 1000) / 10 : null;
      const sig = skew == null ? "n/a" : skew > 3 ? "put-skewed (downside fear / rich put premium)" : skew < -3 ? "call-skewed (upside chase)" : "balanced";
      return JSON.stringify({ symbol: sym, expiration: exp["expiration-date"], dte: exp["days-to-expiration"], spot, atm_iv_pct: pct(atm && atm.iv), put_25d_iv_pct: pct(put25 && put25.iv), call_25d_iv_pct: pct(call25 && call25.iv), skew_pts: skew, signal: sig }, null, 2);
    }

    case "instant_analyzer": {
      const sym = String(args.symbol).toUpperCase();
      const rules = Array.isArray(args.rules) ? args.rules : [];
      const m = {};
      try { const mm = (await fetchMetrics(env, [sym]))[0]; if (mm) { const v = mm["implied-volatility-index-rank"]; m.iv_rank = v != null ? Math.round(parseFloat(v) * 1000) / 10 : null; m.beta = mm.beta != null ? Math.round(parseFloat(mm.beta) * 1000) / 1000 : null; } } catch (e) {}
      try { const cdd = await dxlinkCandles(env, [sym], {}); const b = bollinger(cdd[sym] || []); if (b) { m.pct_b = b.pct_b; m.price = b.price; } } catch (e) {}
      try { const j = await yahooQuoteSummary(sym, "financialData,defaultKeyStatistics,price"); const r = j?.quoteSummary?.result?.[0]; if (r) { const f = r.financialData || {}, k = r.defaultKeyStatistics || {}; const price = f.currentPrice?.raw ?? r.price?.regularMarketPrice?.raw; const tgt = f.targetMeanPrice?.raw; m.analyst_upside_pct = tgt && price ? Math.round((tgt / price - 1) * 1000) / 10 : null; m.forward_pe = k.forwardPE?.raw ?? null; if (m.price == null && price) m.price = price; } } catch (e) {}
      const cmp = (a, op, b) => { if (a == null) return false; a = Number(a); b = Number(b); return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : op === "==" ? a === b : false; };
      const results = rules.map((rl) => ({ metric: rl.metric, op: rl.op, value: rl.value, actual: m[rl.metric] ?? null, pass: cmp(m[rl.metric], rl.op, rl.value) }));
      const passAll = results.length ? results.every((x) => x.pass) : null;
      return JSON.stringify({ symbol: sym, pass: passAll, metrics: m, rules: results }, null, 2);
    }

    case "get_transaction_history": {
      const { items, pagination } = await fetchTransactions(env, {
        underlying: args.underlying,
        start: args.start_date,
        end: args.end_date,
        action: args.action,
        perPage: Math.min(args.limit || 100, 250),
      });
      return JSON.stringify(
        { count: items.length, total_available: pagination["total-items"], transactions: items.map(cleanTx) },
        null,
        2,
      );
    }

    case "get_realized_pnl": {
      const { items } = await fetchTransactions(env, { underlying: args.underlying, start: args.opened_after, perPage: 250 });
      const { closed, totalRealized } = matchRealizedPnl(items);
      return JSON.stringify(
        {
          underlying: String(args.underlying).toUpperCase(),
          closed_trades: closed.length,
          total_realized_pnl: totalRealized,
          note: "realized_pnl is fee-inclusive (from net-value). ror_pct = realized_pnl / (entry_price * quantity * 100 for options, *1 for equity).",
          trades: closed,
        },
        null,
        2,
      );
    }

    case "scan_watchlist_for_csp": {
      const target = args.target_delta != null ? Number(args.target_delta) : -0.30;
      const dteMin = args.dte_min ?? 21;
      const dteMax = args.dte_max ?? 31;
      const dteMid = (dteMin + dteMax) / 2;
      const top = args.top ?? 15;
      const minIv = args.min_iv_rank ?? 20;
      const maxSym = Math.min(args.max_symbols ?? 20, 25);

      // 1) symbols from watchlist or explicit list
      let symbols;
      if (Array.isArray(args.symbols) && args.symbols.length) {
        symbols = args.symbols.map((s) => String(s).toUpperCase());
      } else if (args.name) {
        const w = (await ttFetch(env, "GET", `/watchlists/${encodeURIComponent(args.name)}`)).data;
        symbols = (w["watchlist-entries"] || []).map((e) => e.symbol);
      } else {
        throw new Error("Pass a watchlist `name` or a `symbols` array.");
      }

      // 2) IV-rank pre-filter (one batched REST call) — focus on rich-premium names
      const ranked = scanRows(await fetchMetrics(env, symbols), minIv).slice(0, maxSym);
      const candSyms = ranked.map((r) => r.symbol);
      const ivBySym = Object.fromEntries(ranked.map((r) => [r.symbol, r.iv_rank]));
      if (!candSyms.length) {
        return JSON.stringify({ note: `No names with IV rank >= ${minIv} in this list.`, results: [] }, null, 2);
      }

      // 3) spot prices via DXLink quotes on the tickers
      const spotData = await dxlinkCollect(env, candSyms, { greeks: false, quote: true, timeoutMs: 6000 });

      // 4) fetch chains (parallel) and pick a put strike band around the ~30-delta zone
      const meta = {};
      const allPuts = [];
      await Promise.all(
        candSyms.map(async (sym) => {
          try {
            const data = await ttFetch(env, "GET", `/option-chains/${encodeURIComponent(sym)}/nested`);
            const chain = (data?.data?.items || [])[0];
            if (!chain) return;
            const cand = (chain.expirations || []).filter((e) => e["days-to-expiration"] >= dteMin && e["days-to-expiration"] <= dteMax);
            if (!cand.length) return;
            cand.sort((a, b) => Math.abs(a["days-to-expiration"] - dteMid) - Math.abs(b["days-to-expiration"] - dteMid));
            const exp = cand[0];
            const spot = mid(spotData[sym]?.bid ?? null, spotData[sym]?.ask ?? null);
            let strikes = exp.strikes.filter((s) => s["put-streamer-symbol"]);
            if (spot) strikes = strikes.filter((s) => { const k = num(s["strike-price"]); return k >= spot * 0.65 && k <= spot * 1.0; });
            for (const s of strikes) {
              const st = s["put-streamer-symbol"];
              meta[st] = { sym, strike: num(s["strike-price"]), dte: exp["days-to-expiration"], exp: exp["expiration-date"] };
              allPuts.push(st);
            }
          } catch (e) { /* skip this symbol */ }
        }),
      );

      // 5) one greeks/quote pass across all candidate puts, then pick nearest-delta per name
      const gdata = allPuts.length ? await dxlinkCollect(env, allPuts, { greeks: true, quote: true, timeoutMs: 13000 }) : {};
      const best = {};
      for (const st of allPuts) {
        const r = gdata[st];
        if (!r || r.delta == null) continue;
        const m = meta[st];
        const diff = Math.abs(r.delta - target);
        if (!best[m.sym] || diff < best[m.sym].diff) best[m.sym] = { diff, ...m, delta: r.delta, bid: r.bid ?? null, ask: r.ask ?? null, iv: r.iv ?? null };
      }
      const results = Object.values(best)
        .map((b) => {
          const premium = mid(b.bid, b.ask);
          const ror = premium && b.strike - premium > 0 ? Math.round((premium / (b.strike - premium)) * 10000) / 100 : null;
          const annual = ror != null && b.dte ? Math.round((ror * 365 / b.dte) * 100) / 100 : null;
          return {
            symbol: b.sym, iv_rank: ivBySym[b.sym] ?? null, expiration: b.exp, dte: b.dte,
            strike: b.strike, delta: Math.round(b.delta * 1000) / 1000, premium,
            ror_pct: ror, ror_annualized_pct: annual,
          };
        })
        .filter((r) => r.ror_pct != null)
        .sort((a, b) => (b.ror_annualized_pct ?? -1) - (a.ror_annualized_pct ?? -1));

      return JSON.stringify(
        { target_delta: target, dte_window: `${dteMin}-${dteMax}`, screened: candSyms.length, ranked_by: "ror_annualized_pct", results: results.slice(0, top) },
        null,
        2,
      );
    }

    case "get_position_greeks": {
      const acct = await getAccountNumber(env);
      const positions = (await ttFetch(env, "GET", `/accounts/${acct}/positions`)).data.items || [];
      const optionPos = positions.filter((p) => p["instrument-type"] === "Equity Option");
      const symMap = {};
      for (const p of optionPos) symMap[occToStreamer(p.symbol)] = p;
      const streamers = Object.keys(symMap);
      const gdata = streamers.length ? await dxlinkCollect(env, streamers, { greeks: true, quote: true }) : {};
      const net = { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const rows = streamers.map((st) => {
        const p = symMap[st];
        const g = gdata[st] || {};
        const mult = (num(p.quantity) || 0) * (p["quantity-direction"] === "Long" ? 1 : -1) * 100;
        const pd = g.delta != null ? g.delta * mult : null;
        const pt = g.theta != null ? g.theta * mult : null;
        const pg = g.gamma != null ? g.gamma * mult : null;
        const pv = g.vega != null ? g.vega * mult : null;
        if (pd != null) net.delta += pd;
        if (pt != null) net.theta += pt;
        if (pg != null) net.gamma += pg;
        if (pv != null) net.vega += pv;
        return {
          symbol: p.symbol,
          direction: p["quantity-direction"],
          quantity: p.quantity,
          delta: g.delta ?? null,
          position_delta: pd != null ? Math.round(pd * 100) / 100 : null,
          position_theta: pt != null ? Math.round(pt * 100) / 100 : null,
          position_vega: pv != null ? Math.round(pv * 100) / 100 : null,
          mark: mid(g.bid ?? null, g.ask ?? null),
        };
      });
      const stock = positions
        .filter((p) => p["instrument-type"] === "Equity")
        .map((p) => ({ symbol: p.symbol, shares: p.quantity, direction: p["quantity-direction"] }));
      const stockDelta = stock.reduce((a, s) => a + (num(s.shares) || 0) * (s.direction === "Long" ? 1 : -1), 0);
      return JSON.stringify(
        {
          net_greeks: {
            delta: Math.round((net.delta + stockDelta) * 100) / 100,
            theta: Math.round(net.theta * 100) / 100,
            gamma: Math.round(net.gamma * 1000) / 1000,
            vega: Math.round(net.vega * 100) / 100,
            note: "delta in share-equivalents; includes stock (1 delta/share). theta/vega are per-1% / per-day dollar estimates.",
          },
          option_positions: rows,
          stock_positions: stock,
        },
        null,
        2,
      );
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC + MCP message handling
// ---------------------------------------------------------------------------

function jsonrpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcpMessage(msg, env) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return jsonrpcResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonrpcResponse(id, {});
    case "tools/list":
      return jsonrpcResponse(id, { tools: TOOLS });
    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const text = await executeTool(toolName, toolArgs, env);
        return jsonrpcResponse(id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return jsonrpcResponse(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// CORS + sessions
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsResponse(status, body, extraHeaders = {}) {
  return new Response(body, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

// ---------------------------------------------------------------------------
// Endpoint auth (fail closed, constant-time compare)
// ---------------------------------------------------------------------------

// Tokens shorter than this count as "not configured", so placeholders like
// "changeme" keep the door locked. Generate one with: openssl rand -hex 32
const MIN_AUTH_TOKEN_LENGTH = 32;
const AUTH_ENCODER = new TextEncoder();

async function sha256Bytes(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", AUTH_ENCODER.encode(s)));
}

// Hash both sides so they are always 32 bytes, then compare every byte with no
// early exit. Timing reveals neither the match length nor the secret's length.
async function timingSafeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function checkBearer(authorization, secret) {
  if (typeof secret !== "string" || secret.trim().length < MIN_AUTH_TOKEN_LENGTH) {
    return { ok: false, reason: "secret_unset" };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization || "");
  if (!match) return { ok: false, reason: "missing_header" };
  return (await timingSafeEqual(match[1], secret.trim())) ? { ok: true } : { ok: false, reason: "bad_token" };
}

function generateSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const sessions = new Set();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsResponse(204, null);

    if (url.pathname === "/" || url.pathname === "/health") {
      return corsResponse(200, JSON.stringify({ status: "ok", server: MCP_SERVER_NAME }), {
        "Content-Type": "application/json",
      });
    }

    if (url.pathname === MCP_ENDPOINT) {
      // Endpoint auth fails closed: no configured token means nobody gets in.
      // Bearer header only (no ?key= query token: URLs end up in logs and
      // browser history), compared in constant time.
      const auth = await checkBearer(request.headers.get("Authorization"), env.MCP_AUTH_TOKEN);
      if (!auth.ok) {
        const status = auth.reason === "secret_unset" ? 503 : 401;
        const error = status === 503 ? "Server not configured: MCP_AUTH_TOKEN is unset or too short" : "Unauthorized";
        return corsResponse(status, JSON.stringify({ error }), {
          "Content-Type": "application/json",
          ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
        });
      }

      if (request.method === "DELETE") {
        const sid = request.headers.get("Mcp-Session-Id");
        if (sid) sessions.delete(sid);
        return corsResponse(200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
      }
      if (request.method === "GET") {
        return corsResponse(405, JSON.stringify({ error: "SSE stream not supported; use POST" }), {
          "Content-Type": "application/json",
        });
      }
      if (request.method !== "POST") return corsResponse(405, "Method not allowed");

      let body;
      try {
        body = await request.json();
      } catch {
        return corsResponse(400, JSON.stringify(jsonrpcError(null, -32700, "Parse error")), {
          "Content-Type": "application/json",
        });
      }

      const isInitialize = Array.isArray(body)
        ? body.some((m) => m.method === "initialize")
        : body.method === "initialize";

      let sessionId = request.headers.get("Mcp-Session-Id");
      if (isInitialize) {
        sessionId = generateSessionId();
        sessions.add(sessionId);
      } else if (sessionId && !sessions.has(sessionId)) {
        sessions.add(sessionId); // re-register after cold start
      }

      const messages = Array.isArray(body) ? body : [body];
      const results = [];
      for (const msg of messages) {
        const result = await handleMcpMessage(msg, env);
        if (result !== null) results.push(result);
      }

      if (results.length === 0) {
        return corsResponse(202, null, { "Mcp-Session-Id": sessionId || "" });
      }
      const responseBody = Array.isArray(body) ? results : results[0];
      return corsResponse(200, JSON.stringify(responseBody), {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId || "",
      });
    }

    return corsResponse(404, JSON.stringify({ error: "Not found" }), { "Content-Type": "application/json" });
  },
};
