// Logic test: the same scenario answered bare (baseline) and with the lens mounted.

import type { Engine } from "../engine.ts";
import { completePrompt } from "../llm.ts";
import { TEST_BASELINE_PROMPT, TEST_LOGIC_PROMPT } from "../prompts.ts";

export async function runLogicTest(engine: Engine, id: string): Promise<void> {
  const { db, llm } = engine;
  try {
    db.query("UPDATE logic_tests SET status = 'running' WHERE id = ?").run(id);

    const row = db.query(
      "SELECT extraction_id, scenario FROM logic_tests WHERE id = ?"
    ).get(id) as { extraction_id: string; scenario: string };

    const ext = db.query(
      "SELECT logic_document, knowledge_extract, understanding_document FROM extractions WHERE id = ? AND status = 'complete'"
    ).get(row.extraction_id) as { logic_document: string; knowledge_extract: string | null; understanding_document: string | null };

    const baselinePrompt = TEST_BASELINE_PROMPT(row.scenario);
    const logicPrompt = TEST_LOGIC_PROMPT(
      ext.logic_document,
      ext.knowledge_extract || "",
      ext.understanding_document || "",
      row.scenario
    );

    const [baseline, logic] = await Promise.all([
      completePrompt(llm, baselinePrompt),
      completePrompt(llm, logicPrompt),
    ]);

    db.query(
      "UPDATE logic_tests SET status = 'complete', baseline_response = ?, logic_response = ? WHERE id = ?"
    ).run(baseline, logic, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Test failed";
    db.query("UPDATE logic_tests SET status = 'failed', error = ? WHERE id = ?").run(msg, id);
  }
}
