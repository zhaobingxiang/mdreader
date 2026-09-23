import { linter, type Diagnostic } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'

export interface LineInfo {
  text: string
  /** 行首在文档中的位置 */
  from: number
  /** 行尾在文档中的位置 */
  to: number
  /** 行号，从 1 开始 */
  number: number
}

export interface LintOptions {
  /** 中英文标点混用提示 */
  punctuation?: boolean
  /** 中英文之间缺少空格的提示（默认关，提示量大） */
  pangu?: boolean
  /** 重复标题提示 */
  duplicateHeading?: boolean
}

export interface HeadingInfo {
  level: number
  text: string
  from: number
  to: number
  number: number
}

/** 可自动应用的修复：把 [from, to) 替换成 insert */
export interface LintFix {
  from: number
  to: number
  insert: string
  label: string
}

export interface MarkdownDiagnostic extends Diagnostic {
  fix?: LintFix
}

const FULLWIDTH: Record<string, string> = {
  ',': '，',
  '.': '。',
  ';': '；',
  ':': '：',
  '!': '！',
  '?': '？',
  '(': '（',
  ')': '）',
}

const MAX_DIAGNOSTICS = 60
const FENCE_END = '\n```\n'

function diag(
  from: number,
  to: number,
  severity: Diagnostic['severity'],
  message: string,
  fix?: LintFix,
): MarkdownDiagnostic {
  return { from, to, severity, message, fix }
}

/**
 * 把「非正文」片段替换成等长空白：行内代码、链接目标、URL、内嵌标签。
 * 位置保持不变，这样后续的标点检查既能跳过它们，又能给出准确的偏移。
 *
 * 这一步很关键——否则 `使用说明.md` 这类行内代码会被当成中文标点误用。
 */
function maskNonProse(line: string): string {
  let masked = line
  masked = masked.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length))
  masked = masked.replace(/!\[[^\]]*\]/g, (m) => ' '.repeat(m.length))
  masked = masked.replace(/\]\([^)]*\)/g, (m) => ' '.repeat(m.length))
  masked = masked.replace(/<[^>]*>/g, (m) => ' '.repeat(m.length))
  masked = masked.replace(/\bhttps?:\/\/\S+/g, (m) => ' '.repeat(m.length))
  return masked
}

/** 中文后接 .md / .exe / .go 这类扩展名时不算标点误用 */
const FILE_EXT_AFTER_DOT = /^[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9])/

/** 只屏蔽行内代码（链接语法保留，供空链接检测用） */
function maskInlineCodeOnly(line: string): string {
  return line.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length))
}

/** 提取文档里所有标题（忽略代码块内的 #） */
export function extractHeadings(lines: LineInfo[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let inFence = false
  let fenceChar = ''

  for (const line of lines) {
    const trimmed = line.text.trimStart()
    const indent = line.text.length - trimmed.length

    const fence = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fence) {
      const ch = fence[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
      }
      continue
    }
    if (inFence) continue

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      headings.push({
        level: heading[1]!.length,
        text: (heading[2] ?? '').trim(),
        from: line.from + indent,
        to: line.to,
        number: line.number,
      })
    }
  }
  return headings
}

