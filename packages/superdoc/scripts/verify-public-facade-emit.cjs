#!/usr/bin/env node
/**
 * SD-3178 (Phase 3 of SD-3175): verify the explicit public facade emits a
 * declaration tree that is safe to ship.
 *
 * Runs as a postbuild step under `packages/superdoc/`. Loads the emitted
 * `dist/superdoc/src/public/index.d.ts` and `index.d.cts` with the
 * TypeScript compiler API and asserts:
 *
 *   1. The expected symbol set is exported from each declaration file.
 *   2. The ESM and CJS declarations agree on the exported names.
 *   3. The command signature surface survives the facade emit. This is
 *      the SD-2965 regression vector: specific command signatures getting
 *      dropped or failing to flow through the facade. `EditorCommands` is
 *      `CoreCommands & ExtensionCommands & AllCommandSignatures & Record<string, AnyCommand>`,
 *      so the trailing `Record<string, AnyCommand>` makes any indexer
 *      lookup resolve even when the specific signatures are missing.
 *      The probe asserts the RETURN TYPE of two commands (`setBold`,
 *      `insertComment`) is `boolean`, not the `AnyCommand` fallback's
 *      `unknown`. Two commands from two signature sources (formatting +
 *      comments) catch partial drops a single-command probe would miss.
 *   4. The emitted declarations contain no private workspace specifiers
 *      (`@superdoc/*`), no package-manager internals (`.pnpm/`), and no
 *      absolute local paths into the repo or `node_modules`.
 *
 *      Note: relative declaration references into the per-package dist
 *      tree (e.g. `../../../super-editor/src/index.js`) are expected at
 *      this phase. The dts pipeline relocates `@superdoc/super-editor`
 *      specifiers into the relocated declaration tree so consumers do
 *      not see the workspace specifier. Later SD-3178 follow-ups reduce
 *      how much the facade depends on that broader declaration graph.
 *
 * Exits non-zero on any failure. Designed to fail loud and early.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const distRoot = path.resolve(__dirname, '..', 'dist');
const FACADE_ESM = path.join(distRoot, 'superdoc', 'src', 'public', 'index.d.ts');
const FACADE_CJS = path.join(distRoot, 'superdoc', 'src', 'public', 'index.d.cts');

const EXPECTED_NAMES = ['Config', 'Editor', 'EditorCommands', 'SuperDoc'].sort();

let ts;
try {
  ts = require('typescript');
} catch (err) {
  console.error('[verify-public-facade-emit] typescript is not available in this package.');
  process.exit(1);
}

function loadFile(file) {
  if (!fs.existsSync(file)) {
    console.error(`[verify-public-facade-emit] missing facade declaration: ${file}`);
    console.error('Run `pnpm --filter superdoc run build` first.');
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
}

function listExportedNames(file) {
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  const checker = program.getTypeChecker();
  const src = program.getSourceFile(file);
  const symbol = checker.getSymbolAtLocation(src) ?? (src && src.symbol);
  if (!symbol) {
    return { names: [], program, checker };
  }
  return {
    names: [...new Set(checker.getExportsOfModule(symbol).map((s) => s.getName()))].sort(),
    program,
    checker,
  };
}

let failed = false;

// (1) Symbol set.
const esm = listExportedNames(FACADE_ESM);
if (JSON.stringify(esm.names) !== JSON.stringify(EXPECTED_NAMES)) {
  console.error(`[verify-public-facade-emit] ESM facade exports drifted.`);
  console.error('  expected: ' + EXPECTED_NAMES.join(', '));
  console.error('  actual:   ' + esm.names.join(', '));
  console.error('  If this addition is intentional, update EXPECTED_NAMES in this script and link');
  console.error('  the PR to SD-3175 (path-as-contract umbrella) for reviewer sign-off.');
  failed = true;
}

// (2) ESM/CJS parity.
const cjs = listExportedNames(FACADE_CJS);
if (JSON.stringify(esm.names) !== JSON.stringify(cjs.names)) {
  const importOnly = esm.names.filter((n) => !cjs.names.includes(n));
  const requireOnly = cjs.names.filter((n) => !esm.names.includes(n));
  console.error('[verify-public-facade-emit] ESM/CJS facade declarations disagree on exports.');
  if (importOnly.length) console.error('  ESM-only:  ' + importOnly.join(', '));
  if (requireOnly.length) console.error('  CJS-only:  ' + requireOnly.join(', '));
  console.error('  Fix the CJS shim generator (packages/superdoc/scripts/ensure-types.cjs).');
  failed = true;
}

// (3) Command signature survival: assert two commands return `boolean`,
//     not the `AnyCommand` fallback. See header for why a bare resolution
//     check is not enough (the `Record<string, AnyCommand>` intersection
//     always satisfies the indexer).
{
  const probe = `
    import type { EditorCommands } from ${JSON.stringify(FACADE_ESM)};
    type ReturnsBoolean<F> = F extends (...args: any[]) => boolean ? true : false;
    // Direct assignment of literal \`true\` to the conditional result. If the
    // signature is missing and the indexer falls back to AnyCommand, the
    // conditional resolves to \`false\` and the assignment fails with TS2322.
    // Casts of the form \`true as Result\` would mask the failure by
    // laundering through \`never\`, so the literal stays un-cast on purpose.
    // setBold comes from FormattingCommandAugmentations.
    const __setBoldOk: ReturnsBoolean<EditorCommands['setBold']> = true;
    void __setBoldOk;
    // insertComment comes from CommentCommands. Two sources catches partial
    // drops a single-command probe would miss.
    const __insertCommentOk: ReturnsBoolean<EditorCommands['insertComment']> = true;
    void __insertCommentOk;
  `;
  const probePath = path.join(distRoot, '__public-facade-command-signature-probe.ts');
  fs.writeFileSync(probePath, probe, 'utf8');
  try {
    const program = ts.createProgram({
      rootNames: [probePath],
      options: {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
    });
    const diagnostics = [
      ...program.getSemanticDiagnostics(),
      ...program.getDeclarationDiagnostics(),
    ];
    if (diagnostics.length > 0) {
      console.error('[verify-public-facade-emit] command signature probe failed.');
      console.error('  A command (setBold or insertComment) does not return `boolean` through the facade.');
      console.error('  This is the SD-2965 regression vector: specific command signatures were dropped or failed to flow through the facade, and EditorCommands fell back to the `AnyCommand` indexer.');
      for (const d of diagnostics) {
        const msg = typeof d.messageText === 'string'
          ? d.messageText
          : ts.flattenDiagnosticMessageText(d.messageText, '\n');
        console.error('  - ' + msg);
      }
      failed = true;
    }
  } finally {
    try { fs.unlinkSync(probePath); } catch (_) {}
  }
}

// (4) No internal leaks in emitted code (strip JSDoc/line comments first so
// that comments referencing `@superdoc/super-editor` in prose are not flagged).
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const LEAK_PATTERNS = [
  { name: 'private workspace specifier', re: /(?:from\s+['"]|require\(['"])@superdoc\//g },
  { name: 'pnpm internal path', re: /\.pnpm\//g },
  { name: 'absolute source path', re: /['"][\/\\][^'"\n]*\/(packages|node_modules)\//g },
];

for (const file of [FACADE_ESM, FACADE_CJS]) {
  const code = stripComments(loadFile(file));
  for (const pattern of LEAK_PATTERNS) {
    const matches = code.match(pattern.re);
    if (matches && matches.length > 0) {
      console.error(`[verify-public-facade-emit] leak in ${path.relative(repoRoot, file)}:`);
      console.error(`  ${pattern.name}: ${matches.slice(0, 5).join(', ')}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('');
  console.error('[verify-public-facade-emit] FAILED. The public facade emit is not safe to advance.');
  process.exit(1);
}

console.log(`[verify-public-facade-emit] OK. Facade emits cleanly: ${esm.names.length} exports, ESM/CJS in parity, command signatures survive.`);
