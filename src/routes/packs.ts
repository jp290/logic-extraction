// Grounding packs: CSV → fitted known-form models + validation report. Every pack
// write passes the deterministic verify-at-write gate; there is no ungated write path.

import { exact, pattern, type RequestContext, type Route } from "../router.ts";
import { checkOrigin, contentLength, json, readJson } from "../http.ts";
import { runPackBuild, validatePackInput } from "../packs.ts";
import { generateId } from "../text.ts";

const MAX_PACK_BODY_BYTES = 400_000;

async function createPack(c: RequestContext): Promise<Response> {
  const { db } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.packCreate(c.ipHash)) return json({ error: "Rate limited. Max 10 packs per hour." }, 429);
  if (contentLength(c.req) > MAX_PACK_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  const body = await readJson<unknown>(c.req);
  if (body === undefined) return json({ error: "Invalid JSON" }, 400);
  const { input, error } = validatePackInput(body);
  if (!input) return json({ error }, 400);

  if (input.extraction_id) {
    const ex = db.query("SELECT id FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0").get(input.extraction_id);
    if (!ex) return json({ error: "Linked extraction not found or not complete" }, 404);
  }

  const id = generateId();
  db.query(
    `INSERT INTO packs (id, extraction_id, title, dataset_csv, column_spec, notes, status, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, 'building', ?)`
  ).run(id, input.extraction_id ?? null, input.title, input.csv, JSON.stringify(input.columns), input.notes ?? "", c.ipHash);

  runPackBuild(db, id).catch((err: unknown) => {
    console.error(`[pack ${id}] build crashed:`, err);
    db.query("UPDATE packs SET status = 'failed', error = 'internal error' WHERE id = ? AND status = 'building'").run(id);
  });
  return json({ id, status: "building" });
}

// Unlisted until validated (is_public), but the owner always sees their own.
function listPacks(c: RequestContext): Response {
  const rows = c.app.db
    .query(
      `SELECT id, title, extraction_id, dataset_sha256, status, error, created_at, is_public
       FROM packs WHERE is_public = 1 OR ip_hash = ?
       ORDER BY created_at DESC LIMIT 100`
    )
    .all(c.ipHash);
  return json({ packs: rows });
}

function getPack(c: RequestContext): Response {
  const id = c.path.split("/").pop() as string;
  const row = c.app.db
    .query(
      `SELECT id, title, extraction_id, dataset_sha256, column_spec, notes, pack_doc, verify_report,
              status, error, created_at, is_public, views
       FROM packs WHERE id = ?`
    )
    .get(id);
  if (!row) return json({ error: "Pack not found" }, 404);
  return json(row);
}

interface TelemetryRow {
  mode: string;
  consults: number;
  claims_checked: number | null;
  flags: number | null;
  flagged_consults: number;
}

// Per-mode re-check flag rates (docs/RECHECK-GATE-SPEC.md §2).
function recheckTelemetry(c: RequestContext): Response {
  const rows = c.app.db
    .query<TelemetryRow, []>(
      `SELECT mode,
              COUNT(*) AS consults,
              SUM(claims_checked) AS claims_checked,
              SUM(flags) AS flags,
              SUM(CASE WHEN flags > 0 THEN 1 ELSE 0 END) AS flagged_consults
       FROM consults GROUP BY mode`
    )
    .all();
  const modes = rows.map((r) => {
    const claims = r.claims_checked ?? 0;
    const flags = r.flags ?? 0;
    return {
      mode: r.mode,
      consults: r.consults,
      claims_checked: claims,
      flags,
      flagged_consults: r.flagged_consults,
      claim_flag_rate: claims > 0 ? flags / claims : 0,
      consult_flag_rate: r.consults > 0 ? r.flagged_consults / r.consults : 0,
    };
  });
  return json({ modes });
}

export const packRoutes: Route[] = [
  { method: "POST", match: exact("/api/packs"), handle: createPack },
  { method: "GET", match: exact("/api/packs"), handle: listPacks },
  { method: "GET", match: pattern(/^\/api\/packs\/[a-z0-9]+$/i), handle: getPack },
  { method: "GET", match: exact("/api/recheck-telemetry"), handle: recheckTelemetry },
];
