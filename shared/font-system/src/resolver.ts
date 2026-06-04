/**
 * Logical -> physical font resolution.
 *
 * A document refers to a font by its *logical* family - the name Word wrote, e.g.
 * "Calibri". The browser may not have that font (it is proprietary), so SuperDoc
 * renders a metric-compatible *physical* substitute - e.g. Carlito, whose advance
 * widths match Calibri so line breaks land where Word puts them. The logical name
 * stays the source of truth (toolbar, export); only measurement and paint use the
 * physical family, and they MUST use the same one or text is measured in one font
 * and painted in another.
 *
 * The value reaching measure and paint is a CSS font-family *stack* the layout
 * builds via `toCssFontFamily`, e.g. "Calibri, sans-serif" - so resolution applies
 * to the PRIMARY family and keeps the remaining fallbacks ("Carlito, sans-serif").
 *
 * Resolution is a {@link FontResolver} INSTANCE, not a global: each document gets its
 * own so two editors on one page can map the same logical family differently (a
 * customer `fonts.map`) without leaking across documents - the same per-document
 * isolation the registry already has per `FontFaceSet`. Every instance is seeded with
 * the five verified clean clones (Calibri->Carlito, Cambria->Caladea, Arial->Liberation
 * Sans, Times New Roman->Liberation Serif, Courier New->Liberation Mono). The
 * module-level `resolve*` functions delegate to a shared default instance for callers
 * that have no document context (and for backward compatibility).
 */

export type FontResolutionReason =
  /** No substitute is known; the requested family is used as-is. */
  | 'as_requested'
  /** Replaced by a bundled metric-compatible clone. */
  | 'bundled_substitute'
  /** Replaced by a runtime mapping set on this document's resolver (customer `fonts.map`). */
  | 'custom_mapping';

export interface FontResolution {
  /** The family the document asked for (preserved for toolbar/export). */
  logicalFamily: string;
  /** The bare physical family that is actually loaded, measured, and painted. */
  physicalFamily: string;
  reason: FontResolutionReason;
}

/**
 * Logical (normalized) -> physical family. Lowercased, quote-stripped keys.
 *
 * Only metric-verified clean clones (advance widths + OS/2 line metrics match the Word
 * original) belong here. Each target MUST be a family the bundled pack supplies
 * (see `bundled.ts`). Aptos/Georgia are intentionally absent - no clean clone yet.
 */
const BUNDLED_SUBSTITUTES: Readonly<Record<string, string>> = Object.freeze({
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'Liberation Sans',
  'times new roman': 'Liberation Serif',
  'courier new': 'Liberation Mono',
});

