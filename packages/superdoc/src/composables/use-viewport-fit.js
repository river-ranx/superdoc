import { onBeforeUnmount, nextTick, watch } from 'vue';
import { DOCX } from '@superdoc/common';

const CSS_PX_PER_INCH = 96;
const SIDEBAR_SELECTOR = '.superdoc__right-sidebar';
const PDF_PAGE_SELECTOR = '.sd-pdf-viewer-page';

export const FIT_WIDTH_DEFAULTS = Object.freeze({
  min: 10,
  max: 100,
  padding: 0,
});

// Normalize `config.zoom.fitWidth` into a complete options object. The mode
// (`config.zoom.mode` / `setZoomMode`) decides whether the policy applies;
// these are only its bounds. Invalid field values fall back to defaults;
// min/max are reordered if swapped.
export const resolveFitWidthOptions = (rawFitConfig) => {
  const raw = rawFitConfig && typeof rawFitConfig === 'object' ? rawFitConfig : {};
  const positiveOr = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const min = positiveOr(raw.min, FIT_WIDTH_DEFAULTS.min);
  const max = positiveOr(raw.max, FIT_WIDTH_DEFAULTS.max);
  const padding =
    typeof raw.padding === 'number' && Number.isFinite(raw.padding) && raw.padding >= 0
      ? raw.padding
      : FIT_WIDTH_DEFAULTS.padding;

  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    padding,
  };
};

// Unclamped zoom percentage that fits `documentWidth` into `availableWidth`.
export const computeFitZoom = (availableWidth, documentWidth) => {
  if (!(availableWidth > 0) || !(documentWidth > 0)) return null;
  return Math.round((availableWidth / documentWidth) * 100);
};

// Applied zoom for the fit-width policy: padding reserved, then clamped.
export const computeAppliedFitZoom = (availableWidth, documentWidth, options) => {
  const padded = computeFitZoom(availableWidth - options.padding, documentWidth);
  if (padded === null) return null;
  return Math.round(Math.min(options.max, Math.max(options.min, padded)));
};

/**
 * Viewport fit tracking. Maintains pure viewport metrics (available width,
 * document base width, fit zoom), stores them for `getViewportMetrics()`,
 * emits `viewport-change` when they change, and applies the `fit-width`
 * policy while `zoomMode` is `'fit-width'`.
 *
 * Metrics are policy-free measurements: `availableWidth` is the container
 * width minus the comments sidebar when visible; `fitZoom` is the raw
 * available/document ratio. The fit policy (and only the policy) accounts
 * for `config.zoom.fitWidth` padding and clamping.
 *
 * The base page width is re-resolved on every evaluation (never latched)
 * and is the widest measurable page across all loaded documents: DOCX
 * widths come from page styles (zoom-independent, so a zoom applied
 * before the first measurement cannot corrupt the ratio), PDF widths from
 * rendered pages normalized by their actual scale factor. HTML documents
 * reflow and contribute nothing; an HTML-only instance reports no
 * metrics. A zoom-normalized DOM measurement is the last-resort fallback
 * for a DOCX editor without page styles.
 *
 * The fit application writes the zoom state directly instead of calling
 * `setZoom()`, which by contract switches the mode to `manual`.
 *
 * Must be called inside a component `setup()` (registers watchers and an
 * unmount hook).
 */
