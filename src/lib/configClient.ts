/** Browser-side call to /api/config: display-only app config (the model name for the header pill). */

export interface AppConfig {
  model: string;
}

export async function getAppConfig(): Promise<AppConfig | null> {
  const res = await fetch("/api/config");
  if (!res.ok) return null;
  return (await res.json()) as AppConfig;
}
