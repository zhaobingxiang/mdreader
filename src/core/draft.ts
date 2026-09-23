/**
 * 未保存草稿的本地留存（崩溃 / 误关窗口后的恢复兜底）。
 * 只在文档处于 dirty 时写入，保存成功或切档后清除。
 */

const STORAGE_KEY = 'mdreader.draft'
const MAX_BYTES = 2_000_000
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface Draft {
  name: string
  path: string
  text: string
  savedAt: number
}

export function saveDraft(draft: Draft): void {
  try {
    if (new Blob([draft.text]).size > MAX_BYTES) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // 超配额 / 隐私模式：放弃留存，不影响编辑
  }
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<Draft>
    if (typeof draft.text !== 'string' || draft.text.length === 0) return null
    if (typeof draft.savedAt !== 'number' || Date.now() - draft.savedAt > KEEP_MS) {
      clearDraft()
      return null
    }
    return {
      name: typeof draft.name === 'string' ? draft.name : '未命名.md',
      path: typeof draft.path === 'string' ? draft.path : '',
      text: draft.text,
      savedAt: draft.savedAt,
    }
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
