import { runAiRound, parseJson, AiRoundError, AiRoundTruncatedError } from './ai'
import {
  MAX_TRANSCRIPT_CHARS_PER_WINDOW,
  buildCheckPrompt,
  buildExtractPrompt,
  buildMergePrompt,
  buildRevisePrompt,
  digestTool,
  extractTool,
  issuesTool,
} from './prompts'
import { windowText, windowsOf, type Transcript } from './transcript'
import type { AsrSegment } from '../../core/file/webview'
import {
  mergePartials,
  sanitizeDigest,
  sanitizeIssues,
  sanitizePartial,
  type CheckIssue,
  type MeetingDigest,
  type MeetingDocContext,
  type PartialDigest,
} from './types'

/**
 * 多轮分析流水线。
 *
 * 抽取（按窗口 N 轮）→ 归并 → 内容检查 → 修订。
 * 每轮只要求模型做一件小事，出问题重试一轮，整条链最多四次模型故障才放弃；
 * 检查轮必须真回指转写原文，这是本地语音转写同音字风险的兜底。
 */

/** 单轮失败后的重试次数（不含首次） */
const ROUND_RETRIES = 1

/** 一段抽取得再小也不至于截断的字数，切到这儿还截就认输 */
const MIN_SPLIT_WINDOW_CHARS = 800

/** 抽取轮的一次工作项：一段连续的转写片段，seq 是它原来的窗口序号（仅用于标识） */
interface ExtractJob {
  segments: AsrSegment[]
  seq: number
}

type ExtractResult =
  | { kind: 'ok'; partial: PartialDigest }
  | { kind: 'failed'; message: string }
  | { kind: 'truncated'; message: string }

/** 还能不能切细：至少两条片段，且合起来仍超过一轮的安全字数 */
function splittable(job: ExtractJob): boolean {
  if (job.segments.length < 2) return false
  return job.segments.reduce((sum, s) => sum + s.text.length, 0) > MIN_SPLIT_WINDOW_CHARS
}

export interface AnalyzeProgress {
  stage: 'extracting' | 'merging' | 'checking' | 'revising'
  status: string
  /** 0-100，整条流水线的进度 */
  percent: number
  detail: string
}

export interface AnalyzeOutcome {
  digest: MeetingDigest
  issues: CheckIssue[]
  /** 实际成功执行的模型请求数 */
  rounds: number
}

export class AnalyzeError extends Error {}

function digestAsJson(digest: MeetingDigest): string {
  return JSON.stringify(
    {
      info: digest.info,
      summary: digest.summary,
      topics: digest.topics,
      decisions: digest.decisions,
      actions: digest.actions,
      risks: digest.risks,
      openQuestions: digest.openQuestions,
      report: digest.report,
      timeline: digest.timeline,
      terms: digest.terms,
    },
    null,
    1,
  )
}

/** 重试时附加的硬性压缩要求：模型上一轮被长度上限截断，原样再问一次只会再截一次 */
function tighten(system: string, attempt: number): string {
  if (attempt === 0) return system
  return `${system}\n\n上一次你的输出超出了长度上限被截断，整轮结果作废。这一次收紧：detail 每条不超过 40 字，report 每节 2 段、每段不超过 80 字，条目数砍半（只留有出处的），先保证 JSON 完整收尾。`
}

/** 跑一轮，坏 JSON / 网络抖动都算失败重来；重试耗尽抛出最后一次的错误 */
async function roundWithRetry<T>(
  label: string,
  attempt: (retryIndex: number) => Promise<T>,
  onNote: (note: string) => void,
): Promise<T> {
  let lastError = ''
  for (let i = 0; i <= ROUND_RETRIES; i += 1) {
    try {
      return await attempt(i)
    } catch (err) {
      if (err instanceof AiRoundError && err.message === '已取消') throw err
      lastError = err instanceof Error ? err.message : String(err)
      onNote(i < ROUND_RETRIES ? `${label}没成功（${lastError}），正在重试…` : `${label}失败：${lastError}`)
    }
  }
  throw new AnalyzeError(`${label}失败：${lastError}`)
}

