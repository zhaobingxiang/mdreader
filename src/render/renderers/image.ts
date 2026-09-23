import { escapeHtml } from '../util'
import type { BlockRenderer, RenderRule } from '../registry'

const ZOOM_BOUND = 'imageZoomBound'

function imageRule(_options: unknown, env: { resolveUrl(src: string): string }) {
  return (tokens: Parameters<RenderRule>[0], idx: number): string => {
    const token = tokens[idx]
    void _options
    if (!token) return ''
    const src = token.attrGet('src') ?? ''
    const title = token.attrGet('title')
    const alt = (token.children ?? []).map((c) => c.content).join('') || token.attrGet('alt') || ''
    const resolved = env.resolveUrl(src)
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img class="md-image" src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" decoding="async" data-zoom>`
  }
}

function openLightbox(src: string, alt: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'md-lightbox'
  overlay.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><div class="md-lightbox__hint">点击任意处或按 Esc 关闭</div>`

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }

  overlay.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}

/** 图片：懒加载 + 点击放大 */
export const imageRenderer: BlockRenderer = {
  name: 'image',
  tokenTypes: ['image'],
  order: 16,
  rule: (tokens, idx, _options, env, _self) => {
    return imageRule(_options, env)(tokens, idx)
  },
  enhance(root) {
    if (root.dataset[ZOOM_BOUND] === '1') return
    root.dataset[ZOOM_BOUND] = '1'
    root.addEventListener('click', (event) => {
      const img = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-zoom]')
      if (!img) return
      openLightbox(img.currentSrc || img.src, img.alt)
    })
    // 图片加载失败时给出可读提示，而不是空白
    root.addEventListener(
      'error',
      (event) => {
        const img = event.target as HTMLElement
        if (img.tagName !== 'IMG') return
        const el = img as HTMLImageElement
        el.classList.add('is-broken')
        el.setAttribute('title', `图片加载失败：${el.getAttribute('src') ?? ''}`)
      },
      true,
    )
  },
}
