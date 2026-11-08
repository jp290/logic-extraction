// Interviews: an adaptive interviewer draws out someone's reasoning, a coverage
// tracker steers it toward the weakest dimension, and synthesis turns the transcript
// into a lens (or enriches an existing one). The transcript is the source: every
// quote in the lens must trace to the person's own words.

import type { Engine } from "../engine.ts";
import { completePrompt, type ChatMessage, type LlmClient } from "../llm.ts";
import {
  COVERAGE_ASSESS_SYSTEM,
  INTERVIEW_ENRICH_PROMPT,
  INTERVIEW_PROFILE_PROMPT,
  INTERVIEW_SYNTHESIS_PROMPT,
} from "../prompts.ts";
import { countWords, generateId, stripJsonFence } from "../text.ts";
import { gateDoc } from "./gates.ts";
import { extractAndVerifyEntities } from "./grounding.ts";
import { runKnowledgeExtraction, verifyKnowledgeExtract } from "./knowledge.ts";
import { runUnderstandingSynthesis } from "./understanding.ts";

export const MAX_TURNS = 40;

export interface Coverage {
  core_logic: number;
  commitments: number;
  evaluation: number;
  tensions: number;
}

export interface EnrichTarget {
  id: string;
  logic_document: string;
  source_text: string | null;
  knowledge_extract: string | null;
  understanding_document: string | null;
  word_count: number | null;
}

