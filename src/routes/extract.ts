// Starting extractions: the public endpoint, the token-gated internal endpoints for an
// externally synthesized Logic Document, and the understanding upgrade.

import { exact, prefix, type RequestContext, type Route } from "../router.ts";
import { checkInternal, checkOrigin, contentLength, ID_PATTERN, json, readJson } from "../http.ts";
import { checkExtractionRateLimit, MAX_EXTRACTIONS_PER_WINDOW } from "../limits.ts";
import { completeSynthesis, runExtraction, runUnderstandingUpgrade, type ExtractionMode } from "../pipeline/extraction.ts";
import { MERGE_TYPES, runMerge, type MergeType } from "../pipeline/merge.ts";
import { AGENT_S_PROMPT } from "../prompts.ts";
import { countWords, extractTitle, generateId, stripHTML } from "../text.ts";

const MAX_BODY_BYTES = 5_000_000;
const MIN_TEXT_CHARS = 100;
const BUSY = "Server busy — too many concurrent jobs. Try again shortly.";

interface ExtractBody {
  text?: string;
  title?: string;
  mode?: string;
  is_public?: boolean;
  external_s?: boolean;
}

interface ExternalSRow {
  status: string;
  external_s_state: string | null;
  source_text: string | null;
  agent_a: string | null;
  agent_b: string | null;
  agent_c: string | null;
  agent_v: string | null;
  cross_synthesis: string | null;
}

function modeOf(mode: string | undefined): ExtractionMode {
  return mode === "logic" ? "logic" : "understanding";
}

