// Golden-master harness: boots the engine as a subprocess against the mock LLM,
// drives every HTTP route through one fixed scenario, and returns a normalized
// record (HTTP responses, LLM call multiset, final database state). Two runs of
// the same code must produce identical records; a refactor must too.

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { maskNonces, startMockLlm } from "./mock-llm.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures");
const INTERNAL_TOKEN = "golden-internal-token-0123456789abcdef";
const BIG_BODY = 20_000;

export interface GoldenStep {
  step: string;
  status: number;
  type: string;
  body: unknown;
}

export interface GoldenRecord {
  steps: GoldenStep[];
  llm: string[];
  db: Record<string, unknown[]>;
}

const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const TIMESTAMP = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/g;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ID = /\b[0-9a-f]{12}\b/g;

// Ids are random per run: number them by first appearance (steps run in a fixed
// order, the DB dump follows rowid), so references between rows stay checkable.
function makeNormalizer(): (s: string) => string {
  const seen = new Map<string, string>();
  return (s: string) =>
    maskNonces(s)
      .replace(ID, (id) => {
        if (!seen.has(id)) seen.set(id, `<id${seen.size + 1}>`);
        return seen.get(id) as string;
      })
      .replace(TIMESTAMP, "<ts>");
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

function bigSource(): string {
  const paras: string[] = [];
  for (let i = 1; i <= 3200; i++) {
    paras.push(`Paragraph ${i}. When the pan is loaded with ${i % 7 + 2} pieces, add ${i % 5 + 1} spoons of tallow and wait for the roast aroma before turning; batch ${i} rests ${i % 4 + 1} minutes.`);
  }
  return paras.join("\n\n");
}

export async function runScenario(entry: string): Promise<GoldenRecord> {
  const mock = startMockLlm();
  const dataDir = mkdtempSync(join(tmpdir(), "golden-"));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PORT: String(port),
    DATA_DIR: dataDir,
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_API_URL: mock.url,
    IP_HASH_SALT: "golden-salt",
    INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    PUBLIC_URL: "https://lens.example",
    PACK_PYTHON: process.env.PACK_PYTHON ?? join(ROOT, "tools", "pack", ".venv", "bin", "python"),
  };
  const proc = Bun.spawn(["bun", join(ROOT, entry)], { env, stdout: "pipe", stderr: "pipe", cwd: ROOT });
  const steps: GoldenStep[] = [];
  const normalizeText = makeNormalizer();

  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/api/test-scenarios`)).ok) break;
      } catch { /* not up yet */ }
      if (i > 100) throw new Error("engine did not start");
      await sleep(100);
    }

    const cooking = readFileSync(join(FIXTURES, "cooking-interview.txt"), "utf-8");
    const sourdough = readFileSync(join(FIXTURES, "sourdough-notes.txt"), "utf-8");

    async function call(step: string, method: string, path: string, opts: { json?: unknown; raw?: string; type?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; data: any }> {
      const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "10.0.0.1", ...(opts.headers ?? {}) };
      let body: string | undefined;
      if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers["content-type"] = "application/json"; }
      if (opts.raw !== undefined) { body = opts.raw; headers["content-type"] = opts.type ?? "application/json"; }
      const res = await fetch(base + path, { method, headers, body });
      const type = res.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      let data: any = null;
      let recorded: unknown;
      if (type.includes("application/json")) {
        const text = new TextDecoder().decode(bytes);
        data = JSON.parse(text);
        recorded = text.length > BIG_BODY ? { sha: sha(normalizeText(text)), length: text.length } : JSON.parse(normalizeText(text));
      } else if (type.includes("gzip")) {
        recorded = { disposition: res.headers.get("content-disposition") };
      } else {
        const text = new TextDecoder().decode(bytes);
        recorded = { sha: sha(normalizeText(text)), length: text.length, csp: res.headers.get("content-security-policy") };
      }
      steps.push({ step, status: res.status, type, body: recorded });
      return { status: res.status, data };
    }

    async function waitFor(path: string, done: (d: any) => boolean, headers: Record<string, string> = {}): Promise<any> {
      for (let i = 0; i < 400; i++) {
        const res = await fetch(base + path, { headers: { "x-forwarded-for": "10.0.0.99", ...headers } });
        const d = await res.json();
        if (done(d)) return d;
        await sleep(50);
      }
      throw new Error(`timeout waiting for ${path}`);
    }
    const finished = (d: any): boolean => d.status === "complete" || d.status === "failed";
    // created_at has 1-second resolution; spacing creations keeps ORDER BY created_at deterministic.
    const tick = (): Promise<void> => sleep(1100);

    // ── validation ─────────────────────────────────────────────
    await call("extract: wrong content-type", "POST", "/api/extract", { raw: "x", type: "text/plain" });
    await call("extract: missing text", "POST", "/api/extract", { json: {} });
    await call("extract: too short", "POST", "/api/extract", { json: { text: "short" } });
    await call("extract: invalid json", "POST", "/api/extract", { raw: "{bad" });
    await call("api: unknown route", "GET", "/api/nope");

    // ── extractions ────────────────────────────────────────────
    const cook = (await call("extract: cooking", "POST", "/api/extract", { json: { text: cooking, title: "Cooking", is_public: true } })).data.id;
    await waitFor(`/api/extractions/${cook}`, finished);
    await call("get: cooking", "GET", `/api/extractions/${cook}`);
    await tick();
    const dough = (await call("extract: sourdough logic-only", "POST", "/api/extract", { json: { text: sourdough, mode: "logic", is_public: true } })).data.id;
    await waitFor(`/api/extractions/${dough}`, finished);
    await call("get: sourdough", "GET", `/api/extractions/${dough}`);
    await tick();
    const big = (await call("extract: big chunked", "POST", "/api/extract", { json: { text: bigSource(), is_public: true } })).data.id;
    await waitFor(`/api/extractions/${big}`, finished);
    await call("get: big", "GET", `/api/extractions/${big}`);
    await tick();
    const html = (await call("extract: html private", "POST", "/api/extract", { json: { text: `<h1>Notes</h1><p>${sourdough}</p>&nbsp;` } })).data.id;
    await waitFor(`/api/extractions/${html}`, finished);
    await call("get: html", "GET", `/api/extractions/${html}`);
    await tick();
    const fail = (await call("extract: upstream failure", "POST", "/api/extract", { json: { text: `LLM-FAIL-500 ${sourdough}`, is_public: true } })).data.id;
    await waitFor(`/api/extractions/${fail}`, finished);
    await call("get: failed", "GET", `/api/extractions/${fail}`);
    await tick();

    // ── listing / export ───────────────────────────────────────
    await call("list: default", "GET", "/api/extractions");
    await call("list: search", "GET", "/api/extractions?q=Mock");
    await call("list: sort views", "GET", "/api/extractions?sort=views");
    await call("list: filter source", "GET", "/api/extractions?filter=source");
    await call("list: page 2", "GET", "/api/extractions?page=2&limit=1");
    await call("list: titles", "GET", "/api/extractions/titles");
    await call("get: invalid id", "GET", "/api/extractions/bad-id!");
    await call("get: missing", "GET", "/api/extractions/aaaaaaaaaaaa");
    await call("okf: json", "GET", `/api/extractions/${cook}/okf?format=json`);
    await call("okf: tar", "GET", `/api/extractions/${cook}/okf`);
    await call("okf: missing", "GET", "/api/extractions/aaaaaaaaaaaa/okf");
    await call("workflows", "GET", "/api/workflows");

    // ── consult ────────────────────────────────────────────────
    const q = "How should I sear chicken thighs for a crowd?";
    await call("ask: default", "POST", "/api/ask", { json: { extraction_id: cook, question: q } });
    for (const [style, context] of [["v1", "ld"], ["v1", "ud"], ["v1", "ld+ud"], ["v1", "ld+ke+ud"], ["v2", "ld+kefull+ud"], ["v3", "ld"]]) {
      await call(`ask: ${style} ${context}`, "POST", "/api/ask", { json: { extraction_id: cook, question: q, style, context } });
    }
    await call("ask: speculative + history", "POST", "/api/ask", { json: { extraction_id: cook, question: q, speculative: true, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } });
    await call("ask: reasoning tier", "POST", "/api/ask", { json: { extraction_id: cook, question: q, reasoning: true }, ip: "10.0.0.2" });
    await call("ask: empty answer", "POST", "/api/ask", { json: { extraction_id: cook, question: "EMPTY-ANSWER please", reasoning: true }, ip: "10.0.0.2" });
    await call("ask: bad history", "POST", "/api/ask", { json: { extraction_id: cook, question: q, history: [{ role: "system", content: "x" }] } });
    await call("ask: too short", "POST", "/api/ask", { json: { extraction_id: cook, question: "hm" } });
    await call("ask: missing", "POST", "/api/ask", { json: { question: q } });
    await call("ask: logic-only lens", "POST", "/api/ask", { json: { extraction_id: dough, question: q }, ip: "10.0.0.2" });
    await call("ask: route all", "POST", "/api/ask", { json: { route: true, question: q }, ip: "10.0.0.3" });
    await call("ask: route pool", "POST", "/api/ask", { json: { route_pool: [dough, cook], question: q }, ip: "10.0.0.3" });
    await call("ask: route abstain", "POST", "/api/ask", { json: { route: true, question: "ABSTAIN on this one" }, ip: "10.0.0.3" });
    await call("ask: route invalid choice", "POST", "/api/ask", { json: { route: true, question: "INVALID choice please" }, ip: "10.0.0.3" });
    await call("ask: route bad pool", "POST", "/api/ask", { json: { route_pool: ["bad id!"], question: q }, ip: "10.0.0.3" });
    await call("ask: route pool too small", "POST", "/api/ask", { json: { route_pool: [cook], question: q }, ip: "10.0.0.3" });
    await call("ask-compare", "POST", "/api/ask-compare", { json: { extraction_id: cook, question: q }, ip: "10.0.0.4" });
    await call("ask-compare: missing", "POST", "/api/ask-compare", { json: { question: q }, ip: "10.0.0.4" });

    // ── logic tests ────────────────────────────────────────────
    await call("test-scenarios", "GET", "/api/test-scenarios");
    await call("generate-scenarios", "POST", "/api/generate-scenarios", { json: { extraction_id: cook } });
    await call("generate-scenarios: invalid", "POST", "/api/generate-scenarios", { json: { extraction_id: "bad id" } });
    const test = (await call("test: create", "POST", "/api/test", { json: { extraction_id: cook, scenario: "A dinner party of twelve arrives early and the pan is small." } })).data.id;
    await waitFor(`/api/tests/${test}`, finished);
    await call("test: get", "GET", `/api/tests/${test}`);
    await call("test: too short", "POST", "/api/test", { json: { extraction_id: cook, scenario: "short" } });
    await tick();

    // ── understanding upgrade ──────────────────────────────────
    await call("upgrade: sourdough", "POST", `/api/upgrade-understanding/${dough}`, { json: {} });
    await waitFor(`/api/extractions/${dough}`, finished);
    await call("upgrade: get", "GET", `/api/extractions/${dough}`);
    await call("upgrade: already has UD", "POST", `/api/upgrade-understanding/${dough}`, { json: {} });
    await tick();

    // ── merges ─────────────────────────────────────────────────
    await call("merge preview", "POST", "/api/merge/preview", { json: { parent_a: cook, parent_b: big } });
    await call("merge preview: cached", "POST", "/api/merge/preview", { json: { parent_a: big, parent_b: cook } });
    await call("merge preview: self", "POST", "/api/merge/preview", { json: { parent_a: cook, parent_b: cook } });
    const m1 = (await call("merge: peer", "POST", "/api/merge", { json: { parent_a: cook, parent_b: big, merge_type: "peer", backbone: "a" }, ip: "10.0.0.5" })).data.id;
    const m1done = await waitFor(`/api/merges/${m1}`, finished);
    await call("merge: peer status", "GET", `/api/merges/${m1}`);
    await call("merge: peer result", "GET", `/api/extractions/${m1done.result_id}`);
    await tick();
    const m2 = (await call("merge: thematical", "POST", "/api/merge", { json: { parent_a: dough, parent_b: html, merge_type: "thematical" }, ip: "10.0.0.5" })).data.id;
    const m2done = await waitFor(`/api/merges/${m2}`, finished);
    await call("merge: thematical result", "GET", `/api/extractions/${m2done.result_id}`);
    await tick();
    const m3 = (await call("merge: nested awareness", "POST", "/api/merge", { json: { parent_a: m1done.result_id, parent_b: dough, merge_type: "awareness" }, ip: "10.0.0.5" })).data.id;
    const m3done = await waitFor(`/api/merges/${m3}`, finished);
    await call("merge: nested result", "GET", `/api/extractions/${m3done.result_id}`);
    await call("merge: rate limited", "POST", "/api/merge", { json: { parent_a: cook, parent_b: dough, merge_type: "peer" }, ip: "10.0.0.5" });
    await call("merge: invalid type", "POST", "/api/merge", { json: { parent_a: cook, parent_b: dough, merge_type: "fusion" } });
    await call("merges: list", "GET", "/api/merges", { ip: "10.0.0.5" });
    await call("list: filter merge", "GET", "/api/extractions?filter=merge");
    await tick();

    // ── interviews ─────────────────────────────────────────────
    const ck = { "x-client-key": "a1b2c3d4" };
    const iv = (await call("interview: start", "POST", "/api/interview/start", { json: {}, headers: ck })).data.id;
    await call("interview: message 1", "POST", "/api/interview/message", { json: { id: iv, message: "I cook without recipes, high heat and beef tallow." }, headers: ck });
    await call("interview: synthesize too early", "POST", "/api/interview/synthesize", { json: { id: iv }, headers: ck });
    await call("interview: message 2", "POST", "/api/interview/message", { json: { id: iv, message: "Salt in layers, roast first, then go for doneness." }, headers: ck });
    await call("interview: wrong identity", "POST", "/api/interview/message", { json: { id: iv, message: "hello" }, headers: { "x-client-key": "ffffffff" } });
    await call("interview: synthesize", "POST", "/api/interview/synthesize", { json: { id: iv, is_public: true }, headers: ck });
    const ivDone = await waitFor(`/api/interview/status/${iv}`, finished);
    await call("interview: status", "GET", `/api/interview/status/${iv}`);
    await call("interview: lens", "GET", `/api/extractions/${ivDone.extraction_id}`);
    await tick();
    const iv2 = (await call("interview 2: start", "POST", "/api/interview/start", { json: {}, headers: ck })).data.id;
    await call("interview 2: message 1", "POST", "/api/interview/message", { json: { id: iv2, message: "Broccoli gets salted before frying too." }, headers: ck });
    await call("interview 2: message 2", "POST", "/api/interview/message", { json: { id: iv2, message: "A half-closed lid steams rosemary at the end." }, headers: ck });
    await call("interview 2: enrich", "POST", "/api/interview/synthesize", { json: { id: iv2, enrich_id: ivDone.extraction_id }, headers: ck });
    await waitFor(`/api/interview/status/${iv2}`, finished);
    await call("interview 2: status", "GET", `/api/interview/status/${iv2}`);
    await call("interview 2: enriched lens", "GET", `/api/extractions/${ivDone.extraction_id}`);
    await call("interviews: list", "GET", "/api/interviews", { headers: ck });
    await tick();

    // ── grounding packs ────────────────────────────────────────
    const csv = ["cycle,capacity_ah", ...Array.from({ length: 40 }, (_, i) => `${i + 1},${(2.0 - 0.004 * (i + 1) + ((i * 7) % 5) * 0.001).toFixed(4)}`)].join("\n");
    await call("pack: invalid", "POST", "/api/packs", { json: { title: "x", csv: "a" } });
    const pack = (await call("pack: create", "POST", "/api/packs", { json: { title: "Battery fade", csv, columns: { cycle: { role: "index", unit: "cycle" }, capacity_ah: { role: "value", unit: "Ah" } }, extraction_id: cook } })).data.id;
    await waitFor(`/api/packs/${pack}`, (d) => d.status !== "building");
    await call("pack: get", "GET", `/api/packs/${pack}`);
    await call("packs: list", "GET", "/api/packs");
    await call("ask: pack-only", "POST", "/api/ask", { json: { pack_id: pack, question: "What capacity at cycle 130?" }, ip: "10.0.0.6" });
    await call("ask: lens+pack", "POST", "/api/ask", { json: { extraction_id: cook, pack_id: pack, question: "What capacity at cycle 130?" }, ip: "10.0.0.6" });
    await call("recheck telemetry", "GET", "/api/recheck-telemetry");
    await tick();

    // ── internal (token-gated) ─────────────────────────────────
    const tok = { "x-internal-token": INTERNAL_TOKEN };
    await call("internal: no token", "POST", "/api/internal/extract", { json: { text: sourdough } });
    const ext = (await call("internal: extract external-s", "POST", "/api/internal/extract", { json: { text: sourdough, is_public: true }, headers: tok })).data.id;
    await waitFor(`/api/extractions/${ext}`, (d) => d.status === "phase3");
    await sleep(200);
    await call("internal: s-prompt", "GET", `/api/internal/s-prompt/${ext}`, { headers: tok });
    await call("internal: complete-s too short", "POST", "/api/internal/complete-s", { json: { id: ext, logic_document: "too short" }, headers: tok });
    const ld = `## 0. CORE OPERATING LOGIC\n\nExternal synthesis: "Starter" rules the timeline and the baker keeps "honest attention". ${"Proof until the dough domes and springs back slowly. ".repeat(20)}`;
    await call("internal: complete-s", "POST", "/api/internal/complete-s", { json: { id: ext, logic_document: ld, s_model: "external-model" }, headers: tok });
    await waitFor(`/api/extractions/${ext}`, finished);
    await call("internal: external-s result", "GET", `/api/extractions/${ext}`);
    await call("internal: complete-s again", "POST", "/api/internal/complete-s", { json: { id: ext, logic_document: ld }, headers: tok });
    await tick();
    const im = (await call("internal: merge", "POST", "/api/internal/merge", { json: { parent_a: cook, parent_b: ext, merge_type: "asymmetric" }, headers: tok })).data.id;
    const imDone = await waitFor(`/api/merges/${im}`, finished);
    await call("internal: merge result", "GET", `/api/extractions/${imDone.result_id}`);
    await tick();

    // ── moderation ─────────────────────────────────────────────
    for (const ip of ["10.1.0.1", "10.1.0.2", "10.1.0.3"]) {
      await call(`flag from ${ip}`, "POST", `/api/flag/${html}`, { json: {}, ip });
    }
    await call("get: flagged", "GET", `/api/extractions/${html}`);

    // ── static ─────────────────────────────────────────────────
    await call("static: root", "GET", "/");
    await call("static: alias", "GET", "/logic-extraction");
    await call("static: lens page", "GET", `/e/${cook}`);
    await call("static: lens page missing", "GET", "/e/aaaaaaaaaaaa");
    await call("static: css", "GET", "/base.css");
    await call("static: module", "GET", "/modules/extract.js");
    await call("static: traversal", "GET", "/%2e%2e/server.ts");
    await call("static: missing", "GET", "/nope.txt");
  } finally {
    proc.kill();
    await proc.exited;
    mock.stop();
  }

  const stderr = await new Response(proc.stderr).text();
  const db = dumpDb(join(dataDir, "extractions.db"), normalizeText);
  rmSync(dataDir, { recursive: true, force: true });
  if (process.env.GOLDEN_DEBUG) console.error(stderr);
  return { steps, llm: mock.log.map((r) => `${r.agent} ${r.model} ${r.hash}`).sort(), db };
}

const TABLES = ["extractions", "merges", "logic_tests", "flags", "interviews", "packs", "consults", "lens_consults"];

function dumpDb(path: string, normalizeText: (s: string) => string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const rows = db.query(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
    out[t] = rows.map((row) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== "string") { clean[k] = v; continue; }
        const n = normalizeText(v);
        clean[k] = n.length > 2000 ? { sha: sha(n), length: n.length } : n;
      }
      return clean;
    });
  }
  db.close();
  return out;
}
