import katexCss from 'katex/dist/katex.min.css?inline'
import { escapeHtml } from '../render/util'

/** 导出用的精简排版样式，不依赖应用主题变量 */
const EXPORT_CSS = `
:root { --fg:#1f2328; --fg-dim:#59636e; --border:#d1d9e0; --code-bg:#f6f8fa; --accent:#0969da; }
* { box-sizing: border-box; }
body { margin:0; background:#fff; color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:16px; line-height:1.75; }
.markdown-body { max-width:820px; margin:0 auto; padding:48px 28px 96px; }
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4 { font-weight:600; line-height:1.3; margin:1.8em 0 .7em; }
.markdown-body h1 { font-size:2em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
.markdown-body h2 { font-size:1.5em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
.markdown-body h3 { font-size:1.25em; }
.markdown-body p,.markdown-body ul,.markdown-body ol,.markdown-body blockquote,.markdown-body table { margin:0 0 1.1em; }
.markdown-body ul,.markdown-body ol { padding-left:1.6em; }
.markdown-body li+li { margin-top:.25em; }
.markdown-body a { color:var(--accent); }
.markdown-body code { background:var(--code-bg); padding:.15em .4em; border-radius:5px;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Code",Consolas,monospace; font-size:.88em; }
.markdown-body pre { background:var(--code-bg); border:1px solid var(--border); border-radius:10px;
  padding:14px 16px; overflow:auto; }
.markdown-body pre code { background:none; padding:0; font-size:.86em; }
.markdown-body blockquote { border-left:3px solid var(--border); padding:.2em 1em; color:var(--fg-dim); }
.markdown-body table { border-collapse:collapse; width:100%; display:block; overflow:auto; }
.markdown-body th,.markdown-body td { border:1px solid var(--border); padding:7px 12px; text-align:left; }
.markdown-body th { background:var(--code-bg); font-weight:600; }
.markdown-body img { max-width:100%; height:auto; border-radius:8px; }
.markdown-body hr { border:none; border-top:1px solid var(--border); margin:2.2em 0; }
.markdown-body .md-code__bar { display:none; }
.markdown-body .md-callout { border-left:3px solid var(--accent); background:#f6f8fa;
  border-radius:8px; padding:.8em 1em; margin:1.2em 0; }
.markdown-body .md-callout::before { content:attr(data-callout-title); font-weight:600;
  display:block; margin-bottom:.3em; font-size:.9em; }
.markdown-body .md-task { list-style:none; }
.markdown-body .md-math--block { overflow-x:auto; text-align:center; margin:1.2em 0; }
`

function baseName(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, '') || 'document'
}

function download(content: BlobPart, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出为可独立分发的单文件 HTML（公式样式内联，图表已是 SVG） */
export function exportHtml(previewHtml: string, docName: string): void {
  const title = baseName(docName)
  const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
<style>${katexCss}</style>
</head>
<body>
<main class="markdown-body">${previewHtml}</main>
</body>
</html>`
  download(page, `${title}.html`, 'text/html')
}

/** 复制渲染结果，粘到飞书 / 企业微信 / 公众号保留格式 */
export async function copyRichText(previewHtml: string, plainText: string): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    await navigator.clipboard.writeText(plainText)
    return false
  }
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([previewHtml], { type: 'text/html' }),
      'text/plain': new Blob([plainText], { type: 'text/plain' }),
    })
    await navigator.clipboard.write([item])
    return true
  } catch {
    await navigator.clipboard.writeText(plainText)
    return false
  }
}

export async function copyMarkdown(source: string): Promise<void> {
  await navigator.clipboard.writeText(source)
}

/** 走浏览器打印，配合 @media print 样式输出 PDF */
export function printPreview(): void {
  window.print()
}
