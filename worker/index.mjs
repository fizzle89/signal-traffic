// Signal Traffic revenue attribution worker (DataBull-style, first-touch)
// Routes:
//   POST /api/ev            first-party pageview event (CORS: fizzle89.github.io)
//   POST /api/polar-webhook Polar Standard-Webhooks signed order.paid events
//   POST /api/import        past-payment import (Bearer ATTR_READ_KEY)
//   GET  /api/attr          LTV-by-source summary (Bearer ATTR_READ_KEY)
//   GET  /health

const ALLOWED_ORIGINS = ["https://fizzle89.github.io"];

// ---------- store layer (D1 in prod, in-memory in tests) ----------
export function makeD1Store(db) {
  return {
    insertEventIgnore: (e) => db.prepare(
      "INSERT OR IGNORE INTO events (vid,first_ts,last_ts,ref,landing,utm_source,utm_medium,utm_campaign,utm_content,utm_term,channel) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(e.vid, e.ts, e.ts, e.ref || "", e.landing || "", e.utm.utm_source || "", e.utm.utm_medium || "", e.utm.utm_campaign || "", e.utm.utm_content || "", e.utm.utm_term || "", e.channel).run(),
    touchEvent: (vid, ts) => db.prepare("UPDATE events SET last_ts=? WHERE vid=?").bind(ts, vid).run(),
    getEvent: (vid) => db.prepare("SELECT * FROM events WHERE vid=?").bind(vid).first(),
    insertOrderIgnore: (o) => db.prepare(
      "INSERT OR IGNORE INTO orders (order_id,ts,vid,channel,amount_cents,currency,billing_reason,product_id) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(o.order_id, o.ts, o.vid || "", o.channel, o.amount_cents, o.currency, o.billing_reason, o.product_id || "").run(),
    insertUnattributedIgnore: (o) => db.prepare(
      "INSERT OR IGNORE INTO unattributed (order_id,ts,amount_cents,reason) VALUES (?,?,?,?)"
    ).bind(o.order_id, o.ts, o.amount_cents, o.reason || "").run(),
    insertPing: (order_id, ts, ok, err) => db.prepare(
      "INSERT INTO pings (order_id,ts,ok,err) VALUES (?,?,?,?)"
    ).bind(order_id, ts, ok ? 1 : 0, err || "").run(),
    attrSummary: async () => {
      const bySource = await db.prepare(
        "SELECT channel, COUNT(*) AS orders, SUM(amount_cents) AS revenue_cents FROM orders GROUP BY channel ORDER BY revenue_cents DESC"
      ).all();
      const touches = await db.prepare(
        "SELECT channel, COUNT(*) AS n FROM events GROUP BY channel ORDER BY n DESC"
      ).all();
      const unatt = await db.prepare(
        "SELECT COUNT(*) AS orders, COALESCE(SUM(amount_cents),0) AS revenue_cents FROM unattributed"
      ).first();
      return { bySource: bySource.results || [], touches: touches.results || [], unattributed: unatt };
    },
  };
}

// ---------- channel mapping ----------
const CHANNEL_MAP = [
  ["x.com", "x.com"], ["twitter.com", "x.com"], ["t.co", "x.com"],
  ["chatgpt.com", "chatgpt"], ["claude.ai", "claude"], ["perplexity.ai", "perplexity"],
  ["google.", "google"], ["bing.com", "bing"], ["duckduckgo.com", "duckduckgo"],
  ["news.ycombinator.com", "hackernews"], ["reddit.com", "reddit"],
  ["linkedin.com", "linkedin"], ["facebook.com", "facebook"], ["instagram.com", "instagram"],
  ["tiktok.com", "tiktok"], ["t.me", "telegram"], ["youtube.com", "youtube"],
  ["producthunt.com", "producthunt"], ["github.com", "github"],
];
const INTERNAL_HOSTS = ["fizzle89.github.io", "workers.dev", "pages.dev"];

export function channelFor(ref, utm) {
  const us = (utm && utm.utm_source || "").trim().toLowerCase();
  if (us) return us.replace(/^www\./, "");
  if (!ref) return "direct";
  let h;
  try { h = new URL(ref).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "direct"; }
  if (INTERNAL_HOSTS.some((p) => h === p || h.endsWith("." + p))) return "internal";
  for (const [k, v] of CHANNEL_MAP) {
    if (k.endsWith(".")) { if (h === k.slice(0, -1) || h.includes("." + k) || h.startsWith(k)) return v; }
    else if (h === k || h.endsWith("." + k)) return v;
  }
  return h;
}

// ---------- telegram ----------
function relAge(fromIso, toDate) {
  const ms = toDate - new Date(fromIso);
  if (!isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 48) return h + " h ago";
  return Math.floor(h / 24) + " days ago";
}
export function saleLine(order, ev, channel, amountCents, now) {
  const money = "$" + (amountCents / 100).toFixed(amountCents % 100 ? 2 : 0);
  const renewal = order.billing_reason === "subscription_cycle" ? " (renewal)" : "";
  let line = money + renewal + " - " + (channel || "unattributed");
  if (ev) {
    line += " - first visit " + relAge(ev.first_ts, now || new Date());
    if (ev.landing) line += ", landed on " + ev.landing;
  }
  return line;
}
async function telegram(env, store, orderId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    await store.insertPing(orderId, new Date().toISOString(), false, "telegram secrets not set");
    return { ok: false, err: "telegram secrets not set" };
  }
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text }),
    });
    const ok = r.ok;
    await store.insertPing(orderId, new Date().toISOString(), ok, ok ? "" : "http " + r.status);
    return { ok };
  } catch (e) {
    await store.insertPing(orderId, new Date().toISOString(), false, String(e));
    return { ok: false, err: String(e) };
  }
}

