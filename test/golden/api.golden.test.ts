// Golden master: the engine must answer the full-route scenario exactly as recorded
// (HTTP responses, the multiset of LLM requests, final database state).
// Re-record deliberately after an intended behaviour change: bun run golden:record
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runScenario, type GoldenRecord } from "./harness.ts";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "api.golden.json"), "utf-8")) as GoldenRecord;

test("engine matches the golden master", async () => {
  const actual = await runScenario("src/server.ts");
  expect(actual.steps.map((s) => s.step)).toEqual(golden.steps.map((s) => s.step));
  for (let i = 0; i < golden.steps.length; i++) expect(actual.steps[i]).toEqual(golden.steps[i]);
  expect(actual.llm).toEqual(golden.llm);
  expect(actual.db).toEqual(golden.db);
}, 240_000);
