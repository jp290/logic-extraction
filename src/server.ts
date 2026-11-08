// Entry point: `bun src/server.ts` (or `bun start`).

import { createAppContext, createFetchHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { getClientIP, json } from "./http.ts";
import { createLlmClient } from "./llm.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// A restart (deploy, supervisor) kills in-flight jobs; log the signal so the failed
// rows the next boot recovers are attributable.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    console.error(`[death] ${sig} received at ${new Date().toISOString()} — exiting (in-flight jobs will be marked failed on next boot)`);
    process.exit(0);
  });
}

const llm = createLlmClient(config.llm);
const db = openDatabase(config.databasePath, llm.model);
const app = createAppContext({ config, db, llm });
const handle = createFetchHandler(app);

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  maxRequestBodySize: 5_000_000,
  async fetch(req, server) {
    const start = performance.now();
    const response = await handle(req, server);
    const ms = (performance.now() - start).toFixed(0);
    const ipHash = app.hashIP(getClientIP(req, server)).slice(0, 8);
    console.log(`${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname} ${response.status} ${ms}ms [${ipHash}]`);
    return response;
  },
  // Last line of defence: an unexpected throw becomes a JSON 500, never a stack trace.
  error(err) {
    console.error("[unhandled]", err);
    return json({ error: "Internal server error" }, 500);
  },
});

console.log(`Logic Extraction server running at http://${server.hostname}:${server.port}`);
