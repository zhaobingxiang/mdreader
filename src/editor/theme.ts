import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** Markdown 语法高亮：颜色全部走 CSS 变量，跟随阅读主题切换 */
export const mdHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--md-h1)' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', color: 'var(--md-h2)' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '600', color: 'var(--md-h3)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--md-h4)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--md-dim)' },
  { tag: [t.link, t.url], color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--md-code-fg)', background: 'var(--md-code-bg)' },
  { tag: t.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: [t.list, t.contentSeparator], color: 'var(--md-marker)', fontWeight: '600' },
  { tag: t.labelName, color: 'var(--md-link)' },
  { tag: t.comment, color: 'var(--md-dim)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--md-danger)' },
  // 代码块内的语法高亮
  { tag: t.keyword, color: 'var(--tok-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--tok-number)' },
  { tag: t.function(t.variableName), color: 'var(--tok-func)' },
  { tag: t.typeName, color: 'var(--tok-type)' },
  { tag: t.operator, color: 'var(--tok-op)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--tok-prop)' },
])

/** 编辑器外观。行内即时弱化语法标记，写作时更接近所见即所得 */
export const mdEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 15px)',
    backgroundColor: 'transparent',
    color: 'var(--text-1)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.75',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '28px 0 45vh',
    caretColor: 'var(--accent)',
    maxWidth: 'var(--reading-width, 760px)',
    margin: '0 auto',
  },
  '.cm-line': { padding: '0 24px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-1)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-line-hl)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  // 拖选底色统一在 styles/layout.css 里覆盖：
  // CM6 baseTheme 的选择器特异性更高，这里写普通类选择器压不过它。
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--editor-search)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-search-sel)' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-1)',
    color: 'var(--text-1)',
    border: 'none',
  },
  '.cm-panel.cm-search': { padding: '6px 10px', fontSize: '13px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-1)',
    border: '1px solid var(--border-1)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-2)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '13px', maxHeight: '320px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-strong)',
  },
  '.cm-completionLabel': { fontSize: '13px' },
  '.cm-completionDetail': { fontStyle: 'normal', fontSize: '11px', color: 'var(--text-3)', marginLeft: '8px' },
  '.cm-diagnostic': { padding: '6px 10px', fontSize: '13px', borderLeft: 'none' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-diagnostic-info': { borderLeft: '3px solid var(--accent)' },
  '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px wavy var(--danger)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', borderBottom: '2px wavy var(--warn)' },
  '.cm-lintRange-info': { backgroundImage: 'none', borderBottom: '2px dotted var(--accent)' },
})

export const mdSyntaxHighlighting = syntaxHighlighting(mdHighlightStyle)
