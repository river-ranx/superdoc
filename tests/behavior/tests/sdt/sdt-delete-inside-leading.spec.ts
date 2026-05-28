import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, type SuperDocFixture } from '../../fixtures/superdoc.js';
import { getInlineSdtRange, getInlineSdtSnapshot, type InlineSdtRange } from '../../helpers/sdt.js';

/**
 * Delete with the caret at the inline SDT leading edge, INSIDE the content -
 * the front-of-content mirror of sdt-backspace-inside-trailing.
 *
 * Expected behavior from the word-api parity contract
 *   sdt/inline-delete-inside-leading, Word 16.0
 * Editable modes delete a character per press (content shrinks from the front,
 * wrapper kept); content-locked modes are blocked (content unchanged).
 */

test.use({ config: { toolbar: 'full', showSelection: true } });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = {
  unlocked: path.resolve(DIR, 'fixtures/sd3237-inline-unlocked.docx'),
  sdtLocked: path.resolve(DIR, 'fixtures/sd3218-inline-sdtLocked.docx'),
  contentLocked: path.resolve(DIR, 'fixtures/sd3237-inline-contentlocked.docx'),
  sdtContentLocked: path.resolve(DIR, 'fixtures/sd3218-inline-sdtContentLocked.docx'),
} as const;

async function setupInsideLeading(superdoc: SuperDocFixture, fixture: string): Promise<InlineSdtRange> {
  await superdoc.loadDocument(fixture);
  await superdoc.waitForStable();
  const sdt = await getInlineSdtRange(superdoc.page);
  expect(sdt).not.toBeNull();
  await superdoc.setTextSelection(sdt!.start); // first position inside the content
  await superdoc.page.evaluate(() => (window as any).editor.view.focus());
  await superdoc.waitForStable();
  return sdt!;
}

async function pressN(superdoc: SuperDocFixture, key: string, n: number) {
  for (let i = 0; i < n; i++) {
    await superdoc.press(key);
    await superdoc.waitForStable();
  }
}

test.describe('SDT Delete inside the leading edge - Word parity', () => {
  // Contract: sdt/inline-delete-inside-leading, Word 16.0

  for (const mode of ['unlocked', 'sdtLocked'] as const) {
    test(`${mode}: each Delete removes one character from the front; wrapper preserved`, async ({ superdoc }) => {
      const sdt = await setupInsideLeading(superdoc, FIXTURE[mode]);
      const original = sdt.content;
      await pressN(superdoc, 'Delete', 3);
      const s = await getInlineSdtSnapshot(superdoc.page, sdt.id);
      expect(s.sdtExists).toBe(true);
      expect(s.empty).toBe(true);
      expect(s.sdtContent!.length).toBe(original.length - 3); // three chars gone from the front
      expect(original.endsWith(s.sdtContent!)).toBe(true); // deleted from the leading edge
    });
  }

  for (const mode of ['contentLocked', 'sdtContentLocked'] as const) {
    test(`${mode}: Delete is blocked; content unchanged`, async ({ superdoc }) => {
      const sdt = await setupInsideLeading(superdoc, FIXTURE[mode]);
      const original = sdt.content;
      await pressN(superdoc, 'Delete', 3);
      const s = await getInlineSdtSnapshot(superdoc.page, sdt.id);
      expect(s.sdtExists).toBe(true);
      expect(s.sdtContent).toBe(original); // blocked: nothing deleted
    });
  }
});
