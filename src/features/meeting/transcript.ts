import type { AsrSegment } from '../../core/file/webview'

/**
 * 转写稿的表示与切分。
 *
 * 分析要带时间戳引用，所以转写稿统一成「片段」列表；没有时间的导入文本
 * 用 start = -1 占位，渲染与提示词都会退化成不带时间的写法。
 */

export type TranscriptSource = 'mic' | 'upload' | 'import'

export interface Transcript {
  segments: AsrSegment[]
  /** 录音总时长（秒）；导入文本为 0 */
  seconds: number
  /** 是否带可用时间戳 */
  timed: boolean
  source: TranscriptSource
}

/** 无时间文本按段落切，每片不超过这么多字（要小于抽取窗口，切细重抽时才有的可切） */
const UNTIMED_WINDOW_CHARS = 1_200

export function fromSegments(segments: AsrSegment[], seconds: number, source: TranscriptSource = 'mic'): Transcript {
  const clean = segments
    .map((s) => ({ start: Math.max(0, Math.round(s.start)), end: Math.max(0, Math.round(s.end)), text: s.text.trim() }))
    .filter((s) => s.text.length > 0)
  return {
    segments: clean,
    seconds: Math.round(seconds),
    timed: clean.length > 0,
    source,
  }
}

export function fromPlainText(name: string, raw: string): Transcript {
  const text = stripTranscriptMarkup(raw)
  const timed = parseTimedEntries(text)
  if (timed) return { segments: timed, seconds: lastEnd(timed), timed: true, source: 'import' }

  const segments: AsrSegment[] = []
  for (const block of splitBlocks(text, UNTIMED_WINDOW_CHARS)) {
    segments.push({ start: -1, end: -1, text: block })
  }
  if (segments.length === 0) throw new Error(`《${name}》里没有可读内容`)
  return { segments, seconds: 0, timed: false, source: 'import' }
}

/** 分析用的纯文本：带时间戳时每行前缀 [mm:ss]，方便模型回指原话 */
export function transcriptText(transcript: Transcript, withClock = true): string {
  return transcript.segments
    .map((s) => {
      const clock = withClock && transcript.timed ? `[${formatClock(s.start)}] ` : ''
      return `${clock}${s.text}`
    })
    .join('\n')
}

export function transcriptCharCount(transcript: Transcript): number {
  return transcript.segments.reduce((sum, s) => sum + s.text.length, 0)
}

/** 切成若干抽取窗口：按片段累加，不超过 maxChars 就不断档，保证引用时间戳连续 */
export function windowsOf(transcript: Transcript, maxChars: number): AsrSegment[][] {
  const out: AsrSegment[][] = []
  let current: AsrSegment[] = []
  let chars = 0
  for (const segment of transcript.segments) {
    if (current.length > 0 && chars + segment.text.length > maxChars) {
      out.push(current)
      current = []
      chars = 0
    }
    current.push(segment)
    chars += segment.text.length
  }
  if (current.length > 0) out.push(current)
  return out
}

export function windowText(window: AsrSegment[], timed: boolean): string {
  return window
    .map((s) => `${timed && s.start >= 0 ? `[${formatClock(s.start)}] ` : ''}${s.text}`)
    .join('\n')
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const pad = (v: number): string => String(v).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '时长未知'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
}

/** 导入的 srt / vtt 里常见的编号行与头，去掉后才是干净文本 */
function stripTranscriptMarkup(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*WEBVTT(\s|$)/.test(line) && !/^\s*\d+\s*$/.test(line) && !/^-->/.test(line))
    .join('\n')
    .trim()
}

const TIME_LINE_RE =
  /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/

/** 逐行扫描：命中时间行的开始时间，把它到下一行之间的正文当一条片段 */
function parseTimedEntries(text: string): AsrSegment[] | null {
  const lines = text.split(/\r?\n/)
  const segments: AsrSegment[] = []
  let start = -1
  let end = -1
  let buffer = ''

  const flush = (): void => {
    const body = buffer.replace(/\s+/g, ' ').trim()
    if (start >= 0 && body) segments.push({ start, end: end > start ? end : start, text: body })
    buffer = ''
  }

  for (const line of lines) {
    const match = TIME_LINE_RE.exec(line)
    if (match) {
      flush()
      start = toSeconds(match[1], match[2], match[3], match[4])
      end = toSeconds(match[5], match[6], match[7], match[8])
      // 时间行后面可能同一行还跟着正文（少见），丢掉不影响语义
      continue
    }
    if (start < 0) {
      // 还没出现时间行：说明不是字幕文件，交给上层按纯文本处理
      if (line.trim()) return null
      continue
    }
    buffer += `${line}\n`
  }
  flush()

  if (segments.length === 0) return null
  // 首尾时间即整段时长；中间的时间戳都保留，供模型引用
  return segments.sort((a, b) => a.start - b.start)
}

function toSeconds(hour: string | undefined, minute: string, second: string, ms: string): number {
  const h = hour ? Number.parseInt(hour.replace(':', ''), 10) : 0
  return h * 3600 + Number.parseInt(minute, 10) * 60 + Number.parseInt(second, 10) + Number.parseInt(ms, 10) / 1000
}

function lastEnd(segments: AsrSegment[]): number {
  return segments.reduce((max, s) => Math.max(max, s.end), 0)
}

/** 按空行分段，超长的段再按字数硬切，保证每片能塞进一轮请求 */
function splitBlocks(text: string, maxChars: number): string[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.replace(/[ \t]+/g, ' ').trim())
    .filter((b) => b.length > 0)
  const out: string[] = []
  for (const block of blocks) {
    if (block.length <= maxChars) {
      out.push(block)
      continue
    }
    for (let offset = 0; offset < block.length; offset += maxChars) {
      out.push(block.slice(offset, offset + maxChars))
    }
  }
  return out
}
