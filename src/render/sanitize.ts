import DOMPurify from 'dompurify'

/**
 * 预览 HTML 的统一消毒入口。
 *
 * 必须在 innerHTML 赋值【之前】做：事后扫 DOM 无法阻止
 * <img src=x onerror=...> 在插入瞬间就触发加载事件。
 */
DOMPurify.setConfig({
  // 渲染器与懒加载依赖的属性，白名单外补回来
  ADD_ATTR: ['target', 'loading', 'decoding'],
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
})

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: false }) as string
}
