// Offline tests for the Cloudflare Worker. Run: npm test (or node --test test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadWorker, callTool, mcp, fixture, fakeTastytrade } from "./harness.mjs";

// The endpoint fails closed, so every env that should answer carries a token
// of at least 32 characters, and every request sends it.
const TOKEN = "test".padEnd(40, "-0"); // synthetic bearer token, 40 chars
const AUTH = { token: TOKEN };
const OFF = { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: TOKEN };
const LIVE_AUTH = { LIVE_TRADING_ENABLED: "true", MCP_AUTH_TOKEN: TOKEN };
// `const` bindings are not context properties; read them through the VM.
const vmGet = (ctx, expr) => vm.runInContext(expr, ctx);

const STOCK = { symbol: "AAPL", quantity: 1, limit_price: 150, action: "BUY_TO_OPEN" };

// ---------------- tool surface ----------------
test("exposes 42 uniquely named tools, each with an input schema", () => {
  const { ctx } = loadWorker();
  const tools = vmGet(ctx, "TOOLS");
  assert.equal(tools.length, 42);
  assert.equal(new Set(tools.map((t) => t.name)).size, 42);
  for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
});

test("every live-capable tool says so in its description", () => {
  const { ctx } = loadWorker();
  const tools = vmGet(ctx, "TOOLS");
  for (const name of ["place_order", "place_option_order", "place_spread"]) {
    const d = tools.find((t) => t.name === name).description;
    assert.match(d, /LIVE_TRADING_ENABLED=true/);
    assert.match(d, /MCP_AUTH_TOKEN/);
    assert.match(d, /CONFIRM/);
  }
});

// ---------------- safety model ----------------
test("default: place_order dry-runs and places nothing", async () => {
  const w = loadWorker();
  const r = await callTool(w.worker, OFF, "place_order", { ...STOCK, confirm: "CONFIRM" }, AUTH);
  assert.equal(r.data.status, "DRY_RUN_ONLY");
  assert.equal(w.dryRunPosts().length, 1);
  assert.equal(w.liveOrderPosts().length, 0);
});

test("env var missing entirely is treated as off", async () => {
  const w = loadWorker();
  const r = await callTool(w.worker, { MCP_AUTH_TOKEN: TOKEN }, "place_order", { ...STOCK, confirm: "CONFIRM" }, AUTH);
  assert.equal(r.data.status, "DRY_RUN_ONLY");
  assert.equal(w.liveOrderPosts().length, 0);
});

test("fail-closed: live enabled but MCP_AUTH_TOKEN unset -> endpoint 503, nothing reaches the broker", async () => {
  const w = loadWorker();
  const r = await callTool(w.worker, { LIVE_TRADING_ENABLED: "true" }, "place_order", { ...STOCK, confirm: "CONFIRM" }, AUTH);
  assert.equal(r.status, 503);
  assert.equal(w.calls.length, 0, "no broker call at all");
});

test("defense in depth: safePlace itself still refuses live without MCP_AUTH_TOKEN (BLOCKED)", async () => {
  const w = loadWorker();
  const order = w.ctx.buildOrder(w.ctx.equityLeg("AAPL", 1, "BUY_TO_OPEN"), "BUY_TO_OPEN", 150);
  const r = await w.ctx.safePlace({ LIVE_TRADING_ENABLED: "true" }, order, "CONFIRM");
  assert.equal(r.status, "BLOCKED");
  assert.equal(w.liveOrderPosts().length, 0);
});

test("live + auth but no exact confirm -> NEEDS_CONFIRMATION", async () => {
  for (const confirm of [undefined, "", "confirm", "yes", "CONFIRM "]) {
    const w = loadWorker();
    const r = await callTool(w.worker, LIVE_AUTH, "place_order", { ...STOCK, confirm }, AUTH);
    assert.equal(r.data.status, "NEEDS_CONFIRMATION", String(confirm));
    assert.equal(w.liveOrderPosts().length, 0);
  }
});