/** Normalize a family name for lookup: trim, strip surrounding quotes, lowercase. */
function normalizeFamilyKey(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

/** Split a CSS font-family value into trimmed, non-empty families (primary first). */
function splitStack(cssFontFamily: string): string[] {
  return cssFontFamily
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Per-document logical -> physical font resolver. Seeded with the bundled clean-clone
 * map; also holds per-instance runtime overrides (a customer `fonts.map`). Because each
 * document owns its instance, two documents can map the same logical family to different
 * physical families without interfering. Its {@link signature} (NOT the numeric
 * {@link version}) is the identity measure-cache keys and paint reuse signatures must fold in,
 * so two documents at the same version with different mappings never collide.
 */
export class FontResolver {
  /** Normalized logical family -> physical family. Takes precedence over the bundled map. */
  readonly #overrides = new Map<string, string>();
  #version = 0;
  /** Memoized {@link signature}; null = stale, recomputed on next read. Invalidated on every mutation. */
  #cachedSignature: string | null = null;

  /**
   * Map a logical family to a physical render family for this document, overriding the
   * bundled default (e.g. "Georgia" -> "Gelasio", or a customer family -> their font).
   * The physical family must be one the registry can load.
   */
  map(logicalFamily: string, physicalFamily: string): void {
    const key = normalizeFamilyKey(logicalFamily);
    // The physical name is the bare family the registry loads and CSS renders, so trim
    // surrounding whitespace (" Gelasio " and "Gelasio" must be one mapping, not two).
    const physical = physicalFamily?.trim();
    if (!key || !physical) return;
    if (this.#overrides.get(key) === physical) return;
    // Mapping a family to the physical it resolves to by DEFAULT - its bundled substitute, or its
    // own name when there is none - is the ABSENCE of an override, not an override to record.
    // Storing it would leave a non-empty signature that permanently de-opts this document's cache
    // sharing (a non-empty signature never re-shares with default documents). So treat it as an
    // unmap: drop any existing override (reverting to the default) and bump only if that removed
    // one. This makes `map({ Calibri: 'Carlito' })` a true no-op whether Calibri was unmapped or
    // previously pointed elsewhere (e.g. ->Tinos), restoring shared-cache eligibility either way.
    if ((BUNDLED_SUBSTITUTES[key] ?? logicalFamily.trim()) === physical) {
      if (this.#overrides.delete(key)) {
        this.#version += 1;
        this.#cachedSignature = null;
      }
      return;
    }
    this.#overrides.set(key, physical);
    this.#version += 1;
    this.#cachedSignature = null;
  }

  /** Remove a runtime mapping; the family reverts to its bundled default (or identity). */
  unmap(logicalFamily: string): void {
    if (this.#overrides.delete(normalizeFamilyKey(logicalFamily))) {
      this.#version += 1;
      this.#cachedSignature = null;
    }
  }

  /**
   * Drop all runtime overrides, reverting to the bundled-only map. Call on a document swap
   * (the same editor instance is reused, so the prior document's `fonts.map` must not leak
   * into the next). Bumps {@link version} only if something was actually cleared.
   */
  reset(): void {
    if (this.#overrides.size === 0) return;
    this.#overrides.clear();
    this.#version += 1;
    this.#cachedSignature = null;
  }

  /** Monotonic version; bumps on every mapping change. A lightweight "did it change" signal. */
  get version(): number {
    return this.#version;
  }

  /**
   * Stable content signature of this resolver's runtime mappings - the deterministic,
   * order-independent serialization of its overrides. This (NOT {@link version}) is what
   * measure-cache keys and paint reuse signatures must fold in: two documents can both be at
   * version 1 with DIFFERENT mappings (Georgia->Gelasio vs Georgia->Tinos), and a numeric
   * version would collide; their signatures differ. Empty (no overrides) is `''`, so all
   * default documents share cache safely because they resolve identically.
   */
  get signature(): string {
    if (this.#cachedSignature !== null) return this.#cachedSignature;
    // JSON of sorted [logical, physical] pairs: deterministic and collision-safe even when a
    // font name contains punctuation (a delimited "logical=physical|..." form would not be).
    // Empty (no overrides) is '' so all default documents share cache. Memoized until the next
    // mutation (map/unmap/reset clear the cache), since signature is read several times per render.
    this.#cachedSignature =
      this.#overrides.size === 0
        ? ''
        : JSON.stringify([...this.#overrides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return this.#cachedSignature;
  }

  /** The physical family + why, for a bare logical name. Overrides beat the bundled map. */
  #physicalFor(bareFamily: string): { physical: string; reason: FontResolutionReason } {
    const key = normalizeFamilyKey(bareFamily);
    const override = this.#overrides.get(key);
    if (override) return { physical: override, reason: 'custom_mapping' };
    const bundled = BUNDLED_SUBSTITUTES[key];
    if (bundled) return { physical: bundled, reason: 'bundled_substitute' };
    return { physical: bareFamily, reason: 'as_requested' };
  }

  /**
   * Structured resolution of a logical family (or CSS stack) to its bare physical render
   * family. The primary (first) family drives the result; this is what the load gate
   * awaits and what diagnostics report.
   */
  resolveFontFamily(logicalFamily: string): FontResolution {
    const parts = splitStack(logicalFamily);
    const primary = parts[0] ?? logicalFamily;
    const { physical, reason } = this.#physicalFor(primary);
    return { logicalFamily, physicalFamily: physical, reason };
  }

  /**
   * Resolve a CSS font-family value for MEASURE and PAINT: swap the primary family to its
   * physical substitute and keep the original fallbacks. "Calibri, sans-serif" ->
   * "Carlito, sans-serif"; "Calibri" -> "Carlito". An unmapped value is returned unchanged.
   */
  resolvePhysicalFamily(cssFontFamily: string): string {
    if (!cssFontFamily) return cssFontFamily;
    const parts = splitStack(cssFontFamily);
    if (parts.length === 0) return cssFontFamily;
    const { physical, reason } = this.#physicalFor(parts[0]);
    if (reason === 'as_requested') return cssFontFamily;
    return [physical, ...parts.slice(1)].join(', ');
  }

  /**
   * The bare physical family the load gate must await - the primary family resolved to its
   * substitute. "Calibri, sans-serif" -> "Carlito"; "Calibri" -> "Carlito".
   */
  resolvePrimaryPhysicalFamily(family: string): string {
    const parts = splitStack(family);
    const primary = parts[0] ?? family;
    return this.#physicalFor(primary).physical;
  }

  /** The deduped set of physical face families a set of logical families needs loaded. */
  resolvePhysicalFamilies(families: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const family of families) {
      if (family) out.add(this.resolvePrimaryPhysicalFamily(family));
    }
    return [...out];
  }
}

/** Create a per-document resolver seeded with the bundled clean-clone map. */
export function createFontResolver(): FontResolver {
  return new FontResolver();
}

/**
 * Shared default resolver for callers without a document context. Document rendering
 * threads its OWN {@link FontResolver} (so per-document `map` stays isolated); these
 * module functions delegate here and preserve the prior global behavior.
 */
const defaultResolver = new FontResolver();

export function resolveFontFamily(logicalFamily: string): FontResolution {
  return defaultResolver.resolveFontFamily(logicalFamily);
}

export function resolvePhysicalFamily(cssFontFamily: string): string {
  return defaultResolver.resolvePhysicalFamily(cssFontFamily);
}

export function resolvePrimaryPhysicalFamily(family: string): string {
  return defaultResolver.resolvePrimaryPhysicalFamily(family);
}

export function resolvePhysicalFamilies(families: Iterable<string>): string[] {
  return defaultResolver.resolvePhysicalFamilies(families);
}

/**
 * Maps a logical CSS family to the physical render family (a per-document `fonts.map` override or a
 * bundled substitute). The one shared spelling for what was duplicated as `(cssFontFamily: string)
 * => string` across the painter, measuring, and planner packages.
 */
export type ResolvePhysicalFamily = (cssFontFamily: string) => string;

/**
 * The per-document font identity that every measure and paint path needs, carried as ONE value so
 * the resolver and its signature cannot travel separately and drift:
 * - `resolvePhysical` maps logical -> physical for the document (glyph widths, vertical metrics, paint).
 * - `fontSignature` is the document's stable mapping identity; it keys every measure cache so two
 *   documents (or two renders) with different `fonts.map` never reuse each other's measures.
 *
 * The contract: internal measure helpers take this as a REQUIRED argument and only outer
 * compatibility entry points (e.g. the exported `measureBlock`) default to
 * {@link DEFAULT_FONT_MEASURE_CONTEXT}. Bundling the resolver with its signature is what keeps an
 * internal measure path from silently falling back to the global resolver or pairing a per-document
 * signature with the wrong resolver, and lets every cache site derive its signature from the same
 * context that supplied the resolver. (The required-argument property holds as helpers adopt the
 * context; it is enforced, not assumed, by this pass.)
 */
export interface FontMeasureContext {
  resolvePhysical: ResolvePhysicalFamily;
  fontSignature: string;
}

/**
 * The global-resolver / empty-signature context. The behavior-preserving default for outer entry
 * points and non-document callers (tests, the global measure path). Frozen so a stray
 * `DEFAULT_FONT_MEASURE_CONTEXT.resolvePhysical = ...` cannot pollute every default-path document.
 */
export const DEFAULT_FONT_MEASURE_CONTEXT: FontMeasureContext = Object.freeze({
  resolvePhysical: resolvePhysicalFamily,
  fontSignature: '',
});
