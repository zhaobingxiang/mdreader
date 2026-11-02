/**
 * 会记的数据模型。
 *
 * 模型每轮都只回一个 JSON 对象（通过 emit_json 工具强制），这里逐字段做容错清洗：
 * 大模型给的结构永远比想象中野，宁可丢字段也不能让整条流水线崩掉。
 */

export type MeetingStage =
  | 'idle'
  | 'engine'
  | 'recording'
  | 'uploading'
  | 'transcribing'
  | 'extracting'
  | 'merging'
  | 'checking'
  | 'revising'
  | 'rendering'
  | 'done'
  | 'failed'

/** 一次会记流程的进度快照，面板按它重绘 */
export interface MeetingProgress {
  stage: MeetingStage
  /** 当前阶段的一句话说明 */
  status: string
  /** 0-100；-1 表示不确定 */
  percent: number
  /** 阶段内的细分计数，如「第 2/5 段」 */
  detail: string
  error: string | null
}

// ---------- 与宿主界面的接缝 ----------

/** 用户在 mdreader 里正在写的那份文档：会记要综合它来分析 */
export interface MeetingDocContext {
  name: string
  text: string
}

/**
 * app.ts 注入的能力集合，让会记模块不反向依赖界面。
 * 浏览器版 desktop=false：没有宿主，只能走「导入转写文本」。
 */
export interface MeetingContext {
  desktop: boolean
  readDocument(): MeetingDocContext
  /** 纪要开成一个新的可编辑标签页 */
  openMinutes(markdown: string, name: string): void
  notice(message: string): void
  /** 确认可以把会议内容发给模型；模型没配好时由它引导去设置 */
  ensureAiUsable(): Promise<boolean>
  showSettings(): void
}

// ---------- 分析产物 ----------

export interface MinutesRow {
  /** 议题 / 行动项 / 风险，各表复用这个结构 */
  title: string
  detail: string
  owner: string
  due: string
  /** 转写稿里的时间戳引用，如 00:12:30；无时间稿为空 */
  refs: string[]
  /** 模型自己标注的不确定项 */
  uncertain: boolean
}

export interface ReportSection {
  heading: string
  /** 每项一个自然段或要点 */
  paragraphs: string[]
}

export interface MeetingDigest {
  /** 会议基本信息：主题、时间、参会人等，键固定顺序由渲染层决定 */
  info: { label: string; value: string; uncertain: boolean }[]
  summary: string[]
  topics: MinutesRow[]
  decisions: MinutesRow[]
  actions: MinutesRow[]
  risks: MinutesRow[]
  openQuestions: string[]
  report: ReportSection[]
  timeline: { time: string; text: string }[]
  /** 存疑专名与同音字，供人工核对 */
  terms: { word: string; note: string }[]
}

export interface CheckIssue {
  /** 出问题的位置说明，如「行动项第 3 条」 */
  where: string
  problem: string
  fix: string
  severity: 'warning' | 'info'
}

export interface PartialDigest {
  windowIndex: number
  topics: MinutesRow[]
  decisions: MinutesRow[]
  actions: MinutesRow[]
  risks: MinutesRow[]
  timeline: { time: string; text: string }[]
  terms: { word: string; note: string }[]
}

// ---------- 请求 id ----------

/**
 * 事件里的 requestId 由页面自己编号。AI 面板的会话用的是一号段，
 * 会记另起 50 万起，保证两边同时在跑时事件不会被错认。
 */
let requestSeq = 500_000

export function nextMeetingRequestId(): number {
  requestSeq += 1
  return requestSeq
}

let sessionSeq = 0

/** 一次录音/上传对应宿主侧一个 wav，key 即文件名 */
export function nextMeetingKey(): string {
  sessionSeq += 1
  return `m${Date.now().toString(36)}${sessionSeq.toString(36)}`
}

// ---------- 清洗 ----------

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return value === '是' || value === 'true' || value === 1
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(str).filter((s) => s !== '').slice(0, 24)
  }
  const single = str(value)
  return single ? [single] : []
}

function row(value: unknown): MinutesRow | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const title = str(obj.title ?? obj.topic ?? obj.item ?? obj.name)
  const detail = str(obj.detail ?? obj.content ?? obj.description ?? obj.discussion)
  if (!title && !detail) return null
  return {
    title: title || detail.slice(0, 24),
    detail: detail || title,
    owner: str(obj.owner ?? obj.responsible),
    due: str(obj.due ?? obj.deadline),
    refs: strList(obj.refs ?? obj.evidence ?? obj.timestamps),
    uncertain: bool(obj.uncertain),
  }
}

function rowList(value: unknown): MinutesRow[] {
  if (!Array.isArray(value)) return []
  return value.map(row).filter((r): r is MinutesRow => r !== null).slice(0, 40)
}