test("all three gates open -> exactly one live POST, after the dry-run", async () => {
  const w = loadWorker();
  const r = await callTool(w.worker, LIVE_AUTH, "place_order", { ...STOCK, confirm: "CONFIRM" }, AUTH);
  assert.equal(r.data.status, "PLACED");
  assert.equal(r.data.order_id, 900001);
  const posts = w.calls.filter((c) => c.method === "POST" && c.url.includes("/orders"));
  assert.deepEqual(posts.map((c) => (c.url.endsWith("dry-run") ? "dry" : "live")), ["dry", "live"]);
  assert.deepEqual(posts[0].body, posts[1].body, "the live order is byte-identical to the dry-run order");
});

test("preview_* tools never place, even with every gate open", async () => {
  const w = loadWorker();
  const legs = [
    { strike: 185, option_type: "P", action: "SELL_TO_OPEN", quantity: 1 },
    { strike: 180, option_type: "P", action: "BUY_TO_OPEN", quantity: 1 },
  ];
  const calls = [
    ["preview_order", STOCK],
    ["preview_option_order", { underlying: "AAPL", expiration: "2026-12-18", strike: 185, option_type: "P", quantity: 1, limit_price: 3.2, action: "SELL_TO_OPEN" }],
    ["preview_spread", { underlying: "AAPL", expiration: "2026-12-18", net_price: 1.1, price_effect: "CREDIT", legs }],
  ];
  for (const [name, args] of calls) {
    const r = await callTool(w.worker, LIVE_AUTH, name, { ...args, confirm: "CONFIRM" }, AUTH);
    assert.equal(r.data.status, "DRY_RUN_ONLY", name);
  }
  assert.equal(w.liveOrderPosts().length, 0);
});

test("a rejected dry-run aborts before any live call", async () => {
  const w = loadWorker({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/orders/dry-run")) return new Response('{"error":"rejected"}', { status: 422 });
      return fakeTastytrade(url, init);
    },
  });
  const r = await callTool(w.worker, LIVE_AUTH, "place_order", { ...STOCK, confirm: "CONFIRM" }, AUTH);
  assert.equal(r.isError, true);
  assert.match(r.text, /422/);
  assert.equal(w.liveOrderPosts().length, 0);
});

test("liveEnabled accepts only the string true (any case)", () => {
  const { ctx } = loadWorker();
  for (const v of ["true", "TRUE", "True"]) assert.equal(ctx.liveEnabled({ LIVE_TRADING_ENABLED: v }), true, v);
  for (const v of ["false", "1", "yes", "on", "", undefined, " true"]) assert.equal(ctx.liveEnabled({ LIVE_TRADING_ENABLED: v }), false, String(v));
});

// ---------------- endpoint auth ----------------
test("with MCP_AUTH_TOKEN set, /mcp rejects missing or wrong tokens", async () => {
  const { worker } = loadWorker();
  assert.equal((await mcp(worker, LIVE_AUTH, "tools/list", {})).status, 401);
  assert.equal((await mcp(worker, LIVE_AUTH, "tools/list", {}, { token: "wrong" })).status, 401);
  assert.equal((await mcp(worker, LIVE_AUTH, "tools/list", {}, { token: TOKEN + "x" })).status, 401);
  const ok = await mcp(worker, LIVE_AUTH, "tools/list", {}, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.tools.length, 42);
});

test("fail closed: MCP_AUTH_TOKEN unset, blank or short -> 503 for every caller", async () => {
  const { worker } = loadWorker();
  for (const secret of [undefined, "", "   ", "changeme", "x".repeat(31)]) {
    const env = { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: secret };
    assert.equal((await mcp(worker, env, "tools/list", {})).status, 503, String(secret));
    assert.equal((await mcp(worker, env, "tools/list", {}, { token: secret || "anything" })).status, 503, String(secret));
  }
});

