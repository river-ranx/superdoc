import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '../../core/Editor.js';
import { COMMAND_CATALOG, type StoryLocator } from '@superdoc/document-api';

const mocks = vi.hoisted(() => ({
  checkRevision: vi.fn(),
  getRevision: vi.fn(() => '0'),
  executeDomainCommand: vi.fn(),
  resolveTrackedChangeInStory: vi.fn(),
  getTrackedChangeIndex: vi.fn(),
  resolveStoryRuntime: vi.fn(),
}));

vi.mock('./revision-tracker.js', () => ({
  checkRevision: mocks.checkRevision,
  getRevision: mocks.getRevision,
}));

vi.mock('./plan-wrappers.js', () => ({
  executeDomainCommand: mocks.executeDomainCommand,
}));

vi.mock('../helpers/tracked-change-resolver.js', () => ({
  resolveTrackedChangeInStory: mocks.resolveTrackedChangeInStory,
  resolveTrackedChangeType: vi.fn(() => 'insert'),
}));

vi.mock('../tracked-changes/tracked-change-index.js', () => ({
  getTrackedChangeIndex: mocks.getTrackedChangeIndex,
}));

vi.mock('../story-runtime/resolve-story-runtime.js', () => ({
  resolveStoryRuntime: mocks.resolveStoryRuntime,
}));

import {
  trackChangesAcceptAllWrapper,
  trackChangesAcceptWrapper,
  trackChangesDecideRangeWrapper,
} from './track-changes-wrappers.js';

const footnoteStory: StoryLocator = { kind: 'story', storyType: 'footnote', noteId: '5' };

function expectTrackChangesDecideReceiptCodeDeclared(code: string): void {
  expect(COMMAND_CATALOG['trackChanges.decide'].possibleFailureCodes).toContain(code);
}

function makeEditor(commands: Record<string, unknown> = {}): Editor {
  return {
    commands,
    state: { doc: { textBetween: vi.fn(() => '') } },
  } as unknown as Editor;
}

function makeTextNode(text: string) {
  return {
    type: { name: 'text' },
    attrs: {},
    text,
    nodeSize: text.length,
    isText: true,
    isLeaf: false,
    isBlock: false,
    childCount: 0,
    child: () => {
      throw new Error('text nodes do not have children');
    },
  };
}

function makeInlineWrapper(child: any) {
  return {
    type: { name: 'run' },
    attrs: {},
    nodeSize: child.nodeSize + 2,
    isText: false,
    isLeaf: false,
    isBlock: false,
    childCount: 1,
    child: (index: number) => {
      if (index !== 0) throw new Error('run child out of range');
      return child;
    },
  };
}

function makeParagraphNode(attrs: Record<string, unknown>, child: any = makeTextNode('abcdef')) {
  return {
    type: { name: 'paragraph' },
    attrs,
    nodeSize: child.nodeSize + 2,
    isText: false,
    isLeaf: false,
    isBlock: true,
    childCount: 1,
    child: (index: number) => {
      if (index !== 0) throw new Error('paragraph child out of range');
      return child;
    },
  };
}

function makeRangeDecisionEditor(
  commands: Record<string, unknown>,
  block = makeParagraphNode({ sdBlockId: 'p1' }),
  blockPos = 5,
): Editor {
  return {
    options: { trackedChanges: {} },
    commands,
    state: {
      doc: {
        descendants: (fn: (node: unknown, pos: number) => void | boolean) => {
          fn(block, blockPos);
        },
      },
    },
  } as unknown as Editor;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRevision.mockReturnValue('0');
  mocks.executeDomainCommand.mockReturnValue({ steps: [{ effect: 'changed' }] });
  mocks.getTrackedChangeIndex.mockReturnValue({
    get: vi.fn(() => []),
    getAll: vi.fn(() => []),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    subscribe: vi.fn(),
    dispose: vi.fn(),
  });
});

