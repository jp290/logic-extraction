// Reading lenses: list, search, single lens, OKF export, the prompt catalogue, and
// community flagging.

import { exact, pattern, prefix, type RequestContext, type Route } from "../router.ts";
import { checkOrigin, ID_PATTERN, json, SECURITY_HEADERS } from "../http.ts";
import { buildOkfBundle, bundleToTarGz, createdAtEpoch, validateOkfBundle, type OkfRow } from "../okf.ts";
import { buildMergeHistory, type MergeType } from "../pipeline/merge.ts";
import {
  AGENT_A_PROMPT,
  AGENT_B_PROMPT,
  AGENT_C_PROMPT,
  AGENT_P_PROMPT,
  AGENT_S_PROMPT,
  AGENT_V_FINDINGS_PROMPT,
  AGENT_V_META_PROMPT,
  ASK_PROMPT,
  MERGE_COMPAT_PROMPT,
  MERGE_CRYSTALLIZE_PROMPT,
  MERGE_TURN_PROMPT,
  TEST_BASELINE_PROMPT,
  TEST_LOGIC_PROMPT,
} from "../prompts.ts";

const FLAG_THRESHOLD = 3;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

const ORDER_MAP: Record<string, string> = {
  date: "e.created_at DESC",
  views: "e.views DESC",
  words: "e.word_count DESC",
};

// The prompt catalogue with {PLACEHOLDER} slots, for transparency.
function workflows(c: RequestContext): Response {
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  const ph = (tag: string): string => `{${tag}}`;
  const turn = (n: 1 | 2 | 3, type: MergeType) =>
    MERGE_TURN_PROMPT(n, ph("DOC_A"), "{TITLE_A}", ph("DOC_B"), "{TITLE_B}", n === 1 ? "" : ph("PRIOR_DIALOGUE"), type);
  return json({
    extraction: {
      agent_a: AGENT_A_PROMPT(ph("SOURCE_TEXT")),
      agent_b: AGENT_B_PROMPT(ph("SOURCE_TEXT")),
      agent_c: AGENT_C_PROMPT(ph("SOURCE_TEXT")),
      agent_v_findings: AGENT_V_FINDINGS_PROMPT(ph("SOURCE_TEXT"), "A", ph("AGENT_A_OUTPUT")),
      agent_v_meta: AGENT_V_META_PROMPT(ph("SOURCE_TEXT"), ph("AGENT_A_OUTPUT"), ph("AGENT_B_OUTPUT"), ph("AGENT_C_OUTPUT")),
      agent_s: AGENT_S_PROMPT(ph("SOURCE_TEXT"), ph("AGENT_V_OUTPUT"), ph("AGENT_A_OUTPUT"), ph("AGENT_B_OUTPUT"), ph("AGENT_C_OUTPUT")),
      agent_p: AGENT_P_PROMPT(ph("SOURCE_TEXT")),
    },
    merge: {
      compatibility: MERGE_COMPAT_PROMPT(ph("DOC_A"), ph("TITLE_A"), ph("DOC_B"), ph("TITLE_B")),
      turn_1_peer: turn(1, "peer"),
      turn_2_peer: turn(2, "peer"),
      turn_3_peer: turn(3, "peer"),
      turn_1_asymmetric: turn(1, "asymmetric"),
      turn_2_asymmetric: turn(2, "asymmetric"),
      turn_3_asymmetric: turn(3, "asymmetric"),
      turn_1_awareness: turn(1, "awareness"),
      turn_2_awareness: turn(2, "awareness"),
      turn_3_awareness: turn(3, "awareness"),
      turn_1_thematical: turn(1, "thematical"),
      turn_2_thematical: turn(2, "thematical"),
      turn_3_thematical: turn(3, "thematical"),
      crystallize: MERGE_CRYSTALLIZE_PROMPT(ph("DOC_A"), "{TITLE_A}", ph("DOC_B"), "{TITLE_B}", ph("COMPATIBILITY"), ph("DIALOGUE"), "peer"),
    },
    test: {
      baseline: TEST_BASELINE_PROMPT(ph("SCENARIO")),
      logic: TEST_LOGIC_PROMPT(ph("LOGIC_DOCUMENT"), ph("KNOWLEDGE_EXTRACT"), ph("UNDERSTANDING_DOCUMENT"), ph("SCENARIO")),
    },
    chat: {
      standard: ASK_PROMPT(ph("LOGIC_DOCUMENT"), ph("USER_QUESTION"), false),
      speculative: ASK_PROMPT(ph("LOGIC_DOCUMENT"), ph("USER_QUESTION"), true),
    },
  });
}

