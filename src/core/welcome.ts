/** 首次打开时的示例文档，顺带把渲染注册表里的每种块都演示一遍 */
export const WELCOME_DOC = `# mdreader

一个本地优先的 Markdown 阅读器。左侧是大纲，中间可以随时在 **编辑 / 分屏 / 预览** 之间切换，右侧汇总书写提示。

> [!TIP]
> 按 \`Ctrl+E\` 在编辑与预览之间切换，\`Ctrl+Shift+E\` 进分屏。按 \`/\` 会弹出片段补全菜单。

## 快捷开始

- [x] 把一份 md 文件拖进窗口
- [ ] 用 \`Ctrl+O\` 打开本地文件（Chrome / Edge）
- [ ] 输入 \`/table\` 试试表格骨架

## 代码块

\`\`\`typescript
interface FileHandle {
  readonly meta: FileMeta
  read(): Promise<string>
  write(text: string): Promise<void>
}

export async function wrap(handle: FsaFileHandle): Promise<FileHandle> {
  const meta = await readMeta(handle)
  return { meta, read: () => handle.getFile().then((f) => f.text()) }
}
\`\`\`

## 表格

| 模式 | 快捷键 | 说明 |
| --- | --- | --- |
| 编辑 | Ctrl+E | 纯源码 |
| 分屏 | Ctrl+Shift+E | 左右同步滚动 |
| 预览 | Ctrl+E | 纯渲染 |

## 公式

行内公式 $E = mc^2$ 与块级公式：

$$
\\text{阅读时长} = \\frac{\\text{中文字数}}{400} + \\frac{\\text{西文词数}}{220}
$$

## 图表

\`\`\`mermaid
flowchart LR
  A[Markdown 源码] --> B{渲染注册表}
  B --> C[代码块]
  B --> D[表格]
  B --> E[公式]
  B --> F[图表]
  C --> G[DOM]
  D --> G
  E --> G
  F --> G
\`\`\`

## 提示块

> [!NOTE]
> 支持 Obsidian 风格的 callout：NOTE / TIP / WARNING / DANGER / IMPORTANT。

> [!WARNING]
> 内嵌 HTML 会剥离 \`on*\` 事件属性，但整套渲染在本地进行，仍建议只打开可信来源的文件。

---

*把这段欢迎内容删掉，就可以开始写自己的文档了。*
`
