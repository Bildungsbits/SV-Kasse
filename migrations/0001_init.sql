CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  emoji TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3b82f6',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  starting_cents INTEGER NOT NULL CHECK (starting_cents >= 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at TEXT,
  closed_at TEXT,
  counted_cents INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_shifts_code ON shifts (code, status);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  total_cents INTEGER NOT NULL,
  donation_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_sales_shift ON sales (shift_id, created_at);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  article_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX idx_sale_items_sale ON sale_items (sale_id);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  sale_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts (ip, at);

INSERT INTO settings (key, value) VALUES
  ('school_name', 'HB-BK'),
  ('sv_name', 'SV-Kasse'),
  ('low_stock', '5'),
  ('code_length', '6'),
  ('donation_quick', '[50,100,200]');