export async function analyzeTranscript(
  transcript: Transcript,
  doc: MeetingDocContext,
  signal: AbortSignal,
  onProgress: (p: AnalyzeProgress) => void,
): Promise<AnalyzeOutcome> {
  let rounds = 0
  const notify = (stage: AnalyzeProgress['stage'], percent: number, status: string, detail = ''): void => {
    onProgress({ stage, percent, status, detail })
  }

  const windows = windowsOf(transcript, MAX_TRANSCRIPT_CHARS_PER_WINDOW)
  if (windows.length === 0) throw new AnalyzeError('转写稿是空的，没有可分析的内容')

  // ---------- 第 1 阶段：分段抽取 ----------
  const jobs: ExtractJob[] = windows.map((segments, index) => ({ segments, seq: index }))

  const runExtractRound = async (job: ExtractJob, position: number, retry = 0): Promise<ExtractResult> => {
    notify(
      'extracting',
      Math.round((position / Math.max(1, jobs.length)) * 45),
      `正在抽取第 ${position + 1}/${jobs.length} 段`,
      `${Math.round(((position + 1) / Math.max(1, jobs.length)) * 100)}%`,
    )
    try {
      const base = buildExtractPrompt(doc, transcript, windowText(job.segments, transcript.timed), position, jobs.length)
      const outcome = await runAiRound({
        system: tighten(base.system, retry),
        user: base.user,
        tool: extractTool(),
        maxTokens: 8_192,
        signal,
      })
      rounds += 1
      const parsed = parseJson(outcome.raw)
      if (!parsed) return { kind: 'failed', message: '返回的不是合法 JSON' }
      return { kind: 'ok', partial: sanitizePartial(parsed, job.seq) }
    } catch (err) {
      if (err instanceof AiRoundError && err.message === '已取消') throw err
      const message = err instanceof Error ? err.message : String(err)
      return { kind: err instanceof AiRoundTruncatedError ? 'truncated' : 'failed', message }
    }
  }

  const partials: PartialDigest[] = []
  for (let i = 0; i < jobs.length; i += 1) {
    if (signal.aborted) throw new AiRoundError('已取消')
    const job = jobs[i] as ExtractJob
    let result = await runExtractRound(job, i)

    // 一轮说不完就切细再说：输出被长度上限截断时，重试同样的切片只会再截一次
    if (result.kind === 'truncated' && splittable(job)) {
      const mid = Math.ceil(job.segments.length / 2)
      // 两半仍算同一个来源窗口：seq 只是给归并轮看的标识，不必也不该编新号
      jobs.splice(i, 1, { segments: job.segments.slice(0, mid), seq: job.seq }, { segments: job.segments.slice(mid), seq: job.seq })
      i -= 1
      continue
    }
    if (result.kind !== 'ok') {
      const note = result.kind === 'truncated' ? `${result.message}（已拆到最小，仍放不下）` : result.message
      notify('extracting', Math.round((i / jobs.length) * 45), `这一段抽取没成功（${note}），正在重试…`, '')
      result = await runExtractRound(job, i, 1)
      if (result.kind !== 'ok') {
        throw new AnalyzeError(`第 ${i + 1} 段抽取失败：${result.kind === 'truncated' ? note : result.message}`)
      }
    }
    partials.push(result.partial)
  }

  // ---------- 第 2 阶段：归并 ----------
  /** 哪一轮没跑成要如实记下来，最后作为「内容检查」条目交给用户，不能假装检查过了 */
  const caveats: string[] = []
  notify('merging', 55, '正在合并各段结果并对照你的文档…', `共 ${partials.length} 段`)
  const mergedByModel = await roundWithRetry(
    '归并',
    async (retry) => {
      const base = buildMergePrompt(doc, transcript, JSON.stringify(partials, null, 1))
      const outcome = await runAiRound({
        system: tighten(base.system, retry),
        user: base.user,
        tool: digestTool(),
        maxTokens: 12_288,
        signal,
      })
      rounds += 1
      const parsed = parseJson(outcome.raw)
      if (!parsed) throw new AiRoundError('返回的不是合法 JSON')
      const digest = sanitizeDigest(parsed)
      if (digest.topics.length === 0 && digest.decisions.length === 0 && digest.actions.length === 0) {
        throw new AiRoundError('归并结果里没有议题、决议和行动项')
      }
      return digest
    },
    (note) => notify('merging', 55, note, ''),
  ).catch((err: unknown) => {
    // 归并彻底失败也不能一无所获：机械合并抽取结果，后面照样能出纪要
    if (err instanceof AiRoundError && err.message === '已取消') throw err
    caveats.push('归并轮没跑成，纪要按各段抽取结果机械合并，没有跨段去重，也没对照你的文档做归纳')
    return mergePartials(partials)
  })

  let digest = mergedByModel
  if (digest.summary.length === 0) {
    digest.summary = digest.topics.slice(0, 4).map((topic) => topic.title)
  }

  // ---------- 第 3 阶段：内容检查 ----------
  notify('checking', 70, '正在逐条回指转写原文做内容检查…', '')
  const issues = await roundWithRetry(
    '内容检查',
    async (retry) => {
      const base = buildCheckPrompt(doc, transcript, digestAsJson(digest))
      const outcome = await runAiRound({
        system: tighten(base.system, retry),
        user: base.user,
        tool: issuesTool(),
        maxTokens: 12_288,
        signal,
      })
      rounds += 1
      const parsed = parseJson(outcome.raw)
      if (!parsed) throw new AiRoundError('返回的不是合法 JSON')
      return sanitizeIssues(parsed)
    },
    (note) => notify('checking', 70, note, ''),
  ).catch((err: unknown) => {
    if (err instanceof AiRoundError && err.message === '已取消') throw err
    caveats.push(`内容检查轮没跑成（${err instanceof Error ? err.message : String(err)}），这份纪要没有经过逐条回指原文的二次核对`)
    return [] as CheckIssue[]
  })

  // ---------- 第 4 阶段：修订（有问题才修） ----------
  if (issues.length > 0 && !signal.aborted) {
    notify('revising', 82, `发现 ${issues.length} 处需要核对，正在修订…`, '')
    const revised = await roundWithRetry(
      '修订',
      async (retry) => {
        const base = buildRevisePrompt(doc, transcript, digestAsJson(digest), JSON.stringify(issues, null, 1))
        const outcome = await runAiRound({
          system: tighten(base.system, retry),
          user: base.user,
          tool: digestTool(),
          maxTokens: 12_288,
          signal,
        })
        rounds += 1
        const parsed = parseJson(outcome.raw)
        if (!parsed) throw new AiRoundError('返回的不是合法 JSON')
        const next = sanitizeDigest(parsed)
        if (next.topics.length === 0 && next.actions.length === 0) throw new AiRoundError('修订后内容反而缺失')
        return next
      },
      (note) => notify('revising', 82, note, ''),
    ).catch((err: unknown) => {
      if (err instanceof AiRoundError && err.message === '已取消') throw err
      caveats.push('修订轮没跑成，纪要保留了修订前的版本，检查发现的问题没有逐条落实')
      return digest
    })
    digest = revised
  }

  notify('revising', 95, '分析完成，正在生成纪要与报告…', '')
  const notes: CheckIssue[] = caveats.map((problem) => ({
    where: '分析过程',
    problem,
    fix: '可以重新分析一次；仍然不行就人工核对该部分',
    severity: 'warning',
  }))
  return { digest, issues: [...issues, ...notes], rounds }
}
