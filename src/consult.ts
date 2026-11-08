// Consult-time helpers: route a question to the best lens, and run + persist the
// deterministic answer checks (numeric re-check for packs, entity/numeric grounding
// for lens-only consults). A checker error never fails a consult.

import type { Database } from "bun:sqlite";
import { consultGrounding } from "./gates/consult-grounding.ts";
import { recheckAnswer, type PackArtifacts, type RecheckResult } from "./gates/recheck.ts";
import type { LlmClient } from "./llm.ts";
import { ROUTER_SYSTEM_PROMPT } from "./prompts.ts";
import { generateId } from "./text.ts";

export interface LensMenuEntry {
  id: string;
  title: string;
  doc_type: string | null;
  domain_tags: string | null;
  topic_summary: string | null;
}

const ROUTER_MAX_TOKENS = 256;

// Route a question to the single best-fitting lens id, or "abstain". Uses the cheap flash
// call (llm.chat, temperature 0). One retry on an invalid choice; a second
// invalid result is treated as abstain. Network/API errors propagate to the caller (the
// /api/ask handler maps them to a 500 — routing must never silently fall back).
export async function routeLens(
  llm: LlmClient,
  question: string,
  lenses: LensMenuEntry[]
): Promise<{ choice: string | null; reason: string }> {
  const validIds = new Set(lenses.map((l) => l.id));
  const menu = lenses
    .map(
      (l, i) =>
        `${i + 1}. id: ${l.id}\n   title: ${l.title}\n   doc_type: ${l.doc_type ?? ""}\n   domain_tags: ${l.domain_tags ?? "[]"}\n   topic_summary: ${l.topic_summary ?? ""}`
    )
    .join("\n\n");
  const userMessage = `QUESTION:\n${question}\n\nLENS MENU:\n${menu}\n\nReview EVERY lens in the menu above, then select the most relevant lens id, or abstain.`;
  const messages = [
    { role: "system", content: ROUTER_SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  const attempt = async (): Promise<{ choice: string | null; reason: string } | null> => {
    const raw = await llm.chat(messages, ROUTER_MAX_TOKENS, true, { temperature: 0 });
    try {
      const parsed = JSON.parse(raw) as { choice?: unknown; reason?: unknown };
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      if (parsed.choice === "abstain") return { choice: null, reason };
      if (typeof parsed.choice === "string" && validIds.has(parsed.choice)) {
        return { choice: parsed.choice, reason };
      }
      return null;
    } catch {
      return null;
    }
  };

  const first = await attempt();
  if (first) return first;
  const second = await attempt();
  if (second) return second;
  return { choice: null, reason: "router returned no valid selection" };
}

const EMPTY_RECHECK: RecheckResult = { claims: [], flags: 0, checked: 0 };

// Run the deterministic numeric re-check against the pack's artifacts and persist a
// consult row. A checker error must never fail the consult (spec §2): log and store
// an {"error":...} recheck_json with a zero result. Returns the result for the response.
export function recheckAndPersist(db: Database, args: {
  pack: PackArtifacts;
  packId: string;
  extractionId: string | null;
  mode: "lens+pack" | "pack-only";
  question: string;
  answer: string;
  model: string;
  ipHash: string;
}): RecheckResult {
  let result: RecheckResult = EMPTY_RECHECK;
  let recheckJson: string;
  try {
    result = recheckAnswer(args.pack, args.answer);
    recheckJson = JSON.stringify(result);
  } catch (err) {
    console.error(`[recheck ${args.packId}] checker error:`, err);
    result = EMPTY_RECHECK;
    recheckJson = JSON.stringify({ error: err instanceof Error ? err.message : "recheck failed" });
  }
  try {
    db.query(
      `INSERT INTO consults (id, pack_id, extraction_id, mode, question, answer, model, claims_checked, flags, recheck_json, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId(),
      args.packId,
      args.extractionId,
      args.mode,
      args.question,
      args.answer,
      args.model,
      result.checked,
      result.flags,
      recheckJson,
      args.ipHash
    );
  } catch (err) {
    console.error(`[recheck ${args.packId}] persist error:`, err);
  }
  return result;
}

// Consult-time grounding for lens-only consults: entity + numeric provenance of the
// answer against the lens's stored extraction source. Label-only — flags annotate,
// never block. Same error-isolation contract as recheckAndPersist (spec §2): a
// checker error never fails the consult. Returns null when the lens has no stored
// source_text (pre-column extractions) — no grounding field in the response.
// Visible flags are origin "unknown" only; lens-vocabulary flags (terms coined by
// the lens's own layers) are persisted but not surfaced (noise-floor rule).
export interface LensGroundingResponse {
  flags: Array<{ rule: string; span: string; context: string }>;
  flag_count: number;
  lens_terms: number;
  checked: number;
}

export function groundAndPersistLensConsult(db: Database, args: {
  extractionId: string;
  sourceText: string | null;
  lensText: string;
  question: string;
  answer: string;
  model: string;
  ipHash: string;
}): LensGroundingResponse | null {
  if (!args.sourceText) return null;
  let response: LensGroundingResponse;
  let groundingJson: string;
  try {
    const report = consultGrounding(args.answer, args.sourceText, args.lensText);
    const visible = report.flags.filter((f) => f.origin === "unknown");
    const checked = report.checked.properNames + report.checked.acronyms + report.checked.citations
      + report.checked.urlsEmails + report.checked.numericCandidates;
    response = {
      flags: visible.map((f) => ({ rule: f.rule, span: f.span, context: f.context })),
      flag_count: visible.length,
      lens_terms: report.flags.length - visible.length,
      checked,
    };
    groundingJson = JSON.stringify(report);
  } catch (err) {
    console.error(`[grounding ${args.extractionId}] checker error:`, err);
    response = { flags: [], flag_count: 0, lens_terms: 0, checked: 0 };
    groundingJson = JSON.stringify({ error: err instanceof Error ? err.message : "grounding failed" });
  }
  try {
    db.query(
      `INSERT INTO lens_consults (id, extraction_id, question, answer, model, flags, grounding_json, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId(),
      args.extractionId,
      args.question,
      args.answer,
      args.model,
      response.flag_count,
      groundingJson,
      args.ipHash
    );
  } catch (err) {
    console.error(`[grounding ${args.extractionId}] persist error:`, err);
  }
  return response;
}
