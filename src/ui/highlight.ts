import type { HighlightKind } from '../editor/extensions/highlight'

export type { HighlightKind }

const ALL_CLASSES = [
  'is-hl-error',
  'is-hl-warning',
  'is-hl-info',
  'is-hl-selection',
] as const

export function clearPreviewHighlight(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>(`.${ALL_CLASSES.join(', .')}`)) {
    el.classList.remove(...ALL_CLASSES)
  }
}

/** 预览里所有带 data-line 的块，按行号升序 */
function lineBlocks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-line]')].filter((el) =>
    Number.isFinite(Number(el.dataset.line)),
  )
}

/**
 * 按源行号区间高亮预览里的块。
 * 顺带把「最后一个起始行 <= fromLine」的块也纳入，
 * 因为段落的 data-line 只标了起始行，行号落在段落中间时要能命中。
 */
export function highlightPreviewRange(
  root: HTMLElement,
  fromLine: number,
  toLine: number,
  kind: HighlightKind,
): HTMLElement[] {
  clearPreviewHighlight(root)

  const blocks = lineBlocks(root)
  if (blocks.length === 0) return []

  const low = Math.min(fromLine, toLine)
  const high = Math.max(fromLine, toLine)
  const hit: HTMLElement[] = []

  for (const el of blocks) {
    const line = Number(el.dataset.line)
    if (line > high) break
    if (line >= low) {
      el.classList.add(`is-hl-${kind}`)
      hit.push(el)
    }
  }

  // 起始行落在块内部（比如段落中间那行）时，把该块也点亮
  if (hit.length === 0) {
    let candidate: HTMLElement | null = null
    for (const el of blocks) {
      if (Number(el.dataset.line) <= low) candidate = el
      else break
    }
    if (candidate) {
      candidate.classList.add(`is-hl-${kind}`)
      hit.push(candidate)
    }
  }

  return hit
}

/** 找到承载某个节点（或其自身）的最近块元素 */
export function closestLineBlock(node: Node | null): HTMLElement | null {
  let current: Node | null = node
  while (current) {
    if (current instanceof HTMLElement && current.dataset.line !== undefined) return current
    current = current.parentNode
  }
  return null
}

/** 把当前预览选区映射回源文档位置（拿不到精确位置时退化为行级范围） */
export function mapPreviewSelection(
  root: HTMLElement,
  docSlice: (fromLine: number, toLine: number) => { from: number; to: number; text: string } | null,
): { from: number; to: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const startBlock = closestLineBlock(range.startContainer)
  const endBlock = closestLineBlock(range.endContainer)
  if (!startBlock || !endBlock) return null

  const startLine = Number(startBlock.dataset.line)
  const endLine = Number(endBlock.dataset.line)
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null

  const region = docSlice(Math.min(startLine, endLine), Math.max(startLine, endLine))
  if (!region) return null

  const selected = selection.toString()
  if (!selected.trim()) return { from: region.from, to: region.to }

  // 优先在源文本里精确匹配选中内容（预览与源文本不一定逐字相同，失败就退化为行范围）
  const index = region.text.indexOf(selected)
  if (index >= 0) {
    return { from: region.from + index, to: region.from + index + selected.length }
  }

  return { from: region.from, to: region.to }
}
