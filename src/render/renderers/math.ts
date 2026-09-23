import katex from 'katex'
import { escapeHtml } from '../util'
import type { BlockRenderer, RenderRule } from '../registry'
import type { Md } from '../md-types'

interface MathToken {
  content: string
  markup: string
  block?: boolean
  map?: [number, number] | null
}

interface BlockState {
  src: string
  bMarks: number[]
  eMarks: number[]
  tShift: number[]
  sCount: number[]
  blkIndent: number
  line: number
  push(type: string, tag: string, nesting: number): MathToken
}

interface InlineState {
  src: string
  pos: number
  posMax: number
  pending: string
  push(type: string, tag: string, nesting: number): MathToken
}

function renderMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    })
  } catch (err) {
    return `<span class="md-math__error" title="${escapeHtml((err as Error).message)}">${escapeHtml(source)}</span>`
  }
}

/** $$ ... $$ 块级公式 */
function mathBlock(state: BlockState, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false

  const begin = state.bMarks[startLine]! + state.tShift[startLine]!
  const end = state.eMarks[startLine]!
  if (begin + 2 > end) return false
  if (state.src.slice(begin, begin + 2) !== '$$') return false
  if (silent) return true

  const firstLine = state.src.slice(begin + 2, end)
  const closedOnSameLine = firstLine.trimEnd().endsWith('$$') && firstLine.trim() !== '$$'

  let content: string
  let lastLine = startLine

  if (closedOnSameLine) {
    content = firstLine.trimEnd().slice(0, -2)
  } else {
    const parts = [firstLine]
    let closed = false
    for (let line = startLine + 1; line < endLine; line += 1) {
      const lineBegin = state.bMarks[line]! + state.tShift[line]!
      const lineEnd = state.eMarks[line]!
      const text = state.src.slice(lineBegin, lineEnd)
      lastLine = line
      if (text.trimEnd().endsWith('$$')) {
        parts.push(text.replace(/\$\$\s*$/, ''))
        closed = true
        break
      }
      parts.push(text)
    }
    if (!closed) return false
    content = parts.join('\n')
  }

  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = content.trim()
  token.markup = '$$'
  token.map = [startLine, lastLine + 1]
  state.line = lastLine + 1
  return true
}

/** $ ... $ 行内公式；要求紧贴内容，避免误伤 ¥100 这类文本 */
function mathInline(state: InlineState, silent: boolean): boolean {
  if (state.src[state.pos] !== '$') return false

  let pos = state.pos + 1
  const max = state.posMax
  if (pos >= max) return false
  if (state.src[pos] === ' ' || state.src[pos] === '$') return false

  let close = -1
  while (pos < max) {
    const ch = state.src[pos]
    if (ch === '\\') {
      pos += 2
      continue
    }
    if (ch === '$' && state.src[pos - 1] !== ' ') {
      close = pos
      break
    }
    pos += 1
  }
  if (close < 0) return false

  const content = state.src.slice(state.pos + 1, close)
  if (!content.trim()) return false
  if (silent) return true

  const token = state.push('math_inline', 'math', 0)
  token.content = content
  token.markup = '$'

  state.pos = close + 1
  return true
}

const mathBlockRule: RenderRule = (tokens, idx) => {
  const token = tokens[idx]
  if (!token) return ''
  const lineAttr = token.map ? ` data-line="${token.map[0] + 1}"` : ''
  return `<div class="md-block md-math md-math--block"${lineAttr}>${renderMath(token.content, true)}</div>\n`
}

const mathInlineRule: RenderRule = (tokens, idx) => {
  const token = tokens[idx]
  if (!token) return ''
  return `<span class="md-math md-math--inline">${renderMath(token.content, false)}</span>`
}

function installMath(md: Md): void {
  const blockRuler = md.block.ruler as unknown as {
    before(beforeName: string, ruleName: string, fn: unknown, options: unknown): void
  }
  const inlineRuler = md.inline.ruler as unknown as {
    before(beforeName: string, ruleName: string, fn: unknown): void
  }

  blockRuler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  inlineRuler.before('escape', 'math_inline', mathInline)
}

/** KaTeX 行内 / 块级公式 */
export const mathRenderer: BlockRenderer = {
  name: 'math',
  tokenTypes: ['math_block', 'math_inline'],
  order: 5,
  install: installMath,
  rule: (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    return token.type === 'math_block'
      ? mathBlockRule(tokens, idx, options, env, self)
      : mathInlineRule(tokens, idx, options, env, self)
  },
}