export function formatTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "Interviewee" : "Interviewer"}: ${m.content}`).join("\n\n");
}

export async function assessCoverage(
  llm: LlmClient,
  messages: ChatMessage[]
): Promise<{ coverage: Coverage; notes: string }> {
  const transcript = formatTranscript(messages);
  try {
    const raw = await llm.chat([
      { role: "system", content: COVERAGE_ASSESS_SYSTEM },
      { role: "user", content: transcript },
    ], 256, true, { temperature: 0.1 });
    const obj = JSON.parse(stripJsonFence(raw));
    return {
      coverage: {
        core_logic: Math.max(0, Math.min(100, Number(obj.core_logic) || 0)),
        commitments: Math.max(0, Math.min(100, Number(obj.commitments) || 0)),
        evaluation: Math.max(0, Math.min(100, Number(obj.evaluation) || 0)),
        tensions: Math.max(0, Math.min(100, Number(obj.tensions) || 0)),
      },
      notes: typeof obj.notes === "string" ? obj.notes : "",
    };
  } catch {
    return { coverage: { core_logic: 0, commitments: 0, evaluation: 0, tensions: 0 }, notes: "" };
  }
}

/** System-prompt suffix that points the interviewer at the weakest coverage dimension. */
export function coverageSteering(coverageJson: string, notes: string): string {
  let steering = "";
  try {
    const prevCov = JSON.parse(coverageJson) as Record<string, number>;
    const dims = [
      { key: "core_logic", label: "core logic" },
      { key: "commitments", label: "commitments" },
      { key: "evaluation", label: "evaluation" },
      { key: "tensions", label: "tensions" },
    ];
    if (dims.some(d => typeof prevCov[d.key] === "number" && prevCov[d.key] > 0)) {
      const scored = dims.map(d => ({ ...d, val: Number(prevCov[d.key]) || 0 }));
      const weakest = scored.reduce((a, b) => (b.val < a.val ? b : a));
      const lastNote = (notes.split("\n").pop() || "").trim();
      steering = `\n\nCOVERAGE SO FAR (0-100): core logic ${scored[0].val}, commitments ${scored[1].val}, evaluation ${scored[2].val}, tensions ${scored[3].val}. Weakest dimension: ${weakest.label}.${lastNote ? ` Tracker note: ${lastNote}.` : ""} Steer your next question toward the weakest signal — naturally, never naming these terms.`;
    }
  } catch { /* no prior coverage — first exchange */ }
  return steering;
}

export interface InterviewSynthesis {
  interviewId: string;
  ipHash: string;
  messages: ChatMessage[];
  notes: string;
  isPublic: number;
  enrichTarget: EnrichTarget | null;
}

/** Background job: build (or enrich) the lens. Failures mark the interview failed and restore an enriched lens. */
export async function synthesizeInterview(engine: Engine, job: InterviewSynthesis): Promise<void> {
  const { db, llm } = engine;
  const { interviewId, ipHash, messages, enrichTarget } = job;
  try {
    const transcript = formatTranscript(messages);

    const extractionId = enrichTarget ? enrichTarget.id : generateId();
    const combinedSource = enrichTarget?.source_text
      ? enrichTarget.source_text + "\n\n---NEW CONVERSATION---\n\n" + transcript
      : transcript;

    if (enrichTarget) {
      // ── ENRICH MODE: update existing lens ──

      // Phase 1: Update LD with new conversation findings
      db.query("UPDATE extractions SET status = 'phase3' WHERE id = ?").run(extractionId);
      const enrichPrompt = INTERVIEW_ENRICH_PROMPT(enrichTarget.logic_document, transcript, job.notes);
      const rawLd = await completePrompt(llm, enrichPrompt);

      // Truncation guard: a regenerated LD that is much shorter than the original,
      // or that ends mid-section, is almost certainly truncated at the token cap.
      // Reject it rather than silently replacing a good lens with a broken one.
      const trimmedLd = rawLd.trim();
      const endsCleanly = /[.!?)"'`\]]\s*$/.test(trimmedLd) || /\n#{1,4}\s.*$/.test(trimmedLd) || /^[-*]\s.*$/m.test(trimmedLd.slice(-200));
      if (trimmedLd.length < enrichTarget.logic_document.trim().length * 0.6 || !endsCleanly) {
        throw new Error("Enrichment produced an incomplete Logic Document (truncated output) — the original lens was preserved. Try synthesizing again.");
      }

      // Quote gate BEFORE the write: quotes must trace to the user's words
      // (combined source) or the previously-gated original LD.
      let groundingReport = "{}";
      let logicDocument: string;
      ({ doc: logicDocument, reportJson: groundingReport } = gateDoc(rawLd, `${combinedSource}\n\n${enrichTarget.logic_document}`, groundingReport, "ldQuoteCheck"));

      db.query(
        "UPDATE extractions SET logic_document = ?, source_text = ?, word_count = ? WHERE id = ?"
      ).run(logicDocument, combinedSource, countWords(combinedSource), extractionId);

      // Link interview to extraction early
      db.query("UPDATE interviews SET extraction_id = ? WHERE id = ?").run(extractionId, interviewId);

      // Phase 2: KE from new transcript + merge with existing KE
      db.query("UPDATE extractions SET status = 'phase4' WHERE id = ?").run(extractionId);
      const newKe = await runKnowledgeExtraction(llm, transcript, logicDocument);

      const mergedKe = enrichTarget.knowledge_extract
        ? enrichTarget.knowledge_extract + "\n\n# ADDITIONAL KNOWLEDGE (from follow-up conversation)\n\n" + newKe
        : newKe;

      // Phase 3: Verify merged KE against combined source
      db.query("UPDATE extractions SET status = 'phase5' WHERE id = ?").run(extractionId);
      let finalKe = mergedKe;
      try {
        const { verifiedKe, report } = await verifyKnowledgeExtract(llm, mergedKe, combinedSource);
        finalKe = verifiedKe;
        groundingReport = JSON.stringify({ ...JSON.parse(groundingReport), ...report });
      } catch (err) {
        console.error(`[interview-enrich] KE verification failed for ${extractionId}:`, err);
        groundingReport = JSON.stringify({ ...JSON.parse(groundingReport), error: "Verification failed — using unverified extract" });
      }

      // Quote gate runs even when verification threw — raw KE never ships ungated.
      ({ doc: finalKe, reportJson: groundingReport } = gateDoc(finalKe, `${combinedSource}\n\n${logicDocument}`, groundingReport, "keQuoteCheck"));

      db.query(
        "UPDATE extractions SET knowledge_extract = ?, grounding_report = ? WHERE id = ?"
      ).run(finalKe, groundingReport, extractionId);

      // Phase 4: Re-synthesize UD from updated LD + merged KE
      db.query("UPDATE extractions SET status = 'phase6' WHERE id = ?").run(extractionId);
      let understanding = "";
      try {
        const result = await runUnderstandingSynthesis(llm, logicDocument, finalKe);
        understanding = result.understanding;
        try {
          const existingReport = JSON.parse(groundingReport);
          existingReport.vuReport = result.vuReport;
          groundingReport = JSON.stringify(existingReport);
          db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, extractionId);
        } catch { /* non-critical */ }
      } catch (err) {
        console.error(`[interview-enrich] Understanding synthesis failed for ${extractionId}:`, err);
      }

      if (understanding) {
        ({ doc: understanding, reportJson: groundingReport } = gateDoc(understanding, `${combinedSource}\n\n${logicDocument}\n\n${finalKe}`, groundingReport, "udQuoteCheck"));
        const udFactCheck = extractAndVerifyEntities(understanding, combinedSource);
        try {
          const existingReport = JSON.parse(groundingReport);
          existingReport.udFactCheck = { score: udFactCheck.score, total: udFactCheck.total, ungrounded: udFactCheck.ungrounded };
          groundingReport = JSON.stringify(existingReport);
          db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, extractionId);
        } catch { /* non-critical */ }
      }

      db.query(
        "UPDATE extractions SET status = 'complete', understanding_document = ? WHERE id = ?"
      ).run(understanding || null, extractionId);

      db.query(
        "UPDATE interviews SET status = 'complete', extraction_id = ? WHERE id = ?"
      ).run(extractionId, interviewId);

    } else {
      // ── NEW LENS MODE: create from scratch ──

      // Phase 1: LD synthesis + profile (parallel)
      const synthPrompt = INTERVIEW_SYNTHESIS_PROMPT(transcript, job.notes);
      const profilePrompt = INTERVIEW_PROFILE_PROMPT(transcript);

      const [rawLd, pRaw] = await Promise.all([
        completePrompt(llm, synthPrompt),
        completePrompt(llm, profilePrompt),
      ]);

      let profile = { title: "", author: null as string | null, type: "Interview Extract", topic_summary: "", domain_tags: [] as string[], structure: "Conversational extraction", estimated_reading_level: "General Audience" };
      try {
        const cleaned = stripJsonFence(pRaw);
        const parsed = JSON.parse(cleaned);
        profile.title = typeof parsed.title === "string" ? parsed.title.slice(0, 300) : "Interview Extract";
        profile.author = typeof parsed.author === "string" ? parsed.author.slice(0, 200) : null;
        profile.type = typeof parsed.type === "string" ? parsed.type.slice(0, 100) : "Interview Extract";
        profile.topic_summary = typeof parsed.topic_summary === "string" ? parsed.topic_summary.slice(0, 1000) : "";
        profile.domain_tags = Array.isArray(parsed.domain_tags) ? parsed.domain_tags.filter((t: unknown) => typeof t === "string").map((t: string) => t.slice(0, 100)).slice(0, 20) : [];
      } catch { /* profile parsing failed — use defaults */ }

      // Phase 1b: quote gate BEFORE the insert — anything the LD presents as a
      // verbatim user statement must actually appear in the transcript. The
      // lens is intentionally built from the user's own answers (grounding
      // knowledge arrives later via refine/merge); transcript-traceability is
      // the fidelity standard that applies here.
      let groundingReport = "{}";
      let logicDocument: string;
      ({ doc: logicDocument, reportJson: groundingReport } = gateDoc(rawLd, transcript, groundingReport, "ldQuoteCheck"));
      const ldFactCheck = extractAndVerifyEntities(logicDocument, transcript);
      const ldGroundingEntry = { score: ldFactCheck.score, total: ldFactCheck.total, ungrounded: ldFactCheck.ungrounded };

      db.query(
        `INSERT INTO extractions (id, title, logic_document, author, doc_type, topic_summary, domain_tags, doc_structure, reading_level, word_count, status, ip_hash, model, source_text, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'phase4', ?, ?, ?, ?)`
      ).run(
        extractionId,
        profile.title || "Interview Extract",
        logicDocument,
        profile.author,
        profile.type,
        profile.topic_summary,
        JSON.stringify(profile.domain_tags),
        profile.structure,
        profile.estimated_reading_level,
        countWords(transcript),
        ipHash,
        llm.model,
        transcript,
        job.isPublic
      );

      // Link interview to extraction early
      db.query("UPDATE interviews SET extraction_id = ? WHERE id = ?").run(extractionId, interviewId);

      // Phase 2: Knowledge extraction from transcript (guided by LD)
      const rawKe = await runKnowledgeExtraction(llm, transcript, logicDocument);

      // Phase 3: Verify KE against transcript
      db.query("UPDATE extractions SET status = 'phase5' WHERE id = ?").run(extractionId);
      let finalKe = rawKe;
      try {
        const { verifiedKe, report } = await verifyKnowledgeExtract(llm, rawKe, transcript);
        finalKe = verifiedKe;
        groundingReport = JSON.stringify({ ...JSON.parse(groundingReport), ldFactCheck: ldGroundingEntry, ...report });
      } catch (err) {
        console.error(`[interview] KE verification failed for ${extractionId}:`, err);
        groundingReport = JSON.stringify({ ...JSON.parse(groundingReport), ldFactCheck: ldGroundingEntry, error: "Verification failed — using unverified extract" });
      }

      // Quote gate runs even when verification threw — raw KE never ships ungated.
      ({ doc: finalKe, reportJson: groundingReport } = gateDoc(finalKe, `${transcript}\n\n${logicDocument}`, groundingReport, "keQuoteCheck"));

      db.query(
        "UPDATE extractions SET knowledge_extract = ?, grounding_report = ? WHERE id = ?"
      ).run(finalKe, groundingReport, extractionId);

      // Phase 4: Understanding synthesis (LD + KE → UD)
      db.query("UPDATE extractions SET status = 'phase6' WHERE id = ?").run(extractionId);
      let understanding = "";
      try {
        const result = await runUnderstandingSynthesis(llm, logicDocument, finalKe);
        understanding = result.understanding;
        try {
          const existingReport = JSON.parse(groundingReport);
          existingReport.vuReport = result.vuReport;
          groundingReport = JSON.stringify(existingReport);
          db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, extractionId);
        } catch { /* non-critical */ }
      } catch (err) {
        console.error(`[interview] Understanding synthesis failed for ${extractionId}:`, err);
      }

      if (understanding) {
        ({ doc: understanding, reportJson: groundingReport } = gateDoc(understanding, `${transcript}\n\n${logicDocument}\n\n${finalKe}`, groundingReport, "udQuoteCheck"));
        const udFactCheck = extractAndVerifyEntities(understanding, transcript);
        try {
          const existingReport = JSON.parse(groundingReport);
          existingReport.udFactCheck = { score: udFactCheck.score, total: udFactCheck.total, ungrounded: udFactCheck.ungrounded };
          groundingReport = JSON.stringify(existingReport);
          db.query("UPDATE extractions SET grounding_report = ? WHERE id = ?").run(groundingReport, extractionId);
        } catch { /* non-critical */ }
      }

      db.query(
        "UPDATE extractions SET status = 'complete', understanding_document = ? WHERE id = ?"
      ).run(understanding || null, extractionId);

      db.query(
        "UPDATE interviews SET status = 'complete', extraction_id = ? WHERE id = ?"
      ).run(extractionId, interviewId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    db.query("UPDATE interviews SET status = 'failed', error = ? WHERE id = ?").run(msg, interviewId);
    if (enrichTarget) {
      // Restore the ORIGINAL lens content, not just the status — the failure may
      // have happened after the new LD/KE was already written.
      db.query(
        "UPDATE extractions SET status = 'complete', logic_document = ?, source_text = ?, knowledge_extract = ?, understanding_document = ?, word_count = ? WHERE id = ?"
      ).run(enrichTarget.logic_document, enrichTarget.source_text, enrichTarget.knowledge_extract, enrichTarget.understanding_document, enrichTarget.word_count, enrichTarget.id);
    }
  }
}
