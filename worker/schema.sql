-- Signal Traffic revenue attribution (DataBull-style, first-touch)
CREATE TABLE IF NOT EXISTS events (
  vid TEXT PRIMARY KEY,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  ref TEXT DEFAULT '',
  landing TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  utm_content TEXT DEFAULT '',
  utm_term TEXT DEFAULT '',
  channel TEXT DEFAULT 'direct'
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  vid TEXT DEFAULT '',
  channel TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'usd',
  billing_reason TEXT DEFAULT 'purchase',
  product_id TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS unattributed (
  order_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL,
  err TEXT DEFAULT ''
);
