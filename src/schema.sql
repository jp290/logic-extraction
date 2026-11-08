-- Migration: add merge_id to extractions if missing
-- (SQLite ignores ALTER TABLE ADD COLUMN if column exists via error handling in server.ts)

CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  logic_document TEXT,
  author TEXT,
  doc_type TEXT,
  topic_summary TEXT,
  domain_tags TEXT,
  doc_structure TEXT,
  reading_level TEXT,
  agent_a TEXT,
  agent_b TEXT,
  agent_c TEXT,
  agent_v TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  word_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','phase1','phase2','phase3','phase4','phase5','phase6','complete','failed')),
  error TEXT,
  ip_hash TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  merge_id TEXT,
  is_public INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_extractions_status ON extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_created ON extractions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extractions_ip_hash ON extractions(ip_hash);
CREATE INDEX IF NOT EXISTS idx_extractions_flagged ON extractions(flagged);

-- Merges: link two parent Logic Documents to a merged result
CREATE TABLE IF NOT EXISTS merges (
  id TEXT PRIMARY KEY,
  parent_a TEXT NOT NULL,
  parent_b TEXT NOT NULL,
  merge_type TEXT NOT NULL CHECK(merge_type IN ('peer','asymmetric','awareness','thematical')),
  a_as_backbone INTEGER NOT NULL DEFAULT 0,
  compatibility TEXT,
  dialogue_t1 TEXT,
  dialogue_t2 TEXT,
  dialogue_t3 TEXT,
  crystallization TEXT,
  result_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','compat','dialogue','crystallize','profiling','complete','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL,
  FOREIGN KEY (parent_a) REFERENCES extractions(id),
  FOREIGN KEY (parent_b) REFERENCES extractions(id),
  FOREIGN KEY (result_id) REFERENCES extractions(id)
);

CREATE INDEX IF NOT EXISTS idx_merges_status ON merges(status);
CREATE INDEX IF NOT EXISTS idx_merges_parents ON merges(parent_a, parent_b);
CREATE INDEX IF NOT EXISTS idx_merges_ip ON merges(ip_hash);

-- Logic tests: paired Logic Document vs baseline responses
CREATE TABLE IF NOT EXISTS logic_tests (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL,
  scenario TEXT NOT NULL,
  logic_response TEXT,
  baseline_response TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','complete','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL,
  FOREIGN KEY (extraction_id) REFERENCES extractions(id)
);

CREATE INDEX IF NOT EXISTS idx_tests_extraction ON logic_tests(extraction_id);
CREATE INDEX IF NOT EXISTS idx_tests_ip ON logic_tests(ip_hash);

-- Flags: track individual flag events for threshold-based moderation
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (extraction_id) REFERENCES extractions(id),
  UNIQUE(extraction_id, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_flags_extraction ON flags(extraction_id);

-- Interviews: conversational logic extraction sessions
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  messages TEXT NOT NULL DEFAULT '[]',
  coverage TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  extraction_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','synthesizing','complete','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL,
  FOREIGN KEY (extraction_id) REFERENCES extractions(id)
);

CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status);
CREATE INDEX IF NOT EXISTS idx_interviews_ip ON interviews(ip_hash);
