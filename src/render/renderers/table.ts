import type { BlockRenderer } from '../registry'

/** 表格：外层包一层可横滚容器，窄屏下不撑破布局 */
export const tableRenderer: BlockRenderer = {
  name: 'table',
  tokenTypes: ['table_open', 'table_close'],
  order: 20,
  rule: (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    if (token.type === 'table_open') {
      const lineAttr = token.map ? ` data-line="${token.map[0] + 1}"` : ''
      return `<div class="md-block md-table-wrap"${lineAttr}><table class="md-table">\n`
    }
    if (token.type === 'table_close') {
      return '</table></div>\n'
    }
    return self.renderToken(tokens, idx, options)
  },
  enhance(root) {
    // 表头全空时打标记，样式上弱化首行
    for (const el of root.querySelectorAll<HTMLTableElement>('.md-table')) {
      const cells = el.tHead?.rows[0]?.cells
      if (!cells) continue
      if (Array.from(cells).every((c) => !c.textContent?.trim())) {
        el.classList.add('md-table--nohead')
      }
    }
  },
}
