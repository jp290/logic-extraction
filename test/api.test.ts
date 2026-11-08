// In-process API tests for failure paths: malformed bodies, an upstream model that
// is down, and a full job queue. Builds the app directly with a failing LLM client.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAppContext, createFetchHandler } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import type { LlmClient } from "../src/llm.ts";
import type { AppContext } from "../src/router.ts";

const down = (): Promise<never> => Promise.reject(new Error("AI processing failed (status 503)"));
const failingLlm: LlmClient = { model: "test-model", complete: down, chat: down, consult: down };

let dir: string;
let app: AppContext;
let server: ReturnType<typeof Bun.serve>;
let base: string;

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

function count(table: string): number {
  return (app.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "api-test-"));
  const config = loadConfig({ DEEPSEEK_API_KEY: "x", IP_HASH_SALT: "t", DATA_DIR: dir });
  app = createAppContext({ config, db: openDatabase(config.databasePath, "test-model"), llm: failingLlm });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createFetchHandler(app) });
  base = `http://127.0.0.1:${server.port}`;
  const insert = app.db.query(
    "INSERT INTO extractions (id, title, logic_document, word_count, status, ip_hash, is_public) VALUES (?, ?, ?, 10, 'complete', 'h', 1)"
  );
  insert.run("aaaaaaaaaaa1", "Lens A", "## 0. CORE OPERATING LOGIC\nA");
  insert.run("aaaaaaaaaaa2", "Lens B", "## 0. CORE OPERATING LOGIC\nB");
  app.db
    .query("INSERT INTO interviews (id, messages, coverage, notes, ip_hash) VALUES ('bbbbbbbbbbb1', ?, '{}', '', 'ck:abcdef12')")
    .run(JSON.stringify([{ role: "assistant", content: "Hi — what do you cook?" }]));
});

afterAll(() => {
  server.stop(true);
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("malformed JSON bodies get a 400, not an unhandled exception", () => {
  for (const path of ["/api/ask-compare", "/api/interview/message", "/api/interview/synthesize", "/api/ask", "/api/merge"]) {
    test(path, async () => {
      const res = await post(path, "{not json");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON" });
    });
  }
});

describe("an upstream model failure becomes a JSON 500", () => {
  test("interview start creates no row", async () => {
    const before = count("interviews");
    const res = await post("/api/interview/start", "{}");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to start interview" });
    expect(count("interviews")).toBe(before);
  });

  test("interview message keeps the transcript unchanged", async () => {
    const res = await post("/api/interview/message", JSON.stringify({ id: "bbbbbbbbbbb1", message: "High heat." }), { "x-client-key": "abcdef12" });
    expect(res.status).toBe(500);
    const row = app.db.query("SELECT messages FROM interviews WHERE id = 'bbbbbbbbbbb1'").get() as { messages: string };
    expect(JSON.parse(row.messages)).toHaveLength(1);
  });

  test("merge preview", async () => {
    const res = await post("/api/merge/preview", JSON.stringify({ parent_a: "aaaaaaaaaaa1", parent_b: "aaaaaaaaaaa2" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to generate preview" });
  });

  test("consult", async () => {
    const res = await post("/api/ask", JSON.stringify({ extraction_id: "aaaaaaaaaaa1", question: "How hot should the pan be?" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to generate answer" });
  });
});

describe("a full job queue rejects without leaving orphan rows", () => {
  test("logic test and merge return 503 and insert nothing", async () => {
    let taken = 0;
    while (app.jobs.acquire()) taken++;
    try {
      const tests = count("logic_tests");
      const merges = count("merges");
      const t = await post("/api/test", JSON.stringify({ extraction_id: "aaaaaaaaaaa1", scenario: "Twelve guests arrive early and the pan is small." }));
      const m = await post("/api/merge", JSON.stringify({ parent_a: "aaaaaaaaaaa1", parent_b: "aaaaaaaaaaa2", merge_type: "peer" }));
      expect([t.status, m.status]).toEqual([503, 503]);
      expect([count("logic_tests"), count("merges")]).toEqual([tests, merges]);
    } finally {
      for (let i = 0; i < taken; i++) app.jobs.release();
    }
  });
});

describe("configuration", () => {
  test("canonical links use PUBLIC_URL without a trailing slash", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "x", IP_HASH_SALT: "t", PUBLIC_URL: "https://lens.example/" });
    expect(config.publicUrl).toBe("https://lens.example");
  });

  test("a missing API key is a startup error", () => {
    expect(() => loadConfig({})).toThrow("DEEPSEEK_API_KEY");
  });
});
