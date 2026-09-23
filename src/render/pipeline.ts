import { MarkdownEngine, type OutlineNode } from './markdown'
import { sanitizeHtml } from './sanitize'

export interface PreviewResult {
  outline: OutlineNode[]
  /** 渲染耗时，毫秒 */
  elapsed: number
  /** 是否被更新的渲染取代（异步图表场景） */
  stale: boolean
}

/**
 * 预览渲染管线。
 *
 * 两个关键点：
 *  1. 用自增版本号丢弃过期渲染，避免 Mermaid 这类异步图表回来晚了覆盖新内容；
 *  2. 容器是持久的（只替换 innerHTML），DOM 增强器只需绑定一次事件。
 */
export class PreviewPipeline {
  private version = 0
  private readonly engine: MarkdownEngine

  constructor(engine: MarkdownEngine) {
    this.engine = engine
  }

  get registry() {
    return this.engine.registry
  }

  async renderInto(
    container: HTMLElement,
    source: string,
    baseDir = '',
  ): Promise<PreviewResult> {
    const started = performance.now()
    const version = (this.version += 1)

    const { html, env, outline } = this.engine.render(source, baseDir)
    // 消毒必须发生在赋值之前：内嵌 HTML / 事件属性在插入 DOM 的瞬间就可能触发
    container.innerHTML = sanitizeHtml(html)

    // 首屏字体度量前先算一次耗时，图表异步增强不阻塞返回
    const elapsed = performance.now() - started

    if (version !== this.version) {
      return { outline, elapsed, stale: true }
    }

    await this.engine.registry.enhance(container, env)

    return { outline, elapsed, stale: version !== this.version }
  }
}
