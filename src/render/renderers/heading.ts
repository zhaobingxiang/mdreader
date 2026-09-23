import { slugify } from '../util'
import type { BlockRenderer, RenderRule } from '../registry'

const headingCounters = new Map<string, number>()

const headingOpen: RenderRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!token) return ''
  const inline = tokens[idx + 1]
  const text = inline ? (inline.children ?? []).map((c) => c.content).join('') : ''
  const base = slugify(text) || `section-${idx}`
  const seen = headingCounters.get(base) ?? 0
  headingCounters.set(base, seen + 1)
  const id = seen === 0 ? base : `${base}-${seen}`

  token.attrSet('id', id)
  token.attrJoin('class', 'md-heading')

  env.headings ??= []
  env.headings.push({
    level: Number(token.tag.slice(1)) || 1,
    text: text.trim(),
    id,
    line: token.map ? token.map[0] + 1 : 0,
  })

  return self.renderToken(tokens, idx, options)
}

/** 标题：生成锚点 id 并顺带收集大纲 */
export const headingRenderer: BlockRenderer = {
  name: 'heading',
  tokenTypes: ['heading_open'],
  order: 8,
  rule: headingOpen,
  enhance(root) {
    // 悬停出现「复制锚点链接」
    if (root.dataset.headingBound === '1') return
    root.dataset.headingBound = '1'
    root.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('.md-heading__link')
      if (!link) return
      const id = link.dataset.anchor ?? ''
      const url = `${location.origin}${location.pathname}#${id}`
      void navigator.clipboard.writeText(url)
      link.classList.add('is-ok')
      window.setTimeout(() => link.classList.remove('is-ok'), 1200)
    })
  },
}

/** 每次渲染前重置标题计数，避免同一文档重复标题拿到不断增长的 id */
export function resetHeadingCounters(): void {
  headingCounters.clear()
}
