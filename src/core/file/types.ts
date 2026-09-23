/**
 * 与外壳解耦的文件抽象层。
 *
 * 纯前端核心只依赖这一组接口，完全不关心文件来自哪里：
 *   - File System Access API（浏览器 Chrome / Edge）
 *   - Tauri fs 插件（桌面）
 *   - 内存（降级 / demo / 未授权）
 *
 * 新增一种外壳时，只需实现 FileSystemAdapter，核心代码零改动。
 */

export type AdapterId = 'fs-access' | 'tauri' | 'memory' | 'webview'

export interface FileMeta {
  name: string
  /** 可展示的绝对路径；浏览器下可能只有文件名 */
  path: string
  size: number
  lastModified: number
}

export interface FileHandle {
  readonly meta: FileMeta
  /** 读取全文 */
  read(): Promise<string>
  /** 写回。无权限时抛 FilePermissionError */
  write(text: string): Promise<void>
  canWrite(): Promise<boolean>
  /** 请求写权限（浏览器下会弹授权框） */
  requestWrite(): Promise<boolean>
  /**
   * 订阅外部变更（AI / 其他编辑器改写了这个文件）。
   * 不支持监听的适配器返回一个 noop 取消函数。
   */
  watch(cb: (nextText: string) => void): () => void
}

export interface FileSystemAdapter {
  readonly id: AdapterId
  readonly label: string
  /** 当前环境是否可用 */
  isSupported(): boolean
  /** 打开文件；返回 null 表示用户取消 */
  openFile(): Promise<FileHandle | null>
  /** 新建内存文档 */
  createUntitled(name?: string): FileHandle
  /** 把拖入 / input[type=file] 拿到的 File 包成句柄（浏览器专有） */
  fromFile?(file: File): Promise<FileHandle>
  /** 另存为；不支持的环境留空，由上层回退到 File System Access API */
  saveAs?(text: string, suggestedName: string): Promise<FileHandle | null>
}

export class FilePermissionError extends Error {
  constructor(message = '当前文件没有写入权限') {
    super(message)
    this.name = 'FilePermissionError'
  }
}

export const MARKDOWN_FILE_TYPES = [
  {
    description: 'Markdown 文档',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] as string[] },
  },
]
