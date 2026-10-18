/** Browser-side call to /api/title: a short, model-generated phrase for what a conversation's first message is about, used to upgrade a conversation's sidebar title past the raw-text fallback. */

export async function generateSmartTitle(message: string): Promise<string | null> {
  try {
    const res = await fetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: string };
    return body.title && body.title.length > 0 ? body.title : null;
  } catch {
    return null;
  }
}
