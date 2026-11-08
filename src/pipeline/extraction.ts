// Source extraction: phase 1 (A/B/C, blind and parallel) → phase 2 (V verification,
// optional X cross-synthesis) → phase 3 (S synthesizes the Logic Document, P profiles)
// → phases 4–6 (KE, VK, UD) with deterministic gates on every write. Also the
// understanding upgrade for lenses that were extracted in logic-only mode.

import { buildCoreKnowledge } from "./knowledge-core.ts";
import type { Engine } from "../engine.ts";
import {
  AGENT_A_PROMPT,
  AGENT_B_PROMPT,
  AGENT_C_PROMPT,
  AGENT_MERGE_PROMPT,
  AGENT_P_PROMPT,
  AGENT_S_PROMPT,
  AGENT_V_FINDINGS_PROMPT,
  AGENT_V_META_PROMPT,
  AGENT_X_PROMPT,
} from "../prompts.ts";
import { completePrompt, type LlmClient } from "../llm.ts";
import { chunkAtParagraphs, stripJsonFence } from "../text.ts";
import { addUdNumericReport, applyKeNumericGate, gateDoc, unquoteUnverified } from "./gates.ts";
import { extractAndVerifyEntities } from "./grounding.ts";
import { runKnowledgeExtraction, verifyKnowledgeExtract } from "./knowledge.ts";
import { runUnderstandingSynthesis } from "./understanding.ts";

export type ExtractionMode = "logic" | "understanding";

const PHASE1_SAFE_CHARS = 350000;

async function mergeAgentChunks(llm: LlmClient, outputs: string[], agentLabel: string): Promise<string> {
  if (outputs.length === 1) return outputs[0];
  const prompt = AGENT_MERGE_PROMPT(outputs, agentLabel);
  return llm.complete(prompt.system, prompt.user);
}

