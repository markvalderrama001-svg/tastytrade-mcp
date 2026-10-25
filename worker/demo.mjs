// Offline demo: drive the real Worker over MCP JSON-RPC against a fake
// Tastytrade API (bundled synthetic fixtures). No credentials, no network.
//
//   npm run demo
import { loadWorker, callTool, mcp } from "./test/harness.mjs";

const TOKEN = "demo".padEnd(40, "-0"); // synthetic bearer token, 40 chars
const AUTH = { token: TOKEN };
const say = (s = "") => console.log(s);

async function main() {
  // 1) Handshake + tool list
  {
    const { worker } = loadWorker();
    const env = { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: TOKEN };
    const init = await mcp(worker, env, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }, AUTH);
    const list = await mcp(worker, env, "tools/list", {}, { ...AUTH, sessionId: init.sessionId });
    say(`initialize -> ${init.body.result.serverInfo.name} (protocol ${init.body.result.protocolVersion})`);
    say(`tools/list -> ${list.body.result.tools.length} tools`);
    say();
  }

  // 2) An iron condor on AAPL, previewed as one net-credit order
  {
    const { worker } = loadWorker();
    const r = await callTool(worker, { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: TOKEN }, "preview_spread", {
      underlying: "AAPL", expiration: "2026-12-18", net_price: 1.85, price_effect: "CREDIT",
      legs: [
        { strike: 185, option_type: "P", action: "SELL_TO_OPEN", quantity: 1 },
        { strike: 180, option_type: "P", action: "BUY_TO_OPEN", quantity: 1 },
        { strike: 195, option_type: "C", action: "SELL_TO_OPEN", quantity: 1 },
        { strike: 200, option_type: "C", action: "BUY_TO_OPEN", quantity: 1 },
      ],
    }, AUTH);
    say("preview_spread (AAPL iron condor, 1.85 credit):");
    for (const c of r.data.contracts) say(`   ${c}`);
    say(`   status ${r.data.status}, buying-power change ${r.data.buying_power_change} (${r.data.buying_power_effect})`);
    say();
  }

  // 3) The same live request under each gate configuration
  const LIVE = { LIVE_TRADING_ENABLED: "true", MCP_AUTH_TOKEN: TOKEN };
  const scenarios = [
    ["server has no MCP_AUTH_TOKEN", { LIVE_TRADING_ENABLED: "true" }, "CONFIRM", TOKEN],
    ["caller sends a wrong token", LIVE, "CONFIRM", "wrong-token"],
    ["live switch off", { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: TOKEN }, "CONFIRM", TOKEN],
    ["live on, no confirm", LIVE, "", TOKEN],
    ["live on + CONFIRM", LIVE, "CONFIRM", TOKEN],
  ];
  say("place_option_order (sell 1 AAPL 185 put @ 3.20):");
  for (const [label, env, confirm, token] of scenarios) {
    const w = loadWorker();
    const r = await callTool(w.worker, env, "place_option_order", {
      underlying: "AAPL", expiration: "2026-12-18", strike: 185, option_type: "P",
      quantity: 1, limit_price: 3.2, action: "SELL_TO_OPEN", confirm,
    }, { token });
    const live = w.liveOrderPosts().length;
    const outcome = r.status === 200 ? r.data.status : `HTTP ${r.status}`;
    say(`   ${label.padEnd(30)} -> ${outcome.padEnd(18)} live orders sent: ${live}`);
  }
  say();

  // 4) Realized P&L from (synthetic) transaction history
  {
    const { worker } = loadWorker();
    const r = await callTool(worker, { LIVE_TRADING_ENABLED: "false", MCP_AUTH_TOKEN: TOKEN }, "get_realized_pnl", { underlying: "AAPL" }, AUTH);
    say(`get_realized_pnl -> ${r.data.closed_trades} closed, total ${r.data.total_realized_pnl} (fee-inclusive)`);
    for (const t of r.data.trades) say(`   ${t.symbol.padEnd(22)} ${String(t.realized_pnl).padStart(8)}  ${t.holding_period_days}d  ror ${t.ror_pct}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
