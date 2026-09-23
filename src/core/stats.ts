export interface TodoItem {
  text: string
  done: boolean
  line: number
}

export interface DocStats {
  /** 含空格的字符数 */
  chars: number
  /** 不含空格的字符数 */
  charsNoSpace: number
  /** 中文按字、西文按词统计的总词数 */
  words: number
  lines: number
  paragraphs: number
  headings: number
  /** 预计阅读时长（分钟） */
  readingMinutes: number
  todoTotal: number
  todoDone: number
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g
const LATIN_WORD_RE = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g

/** 中英混排的阅读速度：中文 400 字/分，西文 220 词/分 */
const CJK_SPEED = 400
const LATIN_SPEED = 220

export function computeStats(source: string): DocStats {
  const lines = source.split('\n')
  const chars = source.length
  const charsNoSpace = source.replace(/\s/g, '').length

  const cjkCount = (source.match(CJK_RE) ?? []).length
  const latinCount = (source.replace(CJK_RE, ' ').match(LATIN_WORD_RE) ?? []).length

  let paragraphs = 0
  let headings = 0
  let todoTotal = 0
  let todoDone = 0
  let inFence = false
  let fenceChar = ''

  for (const raw of lines) {
    const line = raw.trim()
    const fence = /^(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const ch = fence[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
      }
      continue
    }
    if (inFence) continue

    if (line) paragraphs += 1
    if (/^#{1,6}\s/.test(line)) headings += 1

    if (/^[-*+]\s+\[[ xX]\]/.test(line)) {
      todoTotal += 1
      if (/^[-*+]\s+\[[xX]\]/.test(line)) todoDone += 1
    }
  }

  const minutes = cjkCount / CJK_SPEED + latinCount / LATIN_SPEED

  return {
    chars,
    charsNoSpace,
    words: cjkCount + latinCount,
    lines: lines.length,
    paragraphs,
    headings,
    readingMinutes: minutes > 0 ? Math.max(1, Math.round(minutes)) : 0,
    todoTotal,
    todoDone,
  }
}

export interface TodoHit extends TodoItem {}

/** 归集全文的待办项，供侧栏「待办」视图使用 */
export function collectTodos(source: string): TodoHit[] {
  const out: TodoHit[] = []
  const lines = source.split('\n')
  let inFence = false
  let fenceChar = ''

  lines.forEach((raw, index) => {
    const line = raw.trim()
    const fence = /^(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const ch = fence[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
      }
      return
    }
    if (inFence) return

    const match = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line)
    if (!match) return
    out.push({ done: match[1]!.toLowerCase() === 'x', text: match[2] ?? '', line: index + 1 })
  })

  return out
}