test("the ?key= query token is not accepted", async () => {
  const { worker } = loadWorker();
  const req = new Request(`https://tastytrade-mcp.example.workers.dev/mcp?key=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal((await worker.fetch(req, LIVE_AUTH)).status, 401);
});

test("checkBearer: scheme is case-insensitive, token must match exactly", async () => {
  const { ctx } = loadWorker();
  assert.equal((await ctx.checkBearer(`bearer ${TOKEN}`, TOKEN)).ok, true);
  assert.equal((await ctx.checkBearer(TOKEN, TOKEN)).reason, "missing_header");
  assert.equal((await ctx.checkBearer(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).reason, "bad_token");
  assert.equal(await ctx.timingSafeEqual("abc", "abc"), true);
  assert.equal(await ctx.timingSafeEqual("abc", "abd"), false);
});

test("initialize returns protocol version and a session id", async () => {
  const { worker } = loadWorker();
  const r = await mcp(worker, OFF, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }, AUTH);
  assert.equal(r.body.result.protocolVersion, "2025-03-26");
  assert.match(r.sessionId, /^[0-9a-f]{32}$/);
});

// ---------------- debit / credit derivation ----------------
test("single-leg orders: positive price, effect derived from action", () => {
  const { ctx } = loadWorker();
  const leg = ctx.equityLeg("aapl", 1, "BUY_TO_OPEN");
  assert.equal(leg.symbol, "AAPL");
  assert.equal(leg.action, "Buy to Open");
  const cases = [
    ["BUY_TO_OPEN", "Debit"], ["BUY_TO_CLOSE", "Debit"],
    ["SELL_TO_OPEN", "Credit"], ["SELL_TO_CLOSE", "Credit"],
  ];
  for (const [action, effect] of cases) {
    const o = ctx.buildOrder(leg, action, -2.5); // a negative input cannot flip the effect
    assert.equal(o["price-effect"], effect, action);
    assert.equal(o.price, "2.5");
    assert.equal(o["order-type"], "Limit");
  }
});

test("normAction rejects unknown actions and defaults to BUY_TO_OPEN", () => {
  const { ctx } = loadWorker();
  assert.equal(ctx.normAction(undefined), "BUY_TO_OPEN");
  assert.equal(ctx.normAction("sell_to_open"), "SELL_TO_OPEN");
  assert.throws(() => ctx.normAction("SELL_SHORT"), /Unknown action/);
});

test("spreads: explicit DEBIT/CREDIT, anything else rejected", () => {
  const { ctx } = loadWorker();
  assert.equal(ctx.buildSpreadOrder([], 1.1, "credit")["price-effect"], "Credit");
  assert.equal(ctx.buildSpreadOrder([], -1.1, "DEBIT").price, "1.1");
  assert.throws(() => ctx.buildSpreadOrder([], 1.1, "EVEN"), /DEBIT or CREDIT/);
});

test("spread legs resolve to OCC symbols from one chain fetch", async () => {
  const w = loadWorker();
  const legs = await w.ctx.resolveSpreadLegs({}, "AAPL", [
    { strike: 185, option_type: "P", action: "SELL_TO_OPEN", quantity: 1 },
    { strike: 180, option_type: "PUT", action: "BUY_TO_OPEN", quantity: 1 },
    { strike: 190, option_type: "C", action: "SELL_TO_OPEN", quantity: 1, expiration: "2027-01-15" },
  ], "2026-12-18");
  assert.deepEqual(legs.map((l) => l.symbol), ["AAPL  261218P00185000", "AAPL  261218P00180000", "AAPL  270115C00190000"]);
  assert.equal(w.calls.filter((c) => c.url.includes("/option-chains/")).length, 1);
  await assert.rejects(w.ctx.resolveSpreadLegs({}, "AAPL", [{ strike: 185, option_type: "P", action: "SELL_TO_OPEN", quantity: 1 }], "2026-12-18"), /at least 2 legs/);
  await assert.rejects(w.ctx.resolveSpreadLegs({}, "AAPL", [
    { strike: 999, option_type: "P", action: "SELL_TO_OPEN", quantity: 1 },
    { strike: 180, option_type: "P", action: "BUY_TO_OPEN", quantity: 1 },
  ], "2026-12-18"), /No strike 999/);
});

// ---------------- symbol parsing ----------------
test("occToStreamer converts OCC symbols to DXLink streamer symbols", () => {
  const { ctx } = loadWorker();
  assert.equal(ctx.occToStreamer("AAPL  260724C00320000"), ".AAPL260724C320");
  assert.equal(ctx.occToStreamer("SPY   261218P00450500"), ".SPY261218P450.5");
  assert.equal(ctx.occToStreamer("KO    261218C00070000"), ".KO261218C70");
});

// ---------------- realized P&L matching ----------------
test("matchRealizedPnl pairs opens with closes, fee-inclusive, closed symbols only", () => {
  const { ctx } = loadWorker();
  const { closed, totalRealized } = ctx.matchRealizedPnl(fixture("transactions.json").data.items);
  const by = Object.fromEntries(closed.map((c) => [c.symbol, c]));
  assert.deepEqual(Object.keys(by).sort(), ["AAPL  261218P00185000", "MSFT"]);

  const put = by["AAPL  261218P00185000"];
  assert.equal(put.realized_pnl, 237.72); // 318.86 credit - 81.14 debit
  assert.equal(put.entry_price, 3.2);
  assert.equal(put.exit_price, 0.8);
  assert.equal(put.ror_pct, 74.29); // 237.72 / (3.20 * 1 * 100)
  assert.equal(put.holding_period_days, 25);

  const stock = by.MSFT;
  assert.equal(stock.realized_pnl, 99.95);
  assert.equal(stock.ror_pct, 2.5); // equity multiplier is 1

  assert.equal(totalRealized, 337.67);
  assert.equal(closed[0].symbol, "AAPL  261218P00185000", "most recent close first");
});

test("get_realized_pnl tool wraps the matcher", async () => {
  const w = loadWorker();
  const r = await callTool(w.worker, OFF, "get_realized_pnl", { underlying: "aapl" }, AUTH);
  assert.equal(r.data.underlying, "AAPL");
  assert.equal(r.data.total_realized_pnl, 337.67);
});

// ---------------- technicals + structure engine ----------------
test("bollinger: needs 20 closes, null %B on a flat series, below 0.5 under the mean", () => {
  const { ctx } = loadWorker();
  const rows = (closes) => closes.map((c, i) => ({ time: i, close: c }));
  assert.equal(ctx.bollinger(rows(Array(19).fill(100))), null);
  assert.equal(ctx.bollinger(rows(Array(20).fill(100))).pct_b, null);
  const alt = Array.from({ length: 21 }, (_, i) => (i % 2 ? 101 : 99)); // ends at 99
  const b = ctx.bollinger(rows(alt));
  assert.ok(b.lower < 99 && b.upper > 101);
  assert.ok(b.pct_b > 0 && b.pct_b < 0.5);
});

const bars = (closes) => closes.map((c, i) => ({ t: i, o: c, h: c + 0.5, l: c - 0.5, c }));
const UP = [115, 118, 121, 117, 113, 108, 98, 106, 110, 106, 104, 100, 103, 106, 112, 114, 110, 111, 116];

test("structure engine: indication -> correction -> continuation (bullish)", () => {
  const { ctx } = loadWorker();
  const out = ctx.iccAnalyze(bars(UP), { n: 2 });
  assert.equal(out.state, "CONTINUATION");
  assert.equal(out.direction, "bullish");
  assert.equal(out.broken_level, 110.5);
  assert.deepEqual(
    { entry: out.trade.entry, stop: out.trade.stop, target: out.trade.target, rr: out.trade.rr },
    { entry: 114.5, stop: 109.5, target: 121.5, rr: 1.4 },
  );
  assert.equal(out.trade.rr_below_target, true);
});

test("structure engine: bearish mirror gives the mirrored trade", () => {
  const { ctx } = loadWorker();
  const out = ctx.iccAnalyze(bars(UP.map((c) => 200 - c)), { n: 2 });
  assert.equal(out.state, "CONTINUATION");
  assert.equal(out.direction, "bearish");
  assert.deepEqual([out.trade.entry, out.trade.stop, out.trade.target], [85.5, 90.5, 78.5]);
});

test("structure engine: close beyond the opposite level invalidates", () => {
  const { ctx } = loadWorker();
  const out = ctx.iccAnalyze(bars([...UP.slice(0, 17), 98]), { n: 2 });
  assert.equal(out.state, "INVALIDATED");
  assert.equal(out.trade, undefined, "no trade levels outside Continuation");
});

test("structure engine: too few bars is UNCLEAR, never a signal", () => {
  const { ctx } = loadWorker();
  assert.equal(ctx.iccAnalyze(bars([100, 101, 102]), { n: 2 }).state, "UNCLEAR");
});
