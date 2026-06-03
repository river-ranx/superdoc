import type { FontFaceRequest, FontResolver } from '@superdoc/font-system';
import type { FontReadinessGate } from './FontReadinessGate.js';

/** One physical font face: a URL source plus optional weight/style (default 400/normal). */
export interface ManagedFontFace {
  /** A URL the FontFace loads ('/fonts/x.woff2' or 'url(...)'). v1 is URL-only; no binary sources. */
  source: string;
  /** Font weight (e.g. 400, 700, 'bold'); defaults to 400. */
  weight?: number | string;
  /** Font style ('normal' | 'italic'); defaults to 'normal'. */
  style?: string;
}

/** A physical family to register, with its weight/style faces. */
export interface ManagedFontFamily {
  /** The physical family name documents map to and CSS renders (e.g. 'Gelasio'). */
  family: string;
  faces: ManagedFontFace[];
}

export interface DocumentFontControllerDeps {
  /**
   * This document's logical->physical resolver. The controller is its ONLY writer (map/unmap/
   * reset); PresentationEditor and `superdoc.fonts.*` route through here rather than mutating it
   * directly, so config-time and runtime changes share one orchestration path.
   */
  resolver: FontResolver;
  /**
   * The current font-readiness gate, or null before init / after teardown. A function (not the
   * gate itself) because the gate is recreated across renders and document swaps; the controller
   * always talks to the live one.
   */
  getGate: () => FontReadinessGate | null;
  /**
   * Invoked once after a mapping change is actually applied (signature changed), so the next
   * `fonts-changed` is labelled `source: 'config-change'` instead of `late-load`.
   */
  onMappingApplied: () => void;
}

/**
 * Normalize a public font source (a plain URL like '/fonts/Gelasio.woff2') to the CSS `url(...)`
 * source the FontFace constructor expects. An already-`url(...)` value is left unchanged.
 */
function toCssFontSource(url: string): string {
  return /^\s*url\(/i.test(url) ? url : `url(${JSON.stringify(url)})`;
}

/**
 * The single writer for a document's font state: `map`/`unmap` change the resolver, `add`
 * registers customer faces through the registry, and `preload` loads them. Runtime
 * `superdoc.fonts.*` routes through here (config-time `new SuperDoc({ fonts })` will use the same
 * methods), so every mutation shares one orchestration path: mutate, then reflow ONCE - and only
 * when something actually changed. Mapping changes are document-local (the per-document resolver
 * signature already busts this document's measure/paint caches), so a reflow goes through
 * {@link FontReadinessGate.notifyFontMappingChanged} and never bumps the global font epoch or
 * touches other editors on the page.
 */
export class DocumentFontController {
  readonly #resolver: FontResolver;
  readonly #getGate: () => FontReadinessGate | null;
  readonly #onMappingApplied: () => void;

  constructor(deps: DocumentFontControllerDeps) {
    this.#resolver = deps.resolver;
    this.#getGate = deps.getGate;
    this.#onMappingApplied = deps.onMappingApplied;
  }

  /**
   * Map logical families to physical render families, e.g. `map({ Georgia: 'Gelasio' })`. Applies
   * every entry, then reflows the document ONCE - and only if the resolver signature actually
   * changed, so a redundant map (same target already set) neither reflows nor emits. The physical
   * family must be loadable (a bundled substitute, or a face registered via `add`); an
   * unmapped/unloadable target falls back at the gate. Render-only: export keeps the logical name.
   */
  map(mappings: Record<string, string>): void {
    const before = this.#resolver.signature;
    for (const [logicalFamily, physicalFamily] of Object.entries(mappings)) {
      this.#resolver.map(logicalFamily, physicalFamily);
    }
    this.#reflowIfChanged(before);
  }

  /** Remove runtime mappings; each family reverts to its bundled default (or identity). */
  unmap(families: string | string[]): void {
    const before = this.#resolver.signature;
    for (const family of Array.isArray(families) ? families : [families]) {
      this.#resolver.unmap(family);
    }
    this.#reflowIfChanged(before);
  }

  /**
   * Clear all runtime overrides (called on a document swap, so a prior document's mappings do not
   * leak into the next). No reflow here: the swap re-renders the new document from scratch.
   */
  reset(): void {
    this.#resolver.reset();
  }

  /**
   * Register custom physical font faces (e.g. a customer's Gelasio woff2s) so they become loadable
   * and mappable. Registers only - it does NOT map (call {@link map} for that). Idempotent per
   * face; a different source for an already-registered family|weight|style throws (the registry is
   * the guard). v1 sources are URLs. Registration changes which faces are available, so it reflows
   * this document once: the gate re-plans and awaits any newly-registered face the document already
   * uses. Export is unaffected (mapping/render only).
   */
  add(families: ManagedFontFamily[]): void {
    const registry = this.#getGate()?.resolveRegistry();
    if (!registry) throw new Error('[superdoc] fonts.add: the font registry is not ready yet');
    let changed = false;
    for (const { family, faces } of families) {
      for (const face of faces) {
        const result = registry.register({
          family,
          source: toCssFontSource(face.source),
          descriptors: { weight: face.weight == null ? undefined : String(face.weight), style: face.style },
        });
        if (result.changed) changed = true;
      }
    }
    // Registration does not change the resolver signature (unlike map/unmap), so reflow whenever a
    // face was actually registered - but skip it (and the config-change event) for a fully
    // idempotent re-add, where availability did not change.
    if (changed) this.#reflow();
  }

  /**
   * Proactively load the physical faces for the given LOGICAL families so they are ready before the
   * document needs them (avoiding a late-load reflow). Resolves each logical family through THIS
   * document's resolver, then awaits its regular (400/normal) face via the registry. Async by
   * design - loading is not hidden inside {@link map}. Weighted/italic variants load on demand.
   */
  async preload(families: string[]): Promise<void> {
    const registry = this.#getGate()?.resolveRegistry();
    if (!registry) throw new Error('[superdoc] fonts.preload: the font registry is not ready yet');
    const requests: FontFaceRequest[] = families.map((logical) => ({
      family: this.#resolver.resolvePrimaryPhysicalFamily(logical),
      weight: '400',
      style: 'normal',
    }));
    await registry.awaitFaceRequests(requests);
  }

  /**
   * Reflow the document once iff the signature changed since `signatureBefore`. A no-op mutation
   * (signature unchanged) must not reflow or emit.
   */
  #reflowIfChanged(signatureBefore: string): void {
    if (this.#resolver.signature !== signatureBefore) this.#reflow();
  }

  /** Document-local reflow + mark the next `fonts-changed` as a config change. */
  #reflow(): void {
    this.#onMappingApplied();
    this.#getGate()?.notifyFontMappingChanged();
  }
}
