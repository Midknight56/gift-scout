CREATE TABLE IF NOT EXISTS qloo_quota (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  remaining INTEGER NOT NULL,
  at TEXT NOT NULL,
  -- When Qloo's month resets (from X-Month-RateLimit-Reset). After it, the reading no longer holds.
  resets_at TEXT
);
