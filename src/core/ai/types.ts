/**
 * AI 优化用的消息与工具协议。
 *
 * v1 只做纯文本改写，但工具调用协议先按「可扩展」铺好：
 * ask_user / propose_document / report_suggestions 都由页面消费，
 * 将来加脚本、批量改写之类的能力不需要改桥接层。
 */

export type AiRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AiToolCall {
  id: string
  name: string
  /** 模型返回的原始 JSON 字符串 */
  arguments: string
}

export interface AiMessage {
  role: AiRole
  content: string
  tool_calls?: AiToolCall[]
  tool_call_id?: string
}

export interface AiSuggestItem {
  message: string
  /** 1-based 行号；没有具体位置时省略 */
  line?: number
  severity?: 'info' | 'warning'
}

export interface AiAsk {
  question: string
  options: string[]
}

export interface AiProposal {
  title: string
  markdown: string
}

export interface AiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface AiToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const AI_TOOLS: AiToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '当文档意图、目标读者或优化方向不明确，且猜错会大改内容时，向用户提问。一次最多问 3 个最关键的问题，合并成一个问题提出。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '一句话问题，具体、可回答' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 个互斥的候选答案，用户可以直接点选；没有合适的候选项时留空',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_document',
      description:
        '给出优化后的完整文档。必须等整篇文档都改好后再一次性调用；markdown 是可直接替换原文的完整内容，不是 diff，不要包在代码围栏里。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说明这次改了什么，展示在确认弹窗标题' },
          markdown: { type: 'string', description: '优化后的完整 Markdown 文档' },
        },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_suggestions',
      description:
        '不改文档，只给出针对当前文档的书写与格式建议。每条建议尽量给出行号（从 1 开始）。最多 12 条，按重要性排序。',
      parameters: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                message: { type: 'string', description: '具体、可执行的建议，一句话' },
                line: { type: 'integer', description: '问题所在行号，从 1 开始' },
                severity: { type: 'string', enum: ['info', 'warning'] },
              },
              required: ['message'],
            },
          },
        },
        required: ['suggestions'],
      },
    },
  },
]

export function parseToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
