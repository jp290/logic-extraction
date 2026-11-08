// Merging two lenses. Peer/asymmetric merges of full lenses run the multi-altitude
// pipeline (reasoning → knowledge → verifier → understanding); the rest run a
// three-turn dialogue. Every merged document is gated against the ROOT ancestors,
// never against intermediate merges (that would launder fabrications).

import type { Database } from "bun:sqlite";
import type { Engine } from "../engine.ts";
import { collectRootDocs, rootQuoteCorpus } from "../gates/lineage.ts";
import { completePrompt } from "../llm.ts";
import {
  AGENT_P_PROMPT,
  CRYSTALLIZE_AUDIT_PROMPT,
  CRYSTALLIZE_REVISE_PROMPT,
  KNOWLEDGE_ALIGNMENT_PROMPT,
  KNOWLEDGE_REASONING_PROMPT,
  MERGE_COMPAT_PROMPT,
  MERGE_CONNECT_PROMPT,
  MERGE_CRYSTALLIZE_PROMPT,
  MERGE_DIVERGE_PROMPT,
  MERGE_DIVIDE_PROMPT,
  MERGE_INTEGRATE_PROMPT,
  MERGE_TURN_PROMPT,
  MERGE_UNDERSTANDING_SYNTHESIS_PROMPT,
  MERGE_VERIFY_PROMPT,
  UNDERSTANDING_MERGE_PROMPT,
} from "../prompts.ts";
import { countWords, generateId, stripJsonFence } from "../text.ts";
import { unquoteUnverified } from "./gates.ts";
import { runUnderstandingSynthesis } from "./understanding.ts";

export type MergeType = "peer" | "asymmetric" | "awareness" | "thematical";
export const MERGE_TYPES: readonly MergeType[] = ["peer", "asymmetric", "awareness", "thematical"];

export interface MergeHistoryNode {
  merge_id: string;
  merge_type: string;
  parent_a: { id: string; title: string; merge_history?: MergeHistoryNode };
  parent_b: { id: string; title: string; merge_history?: MergeHistoryNode };
}

export function buildMergeHistory(db: Database, mergeId: string, depth = 0): MergeHistoryNode | null {
  if (depth > 8) return null;
  const merge = db
    .query(
      `SELECT m.id, m.merge_type, m.parent_a, m.parent_b,
              pa.title as parent_a_title, pa.merge_id as parent_a_merge_id,
              pb.title as parent_b_title, pb.merge_id as parent_b_merge_id
       FROM merges m
       LEFT JOIN extractions pa ON m.parent_a = pa.id
       LEFT JOIN extractions pb ON m.parent_b = pb.id
       WHERE m.id = ?`
    )
    .get(mergeId) as Record<string, unknown> | null;
  if (!merge) return null;

  const nodeA: Record<string, unknown> = { id: merge.parent_a, title: merge.parent_a_title };
  const nodeB: Record<string, unknown> = { id: merge.parent_b, title: merge.parent_b_title };

  if (merge.parent_a_merge_id) {
    nodeA.merge_history = buildMergeHistory(db, merge.parent_a_merge_id as string, depth + 1);
  }
  if (merge.parent_b_merge_id) {
    nodeB.merge_history = buildMergeHistory(db, merge.parent_b_merge_id as string, depth + 1);
  }

  return {
    merge_id: merge.id as string,
    merge_type: merge.merge_type as string,
    parent_a: nodeA as MergeHistoryNode["parent_a"],
    parent_b: nodeB as MergeHistoryNode["parent_b"],
  };
}

/** The LD up to the end of its CORE OPERATING LOGIC section (merge previews). */
export function extractPreamble(ld: string): string {
  const coreIdx = ld.indexOf("## 0. CORE OPERATING LOGIC");
  if (coreIdx === -1) {
    const altIdx = ld.indexOf("CORE OPERATING LOGIC");
    if (altIdx === -1) return ld.substring(0, 2000);
    const nextSection = ld.indexOf("\n## ", altIdx + 25);
    return ld.substring(0, nextSection > 0 ? nextSection : altIdx + 2000);
  }
  const nextSection = ld.indexOf("\n## ", coreIdx + 30);
  return ld.substring(0, nextSection > 0 ? nextSection : coreIdx + 2000);
}