// ---------- polar webhook signature (Standard Webhooks) ----------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function verifyPolarSignature(headers, raw, secret, nowSec) {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader || !secret) return false;
  const t = Number(ts);
  if (!isFinite(t) || Math.abs((nowSec || Date.now() / 1000) - t) > 300) return false;
  const expected = sigHeader.split(" ").map((p) => p.split(",")[1]).filter(Boolean);
  const data = new TextEncoder().encode(id + "." + ts + "." + raw);
  const keys = [new TextEncoder().encode(secret)];
  if (secret.startsWith("whsec_")) {
    try { keys.push(b64ToBytes(secret.slice(6))); } catch {}
  }
  for (const k of keys) {
    const ck = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", ck, data));
    let s = "";
    for (const b of mac) s += String.fromCharCode(b);
    if (expected.includes(btoa(s))) return true;
  }
  return false;
}

// ---------- order attribution ----------
async function checkoutMeta(env, checkoutId) {
  if (!checkoutId || !env.POLAR_API_TOKEN) return {};
  try {
    const r = await fetch("https://api.polar.sh/v1/checkouts/" + checkoutId, {
      headers: { Authorization: "Bearer " + env.POLAR_API_TOKEN, "User-Agent": "curl/8" },
    });
    if (r.ok) return (await r.json()).metadata || {};
  } catch {}
  return {};
}

export async function handleOrderPaid(env, store, order) {
  const oid = order.id;
  if (!oid) return { ok: false, err: "no order id" };
  let meta = order.metadata || {};
  let vid = meta.reference_id || meta.visitor_id || "";
  if (!vid) {
    const cm = await checkoutMeta(env, order.checkout_id);
    meta = { ...cm, ...meta };
    vid = meta.reference_id || meta.visitor_id || "";
  }
  const ev = vid ? await store.getEvent(vid) : null;
  const channel = (meta.utm_source || "").toLowerCase() || (ev && ev.channel) || "";
  const amount = order.total_amount != null ? order.total_amount : (order.amount || 0);
  const ts = order.created_at || new Date().toISOString();
  const line = saleLine(order, ev, channel, amount, new Date());
  if (ev || channel) {
    await store.insertOrderIgnore({
      order_id: oid, ts, vid, channel: channel || "unknown",
      amount_cents: amount, currency: (order.currency || "usd").toLowerCase(),
      billing_reason: order.billing_reason || "purchase", product_id: order.product_id || "",
    });
    const ping = await telegram(env, store, oid, line);
    return { ok: true, attributed: true, channel: channel || "unknown", ping };
  }
  await store.insertUnattributedIgnore({ order_id: oid, ts, amount_cents: amount, reason: vid ? "unknown visitor id" : "no reference_id" });
  const ping = await telegram(env, store, oid, line);
  return { ok: true, attributed: false, ping };
}

// ---------- http ----------
function cors(req) {
  const o = req.headers.get("origin") || "";
  const h = { "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
  if (ALLOWED_ORIGINS.includes(o)) h["access-control-allow-origin"] = o;
  return h;
}
function json(body, status, extra) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json", ...(extra || {}) } });
}
function authed(req, env) {
  const k = env.ATTR_READ_KEY || "";
  return k && req.headers.get("authorization") === "Bearer " + k;
}

export function makeFetch(storeOf) {
  return {
    async fetch(req, env) {
      const store = storeOf(env.DB);
      const u = new URL(req.url);
      if (u.pathname === "/health") return json({ ok: true });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

      if (u.pathname === "/api/ev" && req.method === "POST") {
        let e;
        try { e = await req.json(); } catch { return json({ ok: false }, 400, cors(req)); }
        if (!e || typeof e.vid !== "string" || !e.vid || e.vid.length > 128) return json({ ok: false }, 400, cors(req));
        const ev = {
          vid: e.vid, ts: typeof e.ts === "string" ? e.ts : new Date().toISOString(),
          ref: String(e.ref || "").slice(0, 500), landing: String(e.path || "").slice(0, 300),
          utm: typeof e.utm === "object" && e.utm ? e.utm : {},
          channel: channelFor(String(e.ref || ""), typeof e.utm === "object" && e.utm ? e.utm : {}),
        };
        await store.insertEventIgnore(ev);
        await store.touchEvent(ev.vid, ev.ts);
        return json({ ok: true }, 200, cors(req));
      }

      if (u.pathname === "/api/polar-webhook" && req.method === "POST") {
        const raw = await req.text();
        const ok = await verifyPolarSignature(req.headers, raw, env.POLAR_WEBHOOK_SECRET || "");
        if (!ok) return json({ ok: false, err: "bad signature" }, 401);
        let evt;
        try { evt = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
        if (evt.type === "order.paid" && evt.data) {
          const r = await handleOrderPaid(env, store, evt.data);
          return json(r);
        }
        return json({ ok: true, ignored: evt.type || "unknown" });
      }

      if (u.pathname === "/api/import" && req.method === "POST") {
        if (!authed(req, env)) return json({ ok: false }, 401);
        let order;
        try { order = await req.json(); } catch { return json({ ok: false }, 400); }
        const r = await handleOrderPaid(env, store, order);
        return json(r);
      }

      if (u.pathname === "/api/attr" && req.method === "GET") {
        if (!authed(req, env)) return json({ ok: false }, 401);
        const s = await store.attrSummary();
        return json({ ...s, generated_at: new Date().toISOString() });
      }

      return json({ ok: false, err: "not found" }, 404);
    },
  };
}

export default makeFetch((db) => makeD1Store(db));
