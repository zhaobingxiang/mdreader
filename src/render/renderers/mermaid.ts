import { escapeHtml } from '../util'
import { decodeSource } from './code'
import type { BlockRenderer } from '../registry'

/** 源码 → SVG 缓存，避免每次重渲染都重新布局；LRU 上限防止长会话无限增长 */
const SVG_CACHE_MAX = 64
const svgCache = new Map<string, string>()

function cacheGet(source: string): string | undefined {
  const hit = svgCache.get(source)
  if (hit !== undefined) {
    svgCache.delete(source)
    svgCache.set(source, hit)
  }
  return hit
}

function cacheSet(source: string, svg: string): void {
  svgCache.delete(source)
  svgCache.set(source, svg)
  while (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next()
    if (oldest.done) break
    svgCache.delete(oldest.value)
  }
}

let initialized = false

type MermaidApi = {
  initialize(config: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
}

async function loadMermaid(): Promise<MermaidApi> {
  const mod = (await import('mermaid')) as unknown as { default: MermaidApi }
  const api = mod.default
  if (!initialized) {
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      flowchart: { htmlLabels: false },
    })
    initialized = true
  }
  return api
}

/** Mermaid 图表：异步渲染，带源码缓存与错误兜底 */
export const mermaidRenderer: BlockRenderer = {
  name: 'mermaid',
  tokenTypes: [],
  order: 60,
  async enhance(root) {
    const targets = root.querySelectorAll<HTMLElement>('[data-embed="mermaid"]')
    if (targets.length === 0) return

    let api: MermaidApi
    try {
      api = await loadMermaid()
    } catch (err) {
      for (const el of targets) {
        el.innerHTML = `<div class="md-embed__error">Mermaid 加载失败：${escapeHtml((err as Error).message)}</div>`
      }
      return
    }

    let seq = 0
    for (const el of targets) {
      const source = decodeSource(el.dataset.src)
      if (!source.trim()) continue

      const cached = cacheGet(source)
      if (cached) {
        el.innerHTML = cached
        el.classList.add('is-ready')
        continue
      }

      const id = `md-mermaid-${Date.now()}-${seq}`
      seq += 1
      try {
        const { svg } = await api.render(id, source)
        cacheSet(source, svg)
        el.innerHTML = svg
        el.classList.add('is-ready')
      } catch (err) {
        el.innerHTML = `<div class="md-embed__error">图表语法错误：${escapeHtml((err as Error).message)}</div>
<pre class="md-embed__source"><code>${escapeHtml(source)}</code></pre>`
      }
    }
  },
}
