import type { OutlineNode } from '../render/markdown'
import type { TodoItem } from '../core/stats'
import type { SnippetGroup } from '../core/snippets'
import type { AiSuggestItem } from '../core/ai/types'
import { escapeHtml } from '../render/util'

export interface HintEntry {
  severity: 'error' | 'warning' | 'info'
  message: string
  line: number
  /** 可自动应用的建议；没有则不显示「应用」按钮 */
  fix?: { from: number; to: number; insert: string; label: string }
}

const SEVERITY_LABEL: Record<HintEntry['severity'], string> = {
  error: '错误',
  warning: '警告',
  info: '建议',
}

export function renderOutline(
  container: HTMLElement,
  nodes: OutlineNode[],
  activeId: string | null,
): void {
  if (nodes.length === 0) {
    container.innerHTML = '<div class="panel__empty">这份文档还没有标题</div>'
    return
  }

  const minLevel = nodes.reduce((acc, n) => Math.min(acc, n.level), 6)

  container.innerHTML = nodes
    .map((node) => {
      const indent = Math.max(0, node.level - minLevel)
      const active = node.id === activeId ? ' is-active' : ''
      return `<button type="button" class="outline__item${active}" data-id="${escapeHtml(node.id)}" data-line="${node.line}" style="--indent:${indent}">
<span class="outline__mark">H${node.level}</span>
<span class="outline__text">${escapeHtml(node.text || '(空标题)')}</span>
</button>`
    })
    .join('')
}

/** 只切换高亮，避免滚动时整体重渲染 */
export function highlightOutline(container: HTMLElement, activeId: string | null): void {
  for (const el of container.querySelectorAll<HTMLElement>('.outline__item')) {
    el.classList.toggle('is-active', activeId !== null && el.dataset.id === activeId)
  }
}

/** 根据当前可见行号，找应该高亮的标题 */
export function resolveActiveOutlineId(container: HTMLElement, line: number): string | null {
  let active: string | null = null
  for (const el of container.querySelectorAll<HTMLElement>('.outline__item')) {
    const elLine = Number(el.dataset.line ?? '0')
    if (elLine > line) break
    active = el.dataset.id ?? null
  }
  return active
}

export function renderHints(
  listEl: HTMLElement,
  summaryEl: HTMLElement,
  entries: HintEntry[],
): void {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const e of entries) counts[e.severity] += 1

  if (entries.length === 0) {
    summaryEl.textContent = '通过'
    summaryEl.className = 'panel__badge is-ok'
  } else {
    const parts = (['error', 'warning', 'info'] as const)
      .filter((k) => counts[k] > 0)
      .map((k) => `${counts[k]} ${SEVERITY_LABEL[k]}`)
    summaryEl.textContent = parts.join(' · ')
    summaryEl.className = `panel__badge${counts.error > 0 ? ' is-error' : counts.warning > 0 ? ' is-warn' : ''}`
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="panel__empty">没有发现书写问题</div>'
    return
  }

  const order: HintEntry['severity'][] = ['error', 'warning', 'info']
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const diff = order.indexOf(a.entry.severity) - order.indexOf(b.entry.severity)
      return diff !== 0 ? diff : a.entry.line - b.entry.line
    })

  listEl.innerHTML = sorted
    .map(({ entry, index }) => {
      const fixButton = entry.fix
        ? `<button type="button" class="hint__fix" data-hint-fix="${index}" title="${escapeHtml(entry.fix.label)}">应用</button>`
        : ''
      return `<div class="hint hint--${entry.severity}" data-line="${entry.line}" data-severity="${entry.severity}">
<button type="button" class="hint__main" data-hint-goto>
<span class="hint__line">${entry.line}</span>
<span class="hint__msg">${escapeHtml(entry.message)}</span>
</button>${fixButton}
</div>`
    })
    .join('')
}

export function renderTodos(el: HTMLElement, todos: TodoItem[]): void {
  if (todos.length === 0) {
    el.innerHTML = ''
    return
  }
  const done = todos.filter((t) => t.done).length
  el.innerHTML = `<div class="hint-todos__head">待办 ${done}/${todos.length}</div>
<div class="hint-todos__list">${todos
    .map(
      (t) => `<button type="button" class="todo${t.done ? ' is-done' : ''}" data-line="${t.line}">
<span class="todo__box">${t.done ? '✓' : ''}</span>
<span class="todo__text">${escapeHtml(t.text || '(空)')}</span>
</button>`,
    )
    .join('')}</div>`
}

/** 语法速查：按分组平铺，点一项插入骨架（data-snippet 是「组-项」下标） */
export function renderSyntax(el: HTMLElement, groups: SnippetGroup[]): void {
  el.innerHTML = groups
    .map(
      (group, gi) => `<div class="syntax__group">
<div class="syntax__title">${escapeHtml(group.title)}</div>
<div class="syntax__grid">${group.items
        .map(
          (item, ii) =>
            `<button type="button" class="syntax__item" data-snippet="${gi}-${ii}" title="${escapeHtml(item.detail)}"><code>${escapeHtml(item.label)}</code></button>`,
        )
        .join('')}</div>
</div>`,
    )
    .join('')
}

export interface AiSuggestView {
  /** 正在为当前文档跑建议 */
  running: boolean
  suggestions: AiSuggestItem[]
  /** 建议生成后文档又改过 */
  stale: boolean
  error: string | null
  /** 还没配置模型时提示去设置 */
  unconfigured: boolean
}

export function renderAiSuggest(el: HTMLElement, view: AiSuggestView): void {
  const action = view.running
    ? '<span class="ai-suggest__note"><span class="spinner"></span>正在通读文档…</span>'
    : view.unconfigured
      ? '<span class="ai-suggest__note">先在设置里选择模型</span>'
      : `<button type="button" class="panel__action" data-action="ai-suggest">${
          view.suggestions.length > 0 ? '重新检查' : '让 AI 检查'
        }</button>`

  const stale = view.stale
    ? '<div class="ai-suggest__stale">文档已改动，建议可能过期</div>'
    : ''
  const error = view.error ? `<div class="ai-suggest__error">${escapeHtml(view.error)}</div>` : ''

  let body = ''
  if (view.suggestions.length > 0) {
    body = `<div class="ai-suggest__list">${view.suggestions
      .map((item) => {
        const line = item.line
          ? `<span class="ai-suggest__line">${item.line}</span>`
          : '<span class="ai-suggest__line">·</span>'
        return `<button type="button" class="ai-suggest__item${item.severity === 'warning' ? ' is-warning' : ''}" data-ai-suggest-line="${item.line ?? ''}">
${line}<span class="ai-suggest__msg">${escapeHtml(item.message)}</span>
</button>`
      })
      .join('')}</div>`
  } else if (!view.running && !view.error && !view.unconfigured) {
    body = '<div class="panel__empty">还没有 AI 建议</div>'
  }

  el.innerHTML = `<div class="ai-suggest__head"><span>AI 建议</span>${action}</div>${stale}${error}${body}`
}
