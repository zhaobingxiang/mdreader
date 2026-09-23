import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

const CURSOR = '$0'

interface Snippet {
  label: string
  detail: string
  body: string
}

function applyBody(view: EditorView, from: number, to: number, body: string): void {
  const index = body.indexOf(CURSOR)
  const text = body.replace(CURSOR, '')
  const anchor = index < 0 ? from + text.length : from + index
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor },
    scrollIntoView: true,
  })
}

function toCompletion(snippet: Snippet): Completion {
  return {
    label: snippet.label,
    detail: snippet.detail,
    type: 'keyword',
    apply(view, _completion, from, to) {
      applyBody(view, from, to, snippet.body)
    },
  }
}

const SLASH_SNIPPETS: Snippet[] = [
  { label: '/h1', detail: '一级标题', body: `# ${CURSOR}` },
  { label: '/h2', detail: '二级标题', body: `## ${CURSOR}` },
  { label: '/h3', detail: '三级标题', body: `### ${CURSOR}` },
  {
    label: '/table',
    detail: '表格骨架',
    body: `| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| ${CURSOR} |  |  |`,
  },
  { label: '/code', detail: '代码块', body: '```$0\n\n```' },
  { label: '/todo', detail: '待办项', body: `- [ ] ${CURSOR}` },
  { label: '/quote', detail: '引用块', body: `> ${CURSOR}` },
  { label: '/hr', detail: '分割线', body: `\n---\n${CURSOR}` },
  { label: '/note', detail: '提示块 · 注意', body: `> [!NOTE]\n> ${CURSOR}` },
  { label: '/tip', detail: '提示块 · 提示', body: `> [!TIP]\n> ${CURSOR}` },
  { label: '/warning', detail: '提示块 · 警告', body: `> [!WARNING]\n> ${CURSOR}` },
  { label: '/danger', detail: '提示块 · 危险', body: `> [!DANGER]\n> ${CURSOR}` },
  { label: '/important', detail: '提示块 · 重要', body: `> [!IMPORTANT]\n> ${CURSOR}` },
  { label: '/img', detail: '图片', body: `![${CURSOR}](path/to/image.png)` },
  { label: '/link', detail: '链接', body: `[${CURSOR}](https://)` },
  { label: '/math', detail: '块级公式', body: `$$\n${CURSOR}\n$$` },
  {
    label: '/mermaid',
    detail: '流程图',
    body: `\`\`\`mermaid\nflowchart LR\n  A[${CURSOR}] --> B[下一步]\n\`\`\``,
  },
  { label: '/details', detail: '折叠块', body: `<details>\n<summary>${CURSOR}</summary>\n\n\n</details>` },
  { label: '/date', detail: '当前日期', body: new Date().toISOString().slice(0, 10) },
]

const CODE_LANGUAGES = [
  'javascript', 'typescript', 'jsx', 'tsx', 'python', 'java', 'go', 'rust',
  'c', 'cpp', 'csharp', 'php', 'ruby', 'kotlin', 'swift', 'dart', 'scala',
  'shell', 'bash', 'powershell', 'batch', 'sql', 'json', 'yaml', 'toml',
  'ini', 'xml', 'html', 'css', 'scss', 'less', 'markdown', 'diff', 'dockerfile',
  'nginx', 'makefile', 'graphql', 'protobuf', 'lua', 'perl', 'r', 'matlab',
  'mermaid', 'katex', 'text', 'plaintext',
]

const TABLE_COMPLETION: Completion = {
  label: '|',
  displayLabel: '插入表格',
  detail: '3 列 2 行骨架',
  type: 'keyword',
  apply(view, _completion, from, to) {
    applyBody(
      view,
      from,
      to,
      `| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| ${CURSOR} |  |  |`,
    )
  },
}

/** `/` 触发片段、` ``` ` 触发语言选择、行首 `|` 触发表格骨架 */
export const markdownSnippetSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  // 1. 代码块语言
  const fence = context.matchBefore(/```[\w+#-]*/)
  if (fence) {
    const line = context.state.doc.lineAt(fence.from)
    const indent = context.state.sliceDoc(line.from, fence.from)
    if (/^\s*$/.test(indent)) {
      return {
        from: fence.from + 3,
        options: CODE_LANGUAGES.map((lang) => ({ label: lang, type: 'type', detail: '语言' })),
        validFor: /^[\w+#-]*$/,
      }
    }
  }

  // 2. 斜杠片段
  const slash = context.matchBefore(/\/[\w-]*/)
  if (slash) {
    const before = context.state.sliceDoc(Math.max(0, slash.from - 1), slash.from)
    // 避免把 URL 里的 / 当成触发符
    if (!/[\w/:.@-]/.test(before)) {
      return {
        from: slash.from,
        options: SLASH_SNIPPETS.map(toCompletion),
        validFor: /^\/[\w-]*$/,
      }
    }
  }

  // 3. 行首竖线 → 表格骨架
  const bar = context.matchBefore(/\|\s*$/)
  if (bar) {
    const line = context.state.doc.lineAt(bar.from)
    if (/^\s*$/.test(context.state.sliceDoc(line.from, bar.from))) {
      return { from: bar.from, options: [TABLE_COMPLETION], validFor: /^\|\s*$/ }
    }
  }

  return null
}
