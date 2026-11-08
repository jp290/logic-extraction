// Backfill knowledge_core for existing complete lenses. New lenses are tiered at
// extraction time; this retrofits stored ones.
// Usage: bun tools/backfill-core-ke.ts --id <extraction id> | --all [--force]
import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config.ts";
import { createLlmClient } from "../src/llm.ts";
import { buildCoreKnowledge } from "../src/pipeline/knowledge-core.ts";

const args = Bun.argv.slice(2);
const idFlag = args.indexOf("--id") !== -1 ? args[args.indexOf("--id") + 1] : null;
const ALL = args.includes("--all");
const FORCE = args.includes("--force");
if (!idFlag && !ALL) {
  console.error("usage: bun tools/backfill-core-ke.ts --id <id> | --all [--force]");
  process.exit(1);
}

const config = loadConfig();
const llm = createLlmClient(config.llm);
// Opened directly (not via openDatabase): boot-time job recovery must not run while a server is live.
const db = new Database(config.databasePath, { readwrite: true });

interface Row { id: string; title: string; ld: string | null; ke: string | null }
const select = "SELECT id, title, logic_document ld, knowledge_extract ke FROM extractions WHERE ";
const rows = idFlag
  ? db.query<Row, [string]>(select + "id = ?").all(idFlag)
  : db.query<Row, []>(select + `status = 'complete' AND knowledge_extract IS NOT NULL${FORCE ? "" : " AND knowledge_core IS NULL"}`).all();

console.log(`${rows.length} lenses to tier`);
for (const r of rows) {
  if (!r.ld || !r.ke) {
    console.log(`${r.id} skipped (missing LD or KE)`);
    continue;
  }
  try {
    const core = await buildCoreKnowledge(r.ld, r.ke, llm.complete);
    if (!core) {
      console.log(`${r.id} ${r.title.slice(0, 35)} — no core produced (small KE or selection failure); consults use the full KE`);
      continue;
    }
    db.query("UPDATE extractions SET knowledge_core = ? WHERE id = ?").run(core, r.id);
    console.log(`${r.id} ${r.title.slice(0, 35)} — KE ${r.ke.length} → core ${core.length} chars (${Math.round((core.length / r.ke.length) * 100)}%)`);
  } catch (err) {
    console.error(`${r.id} FAILED:`, err);
  }
}
db.close();
