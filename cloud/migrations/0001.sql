CREATE TABLE workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  patients TEXT NOT NULL,
  closed_since TEXT NOT NULL
);
INSERT INTO workspace VALUES (1, 0, '[]', '{}');
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  time TEXT NOT NULL
);
INSERT INTO settings VALUES (1, 1, '09:00');
CREATE TABLE sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE login_challenge (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX reminders_created ON reminders(created_at);
