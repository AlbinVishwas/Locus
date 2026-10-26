import type Database from "better-sqlite3";
import { RegistryUnavailable, withRegistry } from "./appRegistry";
import { listOwnedSources } from "./registry";

/**
 * The sources an ordinary account may search: the folders it owns, as
 * { id, name, ordinal } -- the ordinal is the library index's own number for
 * the source, known once the indexer has registered it (a folder it hasn't
 * reached yet has none, and so nothing to find yet).
 */
export interface OwnedSource {
  id: string;
  name: string;
  kind: string;
  ordinal: number | null;
}

export function ownedSources(library: Database.Database | null, ownerId: number): OwnedSource[] {
  let owned;
  try {
    owned = withRegistry((registry) => listOwnedSources(registry, ownerId));
  } catch (err) {
    if (err instanceof RegistryUnavailable) return [];
    throw err;
  }
  const lookup = library ? library.prepare("SELECT ordinal FROM sources WHERE id = ?").pluck() : null;
  return owned.map((s) => {
    let ordinal: number | null = null;
    try {
      ordinal = lookup ? ((lookup.get(s.id) as number | null | undefined) ?? null) : null;
    } catch {
      // the index is momentarily unavailable
    }
    return { id: s.id, name: s.name, kind: s.kind, ordinal };
  });
}
