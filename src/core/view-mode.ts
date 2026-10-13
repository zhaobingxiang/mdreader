export type ViewMode = 'edit' | 'split' | 'preview'

export const VIEW_MODES: ViewMode[] = ['edit', 'split', 'preview']

export const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  edit: '编辑',
  split: '分屏',
  preview: '预览',
}

export class ViewModeController {
  private mode: ViewMode
  /** 记住进入分屏前用的是哪种单栏模式，Ctrl+Shift+E 返回时还原 */
  private lastSingle: Exclude<ViewMode, 'split'> = 'edit'
  private readonly listeners = new Set<(mode: ViewMode) => void>()

  constructor(initial: ViewMode = 'split') {
    this.mode = initial
    if (initial !== 'split') this.lastSingle = initial
  }

  get current(): ViewMode {
    return this.mode
  }

  subscribe(fn: (mode: ViewMode) => void): () => void {
    this.listeners.add(fn)
    fn(this.mode)
    return () => {
      this.listeners.delete(fn)
    }
  }

  set(mode: ViewMode): void {
    if (mode === this.mode) return
    if (mode !== 'split') this.lastSingle = mode
    this.mode = mode
    for (const fn of this.listeners) fn(mode)
  }

  /**
   * 标签页切换：直接载入该页记住的模式，
   * 不经过 set 的「上次单栏模式」记忆逻辑，避免污染 Ctrl+E。
   */
  loadMode(mode: ViewMode): void {
    this.mode = mode
    if (mode !== 'split') this.lastSingle = mode
    for (const fn of this.listeners) fn(mode)
  }

  /**
   * Ctrl+E：编辑 ↔ 预览。
   * 当前在分屏时，回到上次用的单栏模式。
   */
  toggleEditPreview(): void {
    if (this.mode === 'split') {
      this.set(this.lastSingle)
      return
    }
    this.set(this.mode === 'edit' ? 'preview' : 'edit')
  }

  /** Ctrl+Shift+E：分屏与单栏互切 */
  toggleSplit(): void {
    this.set(this.mode === 'split' ? this.lastSingle : 'split')
  }
}
