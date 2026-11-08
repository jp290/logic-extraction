// Opens the SQLite database, applies schema + additive migrations, and recovers
// jobs a previous process left half-done.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { initConsultsSchema, initPacksSchema } from "./packs.ts";

// Columns added after the first schema. ALTER fails when the column exists; that is the no-op.
const ADDITIVE_COLUMNS = [
  "ALTER TABLE extractions ADD COLUMN merge_id TEXT",
  "ALTER TABLE extractions ADD COLUMN model TEXT",
  "ALTER TABLE extractions ADD COLUMN source_text TEXT",
  "ALTER TABLE extractions ADD COLUMN knowledge_extract TEXT",
  "ALTER TABLE extractions ADD COLUMN grounding_report TEXT",
  "ALTER TABLE extractions ADD COLUMN understanding_document TEXT",
  "ALTER TABLE extractions ADD COLUMN knowledge_core TEXT",
  "ALTER TABLE extractions ADD COLUMN cross_synthesis TEXT",
  // External-S pause marker ('awaiting' → 'done'); status stays 'phase3' because the
  // status CHECK constraint pins the allowed values.
  "ALTER TABLE extractions ADD COLUMN external_s_state TEXT",
  "ALTER TABLE merges ADD COLUMN model TEXT",
  "ALTER TABLE merges ADD COLUMN audit_report TEXT",
];

function tryExec(db: Database, sql: string): boolean {
  try {
    db.exec(sql);
    return true;
  } catch {
    return false; // column already exists
  }
}

export function openDatabase(dbPath: string, model: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf-8"));

  for (const sql of ADDITIVE_COLUMNS) tryExec(db, sql);
  // Rows created before visibility existed were all public.
  if (tryExec(db, "ALTER TABLE extractions ADD COLUMN is_public INTEGER DEFAULT 0")) {
    db.exec("UPDATE extractions SET is_public = 1");
  }

  initPacksSchema(db);
  initConsultsSchema(db);

  // Lens-only consults get the consult-time grounding check (gates/consult-grounding.ts);
  // pack consults keep the re-check gate. Separate table: the consults table's mode
  // CHECK constraint is pack-scoped.
  db.exec(`CREATE TABLE IF NOT EXISTS lens_consults (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model TEXT,
  flags INTEGER NOT NULL,
  grounding_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL
)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_lens_consults_extraction ON lens_consults(extraction_id)");

  db.query("UPDATE extractions SET model = ? WHERE model IS NULL AND status = 'complete'").run(model);
  db.query("UPDATE merges SET model = ? WHERE model IS NULL AND status = 'complete'").run(model);

  recoverStuckJobs(db);
  return db;
}

// A restart kills in-flight jobs; mark them failed so they are visible instead of
// hanging in a phase forever.
function recoverStuckJobs(db: Database): void {
  const extractions = db
    .query<{ id: string; title: string; status: string }, []>(
      "UPDATE extractions SET status = 'failed' WHERE status NOT IN ('complete', 'failed') AND merge_id IS NULL RETURNING id, title, status"
    )
    .all();
  const merges = db
    .query<{ id: string; merge_type: string; status: string }, []>(
      "UPDATE merges SET status = 'failed' WHERE status NOT IN ('complete', 'failed') RETURNING id, merge_type, status"
    )
    .all();
  if (extractions.length || merges.length) {
    console.warn(`Recovered ${extractions.length} stuck extraction(s), ${merges.length} stuck merge(s) — marked as failed`);
    for (const s of extractions) console.warn(`  extraction ${s.id}: was '${s.status}'`);
    for (const s of merges) console.warn(`  merge ${s.id} (${s.merge_type}): was '${s.status}'`);
  }
}
