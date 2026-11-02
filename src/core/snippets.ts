import type { EditorView } from '@codemirror/view'

/**
 * 高频 Markdown 语法片段：斜杠补全与「语法速查」共用同一份数据，
 * 速查里点一项就往光标处插入对应骨架，免得两处各写一套逐渐走偏。
 */
export interface Snippet {
  /** 斜杠补全的触发词；速查面板不用 */
  slash?: string
  /** 速查面板里显示的样子 */
  label: string
  detail: string
  /** `$0` 表示插入后光标落点 */
  body: string
}

export interface SnippetGroup {
  title: string
  items: Snippet[]
}

const CURSOR = '$0'

export const SNIPPET_GROUPS: SnippetGroup[] = [
  {
    title: '结构',
    items: [
      { slash: '/h1', label: '# 一级标题', detail: '一级标题', body: `# ${CURSOR}` },
      { slash: '/h2', label: '## 二级标题', detail: '二级标题', body: `## ${CURSOR}` },
      { slash: '/h3', label: '### 三级标题', detail: '三级标题', body: `### ${CURSOR}` },
      { slash: '/quote', label: '> 引用', detail: '引用块', body: `> ${CURSOR}` },
      { slash: '/hr', label: '---', detail: '分割线', body: `\n---\n${CURSOR}` },
      {
        slash: '/details',
        label: '<details> 折叠',
        detail: '可折叠区块',
        body: `<details>\n<summary>${CURSOR}</summary>\n\n\n</details>`,
      },
    ],
  },
  {
    title: '强调与链接',
    items: [
      { label: '**粗体**', detail: '加粗', body: `**${CURSOR}**` },
      { label: '*斜体*', detail: '斜体', body: `*${CURSOR}*` },
      { label: '~~删除线~~', detail: '删除线', body: `~~${CURSOR}~~` },
      { label: '`行内代码`', detail: '行内代码', body: '`' + CURSOR + '`' },
      { slash: '/link', label: '[文字](链接)', detail: '链接', body: `[${CURSOR}](https://)` },
      { slash: '/img', label: '![图片](路径)', detail: '图片', body: `![${CURSOR}](path/to/image.png)` },
    ],
  },
  {
    title: '列表与表格',
    items: [
      { label: '- 列表项', detail: '无序列表', body: `- ${CURSOR}` },
      { label: '1. 列表项', detail: '有序列表', body: `1. ${CURSOR}` },
      { slash: '/todo', label: '- [ ] 待办', detail: '任务列表', body: `- [ ] ${CURSOR}` },
      {
        slash: '/table',
        label: '| 表格 |',
        detail: '三列两行骨架',
        body: `| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| ${CURSOR} |  |  |`,
      },
    ],
  },
  {
    title: '代码与公式',
    items: [
      { slash: '/code', label: '``` 代码块', detail: '标注语言可获得高亮', body: '```$0\n\n```' },
      {
        slash: '/mermaid',
        label: '```mermaid',
        detail: '流程图',
        body: `\`\`\`mermaid\nflowchart LR\n  A[${CURSOR}] --> B[下一步]\n\`\`\``,
      },
      { slash: '/math', label: '$$ 公式块', detail: '块级公式', body: `$$\n${CURSOR}\n$$` },
      { label: '$行内公式$', detail: '行内公式', body: `$${CURSOR}$` },
    ],
  },
  {
    title: '提示块',
    items: [
      { slash: '/note', label: '[!NOTE] 注意', detail: '提示块', body: `> [!NOTE]\n> ${CURSOR}` },
      { slash: '/tip', label: '[!TIP] 提示', detail: '提示块', body: `> [!TIP]\n> ${CURSOR}` },
      { slash: '/warning', label: '[!WARNING] 警告', detail: '提示块', body: `> [!WARNING]\n> ${CURSOR}` },
      { slash: '/danger', label: '[!DANGER] 危险', detail: '提示块', body: `> [!DANGER]\n> ${CURSOR}` },
      { slash: '/important', label: '[!IMPORTANT] 重要', detail: '提示块', body: `> [!IMPORTANT]\n> ${CURSOR}` },
    ],
  },
]

export const SLASH_SNIPPETS: Snippet[] = SNIPPET_GROUPS.flatMap((g) => g.items).filter((item) => item.slash)

/** 往当前选区插入骨架；选中了文字时，文字会替换掉 `$0` 占位 */
export function insertSnippet(view: EditorView, body: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const index = body.indexOf(CURSOR)
  const text = (index < 0 ? body : body.slice(0, index) + selected + body.slice(index + CURSOR.length))
  const anchor = index < 0 ? from + text.length : from + index + selected.length
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor },
    scrollIntoView: true,
  })
  view.focus()
}
