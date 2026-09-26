import { createMemoryHandle } from './memory'
import type { FileHandle, FileMeta, FileSystemAdapter } from './types'

/**
 * WebView2 宿主桥接。
 *
 * 桌面壳（.NET + WebView2）通过 postMessage 暴露文件能力，
 * 这一层把它包装成与浏览器版完全一致的 FileHandle，
 * 上层（document / app）不需要知道自己在浏览器还是桌面里跑。
 */

interface WebView2Host {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface HostFilePayload {
  path: string
  name: string
  text: string
  size: number
  lastModified: number
}

export type HostEvent =
  | ({ event: 'openFile' } & HostFilePayload)
  | { event: 'fileChanged'; path: string; text: string }
  | { event: 'zoomChanged'; factor: number }
  | { event: 'error'; message: string }
  | { event: 'windowState'; maximized: boolean }
  | { event: 'confirmExit' }

type PathListener = (text: string) => void

function host(): WebView2Host | null {
  const candidate = (window as unknown as { chrome?: { webview?: WebView2Host } }).chrome?.webview
  return candidate ?? null
}

export function isWebViewHost(): boolean {
  return host() !== null
}

/**
 * 桌面壳里相对资源的基地址：宿主拦截 https://mdasset.local/* 请求，
 * 按当前文档所在目录解析成真实文件（图片等本地资源因此可显示）。
 */
export const DESKTOP_ASSET_BASE = 'https://mdasset.local/'

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const pathListeners = new Map<string, Set<PathListener>>()
const globalListeners = new Set<(event: HostEvent) => void>()

let sequence = 0
let initialized = false

function ensureInitialized(): void {
  if (initialized) return
  const bridge = host()
  if (!bridge) return
  initialized = true

  bridge.addEventListener('message', (event) => {
    const raw = event.data
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>

    // 宿主主动推送的事件
    if (typeof message.event === 'string') {
      if (message.event === 'fileChanged') {
        const path = String(message.path ?? '')
        const text = String(message.text ?? '')
        const set = pathListeners.get(path)
        if (set) for (const cb of set) cb(text)
        return
      }
      for (const cb of globalListeners) cb(message as unknown as HostEvent)
      return
    }

    // 请求的响应
    if (typeof message.id !== 'number') return
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    if (message.ok) slot.resolve(message.result)
    else slot.reject(new Error(String(message.error ?? '宿主返回错误')))
  })
}

/** 调用宿主能力，返回 Promise */
export function callHost<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  ensureInitialized()
  const bridge = host()
  if (!bridge) return Promise.reject(new Error('当前不在桌面宿主环境中'))

  const id = (sequence += 1)
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    bridge.postMessage({ id, action, ...payload })
  })
}

/** 订阅宿主事件（如双击文件、外部改写） */
export function onHostEvent(cb: (event: HostEvent) => void): () => void {
  ensureInitialized()
  globalListeners.add(cb)
  return () => {
    globalListeners.delete(cb)
  }
}

export function notifyTitle(name: string, dirty: boolean, dark: boolean): void {
  if (!isWebViewHost()) return
  void callHost('setTitle', { name, dirty, dark }).catch(() => undefined)
}

export function revealInExplorer(path: string): void {
  if (!isWebViewHost() || !path) return
  void callHost('reveal', { path }).catch(() => undefined)
}

/** 把宿主返回的文件信息包成 FileHandle */
export function createHostHandle(payload: HostFilePayload): FileHandle {
  ensureInitialized()
  const meta: FileMeta = {
    name: payload.name,
    path: payload.path,
    size: payload.size,
    lastModified: payload.lastModified,
  }

  const listeners = new Set<PathListener>()

  return {
    meta,
    async read() {
      const fresh = await callHost<HostFilePayload>('readFile', { path: meta.path })
      meta.size = fresh.size
      meta.lastModified = fresh.lastModified
      return fresh.text
    },
    async write(text) {
      const result = await callHost<{ size: number }>('writeFile', { path: meta.path, text })
      meta.size = result.size
      meta.lastModified = Date.now()
    },
    async canWrite() {
      return true
    },
    async requestWrite() {
      return true
    },
    watch(cb) {
      // 同一路径可能创建多个句柄（重新打开 / 另存后旧句柄仍存活），
      // 必须复用已有监听集合，否则 set 覆盖会让先注册的回调失联
      let registered = pathListeners.get(meta.path)
      if (!registered) {
        registered = new Set<PathListener>()
        pathListeners.set(meta.path, registered)
        void callHost('watch', { path: meta.path }).catch(() => undefined)
      }
      registered.add(cb)
      listeners.add(cb)

      const own = registered
      return () => {
        listeners.delete(cb)
        own.delete(cb)
        if (own.size === 0) {
          pathListeners.delete(meta.path)
          void callHost('unwatch', { path: meta.path }).catch(() => undefined)
        }
      }
    },
  }
}

export const webviewAdapter: FileSystemAdapter = {
  id: 'webview',
  label: '本地文件',
  isSupported: isWebViewHost,

  async openFile() {
    const result = await callHost<HostFilePayload & { cancelled?: boolean }>('openFile')
    if (result.cancelled) return null
    return createHostHandle(result)
  },

  createUntitled(name) {
    // 未命名文档先落在内存里，首次保存时走「另存为」拿到真实路径
    return createMemoryHandle('', name)
  },

  async saveAs(text, suggestedName) {
    const result = await callHost<HostFilePayload & { cancelled?: boolean }>('saveAs', {
      text,
      suggested: suggestedName,
    })
    if (result.cancelled) return null
    return createHostHandle(result)
  },
}
