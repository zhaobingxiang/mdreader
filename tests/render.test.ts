import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, MarkdownEngine, resolveAssetUrl } from '../src/render/markdown'

describe('resolveAssetUrl', () => {
  it('绝对 URL 与 data URI 原样通过', () => {
    expect(resolveAssetUrl('https://a.com/x.png', '/base')).toBe('https://a.com/x.png')
    expect(resolveAssetUrl('data:image/png;base64,AAA', '/base')).toContain('data:')
  })

  it('相对路径拼上 baseDir，去掉 ./ 与前缀多余斜杠', () => {
    expect(resolveAssetUrl('./pic.png', '/docs/')).toBe('/docs/pic.png')
    expect(resolveAssetUrl('sub/pic.png', '/docs')).toBe('/docs/sub/pic.png')
  })

  it('空 baseDir 时保持原样', () => {
    expect(resolveAssetUrl('pic.png', '')).toBe('pic.png')
  })
})

describe('MarkdownEngine 渲染', () => {
  const engine = new MarkdownEngine(createDefaultRegistry())

  it('顶层块级 token 带 1-based data-line', () => {
    const { html } = engine.render('# 标题\n\n段落内容')
    expect(html).toContain('data-line="1"')
    expect(html).toContain('data-line="3"')
  })

  it('行内代码输出完整闭合标签（回归 nesting=0 的坑）', () => {
    const { html } = engine.render('用 `npm run dev` 启动')
    expect(html).toContain('<code class="md-code-inline">npm run dev</code>')
    const openTags = (html.match(/<code\b/g) ?? []).length
    const closeTags = (html.match(/<\/code>/g) ?? []).length
    expect(openTags).toBe(closeTags)
  })

  it('外部链接自动加 target 与 noopener', () => {
    const { html } = engine.render('[官网](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('大纲收集标题层级与行号', () => {
    const { outline } = engine.render('# 一级\n\n## 二级')
    expect(outline.map((h) => [h.level, h.line])).toEqual([
      [1, 1],
      [2, 3],
    ])
  })

  it('内嵌 HTML 原样透传（消毒发生在渲染管线写 DOM 前）', () => {
    const { html } = engine.render('<div class="raw">x</div>')
    expect(html).toContain('<div class="raw">x</div>')
  })
})
