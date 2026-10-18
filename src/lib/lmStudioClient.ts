import OpenAI from "openai";

/**
 * The one place a LM Studio client gets constructed, shared by every route
 * that talks to it (chat, title generation). Built per call, not once at
 * module scope, so editing .env.local takes effect on the next request
 * instead of the next full server restart -- matters most when the base
 * URL is a tunnel whose address changes.
 */
export function lmStudioClient(timeoutMs: number): {
  client: OpenAI;
  model: string;
  baseURL: string;
} {
  const baseURL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
  const model = process.env.LM_STUDIO_MODEL ?? "qwen/qwen3-4b";
  const client = new OpenAI({
    baseURL,
    apiKey: "lm-studio", // LM Studio ignores the value but the SDK requires one
    timeout: timeoutMs,
  });
  return { client, model, baseURL };
}
