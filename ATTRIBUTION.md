# Signal Traffic revenue attribution - owner's manual (v1)

DataBull-style first-touch revenue attribution for Signal Traffic's own sales.
"Which post / search / AI chat brought the buyer, and how much is that source
worth over time (renewals included)." Plus a Telegram ping on every sale.

## What it does
1. `signal-att.js` (served from the Pages site, loaded by both pages) gives each
   visitor an id (localStorage `st_vid`), records first-touch (referrer, UTM
   params, landing path) via `POST /api/ev`, and rewrites every `buy.polar.sh`
   href to carry `reference_id=<visitor id>` + the landing UTMs. Polar copies
   those query params into the Checkout Session metadata and on to the Order
   (source: polar.sh/docs/features/checkout/links, "Query parameters",
   "Attribution and reference metadata").
2. `worker/` (Cloudflare Worker + D1) receives the events, receives Polar
   `order.paid` webhooks (Standard Webhooks signature verified against
   POLAR_WEBHOOK_SECRET), matches payment -> visitor's first-touch, and keeps
   LTV by source. Renewals (`billing_reason=subscription_cycle`) add to the
   original source's LTV. Unmatched payments are recorded in `unattributed`,
   never dropped.
3. Every paid order triggers a Telegram ping: "$29 - x.com - first visit 2 days
   ago, landed on /signal-traffic/". Ping failures are recorded in D1 (pings
   table), never silent.
4. `GET /api/attr` (Bearer ATTR_READ_KEY) returns per-source first touches,
   orders, revenue/LTV, and the unattributed bucket.
5. `import/past-payments.mjs` back-fills past Polar orders through `/api/import`.
   Orders placed before reference_id existed are honestly counted as
   unattributable and skipped.

## What it never does
- No third-party trackers, no fingerprinting, no cross-site anything. The
  visitor id is a random UUID in localStorage on our own pages only.
- Uploaded log files are untouched - the "logs never leave your device" promise
  is unchanged; this is analytics of OUR marketing page, not of customer logs.
- No customer PII beyond what Polar sends in the webhook; emails are not stored.

## Deploy recipe (CF-gated; for the lane holding CF access)
Token scopes needed (scoped API token, account-level):
- Workers Scripts: Edit  (wrangler deploy + wrangler secret put)
- D1: Edit               (wrangler d1 create + migrations)
No zone permissions required (workers.dev subdomain only).

```
cd worker
export CLOUDFLARE_ACCOUNT_ID=3a83a83ef281a5abe83525fc9e828e19
npx wrangler d1 create signal-traffic-attr
# paste the returned database_id into wrangler.toml [[d1_databases]].database_id
npx wrangler d1 execute signal-traffic-attr --remote --file schema.sql
npx wrangler secret put POLAR_WEBHOOK_SECRET   # from the NEW Polar webhook endpoint (step below)
npx wrangler secret put POLAR_API_TOKEN        # Polar org token (read use only)
npx wrangler secret put TELEGRAM_BOT_TOKEN     # pending: Fuseini creates bot via BotFather
npx wrangler secret put TELEGRAM_CHAT_ID       # pending: his chat id with the bot
npx wrangler secret put ATTR_READ_KEY          # any long random string
npx wrangler deploy
```
Telegram pings self-record as "secrets not set" until the two Telegram secrets
land; everything else works without them.

## Polar webhook endpoint (after deploy)
Create a SECOND webhook endpoint (the existing one, id
62ff0abe-06f6-4924-8459-7df659777503, feeds the Security worker fulfilment
ledger - do not touch it):
```
curl -X POST https://api.polar.sh/v1/webhooks/endpoints \
  -H "Authorization: Bearer <org token>" -H "User-Agent: curl/8" \
  -H "content-type: application/json" \
  -d '{"url":"https://shuttlewright-signal-attr.pillar-3a8.workers.dev/api/polar-webhook",
       "format":"raw","events":["order.paid"]}'
```
Put the returned `secret` into POLAR_WEBHOOK_SECRET above.

## Verification
- Local: `node --test worker/test.mjs` - 9/9 (channel mapping, ping shape,
  signature verify raw + whsec_ base64, first-touch match, renewal LTV,
  unattributed, idempotent redelivery, full signed synthetic order.paid through
  the HTTP layer, /api/attr auth).
- Live, no money moved: send a Standard-Webhooks-signed synthetic order.paid to
  /api/polar-webhook with a reference_id seeded via /api/ev; check /api/attr.
  CAVEAT: this proves the worker end (signature, matching, D1, ping attempt).
  It does NOT prove Polar -> worker delivery; that leg is config (endpoint
  above) and is verified when the first real or dashboard-replayed event lands.
- Per the Oct 23 standing ban, no fresh live order/discount was created to test.

## Push recipe (for the lane with the signed-in fizzle89 session)
Branch: feat/revenue-attribution, built on ca056fa (design-pass head).
```
cd signal-traffic
git fetch origin && git checkout main && git pull
git checkout feat/revenue-attribution   # or apply the format-patch bundle
# resolve any overlap with sibling commits (expected none: new files + 2 script tags)
git checkout main && git merge --no-ff feat/revenue-attribution
git push origin main
```
GitHub Pages auto-deploys on push. Live verify after push:
1. Open https://fizzle89.github.io/signal-traffic/ - devtools: signal-att.js
   loads, /api/ev POST returns 200 (needs worker deployed first).
2. The "Get the full report" href contains reference_id= + UTMs when present.
3. Synthetic signed order.paid (see Verification) -> /api/attr shows the row.
