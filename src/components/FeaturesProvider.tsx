"use client";

import { createContext, useContext } from "react";

export interface ClientFeatures {
  chatEnabled: boolean;
  /** The document library (LOCUS_LIBRARY_ENABLED). Absent or false: no library UI at all. */
  libraryEnabled?: boolean;
  /** LOCUS_SEARCH_SCOPE: where searches look until someone picks otherwise. Only used with the library on. */
  defaultScope?: "session" | "library" | "both";
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
