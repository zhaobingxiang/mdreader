import { getSettings } from '../../core/settings'
import { describeSelection, resolveSelection } from '../../core/ai/providers'
import { aiCancel, aiStartChat, onAiEvent, type AiHostEvent } from '../../core/ai/host'
import type { AiMessage, AiToolSpec } from '../../core/ai/types'
import { nextMeetingRequestId } from './types'

/**
 * 会记的多轮请求执行器。
 *
 * 复用 AI 面板那条宿主通道（密钥、SSE、重试、回退模型都在宿主），但每轮是
 * 一次性请求：不带 ask_user / propose_document，只挂一个本轮的 emit_json 工具，
 * 让模型把结果作为结构化的工具参数交回来。模型不守规矩直接写了正文时，
 * 再从文本里抠 JSON，两路都能走通。
 */

/** 一轮请求没有任何回音多久算超时。网关排队时宿主自己会重发并推 aiRetry */
const IDLE_TIMEOUT_MS = 180_000

export class AiRoundError extends Error {}

/** 模型这一轮说到一半就被长度上限掐断：调用方可以据此换策略（切小输入、压低篇幅） */
export class AiRoundTruncatedError extends AiRoundError {}

export interface AiRoundRequest {
  system: string
  user: string
  /** 本轮期望的 JSON 结构；传了就要求模型必须调用它 */
  tool: AiToolSpec
  maxTokens?: number
  /** 每收到一点正文回调一次，面板用它显示「正在生成」 */
  onDelta?: (text: string) => void
  /** 取消信号：中断本轮并把请求从宿主那边撤掉 */
  signal?: AbortSignal
}

export interface AiRoundOutcome {
  /** 模型返回的原始 JSON 字符串（工具参数或抠出来的文本） */
  raw: string
  /** 本轮实际用的模型名，出错时给用户看 */
  model: string
}

export async function runAiRound(request: AiRoundRequest): Promise<AiRoundOutcome> {
  const settings = getSettings()
  const selection = resolveSelection(settings.ai)
  if (!selection) {
    throw new AiRoundError('还没有可用的模型：请在「设置 → AI 优化」里选择平台与模型')
  }

  const messages: AiMessage[] = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.user },
  ]

  const requestId = nextMeetingRequestId()
  const toolName = request.tool.function.name

  return await new Promise<AiRoundOutcome>((resolve, reject) => {
    let content = ''
    let toolArguments = ''
    let settled = false
    let idleTimer = 0

    const cleanup = (): void => {
      window.clearTimeout(idleTimer)
      off()
      request.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const armIdle = (): void => {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        finish(() => reject(new AiRoundError(`${describeSelection(settings.ai)} 长时间没有响应，请检查网络后重试`)))
      }, IDLE_TIMEOUT_MS)
    }
    const onAbort = (): void => {
      aiCancel(requestId)
      finish(() => reject(new AiRoundError('已取消')))
    }

    const onEvent = (event: AiHostEvent): void => {
      if (event.requestId !== requestId) return
      armIdle()
      switch (event.event) {
        case 'aiDelta':
          if (event.kind === 'content') {
            content += event.text
            request.onDelta?.(event.text)
          }
          break
        case 'aiToolCall':
          if (event.name === toolName) toolArguments = event.arguments
          break
        case 'aiError':
          finish(() => reject(new AiRoundError(event.message)))
          break
        case 'aiDone':
          if (event.cancelled) {
            finish(() => reject(new AiRoundError('已取消')))
            break
          }
          if (event.finishReason === 'length') {
            finish(() => reject(new AiRoundTruncatedError('输出被长度上限截断，请把会议分成更短的片段再分析')))
            break
          }
          {
            const raw = toolArguments.trim() || extractJsonBlock(content)
            if (!raw) {
              finish(() => reject(new AiRoundError('模型没有按约定的 JSON 结构返回结果')))
              break
            }
            finish(() => resolve({ raw, model: selection.model }))
          }
          break
        default:
          break
      }
    }

    const off = onAiEvent(onEvent)
    armIdle()
    request.signal?.addEventListener('abort', onAbort, { once: true })

    void aiStartChat({
      requestId,
      provider: selection.providerId,
      baseUrl: selection.baseUrl,
      model: selection.model,
      messages,
      tools: [request.tool],
      thinkingParam: selection.thinkingParam,
      deepThinking: settings.ai.deepThinking,
      maxTokens: request.maxTokens ?? 8_192,
      fallbackModel: selection.model === selection.fallbackModel ? '' : selection.fallbackModel,
    }).catch((err: unknown) => {
      finish(() => reject(new AiRoundError(err instanceof Error ? err.message : String(err))))
    })
  })
}

/** 解析模型给的 JSON；坏了就返回 null，由调用方决定重试还是降级 */
export function parseJson(raw: string): unknown | null {
  const trimmed = extractJsonBlock(raw)
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 从模型输出里抠出 JSON 对象。
 * 小模型爱在前后加「好的，结果如下：」或代码围栏，取第一个平衡括号块最省事。
 */
function extractJsonBlock(text: string): string {
  const start = text.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      if (inString) escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}
