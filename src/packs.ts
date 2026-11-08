// Grounding packs: dataset + fitted known-form models + validation report,
// built deterministically and gated by recompute-verification at write time.
// In the project's experiments packs helped inside their measured envelope, and the
// reasoning tier handled the document form correctly where the flash tier did not.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PACK_TOOLS = join(import.meta.dir, "..", "tools", "pack");
const PYTHON = process.env.PACK_PYTHON || join(PACK_TOOLS, ".venv", "bin", "python");
const BUILD_TIMEOUT_MS = 120_000;
const MAX_CSV_BYTES = 300_000;
const VALID_ROLES = ["index", "value", "group", "x", "y", "ignore"] as const;

export interface ColumnSpec {
  role: (typeof VALID_ROLES)[number];
  unit?: string;
}

export interface PackInput {
  title: string;
  csv: string;
  columns: Record<string, ColumnSpec>;
  notes?: string;
  extraction_id?: string;
}

export function initPacksSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY,
    extraction_id TEXT,
    title TEXT NOT NULL,
    dataset_csv TEXT NOT NULL,
    dataset_sha256 TEXT,
    column_spec TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    pack_doc TEXT,
    params_json TEXT,
    verify_report TEXT,
    status TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip_hash TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (extraction_id) REFERENCES extractions(id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_packs_status ON packs(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_packs_ip ON packs(ip_hash)");
  const stuck = db
    .query("UPDATE packs SET status = 'failed', error = 'interrupted by restart' WHERE status = 'building' RETURNING id")
    .all() as Array<{ id: string }>;
  for (const s of stuck) console.warn(`Recovered stuck pack ${s.id} — marked failed`);
}

// Answer-time numeric re-check ledger: one row per pack-involving consult, with the
// deterministic re-check verdicts (docs/RECHECK-GATE-SPEC.md §2).
export function initConsultsSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS consults (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    extraction_id TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('lens+pack','pack-only')),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    model TEXT,
    claims_checked INTEGER NOT NULL,
    flags INTEGER NOT NULL,
    recheck_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip_hash TEXT NOT NULL,
    FOREIGN KEY (pack_id) REFERENCES packs(id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_consults_pack ON consults(pack_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_consults_mode ON consults(mode)");
}

export function validatePackInput(body: unknown): { input?: PackInput; error?: string } {
  if (typeof body !== "object" || body === null) return { error: "Invalid body" };
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || b.title.trim().length < 3 || b.title.trim().length > 120) {
    return { error: "title must be 3-120 characters" };
  }
  if (typeof b.csv !== "string" || Buffer.byteLength(b.csv) > MAX_CSV_BYTES) {
    return { error: `csv required, max ${MAX_CSV_BYTES / 1000}KB` };
  }
  const lines = b.csv.trim().split("\n");
  if (lines.length < 13) return { error: "csv needs a header plus at least 12 data rows" };
  if (typeof b.columns !== "object" || b.columns === null) return { error: "columns spec required" };
  const columns: Record<string, ColumnSpec> = {};
  const header = lines[0].split(",").map((h) => h.trim());
  for (const [name, raw] of Object.entries(b.columns as Record<string, unknown>)) {
    if (!header.includes(name)) return { error: `column '${name}' not in CSV header` };
    const c = raw as Record<string, unknown>;
    if (typeof c !== "object" || c === null || !VALID_ROLES.includes(c.role as ColumnSpec["role"])) {
      return { error: `column '${name}' needs a role: ${VALID_ROLES.join("|")}` };
    }
    const unit = typeof c.unit === "string" ? c.unit.slice(0, 20) : undefined;
    columns[name] = unit ? { role: c.role as ColumnSpec["role"], unit } : { role: c.role as ColumnSpec["role"] };
  }
  for (const h of header) {
    if (!(h in columns)) return { error: `CSV column '${h}' has no role in spec` };
  }
  const roles = Object.values(columns).map((c) => c.role);
  const count = (r: string) => roles.filter((x) => x === r).length;
  const hasTrend = count("index") === 1 && count("value") >= 1;
  const hasShape = count("group") === 1 && count("x") === 1 && count("y") === 1;
  if (!hasTrend && !hasShape) {
    return { error: "spec must define one index + at least one value column, or one group + one x + one y column" };
  }
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 2000) : "";
  const extraction_id =
    typeof b.extraction_id === "string" && /^[a-z0-9]+$/i.test(b.extraction_id) ? b.extraction_id : undefined;
  return { input: { title: b.title.trim(), csv: b.csv, columns, notes, extraction_id } };
}

async function runScript(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([PYTHON, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

// Build → verify-at-write gate → complete only on ALL PASS. No ungated write path.
export async function runPackBuild(db: Database, id: string): Promise<void> {
  const row = db.query("SELECT dataset_csv, column_spec, notes, title FROM packs WHERE id = ?").get(id) as
    | { dataset_csv: string; column_spec: string; notes: string; title: string }
    | null;
  if (!row) return;
  const work = mkdtempSync(join(tmpdir(), `pack-${id}-`));
  try {
    const csvPath = join(work, "data.csv");
    const specPath = join(work, "spec.json");
    writeFileSync(csvPath, row.dataset_csv);
    writeFileSync(
      specPath,
      JSON.stringify({ title: row.title, notes: row.notes, columns: JSON.parse(row.column_spec) })
    );

    const build = await runScript(
      [join(PACK_TOOLS, "pack_build.py"), "--csv", csvPath, "--spec", specPath, "--out", work],
      BUILD_TIMEOUT_MS
    );
    if (build.code !== 0) {
      let msg = "build failed";
      try {
        msg = (JSON.parse(build.stdout.trim().split("\n").pop() || "{}") as { error?: string }).error ?? msg;
      } catch {
        msg = build.stderr.slice(-500) || msg;
      }
      db.query("UPDATE packs SET status = 'failed', error = ? WHERE id = ?").run(msg, id);
      return;
    }

    const packDoc = await Bun.file(join(work, "pack_doc.md")).text();
    const paramsJson = await Bun.file(join(work, "pack_params.json")).text();

    const verify = await runScript(
      [
        join(PACK_TOOLS, "pack_verify.py"),
        "--csv", csvPath,
        "--spec", specPath,
        "--doc", join(work, "pack_doc.md"),
        "--params", join(work, "pack_params.json"),
      ],
      BUILD_TIMEOUT_MS
    );
    let report: { all_pass?: boolean } = {};
    try {
      report = JSON.parse(verify.stdout.trim().split("\n").pop() || "{}") as { all_pass?: boolean };
    } catch {
      report = {};
    }
    const sha = (JSON.parse(paramsJson) as { sha256?: string }).sha256 ?? null;

    if (verify.code === 0 && report.all_pass === true) {
      db.query(
        "UPDATE packs SET status = 'complete', pack_doc = ?, params_json = ?, verify_report = ?, dataset_sha256 = ? WHERE id = ?"
      ).run(packDoc, paramsJson, verify.stdout.trim(), sha, id);
    } else {
      db.query("UPDATE packs SET status = 'failed', error = 'verify-at-write gate failed', verify_report = ? WHERE id = ?").run(
        verify.stdout.trim() || verify.stderr.slice(-500),
        id
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "internal error";
    db.query("UPDATE packs SET status = 'failed', error = ? WHERE id = ?").run(msg.slice(0, 500), id);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
