// Knowledge Extract (KE): prescriptive + conditional extraction guided by the Logic
// Document, chunk regrouping for long sources, and VK claim verification.

import type { LlmClient } from "../llm.ts";
import { AGENT_K_CONDITIONAL_PROMPT, AGENT_K_PRESCRIPTIVE_PROMPT, AGENT_VK_PROMPT } from "../prompts.ts";
import { chunkText } from "../text.ts";
import { buildClaimPassagePairs, extractAndVerifyEntities, type ClaimPassagePair } from "./grounding.ts";

export function regroupKnowledgeChunks(chunkExtracts: string[]): string {
  const accumulate = (texts: string[]): string => {
    const map = new Map<string, { display: string; lines: string[]; seen: Set<string> }>();
    const order: string[] = [];
    for (const text of texts) {
      for (const part of text.split(/^(?=##\s)/m)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const headingMatch = trimmed.match(/^##\s+(.+)/);
        const display = headingMatch ? headingMatch[1].trim() : "__intro__";
        const norm = display.toLowerCase().replace(/^\d+\.?\s*/, "").trim();
        const body = headingMatch ? trimmed.replace(/^##\s+.+\n?/, "") : trimmed;
        if (!map.has(norm)) {
          map.set(norm, { display, lines: [], seen: new Set() });
          order.push(norm);
        }
        const entry = map.get(norm)!;
        for (const line of body.split("\n")) {
          const key = line.trim();
          if (key.length > 0) {
            if (entry.seen.has(key)) continue;
            entry.seen.add(key);
          }
          entry.lines.push(line);
        }
      }
    }
    return order
      .map((norm) => {
        const entry = map.get(norm)!;
        const content = entry.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
        return norm === "__intro__" ? content : `## ${entry.display}\n\n${content}`;
      })
      .filter(Boolean)
      .join("\n\n");
  };

  const presTexts: string[] = [];
  const condTexts: string[] = [];
  for (const chunk of chunkExtracts) {
    const idx = chunk.indexOf("# CONDITIONAL KNOWLEDGE");
    if (idx !== -1) {
      presTexts.push(chunk.slice(0, idx).replace(/^#\s+PRESCRIPTIVE KNOWLEDGE/i, "").trim());
      condTexts.push(chunk.slice(idx).replace(/^#\s+CONDITIONAL KNOWLEDGE/i, "").trim());
    } else {
      presTexts.push(chunk.replace(/^#\s+PRESCRIPTIVE KNOWLEDGE/i, "").trim());
    }
  }
  return `# PRESCRIPTIVE KNOWLEDGE\n\n${accumulate(presTexts)}\n\n# CONDITIONAL KNOWLEDGE\n\n${accumulate(condTexts)}`;
}

export async function runKnowledgeExtraction(llm: LlmClient, sourceText: string, logicDocument: string): Promise<string> {
  const chunks = chunkText(sourceText);

  async function extractChunk(chunk: string): Promise<string> {
    const [prescriptive, conditional] = await Promise.all([
      llm.complete(
        AGENT_K_PRESCRIPTIVE_PROMPT(chunk, logicDocument).system,
        AGENT_K_PRESCRIPTIVE_PROMPT(chunk, logicDocument).user
      ),
      llm.complete(
        AGENT_K_CONDITIONAL_PROMPT(chunk, logicDocument).system,
        AGENT_K_CONDITIONAL_PROMPT(chunk, logicDocument).user
      ),
    ]);
    return `# PRESCRIPTIVE KNOWLEDGE\n\n${prescriptive}\n\n# CONDITIONAL KNOWLEDGE\n\n${conditional}`;
  }

  if (chunks.length === 1) {
    return extractChunk(chunks[0]);
  }

  const chunkExtracts = await Promise.all(chunks.map(extractChunk));
  return regroupKnowledgeChunks(chunkExtracts);
}

export async function verifyKnowledgeExtract(
  llm: LlmClient,
  ke: string,
  sourceText: string
): Promise<{ verifiedKe: string; report: Record<string, unknown> }> {
  const entityResult = extractAndVerifyEntities(ke, sourceText);
  const pairs = buildClaimPassagePairs(ke, sourceText);

  if (pairs.length === 0) {
    return {
      verifiedKe: ke,
      report: {
        entityScore: entityResult.score,
        entityTotal: entityResult.total,
        ungroundedEntities: entityResult.ungrounded,
        claimsVerified: 0,
        claimsCorrected: 0,
        claimsUnsupported: 0,
        corrections: [],
      },
    };
  }

  const batchSize = 15;
  const batches: ClaimPassagePair[][] = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    batches.push(pairs.slice(i, i + batchSize));
  }

  const vkResults = await Promise.all(
    batches.map(batch => {
      const prompt = AGENT_VK_PROMPT(batch);
      return llm.complete(prompt.system, prompt.user, { temperature: 0.1 });
    })
  );

  const allVkText = vkResults.join('\n\n');

  let corrected = 0;
  let verified = 0;
  let unsupported = 0;
  const corrections: Array<{ claim: string; correction: string }> = [];

  // Structured corrections: VK emits "CLAIM: <original>" / "CORRECTED TO: <new>" pairs.
  const structuredMatches = allVkText.matchAll(/CLAIM:\s*(.+?)\s*\n\s*CORRECTED TO:\s*(.+?)(?:\n|$)/gi);
  for (const m of structuredMatches) {
    const original = m[1].trim();
    const corrTo = m[2].trim();
    if (original.length > 0 && corrTo.length > 0) {
      corrections.push({ claim: original, correction: corrTo });
    }
  }

  corrected = (allVkText.match(/\bCORRECTED\b(?!\s+TO)/gi) || []).length;
  verified = (allVkText.match(/\bVERIFIED\b/g) || []).length;
  unsupported = (allVkText.match(/\bUNSUPPORTED\b/g) || []).length;

  let verifiedKe = ke;
  for (const c of corrections) {
    if (c.claim.length > 10 && verifiedKe.includes(c.claim)) {
      // Apply correction by exact-substring replacement of the original claim text.
      verifiedKe = verifiedKe.replace(c.claim, c.correction);
    } else {
      // Fall back to footnote behavior when the substring isn't found.
      const claimSnippet = c.claim.slice(0, 60);
      if (claimSnippet.length > 10 && verifiedKe.includes(claimSnippet)) {
        verifiedKe += `\n\n> **CORRECTION**: Near "${claimSnippet}..." — source actually says: ${c.correction}`;
      }
    }
  }

  const totalClaims = verified + corrected + unsupported;

  return {
    verifiedKe,
    report: {
      entityScore: entityResult.score,
      entityTotal: entityResult.total,
      ungroundedEntities: entityResult.ungrounded,
      claimsChecked: totalClaims,
      claimsVerified: verified,
      claimsCorrected: corrected,
      claimsUnsupported: unsupported,
      claimScore: totalClaims > 0 ? verified / totalClaims : 1,
      corrections: corrections.map(c => ({ claim: c.claim.slice(0, 80), correction: c.correction.slice(0, 80) })),
    },
  };
}
