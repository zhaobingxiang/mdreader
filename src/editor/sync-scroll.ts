interface EditorSide {
  /** CM6 的滚动容器 */
  scroller: HTMLElement
  /** 当前视口顶部对应的行号 */
  topLine(): number
  scrollToLine(line: number): void
}

interface Anchor {
  line: number
  top: number
}

/** 主动驱动方设置完对侧滚动后，这段时间内忽略对侧回传的 scroll 事件 */
const IGNORE_WINDOW_MS = 120

/**
 * 编辑器 ↔ 预览 滚动同步。
 *
 * 做法：渲染时给每个块级元素打 data-line（源文档行号），
 * 同步时在「行号 → 像素位置」的锚点表里二分 + 线性插值。
 * 比按滚动百分比对齐准得多，因为两边高度比例并不一致。
 */
export class ScrollSync {
  private anchors: Anchor[] = []
  private enabled = false
  private rafId = 0
  private pending: 'editor' | 'preview' | null = null
  private ignoreSide: 'editor' | 'preview' | null = null
  private ignoreUntil = 0

  private readonly editor: EditorSide
  private readonly preview: HTMLElement

  constructor(editor: EditorSide, preview: HTMLElement) {
    this.editor = editor
    this.preview = preview
    this.onEditorScroll = this.onEditorScroll.bind(this)
    this.onPreviewScroll = this.onPreviewScroll.bind(this)
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.editor.scroller.addEventListener('scroll', this.onEditorScroll, { passive: true })
    this.preview.addEventListener('scroll', this.onPreviewScroll, { passive: true })
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.editor.scroller.removeEventListener('scroll', this.onEditorScroll)
    this.preview.removeEventListener('scroll', this.onPreviewScroll)
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.pending = null
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 预览内容更新后重建锚点表 */
  refreshAnchors(): void {
    const previewRect = this.preview.getBoundingClientRect()
    const contentTop = previewRect.top - this.preview.scrollTop
    const nodes = this.preview.querySelectorAll<HTMLElement>('[data-line]')
    const next: Anchor[] = []

    for (const node of nodes) {
      const raw = node.dataset.line
      if (raw === undefined) continue
      const line = Number(raw)
      if (!Number.isFinite(line)) continue
      next.push({ line, top: node.getBoundingClientRect().top - contentTop })
    }

    next.sort((a, b) => a.line - b.line)
    this.anchors = next
  }

  /** 供滚动条缩略图之类的外部逻辑判断当前进度 */
  lineAtPreviewTop(): number {
    return this.lookupEditorLine(this.preview.scrollTop)
  }

  private onEditorScroll(): void {
    if (this.shouldIgnore('editor')) return
    this.schedule('editor')
  }

  private onPreviewScroll(): void {
    if (this.shouldIgnore('preview')) return
    this.schedule('preview')
  }

  private shouldIgnore(side: 'editor' | 'preview'): boolean {
    return this.ignoreSide === side && performance.now() < this.ignoreUntil
  }

  private schedule(side: 'editor' | 'preview'): void {
    this.pending = side
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      const target = this.pending
      this.pending = null
      if (target === 'editor') this.pushToPreview()
      else if (target === 'preview') this.pullFromPreview()
    })
  }

  private pushToPreview(): void {
    const line = this.editor.topLine()
    const top = this.lookupPreviewTop(line)
    this.ignoreSide = 'preview'
    this.ignoreUntil = performance.now() + IGNORE_WINDOW_MS
    if (Math.abs(this.preview.scrollTop - top) < 0.5) return
    this.preview.scrollTop = top
  }

  private pullFromPreview(): void {
    const line = this.lookupEditorLine(this.preview.scrollTop)
    this.ignoreSide = 'editor'
    this.ignoreUntil = performance.now() + IGNORE_WINDOW_MS
    this.editor.scrollToLine(Math.round(line))
  }

  /** 行号 → 预览内容像素偏移 */
  private lookupPreviewTop(line: number): number {
    const list = this.anchors
    if (list.length === 0) return this.preview.scrollTop
    const first = list[0]!
    if (line <= first.line) return 0
    const last = list[list.length - 1]!
    if (line >= last.line) return last.top

    const index = this.lowerBound(list, line, 'line')
    const current = list[index]!
    const next = list[Math.min(index + 1, list.length - 1)]!
    if (next.line === current.line || next.top === current.top) return current.top
    const ratio = (line - current.line) / (next.line - current.line)
    return current.top + (next.top - current.top) * ratio
  }

  /** 预览像素偏移 → 行号（可带小数） */
  private lookupEditorLine(scrollTop: number): number {
    const list = this.anchors
    if (list.length === 0) return 1
    const first = list[0]!
    if (scrollTop <= first.top) return first.line
    const last = list[list.length - 1]!
    if (scrollTop >= last.top) return last.line

    const index = this.lowerBound(list, scrollTop, 'top')
    const current = list[index]!
    const next = list[Math.min(index + 1, list.length - 1)]!
    if (next.top === current.top || next.line === current.line) return current.line
    const ratio = (scrollTop - current.top) / (next.top - current.top)
    return current.line + (next.line - current.line) * ratio
  }

  /** 找到最后一个 key <= value 的下标 */
  private lowerBound(list: Anchor[], value: number, key: keyof Anchor): number {
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((list[mid]![key] as number) <= value) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}
