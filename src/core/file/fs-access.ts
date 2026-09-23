import {
  FilePermissionError,
  MARKDOWN_FILE_TYPES,
  type FileHandle,
  type FileMeta,
  type FileSystemAdapter,
} from './types'
import { createMemoryHandle } from './memory'

/** 浏览器 File System Access API 的最小结构（不依赖 lib.dom 的具体版本） */
interface FsaPermissionDescriptor {
  mode: 'read' | 'readwrite'
}
interface FsaWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
}
interface FsaFileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsaWritable>
  queryPermission?(d: FsaPermissionDescriptor): Promise<PermissionState>
  requestPermission?(d: FsaPermissionDescriptor): Promise<PermissionState>
}
interface PickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}
type PickerWindow = Window & {
  showOpenFilePicker?: (o?: PickerOptions) => Promise<FsaFileHandle[]>
  showSaveFilePicker?: (o?: PickerOptions) => Promise<FsaFileHandle>
}

/** 轮询间隔：FSA 没有原生文件监听，只能比对 lastModified */
const POLL_MS = 1500

function pickerWindow(): PickerWindow {
  return window as PickerWindow
}

export function isFsAccessSupported(): boolean {
  return typeof pickerWindow().showOpenFilePicker === 'function'
}

/** 把一个 FSA 句柄包装成与外壳无关的 FileHandle */
export async function wrapFsaHandle(handle: FsaFileHandle): Promise<FileHandle> {
  const meta = await readMeta(handle)

  async function readMeta(h: FsaFileHandle): Promise<FileMeta> {
    try {
      const file = await h.getFile()
      return { name: file.name, path: file.name, size: file.size, lastModified: file.lastModified }
    } catch {
      return { name: h.name, path: h.name, size: 0, lastModified: Date.now() }
    }
  }

  async function refreshMeta(): Promise<void> {
    Object.assign(meta, await readMeta(handle))
  }

  async function canWrite(): Promise<boolean> {
    if (!handle.queryPermission) return true
    try {
      return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'
    } catch {
      return false
    }
  }

  async function requestWrite(): Promise<boolean> {
    if (!handle.requestPermission) return true
    try {
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
    } catch {
      return false
    }
  }

  return {
    get meta() {
      return meta
    },
    async read() {
      const file = await handle.getFile()
      return file.text()
    },
    async write(text) {
      if (!(await canWrite()) && !(await requestWrite())) {
        throw new FilePermissionError()
      }
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      await refreshMeta()
    },
    canWrite,
    requestWrite,
    watch(cb) {
      let stopped = false
      let timer: number | undefined
      let last = meta.lastModified

      const tick = async (): Promise<void> => {
        if (stopped) return
        try {
          const file = await handle.getFile()
          if (file.lastModified !== last) {
            last = file.lastModified
            meta.lastModified = file.lastModified
            meta.size = file.size
            cb(await file.text())
          }
        } catch {
          // 句柄可能已失效（文件被删/移动），静默跳过，下轮再试
        }
        if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS)
      }

      timer = window.setTimeout(() => void tick(), POLL_MS)
      return () => {
        stopped = true
        if (timer !== undefined) window.clearTimeout(timer)
      }
    },
  }
}

/** 另存为：拿到可写的 FSA 句柄 */
export async function saveAsFsa(text: string, suggestedName: string): Promise<FileHandle | null> {
  const picker = pickerWindow().showSaveFilePicker
  if (!picker) return null
  try {
    const handle = await picker({
      suggestedName,
      types: MARKDOWN_FILE_TYPES,
      excludeAcceptAllOption: false,
    })
    const wrapped = await wrapFsaHandle(handle)
    await wrapped.write(text)
    return wrapped
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

/**
 * 拖入 / input[type=file] 得到的 File 只能在内存里读写，
 * 保存时需另存为。这里包一个内存句柄并标记来源。
 */
export async function handleDroppedFile(file: File): Promise<FileHandle> {
  const text = await file.text()
  const handle = createMemoryHandle(text, file.name)
  handle.meta.lastModified = file.lastModified
  handle.meta.size = file.size
  return handle
}

export const fsAccessAdapter: FileSystemAdapter = {
  id: 'fs-access',
  label: '本地文件',
  isSupported: isFsAccessSupported,
  async openFile() {
    const picker = pickerWindow().showOpenFilePicker
    if (!picker) return null
    try {
      const [handle] = await picker({ multiple: false, types: MARKDOWN_FILE_TYPES })
      if (!handle) return null
      return await wrapFsaHandle(handle)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
  },
  createUntitled: (name) => createMemoryHandle('', name),
  fromFile: handleDroppedFile,
}
