import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import type { LlmClient } from "./llm.ts";

/** What the pipeline needs: configuration, storage and a model client. */
export interface Engine {
  config: Config;
  db: Database;
  llm: LlmClient;
}
