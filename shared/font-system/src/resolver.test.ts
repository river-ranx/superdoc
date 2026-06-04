import { describe, it, expect } from 'vitest';
import {
  resolveFontFamily,
  resolvePhysicalFamily,
  resolvePrimaryPhysicalFamily,
  resolvePhysicalFamilies,
  createFontResolver,
} from './index';

describe('font resolver', () => {
  it('maps the five verified clean clones (bare names)', () => {
    expect(resolvePhysicalFamily('Calibri')).toBe('Carlito');
    expect(resolvePhysicalFamily('Cambria')).toBe('Caladea');
    expect(resolvePhysicalFamily('Arial')).toBe('Liberation Sans');
    expect(resolvePhysicalFamily('Times New Roman')).toBe('Liberation Serif');
    expect(resolvePhysicalFamily('Courier New')).toBe('Liberation Mono');
  });

  it('resolves the PRIMARY family of a CSS stack and keeps the fallbacks', () => {
    // The real shape reaching measure/paint (toCssFontFamily output).
    expect(resolvePhysicalFamily('Calibri, sans-serif')).toBe('Carlito, sans-serif');
    expect(resolvePhysicalFamily('Times New Roman, serif')).toBe('Liberation Serif, serif');
    expect(resolvePhysicalFamily('Calibri , Arial , sans-serif')).toBe('Carlito, Arial, sans-serif');
  });

  it('is case- and quote-insensitive on the primary name', () => {
    expect(resolvePhysicalFamily('"CAMBRIA", serif')).toBe('Caladea, serif');
    expect(resolvePhysicalFamily('courier new')).toBe('Liberation Mono');
  });

  it('passes through a family with no known substitute', () => {
    expect(resolvePhysicalFamily('Verdana, sans-serif')).toBe('Verdana, sans-serif');
    expect(resolveFontFamily('Verdana')).toEqual({
      logicalFamily: 'Verdana',
      physicalFamily: 'Verdana',
      reason: 'as_requested',
    });
    // Aptos/Georgia have no clean clone yet -> not mapped.
    expect(resolvePhysicalFamily('Aptos')).toBe('Aptos');
    expect(resolvePhysicalFamily('Georgia')).toBe('Georgia');
  });

  it('reports the substitution reason + preserves the logical family', () => {
    expect(resolveFontFamily('Cambria')).toEqual({
      logicalFamily: 'Cambria',
      physicalFamily: 'Caladea',
      reason: 'bundled_substitute',
    });
    expect(resolveFontFamily('Calibri, sans-serif').logicalFamily).toBe('Calibri, sans-serif');
  });

  it('extracts the bare physical face the gate must await', () => {
    expect(resolvePrimaryPhysicalFamily('Arial, sans-serif')).toBe('Liberation Sans');
    expect(resolvePrimaryPhysicalFamily('Verdana, sans-serif')).toBe('Verdana');
  });

  it('resolvePhysicalFamilies dedupes to the loadable face names', () => {
    expect(resolvePhysicalFamilies(['Calibri, sans-serif', 'Cambria', 'Calibri', 'Verdana']).sort()).toEqual([
      'Caladea',
      'Carlito',
      'Verdana',
    ]);
  });
});