export function emptyDigest(): MeetingDigest {
  return {
    info: [],
    summary: [],
    topics: [],
    decisions: [],
    actions: [],
    risks: [],
    openQuestions: [],
    report: [],
    timeline: [],
    terms: [],
  }
}

export function sanitizeDigest(value: unknown): MeetingDigest {
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const infoRaw = Array.isArray(obj.info) ? obj.info : []
  const digest = emptyDigest()
  digest.info = infoRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const label = str(entry.label ?? entry.key)
      const entryValue = str(entry.value)
      if (!label || !entryValue) return null
      return { label, value: entryValue, uncertain: bool(entry.uncertain) }
    })
    .filter((x): x is MeetingDigest['info'][number] => x !== null)
    .slice(0, 10)
  digest.summary = strList(obj.summary).slice(0, 8)
  digest.topics = rowList(obj.topics)
  digest.decisions = rowList(obj.decisions)
  digest.actions = rowList(obj.actions)
  digest.risks = rowList(obj.risks)
  digest.openQuestions = strList(obj.openQuestions).slice(0, 10)
  digest.report = (Array.isArray(obj.report) ? obj.report : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const heading = str(entry.heading ?? entry.title)
      const paragraphs = strList(entry.paragraphs ?? entry.points)
      if (!heading || paragraphs.length === 0) return null
      return { heading, paragraphs }
    })
    .filter((x): x is ReportSection => x !== null)
    .slice(0, 10)
  digest.timeline = (Array.isArray(obj.timeline) ? obj.timeline : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const time = str(entry.time)
      const text = str(entry.text ?? entry.event)
      if (!text) return null
      return { time, text }
    })
    .filter((x): x is MeetingDigest['timeline'][number] => x !== null)
    .slice(0, 30)
  digest.terms = (Array.isArray(obj.terms) ? obj.terms : [])
    .map((item) => {
      if (typeof item === 'string') return { word: item, note: '存疑用词' }
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const word = str(entry.word ?? entry.term)
      if (!word) return null
      return { word, note: str(entry.note) || '存疑用词' }
    })
    .filter((x): x is MeetingDigest['terms'][number] => x !== null)
    .slice(0, 20)
  return digest
}

export function sanitizePartial(value: unknown, windowIndex: number): PartialDigest {
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    windowIndex,
    topics: rowList(obj.topics),
    decisions: rowList(obj.decisions),
    actions: rowList(obj.actions),
    risks: rowList(obj.risks),
    timeline: (Array.isArray(obj.timeline) ? obj.timeline : [])
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const entry = item as Record<string, unknown>
        const text = str(entry.text ?? entry.event)
        if (!text) return null
        return { time: str(entry.time), text }
      })
      .filter((x): x is { time: string; text: string } => x !== null)
      .slice(0, 20),
    terms: (Array.isArray(obj.terms) ? obj.terms : [])
      .map((item) => {
        if (typeof item === 'string') return { word: item, note: '存疑用词' }
        if (!item || typeof item !== 'object') return null
        const entry = item as Record<string, unknown>
        const word = str(entry.word ?? entry.term)
        if (!word) return null
        return { word, note: str(entry.note) || '存疑用词' }
      })
      .filter((x): x is { word: string; note: string } => x !== null)
      .slice(0, 12),
  }
}

export function sanitizeIssues(value: unknown): CheckIssue[] {
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const raw = Array.isArray(obj.issues) ? obj.issues : []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const problem = str(entry.problem ?? entry.message)
      if (!problem) return null
      return {
        where: str(entry.where) || '未指明位置',
        problem,
        fix: str(entry.fix) || str(entry.suggestion),
        severity: str(entry.severity) === 'info' ? 'info' : 'warning',
      } as CheckIssue
    })
    .filter((x): x is CheckIssue => x !== null)
    .slice(0, 16)
}

/** 各窗口抽取结果合并成一份候选纪要（归并轮之前先做一次机械去重） */
export function mergePartials(partials: PartialDigest[]): MeetingDigest {
  const digest = emptyDigest()
  const seen = new Set<string>()
  const push = (list: MinutesRow[], target: MinutesRow[]): void => {
    for (const item of list) {
      const key = `${item.title}|${item.detail}`.replace(/\s+/g, '')
      if (seen.has(key)) continue
      seen.add(key)
      target.push(item)
    }
  }
  const timeSeen = new Set<string>()
  for (const partial of partials) {
    push(partial.topics, digest.topics)
    push(partial.decisions, digest.decisions)
    push(partial.actions, digest.actions)
    push(partial.risks, digest.risks)
    for (const event of partial.timeline) {
      const key = `${event.time}|${event.text}`
      if (timeSeen.has(key)) continue
      timeSeen.add(key)
      digest.timeline.push(event)
    }
    for (const term of partial.terms) {
      if (digest.terms.some((t) => t.word === term.word)) continue
      digest.terms.push(term)
    }
  }
  return digest
}
