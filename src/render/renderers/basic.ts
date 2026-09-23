import { escapeHtml } from '../util'
import type { BlockRenderer } from '../registry'

const ANCHOR_BOUND = 'anchorBound'

/**
 * 内嵌 HTML 块。
 *
 * 原样输出交给 markdown-it 的 html 通道；最终 HTML 在写入 DOM 前
 * 由渲染管线统一做 DOMPurify 消毒（见 render/sanitize.ts），
 * 这里不再需要事后扫 DOM。
 */
export const htmlBlockRenderer: BlockRenderer = {
  name: 'html-block',
  tokenTypes: ['html_block'],
  order: 30,
  rule: (tokens, idx) => {
    const token = tokens[idx]
    if (!token) return ''
    return `<div class="md-block md-html">${token.content}</div>\n`
  },
}

/** 链接：外链新窗口并标注，锚点在容器内平滑滚动 */
export const linkRenderer: BlockRenderer = {
  name: 'link',
  tokenTypes: ['link_open'],
  order: 15,
  rule: (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    void env
    const href = token.attrGet('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
      token.attrJoin('class', 'md-link md-link--external')
    } else if (href.startsWith('#')) {
      token.attrJoin('class', 'md-link md-link--anchor')
    } else {
      token.attrJoin('class', 'md-link md-link--local')
    }
    return self.renderToken(tokens, idx, options)
  },
  enhance(root) {
    if (root.dataset[ANCHOR_BOUND] === '1') return
    root.dataset[ANCHOR_BOUND] = '1'
    root.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
      if (!anchor) return
      const raw = anchor.getAttribute('href')?.slice(1)
      if (!raw) return
      const target = root.querySelector<HTMLElement>(`#${CSS.escape(decodeURIComponent(raw))}`)
      if (!target) return
      event.preventDefault()
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  },
}

/**
 * 行内代码。
 *
 * 坑：code_inline 的 nesting 是 0（自包含 token），不能用 self.renderToken ——
 * renderToken 只会吐出 `<code ...>` 这个未闭合的开标签。浏览器的容错解析会
 * 把后续整棵 DOM 当成它的子节点，于是 0.87em 逐级累乘，越往后字越小。
 * 必须自己拼完整的开闭标签。
 */
export const inlineCodeRenderer: BlockRenderer = {
  name: 'code-inline',
  tokenTypes: ['code_inline'],
  order: 12,
  rule: (tokens, idx) => {
    const token = tokens[idx]
    if (!token) return ''
    return `<code class="md-code-inline">${escapeHtml(token.content)}</code>`
  },
}

/** 分割线 */
export const hrRenderer: BlockRenderer = {
  name: 'hr',
  tokenTypes: ['hr'],
  order: 13,
  rule: (tokens, idx, options, env, self) => {
    void env
    const token = tokens[idx]
    if (!token) return ''
    token.attrJoin('class', 'md-hr')
    return self.renderToken(tokens, idx, options)
  },
}

/** 引用块 */
export const blockquoteRenderer: BlockRenderer = {
  name: 'blockquote',
  tokenTypes: ['blockquote_open'],
  order: 14,
  rule: (tokens, idx, options, env, self) => {
    void env
    const token = tokens[idx]
    if (!token) return ''
    token.attrJoin('class', 'md-quote')
    return self.renderToken(tokens, idx, options)
  },
}

export { escapeHtml }
