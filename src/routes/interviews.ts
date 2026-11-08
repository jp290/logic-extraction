// Interview endpoints. A visitor is identified by an optional client key (so an
// interview survives IP changes) and falls back to the hashed IP.

import { exact, prefix, type RequestContext, type Route } from "../router.ts";
import { checkOrigin, ID_PATTERN, json, readJson } from "../http.ts";
import type { ChatMessage } from "../llm.ts";
import {
  assessCoverage,
  coverageSteering,
  MAX_TURNS,
  synthesizeInterview,
  type Coverage,
  type EnrichTarget,
} from "../pipeline/interview.ts";
import { INTERVIEW_SYSTEM_PROMPT } from "../prompts.ts";
import { generateId } from "../text.ts";

const MAX_MESSAGE_CHARS = 10_000;
const MAX_NOTES_CHARS = 2000;

function identity(c: RequestContext): string {
  const clientKey = c.req.headers.get("x-client-key");
  if (clientKey && /^[a-f0-9]{8}$/i.test(clientKey)) return `ck:${clientKey}`;
  return c.ipHash;
}

async function start(c: RequestContext): Promise<Response> {
  const { db, llm } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.interviewCreate(c.ipHash)) return json({ error: "Rate limited. Max 5 interviews per hour." }, 429);
  const owner = identity(c);

  const id = generateId();
  let response: string;
  try {
    response = await llm.chat([
      { role: "system", content: INTERVIEW_SYSTEM_PROMPT() },
      { role: "user", content: "Start the interview. Ask your opening question." },
    ]);
  } catch {
    return json({ error: "Failed to start interview" }, 500);
  }
  const messages = [{ role: "assistant", content: response }];
  const coverage = { core_logic: 0, commitments: 0, evaluation: 0, tensions: 0 };
  db.query("INSERT INTO interviews (id, messages, coverage, notes, ip_hash) VALUES (?, ?, ?, ?, ?)")
    .run(id, JSON.stringify(messages), JSON.stringify(coverage), "", owner);
  return json({ id, message: response, coverage });
}

async function message(c: RequestContext): Promise<Response> {
  const { db, llm } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.interviewMessage(c.ipHash)) return json({ error: "Rate limited. Try again shortly." }, 429);
  const owner = identity(c);

  const body = await readJson<{ id?: string; message?: string }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.id || typeof body.id !== "string" || !ID_PATTERN.test(body.id)) return json({ error: "Invalid id" }, 400);
  if (!body.message?.trim()) return json({ error: "Missing message" }, 400);
  if (body.message.length > MAX_MESSAGE_CHARS) return json({ error: "Message too long" }, 400);

  const row = db
    .query<{ id: string; messages: string; notes: string; coverage: string }, [string, string]>(
      "SELECT id, messages, notes, coverage FROM interviews WHERE id = ? AND status = 'active' AND ip_hash = ?"
    )
    .get(body.id, owner);
  if (!row) return json({ error: "Interview not found" }, 404);

  const messages = JSON.parse(row.messages) as ChatMessage[];
  if (messages.length >= MAX_TURNS * 2) return json({ error: "Interview has reached the maximum number of turns. Please synthesize." }, 400);
  messages.push({ role: "user", content: body.message.trim() });

  const apiMessages = [
    { role: "system", content: INTERVIEW_SYSTEM_PROMPT() + coverageSteering(row.coverage, row.notes) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  let response: string;
  let coverage: Coverage;
  let notes: string;
  try {
    [response, { coverage, notes }] = await Promise.all([llm.chat(apiMessages), assessCoverage(llm, messages)]);
  } catch {
    return json({ error: "Failed to generate a reply" }, 500);
  }

  messages.push({ role: "assistant", content: response });
  const allNotes = (row.notes ? row.notes + "\n" + notes : notes).slice(-MAX_NOTES_CHARS);
  db.query("UPDATE interviews SET messages = ?, coverage = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(messages), JSON.stringify(coverage), allNotes, body.id);
  return json({ message: response, coverage, turn: Math.floor(messages.length / 2) });
}

async function synthesize(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkOrigin(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  const owner = identity(c);

  const body = await readJson<{ id?: string; enrich_id?: string; is_public?: boolean }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.id || typeof body.id !== "string" || !ID_PATTERN.test(body.id)) return json({ error: "Invalid id" }, 400);
  if (body.enrich_id && (typeof body.enrich_id !== "string" || !ID_PATTERN.test(body.enrich_id))) return json({ error: "Invalid enrich_id" }, 400);
  if (!app.limits.interviewCreate(owner)) return json({ error: "Rate limited." }, 429);

  const row = app.db
    .query<{ id: string; messages: string; notes: string }, [string, string]>(
      "SELECT id, messages, notes FROM interviews WHERE id = ? AND status = 'active' AND ip_hash = ?"
    )
    .get(body.id, owner);
  if (!row) return json({ error: "Interview not found" }, 404);
  const messages = JSON.parse(row.messages) as ChatMessage[];
  if (messages.length < 4) return json({ error: "Need at least 2 exchanges before synthesizing" }, 400);

  let enrichTarget: EnrichTarget | null = null;
  if (body.enrich_id) {
    enrichTarget = app.db
      .query<EnrichTarget, [string, string]>(
        "SELECT id, logic_document, source_text, knowledge_extract, understanding_document, word_count FROM extractions WHERE id = ? AND status = 'complete' AND ip_hash = ?"
      )
      .get(body.enrich_id, owner);
    if (!enrichTarget) return json({ error: "Target lens not found" }, 404);
  }

  if (!app.jobs.acquire()) return json({ error: "Server busy" }, 503);
  app.db.query("UPDATE interviews SET status = 'synthesizing' WHERE id = ?").run(body.id);
  synthesizeInterview(app, {
    interviewId: body.id,
    ipHash: owner,
    messages,
    notes: row.notes,
    isPublic: body.is_public === true ? 1 : 0,
    enrichTarget,
  }).finally(app.jobs.release);
  return json({ id: body.id, status: "synthesizing" });
}

function status(c: RequestContext): Response {
  const { db } = c.app;
  const id = c.path.split("/").pop() as string;
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);
  const row = db
    .query<{ id: string; status: string; extraction_id: string | null; error: string | null }, [string]>(
      "SELECT id, status, extraction_id, error FROM interviews WHERE id = ?"
    )
    .get(id);
  if (!row) return json({ error: "Interview not found" }, 404);
  let phase = "";
  if (row.status === "synthesizing" && row.extraction_id) {
    phase = db.query<{ status: string }, [string]>("SELECT status FROM extractions WHERE id = ?").get(row.extraction_id)?.status || "";
  }
  return json({ id: row.id, status: row.status, extraction_id: row.extraction_id, error: row.error, phase });
}

function list(c: RequestContext): Response {
  const rows = c.app.db
    .query(
      `SELECT i.id, i.status, i.extraction_id, i.created_at, i.coverage,
              e.title as extraction_title
       FROM interviews i
       LEFT JOIN extractions e ON i.extraction_id = e.id
       WHERE i.ip_hash = ?
       ORDER BY i.created_at DESC LIMIT 20`
    )
    .all(identity(c));
  return json({ interviews: rows });
}

export const interviewRoutes: Route[] = [
  { method: "POST", match: exact("/api/interview/start"), handle: start },
  { method: "POST", match: exact("/api/interview/message"), handle: message },
  { method: "POST", match: exact("/api/interview/synthesize"), handle: synthesize },
  { method: "GET", match: prefix("/api/interview/status/"), handle: status },
  { method: "GET", match: exact("/api/interviews"), handle: list },
];
