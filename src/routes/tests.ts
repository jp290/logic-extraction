// Logic tests: a scenario answered bare vs. with the lens, plus scenario generation
// tailored to one lens.

import { exact, prefix, type RequestContext, type Route } from "../router.ts";
import { checkOrigin, contentLength, ID_PATTERN, json, readJson } from "../http.ts";
import { runLogicTest } from "../pipeline/logic-test.ts";
import { SCENARIO_GENERATION_PROMPT, SCENARIO_GENERATION_SYSTEM, TEST_SCENARIOS } from "../prompts.ts";
import { generateId, stripJsonFence } from "../text.ts";

const MAX_SCENARIO_CHARS = 2000;
const MIN_SCENARIO_CHARS = 20;
const LD_PREVIEW_CHARS = 4000;

async function generateScenarios(c: RequestContext): Promise<Response> {
  const { db, llm } = c.app;
  if (!checkOrigin(c.req, c.app.config)) return json({ error: "Forbidden" }, 403);
  if (!c.app.limits.test(c.ipHash)) return json({ error: "Rate limited. Max 10 scenario generations per hour." }, 429);
  if (contentLength(c.req) > 10_000) return json({ error: "Payload too large" }, 413);
  const body = await readJson<{ extraction_id?: string }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.extraction_id || typeof body.extraction_id !== "string" || !ID_PATTERN.test(body.extraction_id)) {
    return json({ error: "Invalid extraction_id" }, 400);
  }
  const ext = db
    .query<Record<string, string>, [string]>(
      "SELECT title, doc_type, topic_summary, domain_tags, logic_document FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0"
    )
    .get(body.extraction_id);
  if (!ext) return json({ error: "Document not found" }, 404);

  const prompt = SCENARIO_GENERATION_PROMPT({
    title: ext.title,
    docType: ext.doc_type || "Unknown",
    about: ext.topic_summary || "",
    tags: ext.domain_tags || "[]",
    ldPreview: (ext.logic_document || "").slice(0, LD_PREVIEW_CHARS),
  });
  try {
    const raw = await llm.complete(SCENARIO_GENERATION_SYSTEM, prompt);
    return json({ scenarios: JSON.parse(stripJsonFence(raw)) });
  } catch {
    return json({ error: "Failed to generate scenarios" }, 500);
  }
}

async function createTest(c: RequestContext): Promise<Response> {
  const { app } = c;
  if (!checkOrigin(c.req, app.config)) return json({ error: "Forbidden" }, 403);
  if (!app.limits.test(c.ipHash)) return json({ error: "Rate limited. Max 10 tests per hour." }, 429);
  if (contentLength(c.req) > 100_000) return json({ error: "Payload too large" }, 413);
  const body = await readJson<{ extraction_id?: string; scenario?: string }>(c.req);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  if (!body.extraction_id || !ID_PATTERN.test(body.extraction_id)) return json({ error: "Invalid extraction_id" }, 400);
  if (!body.scenario || typeof body.scenario !== "string") return json({ error: "Missing scenario" }, 400);
  const scenario = body.scenario.trim().slice(0, MAX_SCENARIO_CHARS);
  if (scenario.length < MIN_SCENARIO_CHARS) return json({ error: "Scenario too short (min 20 chars)" }, 400);

  const ext = app.db.query("SELECT id FROM extractions WHERE id = ? AND status = 'complete' AND flagged = 0").get(body.extraction_id);
  if (!ext) return json({ error: "Extraction not found or not complete" }, 404);

  // Take the job slot first: a row inserted without one would sit in 'pending' forever.
  if (!app.jobs.acquire()) return json({ error: "Server busy" }, 503);
  const id = generateId();
  app.db.query("INSERT INTO logic_tests (id, extraction_id, scenario, ip_hash) VALUES (?, ?, ?, ?)").run(id, body.extraction_id, scenario, c.ipHash);
  runLogicTest(app, id).finally(app.jobs.release);
  return json({ id, status: "pending" }, 201);
}

function getTest(c: RequestContext): Response {
  const id = c.path.split("/")[3];
  if (!id || !ID_PATTERN.test(id)) return json({ error: "Invalid id" }, 400);
  const row = c.app.db
    .query("SELECT id, extraction_id, scenario, logic_response, baseline_response, status, error, created_at FROM logic_tests WHERE id = ?")
    .get(id);
  if (!row) return json({ error: "Not found" }, 404);
  return json(row);
}

export const testRoutes: Route[] = [
  { method: "GET", match: exact("/api/test-scenarios"), handle: () => json({ scenarios: TEST_SCENARIOS }) },
  { method: "POST", match: exact("/api/generate-scenarios"), handle: generateScenarios },
  { method: "POST", match: exact("/api/test"), handle: createTest },
  { method: "GET", match: prefix("/api/tests/"), handle: getTest },
];
