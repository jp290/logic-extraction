// Consulting a lens: /api/ask (optionally router-first, optionally with a grounding
// pack) and /api/ask-compare (the same lens under the three prompt styles).

import { exact, type RequestContext, type Route } from "../router.ts";
import { groundAndPersistLensConsult, recheckAndPersist, routeLens, type LensMenuEntry } from "../consult.ts";
import type { PackArtifacts } from "../gates/recheck.ts";
import { checkOrigin, contentLength, ID_PATTERN, json, readJson } from "../http.ts";
import { completePrompt, type Prompt } from "../llm.ts";
import { ASK_PROMPT, ASK_PROMPT_PACK_ONLY, ASK_PROMPT_V2, ASK_PROMPT_V3 } from "../prompts.ts";

const MAX_ASK_BODY_BYTES = 100_000;
const MAX_QUESTION_CHARS = 2000;
const MIN_QUESTION_CHARS = 5;
const MAX_HISTORY = 20;
const MAX_HISTORY_MESSAGE_CHARS = 8000;
const MAX_ROUTE_POOL = 30;
const CONTEXT_MODES = ["ld", "ud", "ld+ud", "ld+ke+ud", "ld+kefull+ud"] as const;
const PROMPT_STYLES = ["v1", "v2", "v3"] as const;

type ContextMode = (typeof CONTEXT_MODES)[number];
type PromptStyle = (typeof PROMPT_STYLES)[number];
type HistoryMessage = { role: "user" | "assistant"; content: string };

interface AskBody {
  extraction_id?: string;
  pack_id?: string;
  reasoning?: boolean;
  question?: string;
  speculative?: boolean;
  context?: string;
  style?: string;
  history?: Array<{ role?: string; content?: string }>;
  route?: boolean;
  route_pool?: string[];
}

interface LensRow {
  logic_document: string;
  knowledge_extract: string | null;
  knowledge_core: string | null;
  understanding_document: string | null;
  source_text: string | null;
}

interface PackRow {
  pack_doc: string | null;
  params_json: string | null;
  dataset_csv: string | null;
  column_spec: string | null;
  notes: string | null;
}

const KE_BLOCK = (ke: string): string => "---BEGIN KNOWLEDGE EXTRACT---\n" + ke + "\n---END KNOWLEDGE EXTRACT---";

/**
 * Pick the prompt for a lens consult. v3 (default) and v2 take labeled layers; v1 nests
 * KE inside the UD block. The default depth injects the Core KE tier (null = untiered
 * lens, fall back to the full KE); "ld+kefull+ud" asks for the complete KE.
 */
export function buildLensPrompt(
  row: LensRow,
  question: string,
  style: PromptStyle,
  ctxMode: ContextMode,
  speculative: boolean,
  packDoc?: string
): { prompt: Prompt; ke: string | undefined; ud: string | undefined } {
  const ud = row.understanding_document ?? undefined;
  const wantsKe = ctxMode === "ld+ke+ud" || ctxMode === "ld+kefull+ud";
  const ke = ctxMode === "ld+kefull+ud"
    ? (row.knowledge_extract ?? undefined)
    : ((row.knowledge_core ?? row.knowledge_extract) ?? undefined);
  const udLayer = ctxMode === "ld" ? undefined : ud;
  const keLayer = wantsKe ? ke : undefined;

  if (style === "v2") return { prompt: ASK_PROMPT_V2(row.logic_document, question, speculative, udLayer, keLayer), ke, ud };
  if (style === "v3") return { prompt: ASK_PROMPT_V3(row.logic_document, question, speculative, udLayer, keLayer, packDoc), ke, ud };

  let ldForChat = row.logic_document;
  let udForChat: string | undefined;
  if (ctxMode === "ud") {
    ldForChat = row.understanding_document || row.logic_document;
  } else if (ctxMode === "ld+ud" || wantsKe) {
    udForChat = ud;
  }
  if (wantsKe && ke) udForChat = (udForChat ? udForChat + "\n\n---\n\n" : "") + KE_BLOCK(ke);
  return { prompt: ASK_PROMPT(ldForChat, question, speculative, udForChat), ke, ud };
}

type Routed = { chosen: string | null; title?: string; reason: string; pool_size: number };

