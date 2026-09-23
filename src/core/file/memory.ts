import type { FileHandle, FileMeta, FileSystemAdapter } from './types'

let seq = 0

/** 内存句柄：无文件系统权限时的降级方案，也是 demo / 新建文档的载体。 */
export function createMemoryHandle(initial = '', name?: string): FileHandle {
  let text = initial
  let externalWatchers = new Set<(next: string) => void>()

  const meta: FileMeta = {
    name: name ?? `未命名-${++seq}.md`,
    path: '',
    size: byteLength(initial),
    lastModified: Date.now(),
  }

  return {
    meta,
    read: async () => text,
    write: async (next) => {
      text = next
      meta.size = byteLength(next)
      meta.lastModified = Date.now()
      // 内存句柄里，自己写入也算一次「变更」，方便联调 diff 审阅
      for (const cb of externalWatchers) cb(next)
    },
    canWrite: async () => true,
    requestWrite: async () => true,
    watch(cb) {
      externalWatchers.add(cb)
      return () => {
        externalWatchers.delete(cb)
      }
    },
  }
}

/** 供外部（如后续接入的 AI 写入通道）注入变更用 */
export function emitMemoryChange(handle: FileHandle, next: string): void {
  void handle.write(next)
}

export const memoryAdapter: FileSystemAdapter = {
  id: 'memory',
  label: '内存',
  isSupported: () => true,
  openFile: async () => null,
  createUntitled: (name) => createMemoryHandle('', name),
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
