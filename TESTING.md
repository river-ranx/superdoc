# Testing Guide

How to verify your changes before pushing.

## Quick Reference

| What to verify | Command | Speed | CI Gate |
|---|---|---|---|
| Logic works? | `pnpm test` | ~30s | Hard |
| Document API smoke? | `pnpm test:document-api-smoke` | ~1 min | Hard |
| Editing works? | `pnpm test:behavior` | ~3 min | Hard |
| Public surface? | `pnpm check:public` | ~5 min | Hard |

## Unit Tests

Test pure logic — data transformations, algorithms, style resolution, layout math.

```bash
pnpm test                 # all packages
pnpm test:editor          # super-editor only
pnpm --filter <pkg> test  # specific package
```

Tests are co-located with source code as `feature.test.ts` next to `feature.ts`. Framework: Vitest.

## Document API Smoke

SuperDoc keeps only low-detail Document API guardrails in this repo:

```bash
pnpm test:document-api-smoke
```

That smoke suite checks representative namespace/method presence and a
small SDK open/read/mutate/save/reopen workflow.

## Behavior Tests

Test editing interactions through a real browser — typing, formatting, tables, comments, tracked changes, clipboard, toolbar.

```bash
pnpm test:behavior                        # all browsers, headless
pnpm test:behavior -- --project=chromium  # single browser
pnpm test:behavior:headed                 # watch the browser
pnpm test:behavior:ui                     # Playwright UI mode
```

These assert on **document state**, not pixels. Located in `tests/behavior/`. See `tests/behavior/README.md` for writing tests.

**First-time setup:**

```bash
pnpm --filter @superdoc-testing/behavior setup   # install browser binaries
```

## Rendering Checks

The public tree does not expose a pixel-diff command. For rendering changes,
run the relevant unit and behavior suites, then manually compare the affected
`.docx` in Microsoft Word and SuperDoc.

```bash
pnpm test
pnpm test:behavior -- --project=chromium
```

Maintainers may run additional release checks for rendering-sensitive changes.

## Uploading Test Documents

For new `.docx` fixtures, keep the file minimal and place it with the public
test suite that consumes it. For larger reproduction documents, attach the file
to the issue or PR and explain which assertion it should cover.

Avoid adding broad fixture dumps; prefer focused documents that make a specific
behavior or rendering expectation clear.

## When to Run What

| I changed... | Run |
|---|---|
| A utility function or algorithm | `pnpm test` |
| An editing command or extension | `pnpm test` + `pnpm test:behavior` |
| Layout engine or style resolution | `pnpm test` + `pnpm test:behavior` + manual Word comparison |
| DomPainter rendering | `pnpm test` + `pnpm test:behavior` + manual Word comparison |
| PM adapter (data conversion) | `pnpm test` + `pnpm test:behavior` |
| Table rendering or spacing | `pnpm test` + `pnpm test:behavior` + manual Word comparison |
| Super-converter (import/export) | `pnpm test` + `pnpm test:behavior` |

## CI Behavior

| Suite | Runs on PRs | Blocks merge |
|---|---|---|
| Unit tests | Yes | Yes |
| Behavior tests | Yes (sharded across 3 runners) | Yes |
| Public surface checks | Yes | Yes |

## Troubleshooting

**Behavior tests fail with port conflict:**

```bash
node scripts/free-port.mjs 9990
pnpm test:behavior
```

**Want to debug a behavior test visually:**

```bash
pnpm test:behavior:headed                          # see the browser
pnpm test:behavior:ui                              # Playwright inspector
pnpm test:behavior:trace                           # record traces
```
