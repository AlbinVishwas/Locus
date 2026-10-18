/**
 * Display-only app config: just the configured model name, for the header
 * pill ("<model> · running locally"). Reads the same env var the chat
 * route already does, read-only -- this never changes chat behavior,
 * it's the one place the UI gets to see what chat.tsx:lmStudio() uses.
 */
export async function GET() {
  const model = process.env.LM_STUDIO_MODEL ?? "qwen/qwen3-4b";
  return Response.json({ model }, { headers: { "Cache-Control": "no-store" } });
}
