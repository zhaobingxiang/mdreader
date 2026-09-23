import { StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** 高亮语义：三类书写提示 + 选区同步 */
export type HighlightKind = 'error' | 'warning' | 'info' | 'selection'

export interface HighlightRange {
  from: number
  to: number
  kind: HighlightKind
}

export const setHighlights = StateEffect.define<HighlightRange[]>()

/** 行背景与文字底纹分开做：行长高亮用 line 装饰，文字范围用 mark 装饰 */
const lineDecorations: Record<HighlightKind, Decoration> = {
  error: Decoration.line({ class: 'cm-hl-line cm-hl-line--error' }),
  warning: Decoration.line({ class: 'cm-hl-line cm-hl-line--warning' }),
  info: Decoration.line({ class: 'cm-hl-line cm-hl-line--info' }),
  selection: Decoration.line({ class: 'cm-hl-line cm-hl-line--selection' }),
}

const textDecorations: Record<HighlightKind, Decoration> = {
  error: Decoration.mark({ class: 'cm-hl-text cm-hl-text--error' }),
  warning: Decoration.mark({ class: 'cm-hl-text cm-hl-text--warning' }),
  info: Decoration.mark({ class: 'cm-hl-text cm-hl-text--info' }),
  selection: Decoration.mark({ class: 'cm-hl-text cm-hl-text--selection' }),
}

export const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update(value, tr) {
    // 文档变化时先跟着挪，避免高亮错位
    value = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (!effect.is(setHighlights)) continue

      const ranges = effect.value
      if (ranges.length === 0) return Decoration.none

      const doc = tr.state.doc
      const items: Range<Decoration>[] = []

      for (const raw of ranges) {
        const from = Math.max(0, Math.min(raw.from, doc.length))
        const to = Math.max(from, Math.min(raw.to, doc.length))
        const line = doc.lineAt(from)

        // 行装饰必须是空范围且贴行首
        items.push(lineDecorations[raw.kind].range(line.from))
        if (to > from) {
          items.push(textDecorations[raw.kind].range(from, to))
        }
      }

      items.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
      return Decoration.set(items, true)
    }

    return value
  },

  provide: (field) => EditorView.decorations.from(field),
})

/** 清空高亮 */
export const clearHighlights = setHighlights.of([])
