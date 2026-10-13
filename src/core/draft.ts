/**
 * 未保存草稿的本地留存（崩溃 / 误关窗口后的恢复兜底）。
 * 标签页模式下每个文档一份草稿，按真实路径（没有路径用文档名）键控；
 * 保存成功或草稿被处理后就删除对应条目。
 */

const STORAGE_KEY = 'mdreader.drafts'
/** 旧版单草稿键，首次读取时迁移 */
const LEGACY_KEY = 'mdreader.draft'
const MAX_BYTES = 2_000_000
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface Draft {
  name: string
  path: string
  text: string
  savedAt: number
}

type DraftMap = Record<string, Draft>

function readAll(): DraftMap {
  let map: DraftMap = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) map = JSON.parse(raw) as DraftMap
  } catch {
    map = {}
  }
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const draft = JSON.parse(legacyRaw) as Partial<Draft>
      localStorage.removeItem(LEGACY_KEY)
      if (typeof draft.text === 'string' && draft.text) {
        const key = draft.path || draft.name || '未命名.md'
        if (!map[key]) {
          map[key] = {
            name: typeof draft.name === 'string' ? draft.name : '未命名.md',
            path: typeof draft.path === 'string' ? draft.path : '',
            text: draft.text,
            savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : Date.now(),
          }
        }
      }
    }
  } catch {
    // 旧数据坏了就丢
  }
  const now = Date.now()
  for (const key of Object.keys(map)) {
    const d = map[key]
    if (!d || typeof d.text !== 'string' || !d.text || now - (d.savedAt ?? 0) > KEEP_MS) {
      delete map[key]
    }
  }
  return map
}

function writeAll(map: DraftMap): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 超配额 / 隐私模式：放弃留存，不影响编辑
  }
}

export function draftKey(path: string, name: string): string {
  return path || name
}

/** 启动时批量检查用的全部有效草稿 */
export function listDrafts(): Draft[] {
  return Object.values(readAll())
}

export function saveDraft(draft: Draft): void {
  const key = draftKey(draft.path, draft.name)
  try {
    if (new Blob([draft.text]).size > MAX_BYTES) {
      const map = readAll()
      delete map[key]
      writeAll(map)
      return
    }
  } catch {
    return
  }
  const map = readAll()
  map[key] = draft
  writeAll(map)
}

/** 当前文档是否有待恢复草稿（内容相同则不算“待恢复”） */
export function loadDraft(path: string, name: string, currentText: string): Draft | null {
  const key = draftKey(path, name)
  const map = readAll()
  const draft = map[key]
  if (!draft) return null
  if (draft.text === currentText) {
    delete map[key]
    writeAll(map)
    return null
  }
  return draft
}

/** 打开文档 / 保存成功：该文档的草稿要么已落地要么已处理 */
export function clearDraft(path: string, name: string): void {
  const map = readAll()
  const key = draftKey(path, name)
  if (key in map) {
    delete map[key]
    writeAll(map)
  }
}
