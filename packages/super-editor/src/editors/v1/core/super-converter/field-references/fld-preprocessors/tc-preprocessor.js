/**
 * Processes a TC (table of contents entry) instruction and creates an `sd:tableOfContentsEntry` node.
 *
 * SD-3227: `w:bookmarkStart`/`w:bookmarkEnd` runs that the customer embeds
 * inside the TC field's instruction (e.g. heading `_Toc...` targets) are
 * lifted back out as siblings of the synthesized entry. The PM
 * `tableOfContentsEntry` node is `atom: true`, so any bookmark left inside it
 * would be invisible to `buildPositionMap` and `bookmarkStartNodeToBlocks`,
 * leaving TOC navigation with no resolvable target.
 *
 * @param {import('../../v2/types/index.js').OpenXmlNode[]} nodesToCombine The nodes to combine.
 * @param {string} instrText The instruction text.
 * @param {import('../../v2/docxHelper').ParsedDocx} [_docx] The docx object (unused).
 * @param {Array<{type: string, text?: string}>} [instructionTokens] Raw instruction tokens.
 * @returns {import('../../v2/types/index.js').OpenXmlNode[]}
 */
export function preProcessTcInstruction(nodesToCombine, instrText, _docx, instructionTokens = null) {
  const leadingBookmarks = [];
  const trailingBookmarks = [];
  const entryElements = [];
  for (const node of nodesToCombine) {
    if (node?.name === 'w:bookmarkStart') {
      leadingBookmarks.push(node);
    } else if (node?.name === 'w:bookmarkEnd') {
      trailingBookmarks.push(node);
    } else {
      entryElements.push(node);
    }
  }
  return [
    ...leadingBookmarks,
    {
      name: 'sd:tableOfContentsEntry',
      type: 'element',
      attributes: {
        instruction: instrText,
        ...(instructionTokens ? { instructionTokens } : {}),
      },
      elements: entryElements,
    },
    ...trailingBookmarks,
  ];
}
