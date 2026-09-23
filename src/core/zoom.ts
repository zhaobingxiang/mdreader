/**
 * 缩放控制。
 *
 * 只缩放内容区（编辑器 + 预览正文），顶栏 / 大纲 / 书写提示面板不跟着变——
 * 所以桌面壳不用 WebView2 的 ZoomFactor（那是整个界面一起缩），
 * 两个环境统一走内容字号：--content-scale 变量。
 *
 * 注意不能用 CSS zoom：它会破坏 CodeMirror 的选区矩形计算，
 * 拖选时选区元素直接不渲染。
 */

const STORAGE_KEY = 'mdreader.zoom'
export const MIN_ZOOM = 0.3
export const MAX_ZOOM = 4
export const ZOOM_STEP = 0.1

export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(factor * 100) / 100))
}

export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`
}

export interface ZoomController {
  get(): number
  set(factor: number): void
  zoomIn(): void
  zoomOut(): void
  reset(): void
  subscribe(cb: (factor: number) => void): () => void
}

function readSaved(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) ? clampZoom(value) : null
  } catch {
    return null
  }
}

function writeSaved(factor: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(factor))
  } catch {
    // 隐私模式下写不了，忽略
  }
}

export function createZoomController(): ZoomController {
  let factor = readSaved() ?? 1
  const listeners = new Set<(value: number) => void>()

  const emit = (): void => {
    document.documentElement.style.setProperty('--content-scale', String(factor))
    for (const cb of listeners) cb(factor)
  }

  const applyFactor = (next: number): void => {
    factor = clampZoom(next)
    emit()
    writeSaved(factor)
  }

  return {
    get: () => factor,
    set: applyFactor,
    zoomIn: () => applyFactor(factor + ZOOM_STEP),
    zoomOut: () => applyFactor(factor - ZOOM_STEP),
    reset: () => applyFactor(1),
    subscribe(cb) {
      listeners.add(cb)
      // 立即回调一次做初始显示；回调里不得访问此处之后才声明的 let（TDZ）
      cb(factor)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
