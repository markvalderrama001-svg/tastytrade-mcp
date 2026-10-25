// Loads the single-file Worker into an isolated VM context with a fake
// Tastytrade API behind `fetch`. No network, no credentials, no Wrangler.
//
// The deployable file is not modified: we only rewrite `export default {` to
// a global assignment so it can run as a classic script. Top-level function
// declarations (safePlace, buildOrder, matchRealizedPnl, ...) then become
// properties of the context, which is how the tests reach the pure helpers.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_FILE = path.join(HERE, "..", "tastytrade-mcp-worker.js");
const FIXTURES = path.join(HERE, "..", "fixtures");

export const SYNTHETIC_ACCOUNT = "DEMO-0001"; // synthetic account id

export function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// Routes a request the way api.tastyworks.com would, from bundled fixtures.
export function fakeTastytrade(url, init = {}) {
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const p = u.pathname;
  if (u.hostname !== "api.tastyworks.com") return json({ error: `unexpected host ${u.hostname}` }, 599);
  if (p === "/oauth/token" && method === "POST") return json({ access_token: "fake-access", expires_in: 900 });
  if (p === "/customers/me/accounts") return json({ data: { items: [{ account: { "account-number": SYNTHETIC_ACCOUNT } }] } });
  if (p === `/accounts/${SYNTHETIC_ACCOUNT}/orders/dry-run` && method === "POST") return json(fixture("dry-run.json"));
  if (p === `/accounts/${SYNTHETIC_ACCOUNT}/orders` && method === "POST") return json({ data: { order: { id: 900001, status: "Received" } } });
  if (p === `/accounts/${SYNTHETIC_ACCOUNT}/transactions`) return json(fixture("transactions.json"));
  if (p.startsWith("/option-chains/") && p.endsWith("/nested")) return json(fixture("option-chain-AAPL.json"));
  return json({ error: `no fake route for ${method} ${p}` }, 404);
}

export function loadWorker({ fetchImpl = fakeTastytrade } = {}) {
  const src = fs.readFileSync(WORKER_FILE, "utf8").replace(/^export default \{/m, "globalThis.__worker = {");
  const calls = [];
  const ctx = {
    console, URL, URLSearchParams, Response, Request, Headers, Intl,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto: globalThis.crypto,
  };
  ctx.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });
    return fetchImpl(String(url), init);
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "tastytrade-mcp-worker.js" });
  const liveOrderPosts = () =>
    calls.filter((c) => c.method === "POST" && /\/accounts\/[^/]+\/orders$/.test(new URL(c.url).pathname));
  const dryRunPosts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/orders/dry-run"));
  return { ctx, calls, worker: ctx.__worker, liveOrderPosts, dryRunPosts };
}

// Minimal MCP client over the Worker's fetch handler.
export async function mcp(worker, env, method, params, { token, id = 1, sessionId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const req = new Request("https://tastytrade-mcp.example.workers.dev/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("Mcp-Session-Id"), body: text ? JSON.parse(text) : null };
}

export async function callTool(worker, env, name, args, opts) {
  const r = await mcp(worker, env, "tools/call", { name, arguments: args }, opts);
  if (r.status !== 200) return { status: r.status, error: r.body };
  const result = r.body.result;
  const text = result.content[0].text;
  return { status: r.status, isError: result.isError, text, data: result.isError ? null : JSON.parse(text) };
}
