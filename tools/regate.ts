// Re-run the deterministic quote gate on existing complete extractions whose docs
// shipped before full gate coverage (or with flagged quotes left in place).
// Unquotes untraceable spans in LD/KE/UD against source_text (+ gated LD for KE/UD)
// and updates grounding_report. Dry-run by default; pass --apply to write.
//
// Usage: bun tools/regate.ts [--apply] <extraction-id> [<extraction-id> ...]

import { Database } from "bun:sqlite";
import { databasePath } from "../src/config.ts";
import { unquoteUnverified as unquote } from "../src/pipeline/gates.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ids = args.filter((a) => a !== "--apply");
if (ids.length === 0) {
  console.error("Usage: bun tools/regate.ts [--apply] <extraction-id> ...");
  process.exit(1);
}

// Opened directly (not via openDatabase): boot-time job recovery must not run while a server is live.
const dbPath = databasePath();
const db = apply ? new Database(dbPath, { readwrite: true }) : new Database(dbPath, { readonly: true });

for (const id of ids) {
  const row = db.query(
    "SELECT id, title, status, source_text, logic_document, knowledge_extract, understanding_document, grounding_report FROM extractions WHERE id = ?"
  ).get(id) as { id: string; title: string; status: string; source_text: string | null; logic_document: string | null; knowledge_extract: string | null; understanding_document: string | null; grounding_report: string | null } | null;

  if (!row) { console.log(`${id}: NOT FOUND`); continue; }
  if (row.status !== "complete") { console.log(`${id}: status=${row.status}, skipping`); continue; }
  if (!row.source_text) { console.log(`${id}: no source_text — cannot re-gate (merged doc? use lineage instead)`); continue; }
  if (!row.logic_document) { console.log(`${id}: no logic_document, skipping`); continue; }

  let report: Record<string, unknown>;
  try { report = JSON.parse(row.grounding_report || "{}"); } catch { report = {}; }

  const ldGate = unquote(row.logic_document, row.source_text);
  report.ldQuoteCheck = { total: ldGate.total, repaired: ldGate.repaired, flagged: ldGate.flagged };

  const keCorpus = `${row.source_text}\n\n${ldGate.doc}`;
  const keGate = row.knowledge_extract ? unquote(row.knowledge_extract, keCorpus) : null;
  if (keGate) report.keQuoteCheck = { total: keGate.total, repaired: keGate.repaired, flagged: keGate.flagged };

  const udGate = row.understanding_document ? unquote(row.understanding_document, row.source_text) : null;
  if (udGate) report.udQuoteCheck = { total: udGate.total, repaired: udGate.repaired, flagged: udGate.flagged };

  report.regated_at = new Date().toISOString();

  console.log(`${id} (${row.title.slice(0, 50)}):`);
  console.log(`  LD: ${ldGate.total} quotes, ${ldGate.repaired} repaired, ${ldGate.flagged.length} still flagged`);
  if (keGate) console.log(`  KE: ${keGate.total} quotes, ${keGate.repaired} repaired, ${keGate.flagged.length} still flagged`);
  if (udGate) console.log(`  UD: ${udGate.total} quotes, ${udGate.repaired} repaired, ${udGate.flagged.length} still flagged`);
  for (const f of [...ldGate.flagged, ...(keGate?.flagged ?? []), ...(udGate?.flagged ?? [])]) {
    console.log(`    [cov ${f.coverage}] "${f.quote.slice(0, 70)}"`);
  }

  if (apply) {
    db.query("UPDATE extractions SET logic_document = ?, knowledge_extract = ?, understanding_document = ?, grounding_report = ? WHERE id = ?")
      .run(ldGate.doc, keGate ? keGate.doc : row.knowledge_extract, udGate ? udGate.doc : row.understanding_document, JSON.stringify(report), id);
    console.log(`  APPLIED`);
  } else {
    console.log(`  (dry run — pass --apply to write)`);
  }
}
