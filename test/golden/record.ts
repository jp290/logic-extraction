// Records the golden master from the current engine entry point.
// Usage: bun test/golden/record.ts [entry] [out]
import { join } from "path";
import { runScenario } from "./harness.ts";

const entry = process.argv[2] ?? "src/server.ts";
const out = process.argv[3] ?? join(import.meta.dir, "api.golden.json");
const record = await runScenario(entry);
await Bun.write(out, JSON.stringify(record, null, 1) + "\n");
console.log(`recorded ${record.steps.length} steps, ${record.llm.length} LLM calls → ${out}`);
