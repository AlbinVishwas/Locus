import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Qwen3 models (the configured default) treat a literal `/no_think` in the
 * user's turn as an instruction to skip their reasoning phase. Measured
 * live against LM Studio: without it, a plain one-line question can spend
 * 30+ seconds and thousands of tokens "thinking" before writing a word of
 * visible reply -- sometimes talking itself into a worse answer along the
 * way, not a better one -- where with it, the same question answers in a
 * few seconds. This is a Qwen-specific convention, not a general LM Studio
 * one, so it's only applied when the configured model looks like Qwen3;
 * `LOCUS_DISABLE_REASONING=false` turns it off entirely (e.g. for a
 * question that genuinely benefits from reasoning), `=true` forces it on
 * regardless of model name.
 */
export function shouldSuppressReasoning(model: string): boolean {
  const override = process.env.LOCUS_DISABLE_REASONING;
  if (override === "true") return true;
  if (override === "false") return false;
  return model.toLowerCase().includes("qwen3");
}

/**
 * Same copy-on-write shape as the URL-context prompt swap in
 * src/app/api/chat/route.ts: only ever applied to `outbound`, the copy
 * sent to the model, never to the message list that gets echoed back as
 * history.
 */
export function withReasoningSuppressed(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const index = messages.findLastIndex(
    (m) => m.role === "user" && typeof m.content === "string"
  );
  if (index === -1) return messages;

  const copy = [...messages];
  copy[index] = { role: "user", content: `${copy[index].content as string} /no_think` };
  return copy;
}