export async function runExtraction(engine: Engine, id: string, text: string, mode: ExtractionMode = "understanding", externalS = false): Promise<void> {
  const { db, llm, config } = engine;
  try {
    db.query("UPDATE extractions SET status = 'phase1' WHERE id = ?").run(id);

    const phase1Chunks = chunkAtParagraphs(text, PHASE1_SAFE_CHARS);

    let a: string, b: string, c: string;
    if (phase1Chunks.length === 1) {
      [a, b, c] = await Promise.all([
        completePrompt(llm, AGENT_A_PROMPT(text)),
        completePrompt(llm, AGENT_B_PROMPT(text)),
        completePrompt(llm, AGENT_C_PROMPT(text)),
      ]);
    } else {
      const [aChunks, bChunks, cChunks] = await Promise.all([
        Promise.all(phase1Chunks.map(ch => completePrompt(llm, AGENT_A_PROMPT(ch)))),
        Promise.all(phase1Chunks.map(ch => completePrompt(llm, AGENT_B_PROMPT(ch)))),
        Promise.all(phase1Chunks.map(ch => completePrompt(llm, AGENT_C_PROMPT(ch)))),
      ]);
      [a, b, c] = await Promise.all([
        mergeAgentChunks(llm, aChunks, "Reasoning Patterns"),
        mergeAgentChunks(llm, bChunks, "Deep Commitments"),
        mergeAgentChunks(llm, cChunks, "Dialectical Tensions"),
      ]);
    }

    db.query(
      "UPDATE extractions SET status = 'phase2', agent_a = ?, agent_b = ?, agent_c = ? WHERE id = ?"
    ).run(a, b, c, id);

    // V-findings runs as three parallel per-agent calls (V-A/V-B/V-C): one call over
    // all three reports was 75–125 judgments and DeepSeek silently sampled them.
    const vAgents: Array<["A" | "B" | "C", string]> = [["A", a], ["B", b], ["C", c]];
    let vFindingsParts: string[], vMeta: string;
    if (phase1Chunks.length === 1) {
      [vFindingsParts, vMeta] = await Promise.all([
        Promise.all(vAgents.map(([letter, report]) => {
          const p = AGENT_V_FINDINGS_PROMPT(text, letter, report);
          return llm.complete(p.system, p.user, { temperature: 0.1 });
        })),
        completePrompt(llm, AGENT_V_META_PROMPT(text, a, b, c), { temperature: 0.1 }),
      ]);
    } else {
      const [vFindingsChunked, vMetaChunks] = await Promise.all([
        Promise.all(vAgents.map(([letter, report]) =>
          Promise.all(phase1Chunks.map(ch => {
            const p = AGENT_V_FINDINGS_PROMPT(ch, letter, report);
            return llm.complete(p.system, p.user, { temperature: 0.1 });
          }))
        )),
        Promise.all(phase1Chunks.map(ch => completePrompt(llm, AGENT_V_META_PROMPT(ch, a, b, c), { temperature: 0.1 }))),
      ]);
      [vFindingsParts, vMeta] = await Promise.all([
        Promise.all(vAgents.map(([letter], i) => mergeAgentChunks(llm, vFindingsChunked[i], `Finding-Level Verification (Agent ${letter})`))),
        mergeAgentChunks(llm, vMetaChunks, "Meta-Level Verification"),
      ]);
    }
    const vFindings = vAgents.map(([letter], i) => `### Verification of Agent ${letter}\n\n${vFindingsParts[i]}`).join("\n\n");
    const v = `## Finding-Level Verification\n\n${vFindings}\n\n## Meta-Level Verification\n\n${vMeta}`;

    // Cross-synthesis (Agent X): mines interactions between A/B/C findings + V-meta.
    // OFF BY DEFAULT — in validation it added net fabrication vs the baseline
    // (source-contradicted "system-level" claims; S laundered its [TENTATIVE] hedges
    // into fact). Not safe to ship until an X-verifier gates it.
    // Enable for experiments with CROSS_SYNTHESIS_ENABLED=1.
    let crossSynthesis = "";
    if (config.crossSynthesis) {
      try {
        const xp = AGENT_X_PROMPT(a, b, c, vMeta);
        crossSynthesis = await llm.complete(xp.system, xp.user, { temperature: 0.2 });
      } catch (err) {
        console.error(`[runExtraction] Cross-synthesis (Agent X) failed for extraction ${id} — proceeding without it:`, err);
        crossSynthesis = "";
      }
    }

    db.query(
      "UPDATE extractions SET status = 'phase3', agent_v = ?, cross_synthesis = ? WHERE id = ?"
    ).run(v, crossSynthesis, id);

    // External-S mode: pause here so a stronger model can synthesize the LD out-of-band
    // (fetched via /api/internal/s-prompt, posted back via /api/internal/complete-s).
    // Agent outputs stay in the DB until completeSynthesis runs data minimization.
    if (externalS) {
      db.query("UPDATE extractions SET external_s_state = 'awaiting' WHERE id = ?").run(id);
      return;
    }

    // Phase 3: Agent S (synthesis)
    const s = await completePrompt(llm, AGENT_S_PROMPT(text, v, a, b, c, crossSynthesis));
    await completeSynthesis(engine, id, text, s, mode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Processing failed";
    db.query("UPDATE extractions SET status = 'failed', error = ? WHERE id = ?").run(
      msg,
      id
    );
  }
}

// Phases 3 (profile) through 6 + data minimization. Shared by the normal DeepSeek-S path
// and the external-S path (/api/internal/complete-s). Throws on failure — callers set
// the failed status.
export async function completeSynthesis(engine: Engine, id: string, text: string, s: string, mode: ExtractionMode): Promise<void> {
  const { db, llm } = engine;
  const pRaw = await completePrompt(llm, AGENT_P_PROMPT(text), { temperature: 0.1 });

  // Parse the profile JSON
  let profile = { title: "", author: null as string | null, type: "Unknown", topic_summary: "", domain_tags: [] as string[], structure: "", estimated_reading_level: "" };
  try {
    const cleaned = stripJsonFence(pRaw);
    const parsed = JSON.parse(cleaned);
    profile.title = typeof parsed.title === "string" ? parsed.title.slice(0, 300) : "";
    profile.author = typeof parsed.author === "string" ? parsed.author.slice(0, 200) : null;
    profile.type = typeof parsed.type === "string" ? parsed.type.slice(0, 100) : "Unknown";
    profile.topic_summary = typeof parsed.topic_summary === "string" ? parsed.topic_summary.slice(0, 1000) : "";
    profile.domain_tags = Array.isArray(parsed.domain_tags) ? parsed.domain_tags.filter((t: unknown) => typeof t === "string").map((t: string) => t.slice(0, 100)).slice(0, 20) : [];
    profile.structure = typeof parsed.structure === "string" ? parsed.structure.slice(0, 200) : "";
    profile.estimated_reading_level = typeof parsed.estimated_reading_level === "string" ? parsed.estimated_reading_level.slice(0, 100) : "";
  } catch {
    // Profile parsing failed — non-critical, proceed with defaults
  }

  // Deterministic quote gate BEFORE the first logic_document write: quoted spans not
  // traceable to the source (paraphrases dressed as verbatim quotes) are unquoted in
  // place — content preserved, false verbatim claim removed. Gating before the write
  // matters: GET /api/extractions/:id serves rows in any status, so a pre-gate LD in
  // the column would be publicly readable (and permanent if the process dies here).
  const ldGate = unquoteUnverified(s, text);
  const ldQuoteEntry = { total: ldGate.total, repaired: ldGate.repaired, flagged: ldGate.flagged };
  const verifiedLd = ldGate.doc;

  db.query(
    `UPDATE extractions SET logic_document = ?,
     title = COALESCE(?, title), author = ?, doc_type = ?, topic_summary = ?,
     domain_tags = ?, doc_structure = ?, reading_level = ?
     WHERE id = ?`
  ).run(
    verifiedLd,
    profile.title || null,
    profile.author || null,
    profile.type || "Unknown",
    profile.topic_summary || "",
    JSON.stringify(profile.domain_tags || []),
    profile.structure || "",
    profile.estimated_reading_level || "",
    id
  );

  // Phase 3b: Lightweight LD fact-check — flag specific numbers in the LD that don't appear in source
  const ldFactCheck = extractAndVerifyEntities(verifiedLd, text);
  const ldGroundingEntry = { score: ldFactCheck.score, total: ldFactCheck.total, ungrounded: ldFactCheck.ungrounded };

  db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(JSON.stringify({ ldFactCheck: ldGroundingEntry, ldQuoteCheck: ldQuoteEntry }), id);

  if (mode === "understanding") {
    // Phase 4: Knowledge Extraction — guided by Logic Document
    db.query("UPDATE extractions SET status = 'phase4' WHERE id = ?").run(id);
    const rawKe = await runKnowledgeExtraction(llm, text, verifiedLd);

    // Phase 5: Verify Knowledge Extract against source text
    db.query("UPDATE extractions SET status = 'phase5' WHERE id = ?").run(id);
    let finalKe = rawKe;
    let groundingReport = "{}";
    try {
      const { verifiedKe, report } = await verifyKnowledgeExtract(llm, rawKe, text);
      finalKe = verifiedKe;
      groundingReport = JSON.stringify({ ldFactCheck: ldGroundingEntry, ldQuoteCheck: ldQuoteEntry, ...report });
    } catch (err) {
      console.error(`[runExtraction] Knowledge extract verification failed for extraction ${id}:`, err);
      groundingReport = JSON.stringify({ ldFactCheck: ldGroundingEntry, ldQuoteCheck: ldQuoteEntry, error: "Verification failed — using unverified extract" });
    }

    // Deterministic quote gate for the KE — runs even when the VK agent threw above,
    // so the raw-KE fallback never ships unverified quotes. KE may quote the LD.
    ({ doc: finalKe, reportJson: groundingReport } = gateDoc(finalKe, `${text}\n\n${verifiedLd}`, groundingReport, "keQuoteCheck"));

    const keGate = applyKeNumericGate(id, text, finalKe, groundingReport);
    groundingReport = keGate.groundingReport;

    db.query(
      `UPDATE extractions SET knowledge_extract = ?, grounding_report = ? WHERE id = ?`
    ).run(finalKe, groundingReport, id);

    try {
      const core = await buildCoreKnowledge(verifiedLd, finalKe, llm.complete);
      if (core) db.query("UPDATE extractions SET knowledge_core = ? WHERE id = ?").run(core, id);
    } catch (err) {
      console.error(`[runExtraction] Core knowledge tiering failed for extraction ${id} — consults fall back to full KE:`, err);
    }

    // Phase 6: Understanding Synthesis — integrates Logic Document + Knowledge Extract + VU verification
    db.query("UPDATE extractions SET status = 'phase6' WHERE id = ?").run(id);
    let understanding = "";
    try {
      const result = await runUnderstandingSynthesis(llm, verifiedLd, keGate.keForUd);
      understanding = result.understanding;
      try {
        const existingReport = JSON.parse(groundingReport);
        existingReport.vuReport = result.vuReport;
        groundingReport = JSON.stringify(existingReport);
        db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, id);
      } catch (err) {
        console.error(`[runExtraction] Failed to update grounding report with VU report for extraction ${id}:`, err);
      }
    } catch (err) {
      console.error(`[runExtraction] Understanding synthesis failed for extraction ${id}:`, err);
      understanding = "";
    }

    // Phase 6c: UD fact-check — flag numbers in the UD that don't appear in source
    if (understanding) {
      const udGate = unquoteUnverified(understanding, text);
      understanding = udGate.doc;
      groundingReport = addUdNumericReport(id, text, understanding, groundingReport);
      const udFactCheck = extractAndVerifyEntities(understanding, text);

      // Add UD fact-check results to grounding report
      try {
        const existingReport = JSON.parse(groundingReport);
        existingReport.udFactCheck = {
          score: udFactCheck.score,
          total: udFactCheck.total,
          ungrounded: udFactCheck.ungrounded,
        };
        existingReport.udQuoteCheck = { total: udGate.total, repaired: udGate.repaired, flagged: udGate.flagged };
        groundingReport = JSON.stringify(existingReport);
        db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, id);
      } catch (err) {
        console.error(`[runExtraction] Failed to update grounding report with UD fact-check for extraction ${id}:`, err);
      }
    }

    db.query(
      `UPDATE extractions SET status = 'complete', understanding_document = ? WHERE id = ?`
    ).run(understanding || null, id);
  } else {
    db.query("UPDATE extractions SET status = 'complete' WHERE id = ?").run(id);
  }

  // Data minimization: clear intermediate agent outputs that may contain source text quotes
  db.query("UPDATE extractions SET agent_a = NULL, agent_b = NULL, agent_c = NULL, agent_v = NULL, cross_synthesis = NULL WHERE id = ?").run(id);
}

