#!/usr/bin/env node
/**
 * SD-3256 Phase 1: single command to validate the public type contract.
 *
 * Runs the validators that, together, answer "is the published
 * superdoc package's public TypeScript surface healthy?" Today these
 * run as three separate invocations across CI:
 *
 *   pnpm run build:superdoc
 *     # vite build + the postbuild validator chain
 *     # (check-tsconfig-type-surface, ensure-types, audit-bundle,
 *     #  audit-declarations, check-export-coverage,
 *     #  verify-public-facade-emit, report-declaration-reachability)
 *
 *   node tests/consumer-typecheck/deep-type-audit.mjs --pack --strict-supported-root
 *     # strict gate on the supported public surface; must be 0 findings
 *
 *   node tests/consumer-typecheck/typecheck-matrix.mjs
 *     # consumer-perspective scenarios compiled against the packed tarball
 *
 * This wrapper orchestrates them in order, prints section headers,
 * fails fast on the first failure, and gives an at-a-glance verdict.
 * Zero behavior change for the validators themselves; this is pure DX.
 *
 * Usage:
 *   pnpm check:public-contract
 *
 * Tracking: SD-3256 (umbrella). Phase 1.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const stages = [
  {
    name: 'build:superdoc',
    cwd: REPO_ROOT,
    cmd: 'pnpm',
    args: ['run', 'build:superdoc'],
    blurb:
      'Build dist + run postbuild validators (audit-bundle, audit-declarations, ' +
      'check-export-coverage, verify-public-facade-emit, ensure-types, ...).',
  },
  {
    name: 'deep-type-audit --strict-supported-root',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['deep-type-audit.mjs', '--pack', '--strict-supported-root'],
    blurb: 'Strict gate on the supported-root public surface (must be 0 findings).',
  },
  {
    name: 'typecheck-matrix',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['typecheck-matrix.mjs'],
    blurb: 'Consumer-perspective scenarios against the packed tarball.',
  },
];

const HR = '='.repeat(72);
const start = Date.now();

let failed = null;
for (const [i, s] of stages.entries()) {
  console.log('');
  console.log(HR);
  console.log(`[${i + 1}/${stages.length}] ${s.name}`);
  console.log(s.blurb);
  console.log(HR);
  const result = spawnSync(s.cmd, s.args, { cwd: s.cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    failed = { stage: s.name, status: result.status ?? 1 };
    break;
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log('');
console.log(HR);
if (failed) {
  console.log(`FAIL: stage "${failed.stage}" exited ${failed.status} (after ${elapsed}s)`);
  console.log('');
  console.log('Re-run the failing stage directly to iterate:');
  const failedStage = stages.find((s) => s.name === failed.stage);
  console.log(`  cd ${failedStage.cwd}`);
  console.log(`  ${failedStage.cmd} ${failedStage.args.join(' ')}`);
  process.exit(failed.status);
} else {
  console.log(`PASS: ${stages.length} stages, ${elapsed}s`);
}