export async function runMerge(engine: Engine, id: string): Promise<void> {
  const { db, llm } = engine;
  try {
    const merge = db.query(
      "SELECT parent_a, parent_b, merge_type, a_as_backbone FROM merges WHERE id = ?"
    ).get(id) as { parent_a: string; parent_b: string; merge_type: MergeType; a_as_backbone: number };

    const docA = db.query(
      "SELECT title, logic_document, source_text, knowledge_extract, understanding_document FROM extractions WHERE id = ? AND status = 'complete'"
    ).get(merge.parent_a) as { title: string; logic_document: string; source_text: string | null; knowledge_extract: string | null; understanding_document: string | null };

    const docB = db.query(
      "SELECT title, logic_document, source_text, knowledge_extract, understanding_document FROM extractions WHERE id = ? AND status = 'complete'"
    ).get(merge.parent_b) as { title: string; logic_document: string; source_text: string | null; knowledge_extract: string | null; understanding_document: string | null };

    const isThematical = merge.merge_type === "thematical";
    const hasFullLayers = !!(docA.knowledge_extract && docB.knowledge_extract && docA.understanding_document && docB.understanding_document);
    const useMultiAltitude = hasFullLayers && (merge.merge_type === "peer" || merge.merge_type === "asymmetric");
    function pickThematicalText(doc: { understanding_document: string | null; knowledge_extract: string | null; logic_document: string }): string {
      if (doc.understanding_document) return doc.understanding_document;
      if (doc.knowledge_extract) return doc.knowledge_extract;
      return doc.logic_document;
    }

    // Phase 1: Compatibility (always uses logic documents)
    db.query("UPDATE merges SET status = 'compat' WHERE id = ?").run(id);
    const compatPrompt = MERGE_COMPAT_PROMPT(docA.logic_document, docA.title, docB.logic_document, docB.title);
    const compatibility = await completePrompt(llm, compatPrompt);
    db.query("UPDATE merges SET compatibility = ? WHERE id = ?").run(compatibility, id);

    let allDialogue: string;
    let crystallization: string;

    if (useMultiAltitude) {
      // ── Multi-Altitude Merge Pipeline ──────────────────────

      // Phase 2a: Reasoning altitude — parallel Connect + Divide agents
      db.query("UPDATE merges SET status = 'dialogue' WHERE id = ?").run(id);
      const connectPrompt = MERGE_CONNECT_PROMPT(docA.logic_document, docA.title, docB.logic_document, docB.title);
      const dividePrompt = MERGE_DIVIDE_PROMPT(docA.logic_document, docA.title, docB.logic_document, docB.title);
      const [connectResult, divideResult] = await Promise.all([
        completePrompt(llm, connectPrompt),
        completePrompt(llm, dividePrompt),
      ]);
      db.query("UPDATE merges SET dialogue_t1 = ? WHERE id = ?").run(`## M-Connect (Reasoning: Unification)\n\n${connectResult}\n\n## M-Divide (Reasoning: Resistance)\n\n${divideResult}`, id);

      // Phase 2b: Knowledge altitude — parallel Integrate + Diverge agents
      const reasoningFindings = `## CONNECTION FINDINGS\n${connectResult}\n\n## DIVISION FINDINGS\n${divideResult}`;
      const integratePrompt = MERGE_INTEGRATE_PROMPT(docA.knowledge_extract!, docA.title, docB.knowledge_extract!, docB.title, reasoningFindings);
      const divergePrompt = MERGE_DIVERGE_PROMPT(docA.knowledge_extract!, docA.title, docB.knowledge_extract!, docB.title, reasoningFindings);
      const [integrateResult, divergeResult] = await Promise.all([
        completePrompt(llm, integratePrompt),
        completePrompt(llm, divergePrompt),
      ]);
      db.query("UPDATE merges SET dialogue_t2 = ? WHERE id = ?").run(`## M-Integrate (Knowledge: Unification)\n\n${integrateResult}\n\n## M-Diverge (Knowledge: Resistance)\n\n${divergeResult}`, id);

      // Phase 2c: Merge Verifier — checks all 4 agent outputs
      const verifyPrompt = MERGE_VERIFY_PROMPT(
        connectResult, divideResult, integrateResult, divergeResult,
        docA.logic_document, docA.title, docB.logic_document, docB.title
      );
      const verifiedFindings = await completePrompt(llm, verifyPrompt, { temperature: 0.1 });

      // Phase 2d: Understanding Synthesis — from verified findings + parent UDs
      const synthPrompt = MERGE_UNDERSTANDING_SYNTHESIS_PROMPT(
        docA.understanding_document!, docA.title,
        docB.understanding_document!, docB.title,
        verifiedFindings
      );
      const understandingSynthesis = await completePrompt(llm, synthPrompt);
      db.query("UPDATE merges SET dialogue_t3 = ? WHERE id = ?").run(`## Merge Verifier\n\n${verifiedFindings}\n\n## Understanding Synthesis\n\n${understandingSynthesis}`, id);

      // Crystallize sees ONLY verified findings + understanding synthesis (not raw agent outputs with projected items)
      allDialogue = `## Verified Merge Findings\n\n${verifiedFindings}\n\n## Understanding Synthesis\n\n${understandingSynthesis}`;

      // Phase 3: Crystallization — sees verified findings only
      db.query("UPDATE merges SET status = 'crystallize' WHERE id = ?").run(id);
      const crystPrompt = MERGE_CRYSTALLIZE_PROMPT(docA.logic_document, docA.title, docB.logic_document, docB.title, compatibility, allDialogue, merge.merge_type);
      crystallization = await completePrompt(llm, crystPrompt);
      db.query("UPDATE merges SET crystallization = ? WHERE id = ?").run(crystallization, id);

    } else {
      // ── Standard Dialogue Merge ────────────────────────────

      const textA = isThematical ? pickThematicalText(docA) : docA.logic_document;
      const textB = isThematical ? pickThematicalText(docB) : docB.logic_document;

      db.query("UPDATE merges SET status = 'dialogue' WHERE id = ?").run(id);

      const t1Prompt = MERGE_TURN_PROMPT(1, textA, docA.title, textB, docB.title, "", merge.merge_type);
      const t1 = await completePrompt(llm, t1Prompt);
      db.query("UPDATE merges SET dialogue_t1 = ? WHERE id = ?").run(t1, id);

      const t2Prompt = MERGE_TURN_PROMPT(2, textA, docA.title, textB, docB.title, `Turn 1 (${docA.title}):\n${t1}`, merge.merge_type);
      const t2 = await completePrompt(llm, t2Prompt);
      db.query("UPDATE merges SET dialogue_t2 = ? WHERE id = ?").run(t2, id);

      const fullDialogue = `Turn 1 (${docA.title}):\n${t1}\n\nTurn 2 (${docB.title}):\n${t2}`;
      const t3Prompt = MERGE_TURN_PROMPT(3, textA, docA.title, textB, docB.title, fullDialogue, merge.merge_type);
      const t3 = await completePrompt(llm, t3Prompt);
      db.query("UPDATE merges SET dialogue_t3 = ? WHERE id = ?").run(t3, id);

      allDialogue = `${fullDialogue}\n\nTurn 3 (Synthesis):\n${t3}`;

      db.query("UPDATE merges SET status = 'crystallize' WHERE id = ?").run(id);
      const crystPrompt = MERGE_CRYSTALLIZE_PROMPT(textA, docA.title, textB, docB.title, compatibility, allDialogue, merge.merge_type);
      crystallization = await completePrompt(llm, crystPrompt);
      db.query("UPDATE merges SET crystallization = ? WHERE id = ?").run(crystallization, id);
    }

    // Transitive-root lineage: gates verify against the ROOT (non-merged) ancestors,
    // not the immediate parents. Per-level gating launders fabrications — a level-1
    // merge's invented numbers become "parent truth" at level 2 (measured: FIELD12 had
    // 15 source-contradicted claims on OOD questions; single-lens routing had 0).
    const rootVisited = new Set<string>();
    const rootDocs = [
      ...collectRootDocs(db, merge.parent_a, rootVisited),
      ...collectRootDocs(db, merge.parent_b, rootVisited),
    ];

    // Phase 3b: Post-crystallize numeric provenance audit — if untraceable numbers
    // are found, revise the LD to apply fixes. The audit report is stored separately,
    // NEVER appended into the shipped LD. Audited against ROOT parent LDs; when those
    // exceed the context budget, batches narrow the UNTRACEABLE set sequentially (a
    // claim is fabricated only if no batch can trace it).
    const AUDIT_DOC_BUDGET = 300_000;
    const auditBatches: { title: string; doc: string }[][] = [[]];
    let batchSize = 0;
    for (const d of rootDocs) {
      const p = { title: d.title, doc: d.logic_document };
      if (auditBatches[auditBatches.length - 1].length > 0 && batchSize + p.doc.length > AUDIT_DOC_BUDGET) {
        auditBatches.push([]);
        batchSize = 0;
      }
      auditBatches[auditBatches.length - 1].push(p);
      batchSize += p.doc.length;
    }
    const untraceableIn = (report: string): boolean => {
      const count = report.match(/UNTRACEABLE[^\n]*?:\s*(\d+)/i);
      return (count ? parseInt(count[1], 10) > 0 : false) || /\[UNTRACEABLE\]/.test(report);
    };
    try {
      let auditReport = "";
      for (let i = 0; i < auditBatches.length; i++) {
        const auditPrompt = CRYSTALLIZE_AUDIT_PROMPT(crystallization, auditBatches[i], i > 0 ? auditReport : undefined);
        auditReport = await completePrompt(llm, auditPrompt, { temperature: 0.1 });
        if (!untraceableIn(auditReport)) break;
      }
      try {
        db.query("UPDATE merges SET audit_report = ? WHERE id = ?").run(auditReport, id);
      } catch (err) {
        console.error(`[runMerge] Failed to store audit report for merge ${id}:`, err);
      }
      if (untraceableIn(auditReport)) {
        const revisePrompt = CRYSTALLIZE_REVISE_PROMPT(crystallization, auditReport);
        const revised = await completePrompt(llm, revisePrompt, { temperature: 0.1 });
        if (revised.trim().length > crystallization.length * 0.6) {
          crystallization = revised;
          db.query("UPDATE merges SET crystallization = ? WHERE id = ?").run(crystallization, id);
        } else {
          console.error(`[runMerge] Crystallize revision too short for merge ${id} — keeping original`);
        }
      }
    } catch (err) {
      console.error(`[runMerge] Post-crystallize audit failed for merge ${id}:`, err);
    }

    // Phase 3c: Deterministic quote gate — quotes in a merged LD must be verbatim in a
    // ROOT lens document or a root's stored source. Intermediate merged docs are
    // deliberately NOT gate truth: their prose is synthesized, so quoting them as
    // verbatim is the false-attribution pattern the gate exists to strip.
    const mergeQuoteCorpus = rootQuoteCorpus(rootDocs);
    const mergeGate = unquoteUnverified(crystallization, mergeQuoteCorpus);
    crystallization = mergeGate.doc;

    // Phase 4: Profile the result
    db.query("UPDATE merges SET status = 'profiling' WHERE id = ?").run(id);
    const pPrompt = AGENT_P_PROMPT(crystallization);
    const pRaw = await completePrompt(llm, pPrompt, { temperature: 0.1 });

    let profile = { title: "", author: null as string | null, type: "Merged Logic Document", topic_summary: "", domain_tags: [] as string[], structure: "", estimated_reading_level: "" };
    try {
      const cleaned = stripJsonFence(pRaw);
      profile = JSON.parse(cleaned);
    } catch {
      profile.title = `${docA.title} × ${docB.title}`;
    }

    // Phase 5: Create extraction record for the result
    const resultId = generateId();
    const mergedTitle = profile.title || `${docA.title} × ${docB.title}`;
    const wordCount = countWords(crystallization);

    db.query(
      `INSERT INTO extractions (id, title, logic_document, author, doc_type, topic_summary, domain_tags, doc_structure, reading_level, word_count, status, ip_hash, merge_id, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', (SELECT ip_hash FROM merges WHERE id = ?), ?, ?)`
    ).run(
      resultId, mergedTitle, crystallization,
      profile.author || null,
      profile.type || "Merged Logic Document",
      profile.topic_summary || "",
      JSON.stringify(profile.domain_tags || []),
      profile.structure || "",
      profile.estimated_reading_level || "",
      wordCount,
      id, id, llm.model
    );
    db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(
      JSON.stringify({
        mergeQuoteCheck: { total: mergeGate.total, repaired: mergeGate.repaired, flagged: mergeGate.flagged },
        rootGrounding: {
          rootCount: rootDocs.length,
          rootIds: rootDocs.map((d) => d.id),
          mergedFallbacks: rootDocs.filter((d) => d.merged_fallback).map((d) => d.id),
          auditBatches: auditBatches.length,
        },
      }),
      resultId
    );

    // Phase 5-7: Knowledge Integration Pipeline (any merge where both parents have KE)
    if (docA.knowledge_extract && docB.knowledge_extract) {
      try {
        // Phase 5: Knowledge Alignment (structural — classify, don't resolve)
        const combinedKeLength = (docA.knowledge_extract?.length || 0) + (docB.knowledge_extract?.length || 0);
        const alignPrompt = KNOWLEDGE_ALIGNMENT_PROMPT(
          docA.knowledge_extract, docA.title,
          docB.knowledge_extract, docB.title,
          crystallization,
          combinedKeLength
        );
        const alignedKe = await completePrompt(llm, alignPrompt, { temperature: 0.1 });

        // Phase 6: Knowledge Reasoning (resolve conflicts)
        const reasonPrompt = KNOWLEDGE_REASONING_PROMPT(
          alignedKe, crystallization, compatibility, docA.title, docB.title
        );
        const reasonedKe = await completePrompt(llm, reasonPrompt);

        // Phase 7: Understanding Merge (integrate parent UDs, don't rebuild from scratch)
        let understanding = "";
        if (docA.understanding_document && docB.understanding_document) {
          try {
            const mergePrompt = UNDERSTANDING_MERGE_PROMPT(
              docA.understanding_document, docA.title,
              docB.understanding_document, docB.title,
              crystallization, reasonedKe
            );
            understanding = await completePrompt(llm, mergePrompt);
          } catch (err) {
            console.error(`[runMerge] Understanding merge failed for merge ${id}:`, err);
            understanding = "";
          }
        } else {
          try {
            const result = await runUnderstandingSynthesis(llm, crystallization, reasonedKe);
            understanding = result.understanding;
          } catch (err) {
            console.error(`[runMerge] Understanding synthesis failed for merge ${id}:`, err);
            understanding = "";
          }
        }

        // Quote gate for the merged KE and UD: same legitimate-quotable corpus as the
        // LD gate, plus the crystallized LD itself (which they may quote).
        const downstreamCorpus = `${mergeQuoteCorpus}\n\n${crystallization}`;
        const keGate = unquoteUnverified(reasonedKe, downstreamCorpus);
        const udGate = understanding ? unquoteUnverified(understanding, downstreamCorpus) : null;
        db.query("UPDATE extractions SET knowledge_extract = ?, understanding_document = ? WHERE id = ?")
          .run(keGate.doc, udGate ? udGate.doc : null, resultId);
        try {
          const existing = JSON.parse((db.query("SELECT grounding_report FROM extractions WHERE id = ?").get(resultId) as { grounding_report: string | null } | null)?.grounding_report || "{}");
          existing.mergeKeQuoteCheck = { total: keGate.total, repaired: keGate.repaired, flagged: keGate.flagged };
          if (udGate) existing.mergeUdQuoteCheck = { total: udGate.total, repaired: udGate.repaired, flagged: udGate.flagged };
          db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(JSON.stringify(existing), resultId);
        } catch (err) {
          console.error(`[runMerge] Failed to update grounding report with merge quote gates for ${resultId}:`, err);
        }
      } catch (err) {
        console.error(`[runMerge] Knowledge integration pipeline failed for merge ${id}, result extraction ${resultId}:`, err);
      }
    }

    // Complete the merge
    db.query("UPDATE merges SET status = 'complete', result_id = ? WHERE id = ?").run(resultId, id);

    // Data minimization: clear intermediate dialogue
    db.query("UPDATE merges SET dialogue_t1 = NULL, dialogue_t2 = NULL, dialogue_t3 = NULL, compatibility = NULL, crystallization = NULL WHERE id = ?").run(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Merge failed";
    db.query("UPDATE merges SET status = 'failed', error = ? WHERE id = ?").run(msg, id);
  }
}
