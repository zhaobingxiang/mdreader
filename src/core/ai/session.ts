import { getSettings } from '../settings'
import { resolveSelection, type AiSelection } from './providers'
import { aiCancel, aiStartChat, aiWriteWorkfile, aiClearWorkfile, onAiEvent, type AiHostEvent } from './host'
import { AI_TOOLS, parseToolArguments, type AiAsk, type AiMessage, type AiProposal, type AiSuggestItem, type AiToolCall, type AiUsage } from './types'
import {
  buildAskAnswer,
  buildOptimizeInstruction,
  buildSuggestInstruction,
  buildSystemPrompt,
  clipDocument,
  MAX_DOC_CHARS,
} from './prompts'

export type AiPhase = 'idle' | 'running' | 'awaiting' | 'proposal' | 'error'
type RunMode = 'document' | 'suggestions'

export interface AiTurn {
  role: 'user' | 'assistant' | 'note'
  text: string
}

export interface AiStream {
  content: string
  reasoning: string
  /** 重试提示：网关繁忙时告诉用户还在等，不要以为是卡死 */
  retryNote: string | null
}

export interface AiSessionState {
  phase: AiPhase
  turns: AiTurn[]
  stream: AiStream
  ask: AiAsk | null
  proposal: AiProposal | null
  /** 提案所基于的文档原文：文档一改就说明提案过期了 */
  proposalBase: string | null
  suggestions: AiSuggestItem[]
  suggestionsBase: string | null
  error: string | null
  status: string
  usage: AiUsage | null
  selection: AiSelection | null
  /** 文档超长被截断时提示用户只送去前 N 字 */
  truncated: boolean
}

let requestSeq = 0
function nextRequestId(): number {
  requestSeq += 1
  return requestSeq
}

