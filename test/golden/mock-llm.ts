// Deterministic stand-in for an OpenAI-compatible chat-completions endpoint.
// Replies depend only on request content (never on call order), so a run is
// reproducible even though the pipeline issues many calls in parallel. Every
// request is logged as a content hash so two runs can be compared call for call.

import { createHash } from "crypto";

export interface LoggedRequest {
  agent: string;
  model: string;
  hash: string;
}

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: string };
}

const ID = /\b[0-9a-f]{12}\b/g;
// prompts.ts wraps injected documents in delimiters carrying a random nonce.
const NONCE = /(---(?:BEGIN|END) [^\[\n]+ \[)[0-9a-z]*(\]---)/g;
export const maskNonces = (s: string): string => s.replace(NONCE, "$1<nonce>$2");
export const maskIds = (s: string): string => maskNonces(s).replace(ID, "<id>");
const sha = (s: string, n = 8): string => createHash("sha256").update(s).digest("hex").slice(0, n);

// System-prompt prefixes of agents whose replies the server parses.
const AGENTS: Array<[string, string]> = [
  ["You are a routing layer", "router"],
  ["You assess interview coverage", "coverage"],
  ["You generate test scenarios as JSON", "scenarios"],
  ["You are a document classifier", "profile"],
  ["You are a knowledge triage specialist", "k-core"],
  ["You are a factual claim verifier", "vk"],
  ["You are a content auditor for an Understanding Document", "vu"],
  ["You are writing an Understanding Document", "u2"],
  ["You verify a crystallized Logic Document", "crystallize-audit"],
  ["You assess framework compatibility for merging", "merge-preview"],
  ["You are an interviewer", "interviewer"],
];

function classify(system: string): string {
  for (const [prefix, name] of AGENTS) if (system.startsWith(prefix)) return name;
  return `agent-${sha(system.slice(0, 200), 6)}`;
}

// Generic markdown reply: carries a verbatim quote from the cooking fixture, a
// fabricated quote, traceable and untraceable numbers, and ≥8 bullet units, so
// the quote gate, numeric reconcile and core tiering all have work to do.
function genericDoc(agent: string, key: string): string {
  const bullets = Array.from({ length: 10 }, (_, i) =>
    `- Unit ${i + 1} (${agent}): keep the pan hot and the fat sufficient before turning [${key}-${i}].`
  ).join("\n");
  return `## 0. CORE OPERATING LOGIC

Mock synthesis by ${agent} [in=${key}]. The anchor move is "salting the chicken in advance" and the cook keeps "honest attention" on the pan.
A fabricated quote follows: "always preheat cast iron for exactly twelve minutes".

## 1. PRACTICE

${bullets}

The pan runs at 8-9/10 heat, roughly 230 °C, for 30s-1min, and 47% of the fat renders (Marco Pierre White, Kitchen Standards Board).

## 2. CLOSING

Roast first, then go for doneness.`;
}

function between(s: string, start: string, end: string): string {
  const a = s.indexOf(start);
  if (a === -1) return "";
  const b = s.indexOf(end, a + start.length);
  return s.slice(a + start.length, b === -1 ? undefined : b);
}

interface MenuEntry {
  id: string;
  canonical: string;
}

// The route-pool query has no ORDER BY, so the menu follows the (random) id order.
// Canonicalize it: entries sorted by their id-masked text, numbering dropped.
function routerMenu(user: string): { entries: MenuEntry[]; canonicalUser: string } {
  const menu = between(user, "LENS MENU:\n", "\n\nReview EVERY lens");
  const entries = menu
    .split("\n\n")
    .map((block) => ({ id: /id: ([0-9a-z]+)/.exec(block)?.[1] ?? "", canonical: maskIds(block.replace(/^\d+\. /, "")) }))
    .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
  return { entries, canonicalUser: user.replace(menu, entries.map((e) => e.canonical).join("\n\n")) };
}

function canonicalRequest(agent: string, body: ChatBody): string {
  if (agent !== "router") return maskIds(JSON.stringify(body));
  const messages = body.messages.map((m) => (m.role === "user" ? { ...m, content: routerMenu(m.content).canonicalUser } : m));
  return maskIds(JSON.stringify({ ...body, messages }));
}

function reply(agent: string, system: string, user: string, model: string): { content: string; finish: string; status: number } {
  const key = sha(agent === "router" ? system + "\n" + routerMenu(user).canonicalUser : maskIds(system + "\n" + user));
  if (user.includes("LLM-FAIL-500")) return { content: "", finish: "stop", status: 500 };
  switch (agent) {
    case "router": {
      const question = between(user, "QUESTION:\n", "\n\nLENS MENU");
      if (question.includes("ABSTAIN")) return ok(JSON.stringify({ choice: "abstain", reason: "no lens fits" }));
      if (question.includes("INVALID")) return ok(JSON.stringify({ choice: "zzzzzzzzzzzz", reason: "bad" }));
      return ok(JSON.stringify({ choice: routerMenu(user).entries[0].id, reason: `first lens [${key}]` }));
    }
    case "coverage": {
      const turns = (user.match(/Interviewee:/g) || []).length;
      return ok(JSON.stringify({ core_logic: turns * 30, commitments: turns * 20, evaluation: turns * 10, tensions: 5, notes: `probe tensions [${key}]` }));
    }
    case "scenarios":
      return ok("```json\n" + JSON.stringify([1, 2, 3].map((n) => ({ domain: `mock-${n}`, text: `Scenario ${n} [${key}]` }))) + "\n```");
    case "profile":
      return ok(JSON.stringify({
        title: `Mock Profile ${key}`, author: user.includes("Coast Guard") ? "USCG" : null, type: "Guide",
        topic_summary: `Summary ${key}`, domain_tags: ["cooking", "mock", key], structure: "Sections", estimated_reading_level: "General",
      }));
    case "k-core":
      return ok(JSON.stringify({ core: [1, 2, 3, 4, 5, 6, 7, 8, 9] }));
    case "vk": {
      const claims = [...user.matchAll(/\*\*Knowledge Extract says:\*\* (.+)/g)].map((m) => m[1]);
      const first = claims[0] ?? "";
      return ok(`### Claim 1\nCORRECTED\nCLAIM: ${first}\nCORRECTED TO: ${first} [corrected ${key}]\n\n### Claim 2\nVERIFIED\n\n### Claim 3\nUNSUPPORTED`);
    }
    case "vu": {
      const ud = between(user, "---BEGIN UNDERSTANDING DOCUMENT---", "---END UNDERSTANDING DOCUMENT---");
      const fabricated = ud.includes("[fab]") && !ud.includes("[draft=2]");
      return ok(`## CITATION AUDIT\n${fabricated ? "Citation 1: FABRICATED" : "Citation 1: ACCURATE"}\n\n## QUALITY SUMMARY\nGrade ${fabricated ? "C" : "A"} [${key}]`);
    }
    case "u2": {
      const regen = user.includes("were found FABRICATED or MISLEADING");
      const tag = regen ? "[draft=2]" : parseInt(key[0], 16) % 2 === 1 ? "[draft=1][fab]" : "[draft=1]";
      return ok(`${genericDoc("u2", key)}\n\n${tag}`);
    }
    case "crystallize-audit":
      return ok(`## FABRICATION REPORT\n- Total quantitative claims checked: 4\n- UNTRACEABLE (fabricated): 1 — 230 °C [${key}]`);
    case "merge-preview":
      return ok(JSON.stringify({ compatibility: "moderate", score: 0.6, notes: `preview ${key}` }));
    case "interviewer":
      return ok(`Interviewer reply [${key}]: what do you watch for next in the pan?`);
    default:
      if (user.includes("EMPTY-ANSWER")) return { content: "", finish: "length", status: 200 };
      return ok(genericDoc(agent, key) + (model.includes("pro") ? "\n\nReasoned with the pro tier." : ""));
  }
}

function ok(content: string): { content: string; finish: string; status: number } {
  return { content, finish: "stop", status: 200 };
}

export function startMockLlm(): { url: string; log: LoggedRequest[]; stop: () => void } {
  const log: LoggedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as ChatBody;
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`).join("\n");
      const agent = classify(system);
      log.push({ agent, model: body.model, hash: sha(canonicalRequest(agent, body), 16) });
      const r = reply(agent, system, user, body.model);
      if (r.status !== 200) return new Response("upstream error", { status: r.status });
      return Response.json({
        model: body.model === "deepseek-chat" ? "deepseek-v4-flash" : body.model,
        choices: [{ message: { content: r.content }, finish_reason: r.finish }],
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/chat/completions`, log, stop: () => server.stop(true) };
}