describe('track-changes-wrappers revision guard', () => {
  it('checks expectedRevision on the host editor before accepting a non-body tracked change', () => {
    const hostEditor = makeEditor();
    const storyEditor = makeEditor({ acceptTrackedChangeById: vi.fn(() => true) });
    const commit = vi.fn();
    const index = {
      get: vi.fn(() => []),
      getAll: vi.fn(() => []),
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
    };

    mocks.resolveTrackedChangeInStory.mockReturnValue({
      editor: storyEditor,
      story: footnoteStory,
      runtimeRef: { storyKey: 'fn:5', rawId: 'raw-1' },
      change: {
        id: 'canon-1',
        rawId: 'raw-1',
        from: 1,
        to: 2,
        attrs: {},
      },
      commit,
    });
    mocks.getTrackedChangeIndex.mockReturnValue(index);

    const receipt = trackChangesAcceptWrapper(
      hostEditor,
      { id: 'canon-1', story: footnoteStory },
      { expectedRevision: '12' },
    );

    expect(receipt).toEqual({ success: true });
    expect(mocks.checkRevision).toHaveBeenCalledWith(hostEditor, '12');
    expect(mocks.executeDomainCommand).toHaveBeenCalledWith(storyEditor, expect.any(Function));
    expect(commit).toHaveBeenCalledWith(hostEditor);
    expect(index.invalidate).toHaveBeenCalledWith(footnoteStory);
  });

  it('preserves typed overlap decision failures for by-id document-api calls', () => {
    const hostEditor = makeEditor();
    const storyEditor = {
      ...makeEditor({ acceptTrackedChangeById: vi.fn(() => false) }),
      storage: {
        trackChanges: {
          lastDecisionFailure: {
            code: 'PERMISSION_DENIED',
            message: 'permission denied for accept of change "canon-1".',
            details: { changeId: 'canon-1' },
          },
        },
      },
    } as unknown as Editor;

    mocks.resolveTrackedChangeInStory.mockReturnValue({
      editor: storyEditor,
      story: footnoteStory,
      runtimeRef: { storyKey: 'fn:5', rawId: 'raw-1' },
      change: {
        id: 'canon-1',
        rawId: 'raw-1',
        from: 1,
        to: 2,
        attrs: {},
      },
    });
    mocks.executeDomainCommand.mockReturnValue({ steps: [{ effect: 'unchanged' }] });

    const receipt = trackChangesAcceptWrapper(hostEditor, { id: 'canon-1', story: footnoteStory });

    expect(receipt).toEqual({
      success: false,
      failure: {
        code: 'PERMISSION_DENIED',
        message: 'permission denied for accept of change "canon-1".',
        details: { changeId: 'canon-1' },
      },
    });
  });

  it('checks expectedRevision once on the host editor for accept-all across multiple stories', () => {
    const hostEditor = makeEditor();
    const bodyEditor = makeEditor({ acceptAllTrackedChanges: vi.fn(() => true) });
    const footnoteEditor = makeEditor({ acceptAllTrackedChanges: vi.fn(() => true) });
    const bodyCommit = vi.fn();
    const footnoteCommit = vi.fn();

    const bodyStory = { kind: 'story', storyType: 'body' } as const;
    const snapshots = [
      {
        story: bodyStory,
        runtimeRef: { storyKey: 'body', rawId: 'raw-body' },
      },
      {
        story: footnoteStory,
        runtimeRef: { storyKey: 'fn:5', rawId: 'raw-fn' },
      },
    ];
    const index = {
      get: vi.fn(() => []),
      getAll: vi.fn(() => snapshots),
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
    };

    mocks.getTrackedChangeIndex.mockReturnValue(index);
    mocks.resolveStoryRuntime.mockImplementation((_host: Editor, story: StoryLocator) => {
      if (story.storyType === 'body') {
        return { editor: bodyEditor, storyKey: 'body', locator: story, kind: 'body', commit: bodyCommit };
      }

      return { editor: footnoteEditor, storyKey: 'fn:5', locator: story, kind: 'note', commit: footnoteCommit };
    });

    const receipt = trackChangesAcceptAllWrapper(hostEditor, {}, { expectedRevision: '33' });

    expect(receipt).toEqual({ success: true });
    expect(mocks.checkRevision).toHaveBeenCalledTimes(1);
    expect(mocks.checkRevision).toHaveBeenCalledWith(hostEditor, '33');
    expect(mocks.executeDomainCommand).toHaveBeenNthCalledWith(1, bodyEditor, expect.any(Function));
    expect(mocks.executeDomainCommand).toHaveBeenNthCalledWith(2, footnoteEditor, expect.any(Function));
    expect(bodyCommit).toHaveBeenCalledWith(hostEditor);
    expect(footnoteCommit).toHaveBeenCalledWith(hostEditor);
    expect(index.invalidate).toHaveBeenCalledWith(bodyStory);
    expect(index.invalidate).toHaveBeenCalledWith(footnoteStory);
  });

  it('resolves range targets against v1 sdBlockId attributes', () => {
    const acceptTrackedChangesBetween = vi.fn(() => true);
    const invalidate = vi.fn();
    const hostEditor = makeRangeDecisionEditor({ acceptTrackedChangesBetween });
    mocks.getTrackedChangeIndex.mockReturnValue({
      get: vi.fn(() => []),
      getAll: vi.fn(() => []),
      invalidate,
      invalidateAll: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
    });

    const receipt = trackChangesDecideRangeWrapper(hostEditor, {
      decision: 'accept',
      range: { kind: 'text', segments: [{ blockId: 'p1', range: { start: 2, end: 4 } }] },
    });

    expect(receipt).toEqual({ success: true });
    expect(acceptTrackedChangesBetween).toHaveBeenCalledWith(8, 10);
    expect(invalidate).toHaveBeenCalledWith({ kind: 'story', storyType: 'body' });
  });

  it('resolves range targets through flattened text offsets for inline wrappers', () => {
    const acceptTrackedChangesBetween = vi.fn(() => true);
    const hostEditor = makeRangeDecisionEditor(
      { acceptTrackedChangesBetween },
      makeParagraphNode({ sdBlockId: 'p1' }, makeInlineWrapper(makeTextNode('Hi'))),
      5,
    );

    const receipt = trackChangesDecideRangeWrapper(hostEditor, {
      decision: 'accept',
      range: { kind: 'text', segments: [{ blockId: 'p1', range: { start: 0, end: 2 } }] },
    });

    expect(receipt).toEqual({ success: true });
    expect(acceptTrackedChangesBetween).toHaveBeenCalledWith(7, 9);
  });

  it('preserves typed overlap decision failures for range document-api calls', () => {
    const acceptTrackedChangesBetween = vi.fn(() => false);
    const hostEditor = {
      options: { trackedChanges: {} },
      commands: { acceptTrackedChangesBetween },
      storage: {
        trackChanges: {
          lastDecisionFailure: {
            code: 'TARGET_NOT_FOUND',
            message: 'no tracked changes match the requested decision target.',
          },
        },
      },
      state: makeRangeDecisionEditor({}).state,
    } as unknown as Editor;

    const receipt = trackChangesDecideRangeWrapper(hostEditor, {
      decision: 'accept',
      range: { kind: 'text', segments: [{ blockId: 'p1', range: { start: 2, end: 4 } }] },
    });

    expect(receipt).toEqual({
      success: false,
      failure: {
        code: 'TARGET_NOT_FOUND',
        message: 'no tracked changes match the requested decision target.',
        details: {
          range: { kind: 'text', segments: [{ blockId: 'p1', range: { start: 2, end: 4 } }] },
          story: undefined,
        },
      },
    });
    expectTrackChangesDecideReceiptCodeDeclared('TARGET_NOT_FOUND');
  });

  it('keeps precondition range decision receipt failures declared in document-api metadata', () => {
    const acceptTrackedChangesBetween = vi.fn(() => false);
    const hostEditor = {
      options: { trackedChanges: {} },
      commands: { acceptTrackedChangesBetween },
      storage: {
        trackChanges: {
          lastDecisionFailure: {
            code: 'PRECONDITION_FAILED',
            message: 'tracked review graph has invariant errors before decision.',
            details: { diagnostics: [{ code: 'INV_REPLACEMENT_MISSING_SIDE' }] },
          },
        },
      },
      state: makeRangeDecisionEditor({}).state,
    } as unknown as Editor;

    const receipt = trackChangesDecideRangeWrapper(hostEditor, {
      decision: 'accept',
      range: { kind: 'text', segments: [{ blockId: 'p1', range: { start: 2, end: 4 } }] },
    });

    expect(receipt).toEqual({
      success: false,
      failure: {
        code: 'PRECONDITION_FAILED',
        message: 'tracked review graph has invariant errors before decision.',
        details: { diagnostics: [{ code: 'INV_REPLACEMENT_MISSING_SIDE' }] },
      },
    });
    expectTrackChangesDecideReceiptCodeDeclared('PRECONDITION_FAILED');
  });

  it('keeps unresolved range target receipt failures declared in document-api metadata', () => {
    const hostEditor = makeRangeDecisionEditor({ acceptTrackedChangesBetween: vi.fn(() => true) });

    const receipt = trackChangesDecideRangeWrapper(hostEditor, {
      decision: 'accept',
      range: { kind: 'text', segments: [{ blockId: 'missing', range: { start: 0, end: 1 } }] },
    });

    expect(receipt).toEqual({
      success: false,
      failure: {
        code: 'INVALID_TARGET',
        message: 'trackChanges.decide range could not be resolved to a contiguous PM coordinate.',
        details: { range: { kind: 'text', segments: [{ blockId: 'missing', range: { start: 0, end: 1 } }] } },
      },
    });
    expectTrackChangesDecideReceiptCodeDeclared('INVALID_TARGET');
  });
});
