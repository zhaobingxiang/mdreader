import { describe, expect, it } from 'vitest'
import { analyzeLines, extractHeadings, type LineInfo } from '../src/editor/extensions/lint'

export function toLines(text: string): LineInfo[] {
  const out: LineInfo[] = []
  let pos = 0
  const raw = text.split('\n')
  raw.forEach((lineText, i) => {
    out.push({ text: lineText, from: pos, to: pos + lineText.length, number: i + 1 })
    pos += lineText.length + 1
  })
  return out
}

describe('analyzeLines：标点混用', () => {
  it('中文后接半角标点给出全角修复', () => {
    const d = analyzeLines(toLines('你好,世界'))
    const hit = d.find((x) => x.message.includes('，'))
    expect(hit).toBeDefined()
    expect(hit?.fix?.insert).toBe('，')
  })

  it('文件名扩展名豁免：中文.md 不误报', () => {
    const d = analyzeLines(toLines('请查看 使用说明.md 了解详情'))
    expect(d.filter((x) => x.message.includes('标点'))).toHaveLength(0)
  })

  it('行内代码内的标点不参与检查', () => {
    const d = analyzeLines(toLines('执行 `a.md,b.txt` 这个文件'))
    expect(d.filter((x) => x.message.includes('标点'))).toHaveLength(0)
  })
})

describe('analyzeLines：链接与围栏', () => {
  it('空链接可自动修复为纯文本', () => {
    const lines = toLines('参考 [文档]() 里的说明')
    const d = analyzeLines(lines)
    const link = d.find((x) => x.message.includes('链接地址为空'))
    expect(link).toBeDefined()
    const raw = lines[0]!.text.slice(link!.from - lines[0]!.from, link!.to - lines[0]!.from)
    expect(raw).toBe('[文档]()')
    expect(link?.fix?.insert).toBe('文档')
  })

  it('未闭合代码块报 error 并可补围栏', () => {
    const lines = toLines('```python\nprint(1)')
    const d = analyzeLines(lines)
    const fence = d.find((x) => x.severity === 'error')
    expect(fence?.message).toContain('结束围栏')
    expect(fence?.fix?.insert).toBe('\n```\n')
  })

  it('闭合完整时代码块内部不做任何检查', () => {
    const d = analyzeLines(toLines('```\n你好,这里不该报错。\n```'))
    expect(d).toHaveLength(0)
  })
})

describe('extractHeadings 与层级跳跃', () => {
  it('代码块内的 # 不算标题', () => {
    const headings = extractHeadings(toLines('```\n# 注释\n```'))
    expect(headings).toHaveLength(0)
  })

  it('H1 直接跳 H3 时建议逐级递进', () => {
    const lines = toLines('# 一\n\n### 三')
    const d = analyzeLines(lines)
    const jump = d.find((x) => x.message.includes('跳到'))
    expect(jump).toBeDefined()
    expect(jump?.fix?.insert).toBe('##')
  })

  it('重复标题只提示不自动修复', () => {
    const d = analyzeLines(toLines('## 概述\n\n## 概述'))
    const dup = d.filter((x) => x.message.includes('重复'))
    expect(dup).toHaveLength(1)
    expect(dup[0]!.fix).toBeUndefined()
  })
})