export function analyzeLines(lines: LineInfo[], options: LintOptions = {}): MarkdownDiagnostic[] {
  const { punctuation = true, pangu = false, duplicateHeading = true } = options
  const out: MarkdownDiagnostic[] = []

  let inFence = false
  let fenceChar = ''
  let fenceStart: LineInfo | null = null

  for (const line of lines) {
    const trimmed = line.text.trimStart()
    const indent = line.text.length - trimmed.length

    // 围栏代码块：内部整段跳过
    const fence = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fence) {
      const ch = fence[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
        fenceStart = line
      } else if (ch === fenceChar) {
        inFence = false
        fenceStart = null
      }
      continue
    }
    if (inFence) continue

    // 空标题
    const emptyHeading = /^(#{1,6})\s*$/.exec(trimmed)
    if (emptyHeading) {
      out.push(diag(line.from + indent, line.to, 'warning', '标题内容为空'))
      continue
    }

    // 屏蔽非正文片段后再检查
    const masked = maskNonProse(line.text)

    // 空链接：在「屏蔽行内代码」的文本上找——链接目标必须保留，
    // 否则 maskNonProse 会把 `](` 也吃掉导致检测失效
    const emptyLink = /\[[^\]]*\]\(\s*\)/.exec(maskInlineCodeOnly(line.text))
    if (emptyLink) {
      const start = line.from + emptyLink.index
      const raw = line.text.slice(emptyLink.index, emptyLink.index + emptyLink[0].length)
      const label = /\[([^\]]*)\]/.exec(raw)?.[1] ?? ''
      out.push(
        diag(
          start,
          start + emptyLink[0].length,
          'warning',
          '链接地址为空',
          {
            from: start,
            to: start + emptyLink[0].length,
            insert: label,
            label: label ? '移除链接语法' : '删除空链接',
          },
        ),
      )
    }

    if (punctuation) {
      const re = /[\u4e00-\u9fff][,.;:!?()]/g
      let match: RegExpExecArray | null
      while ((match = re.exec(masked)) !== null) {
        const badChar = match[0]![1]!
        const dotPos = line.from + match.index + 1

        // 文件名/扩展名豁免：`使用说明.md`
        if (badChar === '.' && FILE_EXT_AFTER_DOT.test(masked.slice(match.index + 2))) continue

        const good = FULLWIDTH[badChar]
        if (!good) continue

        out.push(
          diag(dotPos, dotPos + 1, 'info', `中文语境建议用全角标点「${good}」`, {
            from: dotPos,
            to: dotPos + 1,
            insert: good,
            label: `改为「${good}」`,
          }),
        )
      }
    }

    if (pangu) {
      const tight = /[\u4e00-\u9fff][A-Za-z]{2,}/.exec(masked)
      const tightRev = /[A-Za-z]{2,}[\u4e00-\u9fff]/.exec(masked)
      const hit = tight ?? tightRev
      if (hit) {
        const start = line.from + hit.index
        out.push(diag(start, start + hit[0].length, 'info', '中英文之间建议留一个空格'))
      }
    }
  }

  // 未闭合代码块：补齐结束围栏（追加到文末即可，因为它一直延伸到最后）
  if (inFence && fenceStart) {
    const end = lines.length > 0 ? lines[lines.length - 1]!.to : 0
    out.push(
      diag(fenceStart.from, fenceStart.to, 'error', '代码块缺少结束围栏', {
        from: end,
        to: end,
        insert: FENCE_END,
        label: '补上结束围栏',
      }),
    )
  }

  const headings = extractHeadings(lines)

  // 标题层级跳跃：把该标题调整到上一级 +1
  let prevLevel = 0
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      const target = prevLevel + 1
      out.push(
        diag(h.from, h.to, 'warning', `标题层级从 H${prevLevel} 跳到 H${h.level}，建议逐级递进`, {
          from: h.from,
          to: h.from + h.level,
          insert: '#'.repeat(target),
          label: `调整为 H${target}`,
        }),
      )
    }
    prevLevel = h.level
  }

  // 重复标题（改名属内容决策，不给自动修复）
  if (duplicateHeading) {
    const seen = new Map<string, number>()
    for (const h of headings) {
      if (!h.text) continue
      const first = seen.get(h.text)
      if (first === undefined) {
        seen.set(h.text, h.number)
      } else {
        out.push(
          diag(h.from, h.to, 'info', `标题「${h.text}」与第 ${first} 行重复，锚点会自动加序号`),
        )
      }
    }
  }

  return out.slice(0, MAX_DIAGNOSTICS)
}

export function markdownLinter(options: LintOptions = {}): Extension {
  return linter(
    (view) => {
      const doc = view.state.doc
      const lines: LineInfo[] = []
      for (let i = 1; i <= doc.lines; i += 1) {
        const line = doc.line(i)
        lines.push({ text: line.text, from: line.from, to: line.to, number: i })
      }
      return analyzeLinesCached(lines, options)
    },
    { delay: 400 },
  )
}

/**
 * 带记忆化的分析：右侧提示面板与编辑器内嵌 linter 对同一份内容
 * 各跑一次全量正则分析没有意义，同文本直接复用上一次结果。
 */
let memo: { key: string; diagnostics: MarkdownDiagnostic[] } | null = null

export function analyzeLinesCached(lines: LineInfo[], options: LintOptions = {}): MarkdownDiagnostic[] {
  const key = `${JSON.stringify(options)}\n${lines.map((l) => l.text).join('\n')}`
  if (memo && memo.key === key) return memo.diagnostics
  const diagnostics = analyzeLines(lines, options)
  memo = { key, diagnostics }
  return diagnostics
}

export { MAX_DIAGNOSTICS }
