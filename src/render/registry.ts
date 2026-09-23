import type { Md } from './md-types'

/**
 * markdown-it 的 token / 渲染规则最小结构。
 * 自己声明而不用 @types 里的深层路径，避免类型随版本漂移。
 */
export interface MdToken {
  type: string
  tag: string
  attrs: [string, string][] | null
  map: [number, number] | null
  nesting: number
  level: number
  children: MdToken[] | null
  content: string
  markup: string
  info: string
  block: boolean
  hidden: boolean
  meta: unknown
  attrGet(name: string): string | null
  attrSet(name: string, value: string): void
  attrPush(attr: [string, string]): void
  attrJoin(name: string, value: string): void
}

export interface MdRenderer {
  renderToken(tokens: MdToken[], idx: number, options: unknown): string
  render(tokens: MdToken[], options: unknown, env: RenderEnv): string
}

export type RenderRule = (
  tokens: MdToken[],
  idx: number,
  options: unknown,
  env: RenderEnv,
  self: MdRenderer,
) => string

/** 渲染期间在 markdown-it 与 DOM 增强器之间传递的数据袋 */
export interface RenderEnv {
  /** 文档所在目录，用于解析相对资源路径 */
  baseDir: string
  /** 把 md 里的资源路径解析成可访问 URL */
  resolveUrl(src: string): string
  /** markdown-it 渲染出的 HTML 字符串 */
  html?: string
  /** 代码块索引池：mermaid 等异步块先占位，渲染后再取内容 */
  codeFences?: { lang: string; code: string }[]
  /** 目录结构，供大纲面板复用 */
  headings?: { level: number; text: string; id: string; line: number }[]
  /** markdown-it 要求 env 可挂任意键 */
  [key: string]: unknown
}

/** 渲染完成后对 DOM 做增强（挂交互、异步渲染图表） */
export interface BlockRenderer {
  /** 唯一名字，重复注册会报错 */
  name: string
  /** 接管的 markdown-it token.type */
  tokenTypes: string[]
  /**
   * 安装 tokenizer 插件。markdown-it 内置语法不需要，
   * 自定义语法（如 $公式$）在这里挂 block / inline ruler。
   */
  install?: (md: Md) => void
  /** 覆盖 markdown-it 的渲染规则 */
  rule?: RenderRule
  /** HTML 挂进 DOM 后执行；root 是持久容器，同一次渲染只跑一次绑定 */
  enhance?: (root: HTMLElement, env: RenderEnv) => void | Promise<void>
  /** 执行顺序，小者先跑 */
  order?: number
}

/**
 * 渲染注册表：block type → renderer。
 * 新增一种 md 元素只需注册一个 BlockRenderer，核心代码零改动。
 */
export class RenderRegistry {
  private readonly blocks = new Map<string, BlockRenderer>()

  register(renderer: BlockRenderer): this {
    if (this.blocks.has(renderer.name)) {
      throw new Error(`重复注册渲染器：${renderer.name}`)
    }
    this.blocks.set(renderer.name, renderer)
    return this
  }

  registerAll(renderers: BlockRenderer[]): this {
    for (const r of renderers) this.register(r)
    return this
  }

  get size(): number {
    return this.blocks.size
  }

  list(): BlockRenderer[] {
    return [...this.blocks.values()]
  }

  /** 按 order 排序后的渲染器列表 */
  get ordered(): BlockRenderer[] {
    return [...this.blocks.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /** 把注册表里所有渲染规则挂到 markdown-it 实例上 */
  applyRules(md: Md): void {
    const rules = md.renderer.rules as unknown as Record<string, RenderRule>
    for (const block of this.blocks.values()) {
      block.install?.(md)
      if (!block.rule) continue
      for (const tokenType of block.tokenTypes) {
        rules[tokenType] = block.rule
      }
    }
  }

  /** 渲染后统一执行 DOM 增强 */
  async enhance(root: HTMLElement, env: RenderEnv): Promise<void> {
    for (const block of this.ordered) {
      if (!block.enhance) continue
      await block.enhance(root, env)
    }
  }
}