function titles(c: RequestContext): Response {
  const rows = c.app.db
    .query(
      `SELECT e.id, e.title, e.doc_type, e.domain_tags, e.topic_summary, e.merge_id, e.model,
              e.knowledge_extract IS NOT NULL as has_knowledge_extract,
              m.parent_a, m.parent_b, m.merge_type,
              pa.title as parent_a_title, pb.title as parent_b_title
       FROM extractions e
       LEFT JOIN merges m ON e.merge_id = m.id
       LEFT JOIN extractions pa ON m.parent_a = pa.id
       LEFT JOIN extractions pb ON m.parent_b = pb.id
       WHERE e.flagged = 0 AND e.status = 'complete' AND e.is_public = 1
       ORDER BY e.merge_id IS NOT NULL DESC, e.created_at DESC
       LIMIT 100`
    )
    .all();
  return json({ extractions: rows });
}

// OKF v0.1 export of the stored, already-gated layers. No regeneration, no model calls.
function okf(c: RequestContext): Response {
  const id = c.path.split("/")[3];
  const row = c.app.db
    .query<OkfRow, [string]>(
      `SELECT id, title, author, doc_type, topic_summary, domain_tags, created_at, model,
              logic_document, knowledge_extract, understanding_document, grounding_report
       FROM extractions WHERE id = ? AND flagged = 0 AND status = 'complete'`
    )
    .get(id);
  if (!row || !row.logic_document) return json({ error: "Not found" }, 404);

  const bundle = buildOkfBundle(row, c.app.config.publicUrl);
  const issues = validateOkfBundle(bundle.files);
  if (issues.length > 0) {
    console.error(`[okf] bundle for ${id} failed validation:`, issues);
    return json({ error: "Bundle failed OKF validation" }, 500);
  }
  if ((c.url.searchParams.get("format") || "tar") === "json") {
    return json({ slug: bundle.slug, files: bundle.files });
  }
  return new Response(bundleToTarGz(bundle, bundle.slug, createdAtEpoch(row.created_at)), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${bundle.slug}-okf.tar.gz"`,
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

// Any status is readable by id (the UI polls it); private lenses are unlisted, not hidden.
function getExtraction(c: RequestContext): Response {
  const { db } = c.app;
  const id = c.path.split("/")[3];
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);

  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT id, title, author, logic_document, knowledge_extract, knowledge_core, grounding_report, understanding_document, doc_type, topic_summary, domain_tags, doc_structure, reading_level, created_at, word_count, status, views, merge_id, model,
              source_text IS NOT NULL as has_source_text
       FROM extractions WHERE id = ? AND flagged = 0`
    )
    .get(id);
  if (!row) return json({ error: "Not found" }, 404);

  if (row.status === "complete" && c.app.views.shouldCount(`${id}:${c.ipHash}`)) {
    db.query("UPDATE extractions SET views = views + 1 WHERE id = ?").run(id);
  }
  if (row.merge_id) row.merge_history = buildMergeHistory(db, row.merge_id as string);
  return json(row);
}

function listExtractions(c: RequestContext): Response {
  const { db } = c.app;
  const params = c.url.searchParams;
  const page = Math.max(1, parseInt(params.get("page") || "1") || 1);
  const rawLimit = parseInt(params.get("limit") || String(DEFAULT_PAGE_SIZE));
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const offset = (page - 1) * limit;
  const search = params.get("q") || "";
  const orderBy = ORDER_MAP[params.get("sort") || "date"] ?? ORDER_MAP.date;
  const filter = params.get("filter") || "";
  const filterClause =
    filter === "source" ? "AND e.merge_id IS NULL AND e.status = 'complete'"
    : filter === "merge" ? "AND e.merge_id IS NOT NULL"
    : filter === "processing" ? "AND e.status NOT IN ('complete', 'failed')"
    : "AND e.status != 'failed'";

  const baseSelect = `SELECT e.id, e.title, e.created_at, e.word_count, e.status, e.views, e.model,
                      substr(e.logic_document, 1, 300) as summary,
                      e.merge_id, e.doc_type, e.domain_tags, e.topic_summary,
                      e.knowledge_extract IS NOT NULL as has_knowledge_extract,
                      m.parent_a, m.parent_b,
                      pa.title as parent_a_title, pb.title as parent_b_title,
                      m.merge_type
               FROM extractions e
               LEFT JOIN merges m ON e.merge_id = m.id
               LEFT JOIN extractions pa ON m.parent_a = pa.id
               LEFT JOIN extractions pb ON m.parent_b = pb.id
               WHERE e.flagged = 0 AND e.is_public = 1 ${filterClause}`;
  const ordering = `ORDER BY CASE WHEN e.status != 'complete' THEN 0 ELSE 1 END, ${orderBy}`;

  if (search) {
    const rows = db
      .query(`${baseSelect}
                 AND (e.title LIKE '%' || ? || '%' OR e.topic_summary LIKE '%' || ? || '%')
               ${ordering}
               LIMIT ? OFFSET ?`)
      .all(search, search, limit, offset);
    const total = db
      .query<{ cnt: number }, [string, string]>(
        `SELECT COUNT(*) as cnt FROM extractions e
               WHERE e.flagged = 0 AND e.is_public = 1 ${filterClause}
                 AND (e.title LIKE '%' || ? || '%' OR e.topic_summary LIKE '%' || ? || '%')`
      )
      .get(search, search);
    return json({ extractions: rows, total: total?.cnt, page, limit });
  }
  const rows = db.query(`${baseSelect}\n               ${ordering}\n               LIMIT ? OFFSET ?`).all(limit, offset);
  const total = db
    .query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM extractions e WHERE e.flagged = 0 AND e.is_public = 1 ${filterClause}`)
    .get();
  return json({ extractions: rows, total: total?.cnt, page, limit });
}

