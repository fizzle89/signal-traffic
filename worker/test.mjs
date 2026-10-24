// Tests: node --test worker/test.mjs  (no dependencies; in-memory store)
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { makeFetch, channelFor, saleLine, verifyPolarSignature, handleOrderPaid } from "./index.mjs";

// --- in-memory store with the same contract as makeD1Store ---
function memStore() {
  const events = new Map(), orders = new Map(), unatt = new Map(), pings = [];
  return {
    _events: events, _orders: orders, _unatt: unatt, _pings: pings,
    insertEventIgnore: async (e) => { if (!events.has(e.vid)) events.set(e.vid, { ...e }); },
    touchEvent: async (vid, ts) => { const x = events.get(vid); if (x) x.last_ts = ts; },
    getEvent: async (vid) => events.get(vid) || null,
    insertOrderIgnore: async (o) => { if (!orders.has(o.order_id)) orders.set(o.order_id, { ...o }); },
    insertUnattributedIgnore: async (o) => { if (!unatt.has(o.order_id)) unatt.set(o.order_id, { ...o }); },
    insertPing: async (order_id, ts, ok, err) => { pings.push({ order_id, ts, ok, err }); },
    attrSummary: async () => {
      const by = {};
      for (const o of orders.values()) {
        by[o.channel] = by[o.channel] || { channel: o.channel, orders: 0, revenue_cents: 0 };
        by[o.channel].orders++; by[o.channel].revenue_cents += o.amount_cents;
      }
      const touches = {};
      for (const e of events.values()) { touches[e.channel] = (touches[e.channel] || 0) + 1; }
      let uo = 0, ur = 0;
      for (const u of unatt.values()) { uo++; ur += u.amount_cents; }
      return {
        bySource: Object.values(by).sort((a, b) => b.revenue_cents - a.revenue_cents),
        touches: Object.entries(touches).map(([channel, n]) => ({ channel, n })),
        unattributed: { orders: uo, revenue_cents: ur },
      };
    },
  };
}
const envFor = (over) => ({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", POLAR_API_TOKEN: "", ...over });

test("channelFor: utm_source wins, mapped hosts, direct, internal", () => {
  assert.equal(channelFor("", { utm_source: "X.com" }), "x.com");
  assert.equal(channelFor("https://twitter.com/foo/status/1", {}), "x.com");
  assert.equal(channelFor("https://chatgpt.com/share/x", {}), "chatgpt");
  assert.equal(channelFor("https://news.ycombinator.com/item?id=1", {}), "hackernews");
  assert.equal(channelFor("", {}), "direct");
  assert.equal(channelFor("https://fizzle89.github.io/signal-traffic/", {}), "internal");
  assert.equal(channelFor("https://blog.example.com/post", {}), "blog.example.com");
  assert.equal(channelFor("not a url", {}), "direct");
});

test("saleLine matches DataBull ping shape", () => {
  const ev = { first_ts: "2026-10-22T21:00:00Z", landing: "/signal-traffic/" };
  const line = saleLine({ billing_reason: "purchase" }, ev, "x.com", 2900, new Date("2026-10-24T21:00:00Z"));
  assert.equal(line, "$29 - x.com - first visit 2 days ago, landed on /signal-traffic/");
  const rn = saleLine({ billing_reason: "subscription_cycle" }, ev, "x.com", 2900, new Date("2026-10-24T21:00:00Z"));
  assert.ok(rn.startsWith("$29 (renewal) - x.com"));
});

async function sign(id, ts, body, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "." + ts + "." + body)));
  let s = ""; for (const b of mac) s += String.fromCharCode(b);
  return "v1," + btoa(s);
}
const hdrs = (id, ts, sig) => new Map([["webhook-id", id], ["webhook-timestamp", ts], ["webhook-signature", sig]]);
test("verifyPolarSignature: accepts valid raw-secret signature, rejects bad/old", async () => {
  const body = JSON.stringify({ type: "order.paid", data: { id: "o1" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const good = await sign("msg_1", ts, body, "testsecret");
  const h = hdrs("msg_1", ts, good);
  assert.equal(await verifyPolarSignature(h, body, "testsecret"), true);
  assert.equal(await verifyPolarSignature(h, body, "wrongsecret"), false);
  const old = String(Math.floor(Date.now() / 1000) - 400);
  const oldSig = await sign("msg_1", old, body, "testsecret");
  assert.equal(await verifyPolarSignature(hdrs("msg_1", old, oldSig), body, "testsecret"), false);
  assert.equal(await verifyPolarSignature(hdrs("msg_1", ts, ""), body, "testsecret"), false);
});

test("verifyPolarSignature: whsec_-prefixed base64 secret verifies against decoded key", async () => {
  const rawKey = new Uint8Array(32); for (let i = 0; i < 32; i++) rawKey[i] = i + 1;
  const whsec = "whsec_" + btoa(String.fromCharCode(...rawKey));
  const body = JSON.stringify({ type: "order.paid", data: { id: "o2" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("msg_2." + ts + "." + body)));
  let s = ""; for (const b of mac) s += String.fromCharCode(b);
  assert.equal(await verifyPolarSignature(hdrs("msg_2", ts, "v1," + btoa(s)), body, whsec), true);
});

test("order.paid: purchase matched to first-touch source via reference_id", async () => {
  const store = memStore();
  await store.insertEventIgnore({ vid: "v123", ts: "2026-10-22T10:00:00Z", ref: "https://x.com/a/status/1", landing: "/signal-traffic/", utm: {}, channel: "x.com" });
  const r = await handleOrderPaid(envFor(), store, {
    id: "ord_1", checkout_id: "c_1", metadata: { reference_id: "v123", utm_source: "x.com" },
    total_amount: 2900, currency: "usd", billing_reason: "purchase", product_id: "p_1", created_at: "2026-10-24T10:00:00Z",
  });
  assert.equal(r.attributed, true);
  assert.equal(r.channel, "x.com");
  assert.equal(store._orders.get("ord_1").channel, "x.com");
  assert.equal(store._pings.length, 1);
  assert.equal(store._pings[0].ok, false); // telegram secrets unset -> recorded, not silent
  assert.match(store._pings[0].err, /telegram secrets not set/);
});

test("order.paid: renewal adds LTV to the original source", async () => {
  const store = memStore();
  await store.insertEventIgnore({ vid: "v9", ts: "2026-10-01T10:00:00Z", ref: "", landing: "/", utm: { utm_source: "perplexity" }, channel: "perplexity" });
  await handleOrderPaid(envFor(), store, { id: "o_a", metadata: { reference_id: "v9" }, total_amount: 2900, billing_reason: "purchase", created_at: "2026-10-01T11:00:00Z" });
  await handleOrderPaid(envFor(), store, { id: "o_b", metadata: { reference_id: "v9" }, total_amount: 2900, billing_reason: "subscription_cycle", created_at: "2026-11-01T11:00:00Z" });
  const s = await store.attrSummary();
  assert.equal(s.bySource.length, 1);
  assert.equal(s.bySource[0].channel, "perplexity");
  assert.equal(s.bySource[0].orders, 2);
  assert.equal(s.bySource[0].revenue_cents, 5800);
});

test("order.paid: no reference_id lands in unattributed and still pings", async () => {
  const store = memStore();
  const r = await handleOrderPaid(envFor(), store, { id: "ord_x", metadata: {}, total_amount: 2900, billing_reason: "purchase", created_at: "2026-10-24T10:00:00Z" });
  assert.equal(r.attributed, false);
  assert.equal(store._unatt.get("ord_x").amount_cents, 2900);
  assert.equal(store._pings.length, 1);
});

test("order.paid: duplicate delivery is idempotent", async () => {
  const store = memStore();
  const order = { id: "ord_d", metadata: { utm_source: "hackernews" }, total_amount: 100, billing_reason: "purchase", created_at: "2026-10-24T10:00:00Z" };
  await handleOrderPaid(envFor(), store, order);
  await handleOrderPaid(envFor(), store, order);
  const s = await store.attrSummary();
  assert.equal(s.bySource[0].orders, 1);
  assert.equal(s.bySource[0].revenue_cents, 100);
});

test("worker fetch: end-to-end signed synthetic order.paid, ingest first", async () => {
  const store = memStore();
  const secret = "e2esecret";
  const app = makeFetch(() => store);
  const env = envFor({ POLAR_WEBHOOK_SECRET: secret, ATTR_READ_KEY: "readkey" });

  const evReq = new Request("https://w/api/ev", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://fizzle89.github.io" },
    body: JSON.stringify({ vid: "ve2e", ref: "https://claude.ai/share/abc", path: "/signal-traffic/", ts: "2026-10-23T09:00:00Z", utm: {} }),
  });
  const evRes = await app.fetch(evReq, env);
  assert.equal(evRes.status, 200);
  assert.equal(store._events.get("ve2e").channel, "claude");

  const body = JSON.stringify({ type: "order.paid", data: { id: "ord_e2e", checkout_id: "c9", metadata: { reference_id: "ve2e" }, total_amount: 2900, currency: "usd", billing_reason: "purchase", created_at: "2026-10-24T09:00:00Z" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await sign("msg_e2e", ts, body, secret);
  const req = new Request("https://w/api/polar-webhook", {
    method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_e2e", "webhook-timestamp": ts, "webhook-signature": sig },
    body,
  });
  const r = await app.fetch(req, env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.attributed, true);
  assert.equal(j.channel, "claude");
  assert.equal(store._orders.get("ord_e2e").amount_cents, 2900);

  const badReq = new Request("https://w/api/polar-webhook", {
    method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_e2e", "webhook-timestamp": ts, "webhook-signature": "v1,bogus" },
    body,
  });
  assert.equal((await app.fetch(badReq, env)).status, 401);

  const attr = await app.fetch(new Request("https://w/api/attr", { headers: { authorization: "Bearer readkey" } }), env);
  const a = await attr.json();
  assert.equal(a.bySource[0].channel, "claude");
  assert.equal(a.bySource[0].revenue_cents, 2900);
  assert.equal(a.touches[0].channel, "claude");

  const unauth = await app.fetch(new Request("https://w/api/attr"), env);
  assert.equal(unauth.status, 401);
});
