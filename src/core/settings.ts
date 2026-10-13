import { clampZoom } from './zoom'
import type { ViewMode } from './view-mode'
import { callHost, isWebViewHost } from './file/webview'

/**
 * 应用设置。
 *
 * 桌面壳里真源是宿主的 settings.json（%LocalAppData%），启动时经
 * getSettings 拉取；localStorage 里保留一份镜像，让页面脚本在宿主应答
 * 之前就能同步读到「上一次的状态」，避免等 Promise 造成界面闪跳。
 * 浏览器版没有宿主，localStorage 就是真源。
 */

export type ThemeSetting = 'light' | 'dark' | 'system'

export interface AppSettings {
  /** 新文档 / 新标签页打开时的视图模式 */
  defaultMode: ViewMode
  theme: ThemeSetting
  /** 启动时恢复上次打开的标签页（仅桌面壳） */
  restoreSession: boolean
  /** 记住窗口大小和位置（仅桌面壳） */
  rememberWindow: boolean
  /** 打印页眉页脚（日期/标题/网址/页码）默认开启（仅桌面壳，重启后生效） */
  printHeaderFooter: boolean
  zoom: number
  outlineVisible: boolean
  hintsVisible: boolean
}

export const SETTINGS_DEFAULTS: AppSettings = {
  defaultMode: 'preview',
  theme: 'system',
  restoreSession: true,
  rememberWindow: true,
  printHeaderFooter: false,
  zoom: 1,
  outlineVisible: true,
  hintsVisible: true,
}

const MIRROR_KEY = 'mdreader.settings'
const MODES: ViewMode[] = ['edit', 'split', 'preview']

function sanitize(src: Record<string, unknown>): AppSettings {
  const s: AppSettings = { ...SETTINGS_DEFAULTS }
  const mode = src.defaultMode
  if (typeof mode === 'string' && MODES.includes(mode as ViewMode)) s.defaultMode = mode as ViewMode
  const theme = src.theme
  if (theme === 'light' || theme === 'dark' || theme === 'system') s.theme = theme
  if (typeof src.restoreSession === 'boolean') s.restoreSession = src.restoreSession
  if (typeof src.rememberWindow === 'boolean') s.rememberWindow = src.rememberWindow
  if (typeof src.printHeaderFooter === 'boolean') s.printHeaderFooter = src.printHeaderFooter
  if (typeof src.zoom === 'number' && Number.isFinite(src.zoom)) s.zoom = clampZoom(src.zoom)
  if (typeof src.outlineVisible === 'boolean') s.outlineVisible = src.outlineVisible
  if (typeof src.hintsVisible === 'boolean') s.hintsVisible = src.hintsVisible
  return s
}

/** 升级前的旧持久化键：主题 / 缩放 / 面板折叠只在这里出现一次 */
function readLegacyKeys(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    const theme = localStorage.getItem('mdreader.theme')
    if (theme === 'light' || theme === 'dark') out.theme = theme
    const zoom = Number(localStorage.getItem('mdreader.zoom'))
    if (Number.isFinite(zoom) && zoom > 0) out.zoom = zoom
    const uiRaw = localStorage.getItem('mdreader.ui')
    if (uiRaw) {
      const ui = JSON.parse(uiRaw) as Record<string, unknown>
      if (typeof ui.outlineCollapsed === 'boolean') out.outlineVisible = !ui.outlineCollapsed
      if (typeof ui.hintsCollapsed === 'boolean') out.hintsVisible = !ui.hintsCollapsed
    }
  } catch {
    // 旧数据坏了就当没有
  }
  return out
}

function readMirror(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    if (raw) return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // ignore
  }
  return {}
}

function writeMirror(s: AppSettings): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(s))
  } catch {
    // 存储失败不影响使用
  }
}

const hostManaged = isWebViewHost()

let full: Record<string, unknown> = {
  ...SETTINGS_DEFAULTS,
  ...readLegacyKeys(),
  ...readMirror(),
}
let current: AppSettings = sanitize(full)

type Listener = (s: AppSettings) => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const fn of listeners) fn(current)
}

export function getSettings(): AppSettings {
  return current
}

export function subscribeSettings(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => {
    listeners.delete(cb)
  }
}

export function patchSettings(patch: Partial<AppSettings>): void {
  full = { ...full, ...patch }
  current = sanitize(full)
  writeMirror(current)
  if (hostManaged) {
    void callHost('setSettings', { patch: current }).catch(() => undefined)
  }
  emit()
}

/**
 * 桌面壳：向宿主取真源。宿主文件为空（首次升级）时把本地估算写回去播种。
 * 失败保持本地估算即可，不阻塞启动。
 */
export function initSettings(): Promise<void> {
  if (!hostManaged) return Promise.resolve()
  return callHost<Record<string, unknown>>('getSettings')
    .then((raw) => {
      if (raw && Object.keys(raw).length > 0) {
        // 宿主键里可能带 window 等宿主私有项，合并后由 sanitize 只取认识字段
        full = { ...full, ...raw }
        current = sanitize(full)
        writeMirror(current)
        emit()
      }
      // 无论首次还是升级后补种：把本地已有值写回宿主，补齐缺失键
      // （设置弹窗里改任何一项也会整份写回，这里只是保证默认键先落地）
      void callHost('setSettings', { patch: current }).catch(() => undefined)
    })
    .catch(() => undefined)
}