// Three distinct flaggers hide a lens.
function flag(c: RequestContext): Response {
  const { db } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  const id = c.path.split("/")[3];
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);
  if (!c.app.limits.flag(c.ipHash)) return json({ error: "Rate limited" }, 429);

  try {
    db.query("INSERT OR IGNORE INTO flags (extraction_id, ip_hash) VALUES (?, ?)").run(id, c.ipHash);
  } catch (err) {
    console.error(`[flag] Failed to insert flag for extraction ${id}:`, err);
  }
  const flagCount = db
    .query<{ cnt: number }, [string]>("SELECT COUNT(DISTINCT ip_hash) as cnt FROM flags WHERE extraction_id = ?")
    .get(id);
  if (flagCount && flagCount.cnt >= FLAG_THRESHOLD) {
    db.query("UPDATE extractions SET flagged = 1 WHERE id = ?").run(id);
  }
  return json({ ok: true, flagCount: flagCount?.cnt || 0, threshold: FLAG_THRESHOLD });
}

export const extractionRoutes: Route[] = [
  { method: "GET", match: exact("/api/workflows"), handle: workflows },
  { method: "GET", match: exact("/api/extractions/titles"), handle: titles },
  { method: "GET", match: pattern(/^\/api\/extractions\/[a-z0-9]+\/okf$/i), handle: okf },
  { method: "GET", match: prefix("/api/extractions/"), handle: getExtraction },
  { method: "GET", match: exact("/api/extractions"), handle: listExtractions },
  { method: "POST", match: prefix("/api/flag/"), handle: flag },
];