export function useViewportFit({
  getSuperdoc,
  superdocContainerWidth,
  isReady,
  activeZoom,
  zoomMode,
  viewportMetrics,
  showCommentsSidebar,
  superdocRoot,
  documents,
}) {
  // Page width in CSS px at 100% zoom for one DOCX editor, from its page
  // styles (zoom-independent), or null when unavailable.
  const resolveEditorPageWidth = (editor) => {
    if (!editor) return null;
    let pageStyles = null;
    try {
      pageStyles = editor.getPageStyles?.() ?? null;
    } catch {
      pageStyles = null;
    }
    const pageWidthInches = pageStyles?.pageSize?.width;
    if (typeof pageWidthInches === 'number' && Number.isFinite(pageWidthInches) && pageWidthInches > 0) {
      return pageWidthInches * CSS_PX_PER_INCH;
    }
    return null;
  };

  // Widest rendered PDF page in CSS px at 100% zoom. PDF pages size via
  // `calc(var(--scale-factor) * <pt>px)` where the scale factor is the
  // viewer zoom times the pt-to-CSS-px conversion (96/72). Dividing the
  // measured width by the page's actual rendered scale factor yields PDF
  // points regardless of zoom-sync state; multiplying by 96/72 converts
  // back to the CSS width at 100% zoom (verified: a 612pt letter page
  // renders 816 CSS px at 100%).
  const resolvePdfPageWidth = () => {
    const root = superdocRoot.value;
    if (!root?.querySelectorAll) return null;
    const PDF_POINTS_TO_CSS_PX = 96 / 72;
    let widest = 0;
    for (const page of root.querySelectorAll(PDF_PAGE_SELECTOR)) {
      const measured = Number(page.clientWidth) || Number(page.getBoundingClientRect?.().width) || 0;
      if (!(measured > 0)) continue;
      let scaleFactor = NaN;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        scaleFactor = Number.parseFloat(window.getComputedStyle(page).getPropertyValue('--scale-factor'));
      }
      let normalized;
      if (Number.isFinite(scaleFactor) && scaleFactor > 0) {
        normalized = (measured / scaleFactor) * PDF_POINTS_TO_CSS_PX;
      } else {
        // No scale-factor var: assume the viewer is synced to the global
        // zoom and divide that out instead.
        const zoomFactor = (activeZoom.value ?? 100) / 100;
        normalized = zoomFactor > 0 ? measured / zoomFactor : measured;
      }
      if (normalized > widest) widest = normalized;
    }
    return widest > 0 ? widest : null;
  };

  // Widest measurable document width at 100% zoom across all loaded
  // documents. Zoom is global, so the fit must target the widest page:
  // otherwise one landscape or PDF document overflows while another fits.
  // HTML documents reflow to the container and contribute no fixed width.
  const resolveBaseDocumentWidth = () => {
    const superdoc = getSuperdoc();
    if (!superdoc) return null;
    const widths = [];

    const docs = documents?.value ?? [];
    for (const doc of docs) {
      if (doc?.type !== DOCX) continue;
      const width = resolveEditorPageWidth(doc.getEditor?.());
      if (width !== null) widths.push(width);
    }
    // Store shims in tests (and transitional states) may not expose
    // per-document editors; fall back to the active editor's page styles.
    if (widths.length === 0) {
      const width = resolveEditorPageWidth(superdoc.activeEditor);
      if (width !== null) widths.push(width);
    }

    const pdfWidth = resolvePdfPageWidth();
    if (pdfWidth !== null) widths.push(pdfWidth);

    if (widths.length > 0) return Math.max(...widths);

    // Last resort for a DOCX editor without page styles: the rendered
    // document element, normalized by zoom. Gated on an editor existing;
    // before editor mount the element is shell scaffolding whose width is
    // container-derived, which would produce a garbage base.
    if (superdoc.activeEditor) {
      const docEl = superdocRoot.value?.querySelector?.('.superdoc__document');
      const measured = Number(docEl?.clientWidth) || Number(docEl?.getBoundingClientRect?.().width) || 0;
      if (measured > 0) {
        const zoomFactor = (activeZoom.value ?? 100) / 100;
        return zoomFactor > 0 ? measured / zoomFactor : measured;
      }
    }

    return null;
  };

  // Width the comments sidebar takes from the container when visible.
  const resolveSidebarWidth = () => {
    if (!showCommentsSidebar?.value) return 0;
    const sidebarEl = superdocRoot.value?.querySelector?.(SIDEBAR_SELECTOR);
    const measured = Number(sidebarEl?.offsetWidth) || Number(sidebarEl?.getBoundingClientRect?.().width) || 0;
    return measured > 0 ? measured : 0;
  };

  const applyFitWidth = (superdoc, metrics) => {
    const options = resolveFitWidthOptions(superdoc.config?.zoom?.fitWidth);
    const target = computeAppliedFitZoom(metrics.availableWidth, metrics.documentWidth, options);
    if (target === null) return;
    // Same-value guard: applying the fit re-triggers viewport evaluation
    // through the render pipeline; skipping no-op zooms is what terminates
    // that cycle (the base width is zoom-independent, so the recomputed
    // target is stable).
    if (target === activeZoom.value) return;
    // Write the zoom state directly: setZoom() would flip the mode to
    // manual. The activeZoom watcher in SuperDoc.vue propagates the value
    // to all presentation surfaces exactly as setZoom() does.
    activeZoom.value = target;
    superdoc.emit('zoomChange', { zoom: target, mode: 'fit-width' });
  };

  const evaluateViewport = () => {
    const superdoc = getSuperdoc();
    if (!superdoc) return;

    const containerWidth = superdocContainerWidth.value;
    if (!(containerWidth > 0)) return;
    if (!isReady.value) return;

    const documentWidth = resolveBaseDocumentWidth();
    // No measurable document yet (editors still mounting): skip instead of
    // storing a guessed width; the editorCreate/pagination hooks re-run this.
    if (documentWidth === null) return;

    const availableWidth = containerWidth - resolveSidebarWidth();
    const fitZoom = computeFitZoom(availableWidth, documentWidth);
    if (fitZoom === null) return;

    const metrics = { availableWidth, documentWidth, fitZoom };

    // Store and emit when the measurements change, including base-width
    // changes (page size or orientation) at a constant available width.
    const previous = viewportMetrics.value;
    const changed =
      !previous ||
      previous.fitZoom !== fitZoom ||
      Math.round(previous.documentWidth) !== Math.round(documentWidth) ||
      Math.round(previous.availableWidth) !== Math.round(availableWidth);
    if (changed) {
      viewportMetrics.value = metrics;
      superdoc.emit('viewport-change', metrics);
    }

    // The fit policy re-applies on every evaluation while in fit-width mode.
    // That is safe: leaving the mode requires setZoom()/setZoomMode(), and
    // the same-value guard makes repeat applications no-ops.
    if (zoomMode.value === 'fit-width') {
      applyFitWidth(superdoc, metrics);
    }
  };

  watch(superdocContainerWidth, evaluateViewport);
  watch(isReady, (ready) => {
    if (ready) evaluateViewport();
  });
  // Entering fit-width applies the fit immediately; the sidebar changes the
  // available width without resizing the observed container, so re-measure
  // after it mounts/unmounts.
  watch(zoomMode, (mode) => {
    if (mode === 'fit-width') evaluateViewport();
  });
  if (showCommentsSidebar) {
    watch(showCommentsSidebar, () => {
      nextTick(() => evaluateViewport());
    });
  }

  // Editors mount after store readiness, and page geometry can change
  // without a container resize (orientation, margins, document swap).
  // Re-evaluate on the editor lifecycle signals that change the base width.
  const handleEditorCreate = () => {
    nextTick(() => evaluateViewport());
  };
  const handlePaginationUpdate = () => {
    evaluateViewport();
  };
  const handlePdfDocumentReady = () => {
    nextTick(() => evaluateViewport());
  };

  const superdocAtSetup = getSuperdoc();
  superdocAtSetup?.on?.('editorCreate', handleEditorCreate);
  superdocAtSetup?.on?.('pagination-update', handlePaginationUpdate);
  superdocAtSetup?.on?.('pdf:document-ready', handlePdfDocumentReady);
  onBeforeUnmount(() => {
    superdocAtSetup?.off?.('editorCreate', handleEditorCreate);
    superdocAtSetup?.off?.('pagination-update', handlePaginationUpdate);
    superdocAtSetup?.off?.('pdf:document-ready', handlePdfDocumentReady);
  });

  return { evaluateViewport };
}
