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

/** 一个模型平台的用户配置。密钥不在这里——它由宿主用 DPAPI 单独保存 */
export interface AiProviderSettings {
  baseUrl: string
  /** 用户从平台清单里挑出来、常驻在「我的模型」里的模型 */
  models: string[]
  /** 当前选中的模型，必须属于 models */
  model: string
}

export interface AiSettings {
  active: string
  providers: Record<string, AiProviderSettings>
  /** 请求时打开平台的深度思考参数 */
  deepThinking: boolean
  /** 首次把文档发给模型前用户点了确认的时间戳；0 = 还没确认过 */
  consentAt: number
}

/**
 * 会记设置：本地语音模型包与转写线程数。
 * engineUrl 默认写死在程序里，内网取不到时可在设置里改，或用「从本地压缩包安装」。
 */
export interface MeetingSettings {
  engineUrl: string
  /** 转写线程数；0 = 按 CPU 核心数自动 */
  threads: number
}

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
  aiPanelVisible: boolean
  /** AI 面板高度（px），拖动上沿调整 */
  aiPanelHeight: number
  ai: AiSettings
  meeting: MeetingSettings
}

const DEFAULT_AI: AiSettings = {
  active: 'maas',
  providers: {
    lanz: {
      baseUrl: 'http://lanz.hikvision.com/v3/openai/v1',
      models: ['Lanz-Auto', 'Lanz-Medium', 'Lanz-Medium-V', 'Lanz-Flash'],
      model: 'Lanz-Medium',
    },
    maas: {
      baseUrl: 'https://maas.hikvision.com.cn/v1',
      models: ['GLM-5.3', 'DeepSeek-V4-Flash-0731'],
      model: 'GLM-5.3',
    },
    custom: { baseUrl: '', models: [], model: '' },
  },
  deepThinking: true,
  consentAt: 0,
}

/**
 * 会记的本地语音模型包（SenseVoice + silero VAD + sherpa-onnx 命令行，约 250 MB）。
 * 不进安装包：地址写死在这里，用户点一次装完，之后录音与转写全程离线，
 * 音频和模型权重都不出这台机器。内网取不到这个地址时，
 * 设置里可以改 URL，或者直接下好压缩包用「从本地压缩包安装」。
 *
 * 这是海康网盘的分享页地址（分享的是「mdreader模型」目录，宿主先列目录再取包），
 * 换文件不用换链接：往这个目录里传新包即可。
 */
const MEETING_ENGINE_URL = 'https://drive.ticklink.com/disk/fileDownload?link=qf0cS67g'

const DEFAULT_MEETING: MeetingSettings = {
  engineUrl: MEETING_ENGINE_URL,
  threads: 0,
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
  aiPanelVisible: false,
  aiPanelHeight: 300,
  ai: DEFAULT_AI,
  meeting: DEFAULT_MEETING,
}

const MIRROR_KEY = 'mdreader.settings'
const MODES: ViewMode[] = ['edit', 'split', 'preview']
export const AI_PROVIDER_IDS = ['lanz', 'maas', 'custom'] as const
export const AI_PANEL_MIN_HEIGHT = 180
export const AI_PANEL_MAX_HEIGHT = 640

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Lanz 网关的对话接口在 /v3/openai/v1 下，旧默认值少了 /v1：
 * 打到 /v3/openai/chat/completions 会命中旧版 completions 路由并报缺 prompt。
 * 只重写与旧默认值完全一致的内置地址，用户手填的自定义地址不动。
 */
function normalizeBaseUrl(id: string, raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (id === 'lanz' && value.toLowerCase() === 'http://lanz.hikvision.com/v3/openai') {
    return DEFAULT_AI.providers.lanz!.baseUrl
  }
  return value
}

