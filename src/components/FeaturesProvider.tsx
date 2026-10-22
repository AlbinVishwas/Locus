"use client";

import { createContext, useContext } from "react";

export interface ClientFeatures {
  chatEnabled: boolean;
}

/**
 * The resolved feature switches (src/config/features.ts), handed down from
 * the root layout, which reads them on the server at request time. The
 * default matches features.chatEnabled's own default, for a component
 * rendered with no provider (a static test render, say).
 */
const FeaturesContext = createContext<ClientFeatures>({ chatEnabled: false });

export function FeaturesProvider({
  features,
  children,
}: {
  features: ClientFeatures;
  children: React.ReactNode;
}) {
  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>;
}

export function useFeatures(): ClientFeatures {
  return useContext(FeaturesContext);
}
