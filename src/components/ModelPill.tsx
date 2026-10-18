"use client";

import { useEffect, useState } from "react";
import { getAppConfig } from "@/lib/configClient";

/** "qwen/qwen3-4b · running locally" -- the header pill naming the model actually in use. Renders nothing until the one-time config fetch resolves, rather than showing a placeholder that would shift layout. */
export default function ModelPill({ className = "" }: { className?: string }) {
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => {
    getAppConfig().then((c) => setModel(c?.model ?? null));
  }, []);

  if (!model) return null;

  return (
    <span
      className={`shrink-0 rounded-full border border-line px-2.5 py-1 text-[12px] text-secondary ${className}`}
    >
      {model} · running locally
    </span>
  );
}
