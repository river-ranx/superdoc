import { test, expect } from '@playwright/test';

/**
 * Smart-tags authoring: clicking a tag chip in the sidebar inserts a matching
 * inline SDT at the caret (dogfoods ui.selection.capture + create.contentControl
 * + ui.contentControls.focus). The inserted field carries the field's tag and
 * the token text, and paints with the same .superdoc-structured-content-inline
 * wrapper the chips are styled to match.
 *
 * Runs only for the contract-templates demo (the shared suite runs once per DEMO).
 */

test('clicking a Smart-tags chip inserts a matching inline SDT at the caret', async ({ page }) => {
  test.skip(process.env.DEMO !== 'contract-templates', 'contract-templates demo only');

  await page.route('**/ingest.superdoc.dev/**', (r) =>
    r.fulfill({ status: 204, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/');
  await page.waitForFunction(
    () => (window as any).__demo?.state?.ui?.contentControls?.getSnapshot()?.items?.length > 0,
    null,
    { timeout: 30_000 },
  );
  await page.waitForSelector('[data-tag-key]');

  // Place a caret in the document body so capture() has an insertion point.
  await page.evaluate(() => {
    (window as any).__demo.superdoc.activeEditor.commands?.setTextSelection?.({ from: 6, to: 6 });
  });

  const key = await page.getAttribute('[data-tag-key]', 'data-tag-key');
  expect(key).toBeTruthy();

  // Count existing controls with this tag, then click the chip and expect one more.
  const tag = JSON.stringify({ kind: 'smartField', key });
  const token = key!.replace(/([A-Z])/g, '_$1').toUpperCase();

  const textsForTag = () =>
    page.evaluate((t) => {
      const ed = (window as any).__demo.superdoc.activeEditor;
      const out: string[] = [];
      ed.state.doc.descendants((node: any) => {
        if (node.type.name === 'structuredContent' && node.attrs?.tag === t) out.push(node.textContent);
        return true;
      });
      return out;
    }, tag);

  const before = await textsForTag();
  await page.click(`[data-tag-key="${key}"]`);

  // A new inline SDT carrying this tag + token text should appear.
  await expect
    .poll(async () => (await textsForTag()).filter((x) => x === token).length, { timeout: 6_000 })
    .toBeGreaterThan(before.filter((x) => x === token).length);
});
