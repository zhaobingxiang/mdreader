import MarkdownIt from 'markdown-it'
import { RenderRegistry, type MdToken, type RenderEnv } from './registry'
import type { Md } from './md-types'
import { codeRenderer } from './renderers/code'
import { mathRenderer } from './renderers/math'
import { mermaidRenderer } from './renderers/mermaid'
import { tableRenderer } from './renderers/table'
import { imageRenderer } from './renderers/image'
import { headingRenderer, resetHeadingCounters } from './renderers/heading'
import { taskListRenderer } from './renderers/task'
import { calloutRenderer } from './renderers/callout'
import {
  blockquoteRenderer,
  hrRenderer,
  htmlBlockRenderer,
  inlineCodeRenderer,
  linkRenderer,
} from './renderers/basic'

export interface OutlineNode {
  level: number
  text: string
  id: string
  /** 源文档行号，用于滚动时同步高亮 */
  line: number
}

/** 全部内置渲染器。新增一种 md 元素，往这里加一行即可。 */
export function createDefaultRegistry(): RenderRegistry {
  return new RenderRegistry().registerAll([
    headingRenderer,
    mathRenderer,
    codeRenderer,
    inlineCodeRenderer,
    hrRenderer,
    blockquoteRenderer,
    linkRenderer,
    imageRenderer,
    tableRenderer,
    htmlBlockRenderer,
    calloutRenderer,
    taskListRenderer,
    mermaidRenderer,
  ])
}

/** 把 md 里的相对资源路径解析成浏览器可访问的 URL */
export function resolveAssetUrl(src: string, baseDir: string): string {
  const trimmed = src.trim()
  if (!trimmed) return ''
  if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) return trimmed
  if (!baseDir) return trimmed
  return `${baseDir.replace(/\/+$/, '')}/${trimmed.replace(/^\.\//, '')}`
}

export interface MarkdownEngineOptions {
  /** 允许内嵌 HTML，默认 true */
  html?: boolean
  /** 自动识别裸链接，默认 true */
  linkify?: boolean
}

/**
 * 给顶层块级 token 打上源文档行号。
 *
 * 统一用 1-based（markdown-it 的 token.map 是 0-based，这里 +1），
 * 这样 data-line 可以直接和 CodeMirror 的行号比较，不必到处做偏移换算。
 */
function installSourceMap(md: Md): void {
  const core = md.core.ruler as unknown as {
    push(name: string, fn: (state: { tokens: MdToken[] }) => void): void
  }
  core.push('mdreader_source_map', (state) => {
    for (const token of state.tokens) {
      if (!token.map || token.nesting === -1) continue
      if (token.attrGet('data-line') !== null) continue
      token.attrSet('data-line', String(token.map[0] + 1))
    }
  })
}

export interface RenderResult {
  html: string
  env: RenderEnv
  outline: OutlineNode[]
}

export class MarkdownEngine {
  readonly registry: RenderRegistry
  private readonly md: Md

  constructor(registry: RenderRegistry, options: MarkdownEngineOptions = {}) {
    this.registry = registry
    this.md = new MarkdownIt({
      html: options.html ?? true,
      linkify: options.linkify ?? true,
      typographer: false,
      breaks: false,
      xhtmlOut: false,
    })
    registry.applyRules(this.md)
    installSourceMap(this.md)
  }

  render(source: string, baseDir = ''): RenderResult {
    resetHeadingCounters()
    const env: RenderEnv = {
      baseDir,
      resolveUrl: (src) => resolveAssetUrl(src, baseDir),
      headings: [],
    }
    const html = this.md.render(source, env as never)
    env.html = html
    return { html, env, outline: env.headings ?? [] }
  }
}