describe('FontResolver (per-document context)', () => {
  it('is seeded with the bundled clean-clone map', () => {
    const resolver = createFontResolver();
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito');
    expect(resolver.resolvePhysicalFamily('Arial, sans-serif')).toBe('Liberation Sans, sans-serif');
    expect(resolver.version).toBe(0);
  });

  it('map() overrides the bundled default and reports custom_mapping', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia, serif')).toBe('Gelasio');
    expect(resolver.resolveFontFamily('Georgia')).toEqual({
      logicalFamily: 'Georgia',
      physicalFamily: 'Gelasio',
      reason: 'custom_mapping',
    });
    // An override beats the bundled map for the same logical family.
    resolver.map('Calibri', 'MyCalibri');
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('MyCalibri');
  });

  it('version bumps on each distinct mapping change, not on no-ops', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    expect(resolver.version).toBe(1);
    resolver.map('Georgia', 'Gelasio'); // same -> no bump
    expect(resolver.version).toBe(1);
    resolver.unmap('Georgia');
    expect(resolver.version).toBe(2);
    resolver.unmap('Georgia'); // absent -> no bump
    expect(resolver.version).toBe(2);
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia'); // reverted to identity
  });

  it('mapping a family to its DEFAULT physical drops any override instead of recording a redundant one', () => {
    const resolver = createFontResolver();

    // Override away from the bundled default, then map back TO the bundled default.
    resolver.map('Calibri', 'Tinos');
    expect(resolver.version).toBe(1);
    expect(resolver.signature).not.toBe('');
    resolver.map('Calibri', 'Carlito'); // Carlito IS Calibri's bundled default
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito');
    expect(resolver.version).toBe(2); // removing the override is a real change
    expect(resolver.signature).toBe(''); // back to the shared default, not '[["calibri","Carlito"]]'

    // Mapping to the default with no existing override is a pure no-op (no bump, no signature).
    resolver.map('Cambria', 'Caladea'); // Caladea IS Cambria's bundled default
    expect(resolver.version).toBe(2);
    expect(resolver.signature).toBe('');

    // Identity: mapping a non-substituted family to its own name is also a no-op.
    resolver.map('Georgia', 'Georgia');
    expect(resolver.version).toBe(2);
    expect(resolver.signature).toBe('');
  });

  it('isolates mappings per instance: two documents map the same logical family differently', () => {
    const docA = createFontResolver();
    const docB = createFontResolver();
    docA.map('Georgia', 'Gelasio');
    docB.map('Georgia', 'Tinos');

    expect(docA.resolvePrimaryPhysicalFamily('Georgia')).toBe('Gelasio');
    expect(docB.resolvePrimaryPhysicalFamily('Georgia')).toBe('Tinos');
    // A document with no override still gets the bundled default, unaffected by the others.
    expect(createFontResolver().resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia');
    expect(docA.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito'); // bundled map intact
  });

  it('signature is stable, order-independent, and distinguishes different mappings at the same version', () => {
    const empty = createFontResolver();
    expect(empty.signature).toBe(''); // default docs share cache safely

    const docA = createFontResolver();
    docA.map('Georgia', 'Gelasio');
    const docB = createFontResolver();
    docB.map('Georgia', 'Tinos');
    // Same version (1), DIFFERENT mappings -> signatures MUST differ (else measure/paint collide).
    expect(docA.version).toBe(docB.version);
    expect(docA.signature).not.toBe(docB.signature);

    // Order-independent: the same set of mappings yields the same signature regardless of insertion order.
    const x = createFontResolver();
    x.map('Georgia', 'Gelasio');
    x.map('Arial', 'MyArial');
    const y = createFontResolver();
    y.map('Arial', 'MyArial');
    y.map('Georgia', 'Gelasio');
    expect(x.signature).toBe(y.signature);

    // Identical mapping -> identical signature (safe cross-document cache sharing).
    const z = createFontResolver();
    z.map('Georgia', 'Gelasio');
    expect(z.signature).toBe(docA.signature);
  });

  it('reset() drops all overrides (document swap) and reverts to the bundled-only map', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    resolver.map('Calibri', 'MyCalibri');
    expect(resolver.signature).not.toBe('');

    resolver.reset();
    expect(resolver.signature).toBe(''); // back to default identity
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia'); // override gone
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito'); // bundled default restored
    expect(resolver.version).toBe(3); // 2 maps + 1 reset

    const before = resolver.version;
    resolver.reset(); // already empty -> no-op, no version bump
    expect(resolver.version).toBe(before);
  });

  it('signature returns to empty after map()+unmap() and converges regardless of add/remove order', () => {
    const resolver = createFontResolver();

    // map then unmap the SAME family -> signature reverts to '' (the memoized signature MUST
    // invalidate on unmap, not serve a stale non-empty value). Cross-render measure reuse depends
    // on this reversibility.
    resolver.map('Georgia', 'Gelasio');
    expect(resolver.signature).not.toBe('');
    resolver.unmap('Georgia');
    expect(resolver.signature).toBe('');

    // Two maps, unmapped in REVERSE order, fully revert to ''.
    resolver.map('Calibri', 'Carlito');
    resolver.map('Cambria', 'Caladea');
    expect(resolver.signature).not.toBe('');
    resolver.unmap('Cambria');
    resolver.unmap('Calibri');
    expect(resolver.signature).toBe('');

    // Order-independent: reaching the same {Georgia, Calibri} mapping set via different add/remove
    // paths converges to ONE signature, so two documents that arrived differently still share cache.
    const viaForward = createFontResolver();
    viaForward.map('Georgia', 'Gelasio');
    viaForward.map('Calibri', 'Carlito');

    const viaDetour = createFontResolver();
    viaDetour.map('Calibri', 'WrongFont');
    viaDetour.map('Georgia', 'Gelasio');
    viaDetour.unmap('Calibri');
    viaDetour.map('Calibri', 'Carlito');

    expect(viaDetour.signature).toBe(viaForward.signature);
  });

  it('trims the physical family and ignores empty/whitespace mappings', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', '  Gelasio  ');
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Gelasio'); // trimmed
    expect(resolver.version).toBe(1);
    resolver.map('Georgia', 'Gelasio'); // same after trim -> no bump
    expect(resolver.version).toBe(1);
    resolver.map('Tahoma', '   '); // whitespace-only physical -> ignored
    expect(resolver.resolvePrimaryPhysicalFamily('Tahoma')).toBe('Tahoma');
    expect(resolver.version).toBe(1);
  });
});

