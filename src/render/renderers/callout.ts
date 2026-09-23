import type { BlockRenderer, MdToken } from '../registry'
import type { Md } from '../md-types'

const CALLOUT_OPEN_RE = /^\[!(\w+)\][+-]?\s*/

const CALLOUT_TITLES: Record<string, string> = {
  note: '注意',
  info: '说明',
  tip: '提示',
  hint: '提示',
  success: '成功',
  question: '疑问',
  warning: '警告',
  caution: '小心',
  danger: '危险',
  error: '错误',
  important: '重要',
  example: '示例',
  quote: '引用',
}

/**
 * Obsidian / GitHub 风格的 callout：
 *   > [!NOTE] 可选标题
 *   > 正文
 */
function calloutPlugin(md: Md): void {
  const core = md.core.ruler as unknown as {
    push(ruleName: string, fn: (state: { tokens: unknown[] }) => void): void
  }

  core.push('mdreader_callout', (state) => {
    const tokens = state.tokens as MdToken[]

    for (let i = 2; i < tokens.length; i += 1) {
      const inline = tokens[i]
      if (!inline || inline.type !== 'inline') continue
      if (tokens[i - 1]?.type !== 'paragraph_open') continue
      const open = tokens[i - 2]
      if (!open || open.type !== 'blockquote_open') continue

      const first = inline.children?.[0]
      if (!first || first.type !== 'text') continue

      const match = CALLOUT_OPEN_RE.exec(first.content)
      if (!match) continue

      const kind = (match[1] ?? 'note').toLowerCase()
      const rest = first.content.slice(match[0].length).trim()
      first.content = rest
      if (!rest) inline.children!.shift()

      open.attrJoin('class', 'md-callout')
      open.attrSet('data-callout', kind)
      open.attrSet('data-callout-title', CALLOUT_TITLES[kind] ?? kind)
    }
  })
}

/** `> [!NOTE]` 提示块 */
export const calloutRenderer: BlockRenderer = {
  name: 'callout',
  tokenTypes: [],
  order: 39,
  install: calloutPlugin,
}

export const CALLOUT_KINDS = Object.keys(CALLOUT_TITLES)