export async function runUnderstandingUpgrade(engine: Engine, id: string, sourceText: string, logicDocument: string): Promise<void> {
  const { db, llm } = engine;
  try {
    const rawKe = await runKnowledgeExtraction(llm, sourceText, logicDocument);

    let finalKe = rawKe;
    let groundingReport = "{}";
    try {
      const { verifiedKe, report } = await verifyKnowledgeExtract(llm, rawKe, sourceText);
      finalKe = verifiedKe;
      groundingReport = JSON.stringify(report);
    } catch (err) {
      console.error(`[runUnderstandingUpgrade] Knowledge extract verification failed for extraction ${id}:`, err);
      groundingReport = JSON.stringify({ error: "Verification failed — using unverified extract" });
    }

    ({ doc: finalKe, reportJson: groundingReport } = gateDoc(finalKe, `${sourceText}\n\n${logicDocument}`, groundingReport, "keQuoteCheck"));

    const keGate = applyKeNumericGate(id, sourceText, finalKe, groundingReport);
    const keForUd = keGate.keForUd;
    groundingReport = keGate.groundingReport;

    db.query("UPDATE extractions SET knowledge_extract = ?, grounding_report = ? WHERE id = ?").run(finalKe, groundingReport, id);

    try {
      const core = await buildCoreKnowledge(logicDocument, finalKe, llm.complete);
      if (core) db.query("UPDATE extractions SET knowledge_core = ? WHERE id = ?").run(core, id);
    } catch (err) {
      console.error(`[runUnderstandingUpgrade] Core knowledge tiering failed for extraction ${id} — consults fall back to full KE:`, err);
    }

    let understanding = "";
    try {
      const result = await runUnderstandingSynthesis(llm, logicDocument, keForUd);
      understanding = result.understanding;
      try {
        const existingReport = JSON.parse(groundingReport);
        existingReport.vuReport = result.vuReport;
        groundingReport = JSON.stringify(existingReport);
        db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, id);
      } catch (err) {
        console.error(`[runUnderstandingUpgrade] Failed to update grounding report with VU report for extraction ${id}:`, err);
      }
    } catch (err) {
      console.error(`[runUnderstandingUpgrade] Understanding synthesis failed for extraction ${id}:`, err);
      understanding = "";
    }

    if (understanding) {
      ({ doc: understanding, reportJson: groundingReport } = gateDoc(understanding, sourceText, groundingReport, "udQuoteCheck"));
      groundingReport = addUdNumericReport(id, sourceText, understanding, groundingReport);
      const udFactCheck = extractAndVerifyEntities(understanding, sourceText);
      try {
        const existingReport = JSON.parse(groundingReport);
        existingReport.udFactCheck = { score: udFactCheck.score, total: udFactCheck.total, ungrounded: udFactCheck.ungrounded };
        groundingReport = JSON.stringify(existingReport);
        db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, id);
      } catch (err) {
        console.error(`[runUnderstandingUpgrade] Failed to update grounding report with UD fact-check for extraction ${id}:`, err);
      }
    }

    db.query("UPDATE extractions SET status = 'complete', understanding_document = ? WHERE id = ?").run(understanding || null, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upgrade failed";
    db.query("UPDATE extractions SET status = 'failed', error = ? WHERE id = ?").run(msg, id);
  }
}
