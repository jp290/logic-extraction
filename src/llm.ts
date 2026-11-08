// Thin client for an OpenAI-compatible chat-completions endpoint (DeepSeek by default).
// Errors never carry the upstream body: it may echo auth headers.

import type { Config } from "./config.ts";

export interface ChatMessage {
  role: string;
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
}

export type CompleteFn = (system: string, user: string, options?: CompletionOptions) => Promise<string>;

export interface LlmClient {
  /** Model name recorded with every artifact. */
  readonly model: string;
  /** Single system+user call on the extraction tier. */
  complete: CompleteFn;
  /** Multi-turn call; jsonMode requests a JSON object response. */
  chat(messages: ChatMessage[], maxTokens?: number, jsonMode?: boolean, options?: CompletionOptions): Promise<string>;
  /** Consult call with history; `reasoning` selects the reasoning tier. Returns the model the API reports. */
  consult(
    system: string,
    user: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    reasoning: boolean
  ): Promise<{ answer: string; model: string }>;
}

const COMPLETE_MAX_TOKENS = 16384;
const CHAT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

interface CompletionResponse {
  model?: string;
  choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
}

export function createLlmClient(config: Config["llm"]): LlmClient {
  async function post(body: Record<string, unknown>): Promise<CompletionResponse> {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const status = response.status;
      await response.text();
      throw new Error(`AI processing failed (status ${status})`);
    }
    return (await response.json()) as CompletionResponse;
  }

  return {
    model: config.model,

    async complete(system, user, options = {}) {
      const data = await post({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: COMPLETE_MAX_TOKENS,
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      });
      return data.choices[0].message.content as string;
    },

    async chat(messages, maxTokens = CHAT_MAX_TOKENS, jsonMode = false, options = {}) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      };
      if (jsonMode) body.response_format = { type: "json_object" };
      const data = await post(body);
      return data.choices[0].message.content as string;
    },

    async consult(system, user, history, reasoning) {
      const requestModel = reasoning ? config.reasoningModel : config.model;
      const data = await post({
        model: requestModel,
        messages: [{ role: "system", content: system }, ...history, { role: "user", content: user }],
        max_tokens: config.reasoningMaxTokens,
        temperature: DEFAULT_TEMPERATURE,
      });
      const choice = data.choices[0];
      const answer = choice?.message?.content ?? "";
      if (!answer.trim()) {
        throw new Error(
          choice?.finish_reason === "length"
            ? "Reasoning consumed the whole token budget — no answer returned"
            : "Empty answer from model"
        );
      }
      return { answer, model: data.model ?? requestModel };
    },
  };
}

export interface Prompt {
  system: string;
  user: string;
}

/** Run a prompt builder's {system, user} pair on the extraction tier. */
export function completePrompt(llm: LlmClient, prompt: Prompt, options?: CompletionOptions): Promise<string> {
  return llm.complete(prompt.system, prompt.user, options);
}
