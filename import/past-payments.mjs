// Past-payment import: pulls Polar orders via the org token (read from the vault,
// never printed) and POSTs each to the attribution worker's /api/import.
// Orders placed before reference_id existed mostly land as "unattributed" - honest.
// Usage: node import/past-payments.mjs <worker-base-url> <ATTR_READ_KEY>
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const [base, readKey] = process.argv.slice(2);
if (!base || !readKey) { console.error("usage: node import/past-payments.mjs <worker-base-url> <ATTR_READ_KEY>"); process.exit(2); }

const out = JSON.parse(execFileSync("tools", ["vault", "write-file", "--key", "password", "--name", "Polar product setup organization token", "--return-channel", "none", "--json"], { encoding: "utf8" }));
const tok = readFileSync(out.path, "utf8").trim();
rmSync(out.path);
const H = { Authorization: "Bearer " + tok, "User-Agent": "curl/8" };

let url = "https://api.polar.sh/v1/orders/?limit=100";
let n = 0, attributed = 0, skipped = 0;
while (url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) { console.error("Polar list failed: http", r.status); process.exit(2); }
  const page = await r.json();
  for (const o of page.items || []) {
    n++;
    const ref = (o.metadata && (o.metadata.reference_id || o.metadata.visitor_id)) || "";
    if (!ref) { skipped++; continue; } // nothing to match against; leave for organic webhook replay
    const ir = await fetch(base.replace(/\/$/, "") + "/api/import", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + readKey },
      body: JSON.stringify(o),
    });
    const j = await ir.json().catch(() => ({}));
    if (ir.ok && j.attributed) attributed++;
    else skipped++;
  }
  url = page.pagination && page.pagination.next_url ? page.pagination.next_url : null;
}
console.log(JSON.stringify({ orders_seen: n, imported_attributed: attributed, skipped_unattributable: skipped }));
