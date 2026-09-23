import type MarkdownIt from 'markdown-it'

/**
 * markdown-it 的类型声明导出的是构造函数 const（`export = MarkdownIt`），
 * 不能直接当类型用，必须经 InstanceType 取实例类型。
 */
export type Md = InstanceType<typeof MarkdownIt>
