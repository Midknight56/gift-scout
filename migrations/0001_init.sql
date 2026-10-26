CREATE TABLE IF NOT EXISTS qloo_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  turns TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_cache (
  key TEXT PRIMARY KEY,
  conversation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The same shape as the shared hackathon-ledger's table, used when that database is not bound.
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  day TEXT NOT NULL,
  neurons REAL NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ai_calls_day ON ai_calls(day, app);