// Router-first: only when no explicit lens is given. Returns the chosen id, or a response to send.
async function routeQuestion(c: RequestContext, body: AskBody): Promise<{ routed: Routed; id: string } | Response> {
  const { db, llm } = c.app;
  if (body.route_pool !== undefined) {
    if (
      !Array.isArray(body.route_pool) ||
      body.route_pool.length > MAX_ROUTE_POOL ||
      !body.route_pool.every((p) => typeof p === "string" && ID_PATTERN.test(p))
    ) {
      return json({ error: "Invalid route_pool" }, 400);
    }
  }
  if (!body.question || typeof body.question !== "string" || body.question.trim().length < MIN_QUESTION_CHARS) {
    return json({ error: "Question too short" }, 400);
  }
  const question = body.question.trim().slice(0, MAX_QUESTION_CHARS);
  const pool = body.route_pool ?? [];
  const candidates = pool.length > 0
    ? db
        .query<LensMenuEntry, string[]>(
          `SELECT id, title, doc_type, domain_tags, topic_summary FROM extractions
                   WHERE id IN (${pool.map(() => "?").join(", ")}) AND status = 'complete' AND flagged = 0`
        )
        .all(...pool)
    : db
        .query<LensMenuEntry, []>(
          `SELECT id, title, doc_type, domain_tags, topic_summary FROM extractions
                   WHERE status = 'complete' AND flagged = 0 AND is_public = 1
                   ORDER BY created_at DESC LIMIT 100`
        )
        .all();
  if (candidates.length < 2) return json({ error: "Routing needs at least 2 candidate lenses" }, 400);

  let selection: { choice: string | null; reason: string };
  try {
    selection = await routeLens(llm, question, candidates);
  } catch {
    return json({ error: "Routing failed" }, 500);
  }
  if (selection.choice === null) {
    return json({ abstained: true, routed: { chosen: null, reason: selection.reason, pool_size: candidates.length } });
  }
  const chosen = candidates.find((l) => l.id === selection.choice) as LensMenuEntry;
  return { routed: { chosen: chosen.id, title: chosen.title, reason: selection.reason, pool_size: candidates.length }, id: chosen.id };
}

function parseHistory(raw: AskBody["history"]): HistoryMessage[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY) return null;
  const history: HistoryMessage[] = [];
  for (const h of raw) {
    if (!h || (h.role !== "user" && h.role !== "assistant") || typeof h.content !== "string" || h.content.length > MAX_HISTORY_MESSAGE_CHARS) {
      return null;
    }
    history.push({ role: h.role, content: h.content });
  }
  return history;
}

