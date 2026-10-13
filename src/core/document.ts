import { FilePermissionError, type FileHandle, type FileSystemAdapter } from './file/types'
import { createMemoryHandle } from './file/memory'
import { fsAccessAdapter, saveAsFsa } from './file/fs-access'

export interface DocumentSnapshot {
  text: string
  name: string
  path: string
  /** 句柄上的真实磁盘路径；未落盘的文档（新建 / 拖入）为空串。path 是带文件名兜底的展示值 */
  rawPath: string
  /** 有未保存修改 */
  dirty: boolean
  /** 底层句柄是否可写（拖入的文件、未授权目录为 false） */
  writable: boolean
  /** 外部（AI / 其他编辑器）写入的待审版本；null 表示无 */
  pendingExternal: string | null
  /** 最近一次错误提示，供状态栏展示 */
  notice: string | null
}

export type DocumentEventType = 'text' | 'external' | 'meta' | 'doc-switched'
export interface DocumentEvent {
  type: DocumentEventType
  snapshot: DocumentSnapshot
  /** type === 'external' 时为外部写入的新内容 */
  incoming?: string
}

type Listener = (e: DocumentEvent) => void

/**
 * 文档模型：持有文本、当前句柄、脏标记，并统一对外广播变更。
 * 视图层只订阅事件，不直接碰 FileHandle。
 */
export class MarkdownDocument {
  private handle: FileHandle = createMemoryHandle('')
  /** 由上层注入：浏览器用 FSA，桌面壳用 WebView2 桥 */
  private adapter: FileSystemAdapter = fsAccessAdapter
  private text = ''
  private savedText = ''
  private writable = true
  private pendingExternal: string | null = null
  private notice: string | null = null
  private unwatch: (() => void) | null = null
  private listeners = new Set<Listener>()
  /** 自己写入时标记，避免把自己的保存当成外部变更 */
  private selfWriteToken = 0

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get snapshot(): DocumentSnapshot {
    return {
      text: this.text,
      name: this.handle.meta.name,
      path: this.handle.meta.path || this.handle.meta.name,
      rawPath: this.handle.meta.path,
      dirty: this.text !== this.savedText,
      writable: this.writable,
      pendingExternal: this.pendingExternal,
      notice: this.notice,
    }
  }

  get currentText(): string {
    return this.text
  }

  private emit(type: DocumentEventType, incoming?: string): void {
    const e: DocumentEvent = { type, snapshot: this.snapshot, incoming }
    for (const fn of this.listeners) fn(e)
  }

  setNotice(message: string | null): void {
    this.notice = message
    this.emit('meta')
  }

  /** 装载一个句柄指向的文件 */
  async open(handle: FileHandle): Promise<void> {
    this.detachWatch()
    this.handle = handle
    this.text = await handle.read()
    this.savedText = this.text
    this.writable = await handle.canWrite()
    this.pendingExternal = null
    this.notice = null
    this.attachWatch()
    this.emit('text')
    // 通知视图重建编辑器状态：清空撤销历史，防止撤销跨文档回退
    this.emit('doc-switched')
  }

  /** 切换底层文件适配器（浏览器 / 桌面壳） */
  setAdapter(adapter: FileSystemAdapter): void {
    this.adapter = adapter
  }

  /** 触发系统文件选择器 */
  async openViaPicker(): Promise<boolean> {
    const handle = await this.adapter.openFile()
    if (!handle) return false
    await this.open(handle)
    return true
  }

  /** 拖入的文件（只读内存句柄） */
  async openDroppedFile(file: File): Promise<void> {
    const handle = this.adapter.fromFile
      ? await this.adapter.fromFile(file)
      : await createDroppedFallback(file)
    if (!handle) return
    await this.open(handle)
    if (this.adapter.id !== 'webview') {
      this.writable = false
      this.notice = '拖入的文件为只读，保存时会提示另存为'
    }
    this.emit('meta')
  }

  createUntitled(name = '未命名.md'): void {
    this.detachWatch()
    this.handle = createMemoryHandle('', name)
    this.text = ''
    this.savedText = ''
    this.writable = true
    this.pendingExternal = null
    this.notice = null
    this.emit('text')
  }

  /** 编辑器输入 */
  setText(next: string): void {
    if (next === this.text) return
    this.text = next
    this.emit('text')
  }

  /** 把当前文本视作已保存（内置欢迎文档等场景，不产生磁盘写入） */
  markSaved(): void {
    this.savedText = this.text
    this.emit('meta')
  }

  /** 保存；返回是否成功 */
  async save(): Promise<boolean> {
    // 内存句柄（新建 / 拖入且未落盘）没有真实路径，直接写内存是「假保存」，
    // 必须改走另存为拿一个真实路径
    if (!this.writable || !this.handle.meta.path) return this.saveAs()
    try {
      this.selfWriteToken += 1
      await this.handle.write(this.text)
      this.savedText = this.text
      this.notice = '已保存'
      this.emit('meta')
      return true
    } catch (err) {
      if (err instanceof FilePermissionError) {
        this.notice = '写入被拒绝，请重新授权'
        this.emit('meta')
        return false
      }
      this.notice = `保存失败：${(err as Error).message}`
      this.emit('meta')
      return false
    }
  }

  /** 另存为（内存句柄或只读来源） */
  async saveAs(): Promise<boolean> {
    try {
      const handle = this.adapter.saveAs
        ? await this.adapter.saveAs(this.text, this.handle.meta.name)
        : await saveAsFsa(this.text, this.handle.meta.name)
      if (!handle) return false
      this.detachWatch()
      this.handle = handle
      this.savedText = this.text
      this.writable = true
      this.notice = '已另存为'
      this.attachWatch()
      this.emit('meta')
      return true
    } catch (err) {
      this.notice = `另存为失败：${(err as Error).message}`
      this.emit('meta')
      return false
    }
  }

  /** 采纳外部（AI）写入的版本 */
  acceptExternal(): void {
    if (this.pendingExternal === null) return
    this.text = this.pendingExternal
    this.savedText = this.pendingExternal
    this.pendingExternal = null
    this.notice = '已采纳外部修改'
    this.emit('text')
  }

  /** 忽略外部写入 */
  dismissExternal(): void {
    if (this.pendingExternal === null) return
    this.pendingExternal = null
    this.notice = '已忽略外部修改'
    this.emit('meta')
  }

  /** 拿到待审内容，供 diff 视图使用 */
  get pendingExternalText(): string | null {
    return this.pendingExternal
  }

  dispose(): void {
    this.detachWatch()
    this.listeners.clear()
  }

  private attachWatch(): void {
    this.unwatch = this.handle.watch((next) => {
      if (next === this.text) return
      this.pendingExternal = next
      this.notice = this.text !== this.savedText ? '外部已修改，且本地有未保存内容' : '检测到外部修改'
      this.emit('external', next)
    })
  }

  private detachWatch(): void {
    this.unwatch?.()
    this.unwatch = null
  }
}

/** 适配器没有 fromFile 时的兜底：包成只读内存句柄 */
async function createDroppedFallback(file: File): Promise<FileHandle> {
  const handle = createMemoryHandle(await file.text(), file.name)
  handle.meta.lastModified = file.lastModified
  handle.meta.size = file.size
  return handle
}