function insertPending(c: RequestContext, title: string, wordCount: number, ipHash: string, text: string, isPublic: number): string {
  const id = generateId();
  c.app.db
    .query(
      `INSERT INTO extractions (id, title, word_count, status, ip_hash, model, source_text, is_public)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .run(id, title, wordCount, ipHash, c.app.llm.model, text, isPublic);
  return id;
}

async function extract(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkOrigin(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  if (contentLength(c.req) > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  const body = await readJson<ExtractBody>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.text || typeof body.text !== "string") return json({ error: "Missing text field" }, 400);

  const cleanText = stripHTML(body.text.trim());
  if (cleanText.length < MIN_TEXT_CHARS) return json({ error: "Text too short (minimum 100 characters)" }, 400);
  const wordCount = countWords(cleanText);
  if (wordCount > app.config.maxWords) {
    return json(
      { error: `Text exceeds ${app.config.maxWords.toLocaleString()} word limit (${wordCount.toLocaleString()} words)` },
      400
    );
  }
  if (!checkExtractionRateLimit(app.db, c.ipHash, app.config.rateLimitMinutes)) {
    return json(
      { error: `Rate limited. Max ${MAX_EXTRACTIONS_PER_WINDOW} extractions per ${app.config.rateLimitMinutes} minutes.` },
      429
    );
  }

  const title = body.title && typeof body.title === "string" ? body.title.slice(0, 200) : extractTitle(cleanText);
  const id = insertPending(c, title, wordCount, c.ipHash, cleanText, body.is_public === true ? 1 : 0);
  if (!app.jobs.acquire()) {
    app.db.query("UPDATE extractions SET status = 'failed', error = 'Server busy' WHERE id = ?").run(id);
    return json({ error: BUSY }, 503);
  }
  runExtraction(app, id, cleanText, modeOf(body.mode)).finally(app.jobs.release);
  return json({ id, status: "pending" }, 201);
}

// Internal: extraction that pauses before phase 3 so a stronger model can write the
// Logic Document out-of-band (GET s-prompt, POST complete-s). Token-gated.
async function internalExtract(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkInternal(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const body = await readJson<ExtractBody>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.text || typeof body.text !== "string") return json({ error: "Missing text field" }, 400);
  const cleanText = stripHTML(body.text.trim());
  if (cleanText.length < MIN_TEXT_CHARS) return json({ error: "Text too short (minimum 100 characters)" }, 400);
  const wordCount = countWords(cleanText);
  if (wordCount > app.config.maxWords) return json({ error: `Text exceeds ${app.config.maxWords.toLocaleString()} word limit` }, 400);

  const title = body.title && typeof body.title === "string" ? body.title.slice(0, 200) : extractTitle(cleanText);
  const id = insertPending(c, title, wordCount, app.hashIP("internal"), cleanText, body.is_public === true ? 1 : 0);
  if (!app.jobs.acquire()) {
    app.db.query("UPDATE extractions SET status = 'failed', error = 'Server busy' WHERE id = ?").run(id);
    return json({ error: BUSY }, 503);
  }
  runExtraction(app, id, cleanText, modeOf(body.mode), body.external_s !== false).finally(app.jobs.release);
  return json({ id, status: "pending" }, 201);
}

function notAwaiting(row: { status: string; external_s_state: string | null }): Response {
  return json({ error: `Extraction is '${row.status}'/${row.external_s_state ?? "none"}, not awaiting external S` }, 409);
}

function sPrompt(c: RequestContext): Response {
  const { app } = c;
  if (!checkInternal(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const id = c.path.slice("/api/internal/s-prompt/".length);
  const row = app.db
    .query<ExternalSRow, [string]>(
      "SELECT status, external_s_state, source_text, agent_a, agent_b, agent_c, agent_v, cross_synthesis FROM extractions WHERE id = ?"
    )
    .get(id);
  if (!row) return json({ error: "Not found" }, 404);
  if (row.external_s_state !== "awaiting" || !row.source_text || !row.agent_a || !row.agent_b || !row.agent_c || !row.agent_v) {
    return notAwaiting(row);
  }
  const p = AGENT_S_PROMPT(row.source_text, row.agent_v, row.agent_a, row.agent_b, row.agent_c, row.cross_synthesis || "");
  return json({ id, system: p.system, user: p.user });
}

async function completeS(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkInternal(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const body = await readJson<{ id?: string; logic_document?: string; s_model?: string; mode?: string }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.id || typeof body.id !== "string" || !body.logic_document || typeof body.logic_document !== "string") {
    return json({ error: "Missing id or logic_document" }, 400);
  }
  const ld = body.logic_document.trim();
  if (ld.length < 500 || ld.length > 500_000) return json({ error: "logic_document length out of range" }, 400);
  const row = app.db
    .query<{ status: string; external_s_state: string | null; source_text: string | null }, [string]>(
      "SELECT status, external_s_state, source_text FROM extractions WHERE id = ?"
    )
    .get(body.id);
  if (!row) return json({ error: "Not found" }, 404);
  if (row.external_s_state !== "awaiting" || !row.source_text) return notAwaiting(row);

  if (typeof body.s_model === "string" && body.s_model) {
    app.db.query("UPDATE extractions SET model = ? WHERE id = ?").run(`${app.llm.model}+s:${body.s_model.slice(0, 60)}`, body.id);
  }
  if (!app.jobs.acquire()) return json({ error: BUSY }, 503);
  app.db.query("UPDATE extractions SET external_s_state = 'done' WHERE id = ?").run(body.id);
  const id = body.id;
  completeSynthesis(app, id, row.source_text, ld, modeOf(body.mode))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Processing failed";
      app.db.query("UPDATE extractions SET status = 'failed', error = ? WHERE id = ?").run(msg, id);
    })
    .finally(app.jobs.release);
  return json({ id, status: "phase3" }, 202);
}

// Internal merge: same flow as /api/merge, token-gated, no rate limit.
async function internalMerge(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkInternal(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const body = await readJson<{ parent_a?: string; parent_b?: string; merge_type?: string; backbone?: string }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.parent_a || !body.parent_b || body.parent_a === body.parent_b) {
    return json({ error: "Need two distinct parent ids" }, 400);
  }
  if (!body.merge_type || !MERGE_TYPES.includes(body.merge_type as MergeType)) {
    return json({ error: "Invalid merge_type" }, 400);
  }
  const complete = app.db.query("SELECT id FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0");
  if (!complete.get(body.parent_a) || !complete.get(body.parent_b)) return json({ error: "One or both extractions not found" }, 404);
  if (!app.jobs.acquire()) return json({ error: "Server busy" }, 503);
  const id = generateId();
  app.db
    .query("INSERT INTO merges (id, parent_a, parent_b, merge_type, a_as_backbone, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, body.parent_a, body.parent_b, body.merge_type, body.backbone === "a" ? 1 : 0, app.hashIP("internal"));
  runMerge(app, id).finally(app.jobs.release);
  return json({ id, status: "pending" }, 201);
}

interface UpgradeRow {
  id: string;
  source_text: string | null;
  logic_document: string;
  knowledge_extract: string | null;
  understanding_document: string | null;
}

// Add KE + UD to a lens that was extracted in logic-only mode.
function upgradeUnderstanding(c: RequestContext): Response {
  const { app } = c;
  if (!checkOrigin(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const id = c.path.split("/").pop() as string;
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);
  if (!app.limits.upgrade(c.ipHash)) return json({ error: "Rate limited. Max 3 upgrades per hour." }, 429);

  const row = app.db
    .query<UpgradeRow, [string]>(
      "SELECT id, source_text, logic_document, knowledge_extract, understanding_document FROM extractions WHERE id = ? AND status = 'complete'"
    )
    .get(id);
  if (!row) return json({ error: "Document not found or not complete" }, 404);
  if (!row.source_text) return json({ error: "Document has no stored source text" }, 400);
  if (row.understanding_document) return json({ error: "Document already has an Understanding Document" }, 400);

  if (!app.jobs.acquire()) return json({ error: "Server busy" }, 503);
  app.db.query("UPDATE extractions SET status = 'phase3' WHERE id = ?").run(id);
  runUnderstandingUpgrade(app, id, row.source_text, row.logic_document).finally(app.jobs.release);
  return json({ id, status: "upgrading" });
}

export const extractRoutes: Route[] = [
  { method: "POST", match: exact("/api/extract"), handle: extract },
  { method: "POST", match: exact("/api/internal/extract"), handle: internalExtract },
  { method: "GET", match: prefix("/api/internal/s-prompt/"), handle: sPrompt },
  { method: "POST", match: exact("/api/internal/complete-s"), handle: completeS },
  { method: "POST", match: exact("/api/internal/merge"), handle: internalMerge },
  { method: "POST", match: prefix("/api/upgrade-understanding/"), handle: upgradeUnderstanding },
];