/** 只认内置平台的键；模型和地址原样保留，空值回落到默认 */
function sanitizeAi(src: unknown): AiSettings {
  const raw = (src && typeof src === 'object' ? src : {}) as Record<string, unknown>
  const rawProviders = (raw.providers && typeof raw.providers === 'object' ? raw.providers : {}) as Record<
    string,
    unknown
  >
  const providers: Record<string, AiProviderSettings> = {}
  for (const id of AI_PROVIDER_IDS) {
    const fallback = DEFAULT_AI.providers[id]!
    const entry = (rawProviders[id] && typeof rawProviders[id] === 'object' ? rawProviders[id] : {}) as Record<
      string,
      unknown
    >
    // 旧版本每平台只存一个 model：迁移成「清单里只有它」
    const legacy = str(entry.model, '').trim()
    const rawModels = Array.isArray(entry.models) ? entry.models : []
    const models = [
      ...new Set(
        rawModels
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim())
          .filter((m) => m !== ''),
      ),
    ]
    const list = models.length > 0 ? models : legacy ? [legacy] : [...fallback.models]
    let model: string
    if (models.length === 0 && !legacy) model = list.includes(fallback.model) ? fallback.model : (list[0] ?? '')
    else model = list.includes(legacy) ? legacy : (list[0] ?? '')
    providers[id] = {
      baseUrl: normalizeBaseUrl(id, str(entry.baseUrl, fallback.baseUrl)),
      models: list,
      model,
    }
  }
  const active = str(raw.active, DEFAULT_AI.active)
  return {
    active: (AI_PROVIDER_IDS as readonly string[]).includes(active) ? active : DEFAULT_AI.active,
    providers,
    deepThinking: typeof raw.deepThinking === 'boolean' ? raw.deepThinking : DEFAULT_AI.deepThinking,
    consentAt: typeof raw.consentAt === 'number' && Number.isFinite(raw.consentAt) ? raw.consentAt : 0,
  }
}

function sanitizeMeeting(src: unknown): MeetingSettings {
  const raw = (src && typeof src === 'object' ? src : {}) as Record<string, unknown>
  const url = str(raw.engineUrl, DEFAULT_MEETING.engineUrl).trim()
  const threads = typeof raw.threads === 'number' && Number.isFinite(raw.threads) ? Math.round(raw.threads) : 0
  // 早期版本存下过空地址；留空没有意义，一律回到程序内置的网盘链接
  return { engineUrl: url || MEETING_ENGINE_URL, threads: Math.min(Math.max(threads, 0), 64) }
}

function sanitize(src: Record<string, unknown>): AppSettings {
  const s: AppSettings = {
    ...SETTINGS_DEFAULTS,
    ai: sanitizeAi(src.ai),
    meeting: sanitizeMeeting(src.meeting),
  }
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
  if (typeof src.aiPanelVisible === 'boolean') s.aiPanelVisible = src.aiPanelVisible
  if (typeof src.aiPanelHeight === 'number' && Number.isFinite(src.aiPanelHeight)) {
    s.aiPanelHeight = Math.min(Math.max(Math.round(src.aiPanelHeight), AI_PANEL_MIN_HEIGHT), AI_PANEL_MAX_HEIGHT)
  }
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

/**
 * 宿主回包前用户已经改过的键。回包是启动更早时刻的快照，
 * 直接合并会把刚点的「显示 AI 面板」等改回旧值；
 * 初始化期间记下这些键，合并时让本地值优先。
 */
let patchedDuringInit: Record<string, unknown> | null = null

export function patchSettings(patch: Partial<AppSettings>): void {
  full = { ...full, ...patch }
  if (patchedDuringInit) Object.assign(patchedDuringInit, patch)
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
  patchedDuringInit = {}
  return callHost<Record<string, unknown>>('getSettings')
    .then((raw) => {
      const localEdits = patchedDuringInit ?? {}
      patchedDuringInit = null
      if (raw && Object.keys(raw).length > 0) {
        // 宿主键里可能带 window 等宿主私有项，合并后由 sanitize 只取认识字段；
        // 回包前用户改过的键以本地为准
        full = { ...full, ...raw, ...localEdits }
        current = sanitize(full)
        writeMirror(current)
        emit()
      }
      // 无论首次还是升级后补种：把本地已有值写回宿主，补齐缺失键
      // （设置弹窗里改任何一项也会整份写回，这里只是保证默认键先落地）
      void callHost('setSettings', { patch: current }).catch(() => undefined)
    })
    .catch(() => {
      patchedDuringInit = null
    })
}
