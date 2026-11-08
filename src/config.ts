import { join } from "path";

export interface Config {
  port: number;
  host: string;
  /** Public base URL for canonical links (OKF bundles, lens pages). */
  publicUrl: string;
  /** SQLite file path, derived from DATA_DIR. */
  databasePath: string;
  production: boolean;
  allowedOrigin: string;
  internalApiToken: string;
  ipHashSalt: string;
  rateLimitMinutes: number;
  maxWords: number;
  crossSynthesis: boolean;
  llm: {
    apiUrl: string;
    apiKey: string;
    /** Extraction tier; also the consult default. "deepseek-chat" resolves to v4-flash server-side. */
    model: string;
    /** Consult-only reasoning tier. */
    reasoningModel: string;
    /** Reasoning models bill hidden reasoning inside max_tokens; below ~16k they return empty content. */
    reasoningMaxTokens: number;
  };
}

const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");

/** Where the SQLite database lives (DATA_DIR, default ./data). Also used by tools/. */
export function databasePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.DATA_DIR || DEFAULT_DATA_DIR, "extractions.db");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set (see .env.example)");
  if (!env.IP_HASH_SALT) {
    console.warn("WARNING: IP_HASH_SALT not set — rate limits will reset on restart. Set it in .env for persistence.");
  }
  const port = parseInt(env.PORT || "3471");
  return {
    port,
    host: env.HOST || "127.0.0.1",
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    databasePath: databasePath(env),
    production: env.NODE_ENV === "production",
    allowedOrigin: env.ALLOWED_ORIGIN || "",
    internalApiToken: env.INTERNAL_API_TOKEN || "",
    ipHashSalt: env.IP_HASH_SALT || crypto.randomUUID(),
    rateLimitMinutes: parseInt(env.RATE_LIMIT_MINUTES || "60"),
    maxWords: parseInt(env.MAX_WORDS || "400000"),
    crossSynthesis: env.CROSS_SYNTHESIS_ENABLED === "1",
    llm: {
      apiUrl: env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
      apiKey,
      model: "deepseek-chat",
      reasoningModel: "deepseek-v4-pro",
      reasoningMaxTokens: 16384,
    },
  };
}