describe('face-aware resolution (resolveFace / resolvePhysicalFamilyForFace)', () => {
  const allFaces = () => true;
  const regularOnly = (_f: string, w: '400' | '700', s: 'normal' | 'italic') => w === '400' && s === 'normal';
  const noFaces = () => false;
  const FACES = [
    { weight: '400', style: 'normal' },
    { weight: '700', style: 'normal' },
    { weight: '400', style: 'italic' },
    { weight: '700', style: 'italic' },
  ] as const;

  it('four-face clones substitute on EVERY face (unchanged vs family-level)', () => {
    const r = createFontResolver();
    for (const face of FACES) {
      expect(r.resolveFace('Calibri', face, allFaces)).toEqual({
        logicalFamily: 'Calibri',
        physicalFamily: 'Carlito',
        reason: 'bundled_substitute',
      });
      expect(r.resolvePhysicalFamilyForFace('Calibri, sans-serif', face, allFaces)).toBe('Carlito, sans-serif');
    }
  });

  it('single-face substitute: maps the provided face, passes other faces through (fallback_face_absent)', () => {
    const r = createFontResolver();
    r.map('Georgia', 'Gelasio'); // a single-face clone, Regular-only registered (regularOnly)
    expect(r.resolveFace('Georgia', { weight: '400', style: 'normal' }, regularOnly)).toEqual({
      logicalFamily: 'Georgia',
      physicalFamily: 'Gelasio',
      reason: 'custom_mapping',
    });
    // Bold/italic: substitute lacks the face -> pass the LOGICAL family through, reported non-metric.
    expect(r.resolveFace('Georgia', { weight: '700', style: 'normal' }, regularOnly)).toEqual({
      logicalFamily: 'Georgia',
      physicalFamily: 'Georgia',
      reason: 'fallback_face_absent',
    });
    expect(r.resolveFace('Georgia', { weight: '400', style: 'italic' }, regularOnly).reason).toBe(
      'fallback_face_absent',
    );
    // CSS-stack variant: substitute only the present face; return the value UNCHANGED for an absent
    // face (so the painter never faux-styles the substitute's Regular).
    expect(r.resolvePhysicalFamilyForFace('Georgia, serif', { weight: '400', style: 'normal' }, regularOnly)).toBe(
      'Gelasio, serif',
    );
    expect(r.resolvePhysicalFamilyForFace('Georgia, serif', { weight: '700', style: 'normal' }, regularOnly)).toBe(
      'Georgia, serif',
    );
  });

  it('map to an UNREGISTERED physical family passes through (fallback_face_absent), never faux-styled', () => {
    const r = createFontResolver();
    r.map('Georgia', 'Some System Font'); // not bundled, not added via fonts.add() -> hasFace false
    expect(r.resolveFace('Georgia', { weight: '400', style: 'normal' }, noFaces)).toEqual({
      logicalFamily: 'Georgia',
      physicalFamily: 'Georgia',
      reason: 'fallback_face_absent',
    });
    expect(r.resolvePhysicalFamilyForFace('Georgia', { weight: '400', style: 'normal' }, noFaces)).toBe('Georgia');
  });

  it('an unmapped family with no substitute is as_requested regardless of hasFace', () => {
    const r = createFontResolver();
    expect(r.resolveFace('Aptos', { weight: '400', style: 'normal' }, noFaces)).toEqual({
      logicalFamily: 'Aptos',
      physicalFamily: 'Aptos',
      reason: 'as_requested',
    });
  });
});
