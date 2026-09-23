import type { BlockRenderer, MdToken } from '../registry'
import type { Md } from '../md-types'

const TODO_RE = /^\[([ xX])\]\s+/

function makeCheckbox(checked: boolean): MdToken {
  return {
    type: 'html_inline',
    tag: '',
    attrs: null,
    map: null,
    nesting: 0,
    level: 0,
    children: null,
    content: `<input type="checkbox" class="md-task__box"${checked ? ' checked' : ''} disabled>`,
    markup: '',
    info: '',
    block: false,
    hidden: false,
    meta: null,
    attrGet: () => null,
    attrSet: () => undefined,
    attrPush: () => undefined,
    attrJoin: () => undefined,
  }
}

/**
 * 任务列表：markdown-it 核心层后处理。
 * 命中 `- [ ] 待办` 时把前缀替换成真实 checkbox。
 */
function taskListPlugin(md: Md): void {
  const core = md.core.ruler as unknown as {
    after(afterName: string, ruleName: string, fn: (state: { tokens: unknown[] }) => void): void
  }

  core.after('inline', 'mdreader_task_list', (state) => {
    const tokens = state.tokens as MdToken[]

    for (let i = 3; i < tokens.length; i += 1) {
      const inline = tokens[i]
      if (!inline || inline.type !== 'inline') continue
      if (tokens[i - 1]?.type !== 'paragraph_open') continue
      if (tokens[i - 2]?.type !== 'list_item_open') continue

      const first = inline.children?.[0]
      if (!first || first.type !== 'text') continue

      const match = TODO_RE.exec(first.content)
      if (!match) continue

      const checked = match[1]!.toLowerCase() === 'x'
      first.content = first.content.slice(match[0].length)
      if (!first.content) inline.children!.shift()
      inline.children!.unshift(makeCheckbox(checked))

      tokens[i - 3]?.attrJoin('class', 'md-task-list')
      tokens[i - 2]!.attrJoin('class', checked ? 'md-task is-done' : 'md-task')
    }
  })
}

/** 任务清单 `- [x]` */
export const taskListRenderer: BlockRenderer = {
  name: 'task-list',
  tokenTypes: [],
  order: 40,
  install: taskListPlugin,
}