async function ask(c: RequestContext): Promise<Response> {
  const { db, llm } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.ask(c.ipHash)) return json({ error: "Rate limited. Max 30 questions per hour." }, 429);
  if (contentLength(c.req) > MAX_ASK_BODY_BYTES) return json({ error: "Payload too large" }, 413);
  let body = await readJson<AskBody>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const routeRequested =
    !(typeof body.extraction_id === "string" && body.extraction_id) &&
    (body.route === true || (Array.isArray(body.route_pool) && body.route_pool.length > 0));
  let routed: Routed | null = null;
  if (routeRequested) {
    const result = await routeQuestion(c, body);
    if (result instanceof Response) return result;
    routed = result.routed;
    body = { ...body, extraction_id: result.id };
  }

  const extractionId = typeof body.extraction_id === "string" && ID_PATTERN.test(body.extraction_id) ? body.extraction_id : null;
  const packId = typeof body.pack_id === "string" && ID_PATTERN.test(body.pack_id) ? body.pack_id : null;
  if ((!extractionId && !packId) || !body.question || typeof body.question !== "string") {
    return json({ error: "Missing extraction_id or pack_id, or question" }, 400);
  }
  const history = parseHistory(body.history);
  if (!history) return json({ error: "Invalid history" }, 400);
  const question = body.question.trim().slice(0, MAX_QUESTION_CHARS);
  if (question.length < MIN_QUESTION_CHARS) return json({ error: "Question too short" }, 400);
  const ctxMode: ContextMode = CONTEXT_MODES.includes(body.context as ContextMode) ? (body.context as ContextMode) : "ld+ke+ud";

  let packDoc: string | undefined;
  let packArtifacts: PackArtifacts | undefined;
  if (packId) {
    const packRow = db
      .query<PackRow, [string]>("SELECT pack_doc, params_json, dataset_csv, column_spec, notes FROM packs WHERE id = ? AND status = 'complete'")
      .get(packId);
    if (!packRow?.pack_doc) return json({ error: "Pack not found or not complete" }, 404);
    packDoc = packRow.pack_doc;
    packArtifacts = {
      paramsJson: packRow.params_json ?? "",
      datasetCsv: packRow.dataset_csv ?? "",
      columnSpec: packRow.column_spec ?? "",
      notes: packRow.notes ?? "",
    };
  }
  // The reasoning tier defaults ON with a pack: flash + pack fabricates solves,
  // the reasoning model solves pack models correctly. Explicit false opts out.
  const reasoning = typeof body.reasoning === "boolean" ? body.reasoning : packId !== null;

  const row = extractionId
    ? db
        .query<LensRow, [string]>(
          "SELECT logic_document, knowledge_extract, knowledge_core, understanding_document, source_text FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0"
        )
        .get(extractionId)
    : null;
  if (extractionId && (!row || !row.logic_document)) return json({ error: "Extraction not found or not complete" }, 404);

  try {
    if (!row) {
      // A pack without a lens consults the pack alone.
      const prompt = ASK_PROMPT_PACK_ONLY(packDoc as string, question);
      const result = await llm.consult(prompt.system, prompt.user, history, reasoning);
      const recheck = recheckAndPersist(db, {
        pack: packArtifacts as PackArtifacts,
        packId: packId as string,
        extractionId: null,
        mode: "pack-only",
        question,
        answer: result.answer,
        model: result.model,
        ipHash: c.ipHash,
      });
      return json({ answer: result.answer, model: result.model, recheck: { claims: recheck.claims, flags: recheck.flags, checked: recheck.checked } });
    }

    // A pack rides the v3 layered prompt; style only applies to lens-only consults.
    const style: PromptStyle = PROMPT_STYLES.includes(body.style as PromptStyle) && !packDoc ? (body.style as PromptStyle) : "v3";
    const { prompt, ke, ud } = buildLensPrompt(row, question, style, ctxMode, !!body.speculative, packDoc);
    const result = await llm.consult(prompt.system, prompt.user, history, reasoning);
    if (packArtifacts) {
      const recheck = recheckAndPersist(db, {
        pack: packArtifacts,
        packId: packId as string,
        extractionId,
        mode: "lens+pack",
        question,
        answer: result.answer,
        model: result.model,
        ipHash: c.ipHash,
      });
      return json({ answer: result.answer, model: result.model, recheck: { claims: recheck.claims, flags: recheck.flags, checked: recheck.checked }, ...(routed ? { routed } : {}) });
    }
    const grounding = groundAndPersistLensConsult(db, {
      extractionId: extractionId as string,
      sourceText: row.source_text,
      lensText: [row.logic_document, ke, ud].filter(Boolean).join("\n\n"),
      question,
      answer: result.answer,
      model: result.model,
      ipHash: c.ipHash,
    });
    return json({ answer: result.answer, model: result.model, ...(grounding ? { grounding } : {}), ...(routed ? { routed } : {}) });
  } catch (err) {
    const msg = err instanceof Error && err.message.startsWith("Reasoning consumed") ? err.message : "Failed to generate answer";
    return json({ error: msg }, 500);
  }
}

// The same lens and data under the three prompt styles, side by side.
async function askCompare(c: RequestContext): Promise<Response> {
  const { db, llm } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.ask(c.ipHash)) return json({ error: "Rate limited" }, 429);
  const body = await readJson<Record<string, unknown>>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.extraction_id || !ID_PATTERN.test(body.extraction_id as string) || !body.question || typeof body.question !== "string") {
    return json({ error: "Missing extraction_id or question" }, 400);
  }
  const question = body.question.trim().slice(0, MAX_QUESTION_CHARS);
  const row = db
    .query<{ logic_document: string; knowledge_extract: string | null; understanding_document: string | null }, [string]>(
      "SELECT logic_document, knowledge_extract, understanding_document FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0"
    )
    .get(body.extraction_id as string);
  if (!row || !row.logic_document) return json({ error: "Extraction not found" }, 404);

  try {
    const ud = row.understanding_document ?? undefined;
    const ke = row.knowledge_extract ?? undefined;
    const udForV1 = ke ? (ud ? ud + "\n\n---\n\n" : "") + KE_BLOCK(ke) : ud;
    const [answerV1, answerV2, answerV3] = await Promise.all([
      completePrompt(llm, ASK_PROMPT(row.logic_document, question, false, udForV1)),
      completePrompt(llm, ASK_PROMPT_V2(row.logic_document, question, false, ud, ke)),
      completePrompt(llm, ASK_PROMPT_V3(row.logic_document, question, false, ud, ke)),
    ]);
    return json({
      v1: { answer: answerV1, label: "Current" },
      v2: { answer: answerV2, label: "Structured" },
      v3: { answer: answerV3, label: "Balanced" },
    });
  } catch {
    return json({ error: "Failed to generate answers" }, 500);
  }
}

export const consultRoutes: Route[] = [
  { method: "POST", match: exact("/api/ask"), handle: ask },
  { method: "POST", match: exact("/api/ask-compare"), handle: askCompare },
];
