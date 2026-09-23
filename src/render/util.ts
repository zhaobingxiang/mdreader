/** 转义 HTML 文本 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/** 生成标题锚点 id，中文保留、空格转连字符 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): ((...args: A) => void) & { cancel(): void } {
  let timer: number | undefined
  const wrapped = (...args: A): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      fn(...args)
    }, wait)
  }
  wrapped.cancel = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
  }
  return wrapped
}

/** 简单的行级 diff，够用于「外部改写」审阅 */
export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  // LCS 动态规划；文档量级下开销可以接受
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j += 1
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i]! })
    i += 1
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j]! })
    j += 1
  }
  return out
}
