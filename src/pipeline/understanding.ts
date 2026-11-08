// Understanding Document (UD): U1 maps connections between LD and KE, U2 writes the
// UD, VU audits it; one regeneration pass when the audit finds fabricated citations.

import type { LlmClient } from "../llm.ts";
import { AGENT_U1_PROMPT, AGENT_U2_PROMPT, AGENT_VU_PROMPT } from "../prompts.ts";

export async function runUnderstandingSynthesis(
  llm: LlmClient,
  logicDocument: string,
  knowledgeExtract: string
): Promise<{ understanding: string; vuReport: string }> {
  const u1Prompt = AGENT_U1_PROMPT(logicDocument, knowledgeExtract);
  const connectionMap = await llm.complete(u1Prompt.system, u1Prompt.user);

  const u2Prompt = AGENT_U2_PROMPT(logicDocument, knowledgeExtract, connectionMap);
  let understanding = await llm.complete(u2Prompt.system, u2Prompt.user);

  const runVu = (ud: string): Promise<string> => {
    const vuPrompt = AGENT_VU_PROMPT(logicDocument, knowledgeExtract, ud);
    return llm.complete(vuPrompt.system, vuPrompt.user, { temperature: 0.1 });
  };

  let vuReport = await runVu(understanding);

  // If the audit found fabricated citations, regenerate U2 once with the VU
  // findings as mandatory corrections, then re-audit and ship the corrected version.
  if (/\bFABRICATED\b/.test(vuReport)) {
    try {
      const corrections = `The prior draft of this Understanding Document was audited and the following citations were found FABRICATED or MISLEADING. You MUST remove or fix every one of them — do not cite a passage that does not exist or does not say what you claim. Here is the audit:\n\n${vuReport}`;
      const regenPrompt = AGENT_U2_PROMPT(logicDocument, knowledgeExtract, connectionMap);
      const regenerated = await llm.complete(regenPrompt.system, regenPrompt.user + "\n\n" + corrections);
      const reVuReport = await runVu(regenerated);
      understanding = regenerated;
      vuReport = reVuReport;
    } catch (err) {
      console.error("[runUnderstandingSynthesis] VU correction pass failed:", err);
    }
  }

  return { understanding, vuReport };
}
