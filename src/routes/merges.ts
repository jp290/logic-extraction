// Merging two lenses: a cached compatibility preview, the merge job, and its status.

import { exact, prefix, type RequestContext, type Route } from "../router.ts";
import { checkOrigin, contentLength, ID_PATTERN, json, readJson } from "../http.ts";
import { completePrompt } from "../llm.ts";
import { extractPreamble, MERGE_TYPES, runMerge, type MergeType } from "../pipeline/merge.ts";
import { MERGE_PREVIEW_PROMPT } from "../prompts.ts";
import { generateId, stripJsonFence } from "../text.ts";

const PREVIEW_CACHE_TTL_MS = 3_600_000;

interface MergeBody {
  parent_a?: string;
  parent_b?: string;
  merge_type?: string;
  backbone?: string;
}

async function preview(c: RequestContext): Promise<Response> {
  const { db, llm, previewCache } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (contentLength(c.req) > 10_000) return json({ error: "Payload too large" }, 413);
  const body = await readJson<MergeBody>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.parent_a || !ID_PATTERN.test(body.parent_a)) return json({ error: "Invalid parent_a" }, 400);
  if (!body.parent_b || !ID_PATTERN.test(body.parent_b)) return json({ error: "Invalid parent_b" }, 400);
  if (body.parent_a === body.parent_b) return json({ error: "Cannot preview a document with itself" }, 400);

  const cacheKey = [body.parent_a, body.parent_b].sort().join(":");
  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PREVIEW_CACHE_TTL_MS) return json(cached.result);

  const lens = db.query<{ title: string; logic_document: string }, [string]>(
    "SELECT title, logic_document FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0"
  );
  const docA = lens.get(body.parent_a);
  const docB = lens.get(body.parent_b);
  if (!docA || !docB) return json({ error: "One or both extractions not found" }, 404);

  let raw: string;
  try {
    raw = await completePrompt(
      llm,
      MERGE_PREVIEW_PROMPT(extractPreamble(docA.logic_document), docA.title, extractPreamble(docB.logic_document), docB.title),
      { temperature: 0.1 }
    );
  } catch {
    return json({ error: "Failed to generate preview" }, 500);
  }
  let result: unknown;
  try {
    result = JSON.parse(stripJsonFence(raw));
  } catch {
    return json({ error: "Failed to parse preview response" }, 500);
  }
  previewCache.set(cacheKey, { result, timestamp: Date.now() });
  return json(result);
}

async function createMerge(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkOrigin(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  if (!app.limits.merge(c.ipHash)) return json({ error: "Rate limited. Max 3 merges per hour." }, 429);
  if (contentLength(c.req) > 100_000) return json({ error: "Payload too large" }, 413);
  const body = await readJson<MergeBody>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.parent_a || !ID_PATTERN.test(body.parent_a)) return json({ error: "Invalid parent_a" }, 400);
  if (!body.parent_b || !ID_PATTERN.test(body.parent_b)) return json({ error: "Invalid parent_b" }, 400);
  if (body.parent_a === body.parent_b) return json({ error: "Cannot merge a document with itself" }, 400);
  if (!body.merge_type || !MERGE_TYPES.includes(body.merge_type as MergeType)) {
    return json({ error: "Invalid merge_type (peer, asymmetric, awareness, thematical)" }, 400);
  }

  const complete = app.db.query("SELECT id FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0");
  const extA = complete.get(body.parent_a);
  const extB = complete.get(body.parent_b);
  if (!extA || !extB) return json({ error: "One or both extractions not found" }, 404);

  // Take the job slot first: a row inserted without one would sit in 'pending' forever.
  if (!app.jobs.acquire()) return json({ error: "Server busy" }, 503);
  const id = generateId();
  app.db
    .query("INSERT INTO merges (id, parent_a, parent_b, merge_type, a_as_backbone, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, body.parent_a, body.parent_b, body.merge_type, body.backbone === "a" ? 1 : 0, c.ipHash);
  runMerge(app, id).finally(app.jobs.release);
  return json({ id, status: "pending" }, 201);
}

function getMerge(c: RequestContext): Response {
  const id = c.path.split("/")[3];
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);
  const row = c.app.db
    .query("SELECT id, parent_a, parent_b, merge_type, status, result_id, error, created_at FROM merges WHERE id = ?")
    .get(id);
  if (!row) return json({ error: "Not found" }, 404);
  return json(row);
}

// A visitor's own recent merges.
function listMerges(c: RequestContext): Response {
  const rows = c.app.db
    .query(
      `SELECT m.id, m.parent_a, m.parent_b, m.merge_type, m.status, m.result_id, m.created_at,
              ea.title as title_a, eb.title as title_b
       FROM merges m
       LEFT JOIN extractions ea ON m.parent_a = ea.id
       LEFT JOIN extractions eb ON m.parent_b = eb.id
       WHERE m.ip_hash = ?
       ORDER BY m.created_at DESC LIMIT 20`
    )
    .all(c.ipHash);
  return json({ merges: rows });
}

export const mergeRoutes: Route[] = [
  { method: "POST", match: exact("/api/merge/preview"), handle: preview },
  { method: "POST", match: exact("/api/merge"), handle: createMerge },
  { method: "GET", match: prefix("/api/merges/"), handle: getMerge },
  { method: "GET", match: exact("/api/merges"), handle: listMerges },
];