let sessionSeq = 0
function nextSessionId(): string {
  sessionSeq += 1
  return `tab${sessionSeq}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const EMPTY_STREAM = (): AiStream => ({ content: '', reasoning: '', retryNote: null })

/**
 * 一个标签页一个会话。文档正文不留在对话历史里：
 * 每次请求都把最新文档拼进 system 消息，历史只留用户指令与模型回复，
 * 这样文档改动后不会被旧快照误导，长对话也不会无限膨胀。
 */
export class AiSession {
  readonly id = nextSessionId()

  private state: AiSessionState = {
    phase: 'idle',
    turns: [],
    stream: EMPTY_STREAM(),
    ask: null,
    proposal: null,
    proposalBase: null,
    suggestions: [],
    suggestionsBase: null,
    error: null,
    status: '',
    usage: null,
    selection: null,
    truncated: false,
  }

  private history: AiMessage[] = []
  private activeRequest = 0
  private activeMode: RunMode = 'document'
  /** ask_user 的 tool_call id：等用户回答后要补一条 tool 结果，协议才完整 */
  private pendingAskCallId: string | null = null
  private toolCalls: AiToolCall[] = []
  private disposers: (() => void)[] = []
  private readonly listeners = new Set<(s: AiSessionState) => void>()
  private cancelTimer = 0

  constructor(private readonly readDoc: () => { name: string; text: string }) {
    this.disposers.push(onAiEvent((event) => this.onHostEvent(event)))
  }

  get snapshot(): AiSessionState {
    return this.state
  }

  get busy(): boolean {
    return this.state.phase === 'running'
  }

  /** 最近一次请求的类型：书写建议是旁路请求，界面要分开显示状态 */
  get mode(): RunMode {
    return this.activeMode
  }

  subscribe(cb: (s: AiSessionState) => void): () => void {
    this.listeners.add(cb)
    cb(this.state)
    return () => {
      this.listeners.delete(cb)
    }
  }

  dispose(): void {
    this.cancel()
    for (const off of this.disposers) off()
    this.disposers = []
    this.listeners.clear()
  }

  // ---------- 对外动作 ----------

  /** 自动优化：对当前文档做格式 + 表述改写；direction 是用户补的优化方向 */
  optimize(direction?: string): void {
    if (this.busy) return
    this.dropPendingAsk()
    this.state.ask = null
    this.state.error = null
    this.clearOldProposal()
    this.setPhase('running')
    const text = buildOptimizeInstruction(direction)
    this.history.push({ role: 'user', content: text })
    this.state.turns.push({ role: 'user', text: direction?.trim() ? direction.trim() : '优化当前文档' })
    this.begin('document')
  }

  /** AI 面板里的自由对话：同样允许模型提问和提交改写稿 */
  chat(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.busy) return
    this.dropPendingAsk()
    this.state.ask = null
    this.state.error = null
    this.clearOldProposal()
    this.setPhase('running')
    this.history.push({ role: 'user', content: trimmed })
    this.state.turns.push({ role: 'user', text: trimmed })
    this.begin('document')
  }

  /** 回答模型的反问，然后让它继续 */
  answer(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.busy) return
    const callId = this.pendingAskCallId
    this.pendingAskCallId = null
    this.state.ask = null
    this.state.error = null
    if (callId) this.history.push({ role: 'tool', tool_call_id: callId, content: buildAskAnswer(trimmed) })
    this.state.turns.push({ role: 'user', text: trimmed })
    this.setPhase('running')
    this.begin(this.activeMode)
  }

  /** 切换平台 / 模型后留一行提示：只显示，不进对话历史、不发给模型 */
  addNote(text: string): void {
    this.state.turns.push({ role: 'note', text })
    this.emit()
  }

  /** 书写提示里的 AI 建议：只读，不改文档 */
  suggest(): void {
    if (this.busy) return
    this.dropPendingAsk()
    this.state.ask = null
    this.state.error = null
    this.setPhase('running')
    this.state.status = '正在通读文档…'
    this.begin('suggestions')
  }

  cancel(): void {
    if (!this.activeRequest) return
    aiCancel(this.activeRequest)
    this.state.status = '正在停止…'
    this.emit()
    // 宿主偶尔来不及回 aiDone（比如请求恰好刚结束），兜底回到空闲
    window.clearTimeout(this.cancelTimer)
    this.cancelTimer = window.setTimeout(() => {
      if (this.state.phase === 'running') {
        this.activeRequest = 0
        this.state.stream = EMPTY_STREAM()
        this.setPhase('idle')
        this.state.status = '已停止'
        this.emit()
      }
    }, 2000)
  }

  /** 提案被采纳或被丢弃后收起 */
  clearProposal(): void {
    this.state.proposal = null
    this.state.proposalBase = null
    if (this.state.phase === 'proposal') this.setPhase('idle')
    this.emit()
  }

  /** 清空对话与产物 */
  reset(): void {
    this.cancel()
    this.history = []
    this.pendingAskCallId = null
    this.state = {
      ...this.state,
      phase: 'idle',
      turns: [],
      stream: EMPTY_STREAM(),
      ask: null,
      proposal: null,
      proposalBase: null,
      suggestions: [],
      suggestionsBase: null,
      error: null,
      status: '',
      usage: null,
      truncated: false,
    }
    aiClearWorkfile(this.id)
    this.emit()
  }

  // ---------- 请求生命周期 ----------

  private begin(mode: RunMode): void {
    this.activeMode = mode
    this.toolCalls = []
    this.state.stream = EMPTY_STREAM()
    this.state.usage = null
    this.state.error = null
    this.state.status = mode === 'suggestions' ? '正在通读文档…' : '正在思考…'

    const settings = getSettings()
    const selection = resolveSelection(settings.ai)
    this.state.selection = selection
    if (!selection) {
      this.fail('还没有可用的模型：请在「设置 → AI 优化」里选择平台与模型')
      return
    }

    const doc = clipDocument(this.readDoc().text)
    this.state.truncated = doc.truncated
    const messages: AiMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(mode, { name: this.readDoc().name, text: doc.text, truncated: doc.truncated }, selection),
      },
      ...this.trimHistory(this.history),
    ]
    if (mode === 'suggestions') messages.push({ role: 'user', content: buildSuggestInstruction() })

    const requestId = nextRequestId()
    this.activeRequest = requestId
    this.emit()

    aiStartChat({
      requestId,
      provider: selection.providerId,
      baseUrl: selection.baseUrl,
      model: selection.model,
      messages,
      tools: AI_TOOLS,
      thinkingParam: selection.thinkingParam,
      deepThinking: settings.ai.deepThinking,
      maxTokens: mode === 'suggestions' ? 4096 : 16_384,
      fallbackModel: selection.model === selection.fallbackModel ? '' : selection.fallbackModel,
    }).catch((err: unknown) => {
      if (this.activeRequest !== requestId) return
      this.fail(err instanceof Error ? err.message : String(err))
    })
  }

  private onHostEvent(event: AiHostEvent): void {
    if (!this.activeRequest || event.requestId !== this.activeRequest) return
    switch (event.event) {
      case 'aiDelta':
        if (event.kind === 'reasoning') {
          this.state.stream.reasoning += event.text
          this.state.status = '正在思考…'
        } else {
          this.state.stream.content += event.text
          this.state.status = '正在生成…'
        }
        this.state.stream.retryNote = null
        this.emit()
        break
      case 'aiToolCall':
        this.toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
        this.emit()
        break
      case 'aiRetry':
        this.state.stream.retryNote = `网关繁忙，${Math.round(event.delayMs / 1000)} 秒后重试（第 ${event.attempt} 次）`
        this.state.status = this.state.stream.retryNote
        this.emit()
        break
      case 'aiModelFallback':
        this.addNote(`${event.from} 当前不可用，这次改用 ${event.to}`)
        break
      case 'aiError':
        this.fail(event.message)
        break
      case 'aiDone':
        this.finish(event.cancelled, event.finishReason, event.usage)
        break
      default:
        break
    }
  }

  private finish(cancelled: boolean, finishReason?: string, usage?: Record<string, number>): void {
    window.clearTimeout(this.cancelTimer)
    this.activeRequest = 0
    // 书写建议是旁路请求，它的 token 不该记到文档会话头上
    this.state.usage = this.activeMode === 'suggestions' ? null : usage ?? null

    if (cancelled) {
      this.state.stream = EMPTY_STREAM()
      this.setPhase('idle')
      this.state.status = '已停止'
      this.emit()
      this.persist()
      return
    }

    const content = this.state.stream.content.trim()
    const calls = this.toolCalls
    const isolated = this.activeMode === 'suggestions'
    this.toolCalls = []

    // 书写建议是一次性旁路请求：不写进文档对话历史，免得污染后续优化
    if (!isolated) {
      if (calls.length > 0) {
        this.history.push({ role: 'assistant', content, tool_calls: calls })
      } else if (content) {
        this.history.push({ role: 'assistant', content })
      }
      if (content) this.state.turns.push({ role: 'assistant', text: content })
    }

    let handled = false
    for (const call of calls) {
      const args = parseToolArguments(call.arguments) ?? {}
      if (call.name === 'ask_user') {
        const question = typeof args.question === 'string' ? args.question.trim() : ''
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 4)
          : []
        if (question) {
          this.pendingAskCallId = call.id
          this.state.ask = { question, options }
          this.setPhase('awaiting')
          this.state.status = ''
          handled = true
          continue
        }
      }
      if (call.name === 'propose_document' && this.activeMode === 'document') {
        const markdown = typeof args.markdown === 'string' ? args.markdown : ''
        if (markdown.trim()) {
          this.state.proposal = {
            title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'AI 优化稿',
            markdown,
          }
          this.state.proposalBase = this.readDoc().text
          this.setPhase('proposal')
          this.state.status = ''
          this.history.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' })
          handled = true
          continue
        }
      }
      if (call.name === 'report_suggestions') {
        const raw = Array.isArray(args.suggestions) ? args.suggestions : []
        this.state.suggestions = raw
          .map((item): AiSuggestItem | null => {
            const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
            const message = typeof obj.message === 'string' ? obj.message.trim() : ''
            if (!message) return null
            const severity: AiSuggestItem['severity'] = obj.severity === 'warning' ? 'warning' : 'info'
            const out: AiSuggestItem = { message, severity }
            if (typeof obj.line === 'number' && obj.line > 0) out.line = Math.round(obj.line)
            return out
          })
          .filter((s): s is AiSuggestItem => s !== null)
          .slice(0, 12)
        this.state.suggestionsBase = this.readDoc().text
        if (!isolated) this.history.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' })
        this.setPhase('idle')
        this.state.status = this.state.suggestions.length > 0 ? '' : '没有发现需要改的地方'
        handled = true
        continue
      }
      // 未知工具：补一条失败结果，避免下一次请求因缺 tool 响应被拒
      if (!isolated) {
        this.history.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":false,"error":"unsupported tool"}' })
      }
    }

    if (!handled) {
      if (finishReason === 'length') {
        this.fail('输出达到单次长度上限被截断：文档可能过长，请分章节优化')
        return
      }
      if (!content && calls.length === 0) {
        this.fail('模型没有返回内容')
        return
      }
      this.setPhase('idle')
      this.state.status = ''
    }

    this.emit()
    this.persist()
  }

  private fail(message: string): void {
    window.clearTimeout(this.cancelTimer)
    this.activeRequest = 0
    this.state.stream = EMPTY_STREAM()
    this.state.error = message
    this.setPhase('error')
    this.state.status = ''
    this.emit()
  }

  private setPhase(phase: AiPhase): void {
    this.state.phase = phase
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state)
  }

  /** 新一轮开始后旧稿必然过期，留着只会让人误以为是这次的结果 */
  private clearOldProposal(): void {
    this.state.proposal = null
    this.state.proposalBase = null
  }

  /** 用户跳过反问直接给新指令：补一条 tool 结果，历史里才不会留下没有回应的 tool_calls */
  private dropPendingAsk(): void {
    const callId = this.pendingAskCallId
    if (!callId) return
    this.pendingAskCallId = null
    this.history.push({
      role: 'tool',
      tool_call_id: callId,
      content: '{"answered":false,"note":"用户跳过了这个问题，请按新指令继续"}',
    })
  }

  /** 只留最近若干轮，且不能从孤立的 tool 结果或 tool_calls 中间截断 */
  private trimHistory(history: AiMessage[]): AiMessage[] {
    const kept = history.slice(-12)
    while (kept.length > 0 && (kept[0]!.role === 'tool' || (kept[0]!.tool_calls?.length ?? 0) > 0)) {
      kept.shift()
    }
    return kept
  }

  private persist(): void {
    const payload = {
      sessionId: this.id,
      updatedAt: new Date().toISOString(),
      turns: this.state.turns,
      usage: this.state.usage,
    }
    void aiWriteWorkfile(this.id, 'conversation.json', JSON.stringify(payload, null, 2))
    if (this.state.proposal) {
      void aiWriteWorkfile(this.id, 'proposal.md', this.state.proposal.markdown)
    }
  }
}

export { MAX_DOC_CHARS }
