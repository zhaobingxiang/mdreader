import hljs from 'highlight.js/lib/common'
import { escapeHtml } from '../util'
import type { BlockRenderer, MdToken, RenderRule } from '../registry'

/** 把源码编码进 data 属性，避免转义地狱与 env 生命周期问题 */
export function encodeSource(source: string): string {
  return encodeURIComponent(source)
}

export function decodeSource(encoded: string | undefined): string {
  if (!encoded) return ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

const CODE_COPY_BOUND = 'codeCopyBound'
const CODE_EXPAND_BOUND = 'codeExpandBound'

function pickLanguage(token: MdToken): string {
  const info = token.info ? token.info.trim() : ''
  return info.split(/\s+/)[0] ?? ''
}

function highlight(code: string, lang: string): { html: string; label: string } {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return {
        html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value,
        label: lang,
      }
    } catch {
      // 落到纯文本
    }
  }
  return { html: escapeHtml(code), label: lang || 'text' }
}

const fenceRule: RenderRule = (tokens, idx) => {
  const token = tokens[idx]
  if (!token) return ''
  const lang = pickLanguage(token)
  const source = token.content
  const encoded = encodeSource(source)
  const lineCount = source.replace(/\n$/, '').split('\n').length

  const lineNo = token.map ? token.map[0] + 1 : undefined
  const lineAttr = lineNo === undefined ? '' : ` data-line="${lineNo}"`

  // mermaid 交给独立的图表渲染器，这里只留占位
  if (lang === 'mermaid' || lang === 'mmd') {
    return `<div class="md-block md-embed md-embed--mermaid"${lineAttr} data-embed="mermaid" data-src="${encoded}"><div class="md-embed__hint">Mermaid 图表渲染中…</div></div>\n`
  }

  const { html, label } = highlight(source, lang)

  return `<div class="md-block md-code"${lineAttr} data-lines="${lineCount}">
<div class="md-code__bar">
<span class="md-code__lang">${escapeHtml(label)}</span>
<span class="md-code__meta">${lineCount} 行</span>
<button type="button" class="md-code__btn" data-code-copy>复制</button>
</div>
<pre class="md-code__pre"><code class="hljs language-${escapeHtml(lang || 'text')}">${html}</code></pre>
</div>\n`
}

/** 代码块：语言标签 + 行数 + 一键复制 + 长代码折叠 */
export const codeRenderer: BlockRenderer = {
  name: 'code',
  tokenTypes: ['fence', 'code_block'],
  order: 10,
  rule: fenceRule,
  enhance(root) {
    if (root.dataset[CODE_COPY_BOUND] !== '1') {
      root.dataset[CODE_COPY_BOUND] = '1'
      root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement
        const btn = target.closest<HTMLButtonElement>('[data-code-copy]')
        if (!btn) return
        const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? ''
        void navigator.clipboard.writeText(code).then(
          () => {
            btn.textContent = '已复制'
            btn.classList.add('is-ok')
            window.setTimeout(() => {
              btn.textContent = '复制'
              btn.classList.remove('is-ok')
            }, 1200)
          },
          () => {
            btn.textContent = '复制失败'
          },
        )
      })
    }

    if (root.dataset[CODE_EXPAND_BOUND] !== '1') {
      root.dataset[CODE_EXPAND_BOUND] = '1'
      // 超过 24 行的代码块默认折叠，点击展开
      root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement
        const meta = target.closest<HTMLElement>('.md-code__meta')
        if (!meta) return
        const block = meta.closest('.md-code')
        block?.classList.toggle('is-expanded')
      })
    }

    for (const el of root.querySelectorAll<HTMLElement>('.md-code')) {
      const lines = Number(el.dataset.lines ?? '0')
      el.classList.toggle('is-collapsible', lines > 24)
    }
  },
}
