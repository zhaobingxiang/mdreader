import { callHost, onHostEvent, type HostEvent } from '../file/webview'
import type { AiMessage, AiToolSpec, AiUsage } from './types'
import type { ThinkingParam } from './providers'

/**
 * AI 能力的宿主侧入口。
 * 网络请求、密钥、SSE 解析全在宿主；页面只发参数、收事件，
 * 所以页面跑在 mdreader.local 也不会有 CORS 问题，密钥也不进 JS 内存。
 */

export interface AiKeyStatus {
  hasKey: boolean
  tail: string
  /** 没有自配 Key、走的是内置公共 Key */
  builtin: boolean
}

export interface AiModelsResult {
  models?: string[]
  /** 平台没有 /models 接口（Lanz） */
  unsupported?: boolean
}

export interface AiChatPayload {
  requestId: number
  provider: string
  baseUrl: string
  model: string
  messages: AiMessage[]
  tools?: AiToolSpec[]
  thinkingParam: ThinkingParam
  deepThinking: boolean
  maxTokens: number
  /** 平台上没有这个模型时，宿主改用它的回退模型再发一次 */
  fallbackModel?: string
}

export function aiStatus(provider: string): Promise<AiKeyStatus> {
  return callHost<AiKeyStatus>('aiStatus', { provider })
}

export function aiSetKey(provider: string, key: string): Promise<AiKeyStatus> {
  return callHost<AiKeyStatus>('aiSetKey', { provider, key })
}

export function aiListModels(provider: string, baseUrl: string): Promise<AiModelsResult> {
  return callHost<AiModelsResult>('aiListModels', { provider, baseUrl })
}

export function aiStartChat(payload: AiChatPayload): Promise<{ started: boolean; requestId: number }> {
  return callHost('aiChat', payload as unknown as Record<string, unknown>)
}

export function aiCancel(requestId: number): void {
  void callHost('aiCancel', { requestId }).catch(() => undefined)
}

/** 会话产物落在 %APPDATA%\mdreader\workfile\<会话 id>\，不碰文档目录 */
export function aiWriteWorkfile(sessionId: string, name: string, content: string): Promise<string | null> {
  return callHost<{ path: string }>('aiWorkfile', { sessionId, name, content })
    .then((r) => r.path ?? null)
    .catch(() => null)
}

export function aiClearWorkfile(sessionId: string): void {
  void callHost('aiWorkfileClear', { sessionId }).catch(() => undefined)
}

export type AiHostEvent = Extract<HostEvent, { event: `ai${string}` }>

export function onAiEvent(cb: (event: AiHostEvent) => void): () => void {
  return onHostEvent((event) => {
    if (event.event.startsWith('ai')) cb(event as AiHostEvent)
  })
}

export type { AiUsage }
