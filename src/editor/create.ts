import { Annotation, EditorState, Transaction, type Extension } from '@codemirror/state'
import {
  EditorView,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { mdEditorTheme, mdSyntaxHighlighting } from './theme'
import { markdownLinter } from './extensions/lint'
import { markdownSnippetSource } from './extensions/autocomplete'
import { highlightField } from './extensions/highlight'

/** 标记「由外部程序写入」，用于把程序改动与用户输入区分开 */
export const ExternalUpdate = Annotation.define<boolean>()

export interface EditorCallbacks {
  onChange(text: string): void
  onCursor?(line: number, column: number, selectedChars: number): void
  /** 选区变化（用于分屏时的双向选区同步） */
  onSelection?(from: number, to: number): void
  onScroll?(): void
}

export interface EditorHandle {
  readonly view: EditorView
  getText(): string
  /** 程序化写入，不会触发 onChange */
  setText(text: string): void
  /** 重建编辑器状态（彻底清空撤销历史），用于打开 / 切换文档 */
  resetDoc(text: string): void
  /** 当前编辑器状态快照（含撤销历史与选区），标签页切走时保存 */
  currentState(): EditorState
  /** 用本编辑器扩展新建一份状态（历史为空），标签页首次挂载时用 */
  newStateFor(text: string): EditorState
  /** 切换到已有状态；只接受本编辑器产生的状态，标签页切回时用 */
  useState(state: EditorState): void
  focus(): void
  scrollToLine(line: number): void
  /** 当前视口顶部的行号，供滚动同步用 */
  topVisibleLine(): number
  destroy(): void
}

export interface CreateEditorOptions {
  parent: HTMLElement
  initialText?: string
  readOnly?: boolean
  callbacks: EditorCallbacks
}

function baseExtensions(options: CreateEditorOptions): Extension[] {
  const { callbacks } = options

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    // 不用 drawSelection：它自绘的选区矩形在系统 DPI / 缩放环境下对
    // 「单行内选一部分」最容易算出无效矩形，表现为拖选没有选中底色。
    // 改用浏览器原生 ::selection（见 layout.css），任何环境下都像 txt 一样可靠。
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    autocompletion({ override: [markdownSnippetSource], activateOnTyping: true }),
    markdownLinter(),
    highlightField,
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: true,
    }),
    mdSyntaxHighlighting,
    mdEditorTheme,
    EditorView.lineWrapping,
    EditorState.readOnly.of(Boolean(options.readOnly)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const fromExternal = update.transactions.some((tr) => tr.annotation(ExternalUpdate))
        if (!fromExternal) callbacks.onChange(update.state.doc.toString())
      }
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main
        const line = update.state.doc.lineAt(range.head)
        callbacks.onCursor?.(line.number, range.head - line.from + 1, range.to - range.from)
        callbacks.onSelection?.(range.from, range.to)
      }
      if (update.geometryChanged || update.viewportChanged) {
        callbacks.onScroll?.()
      }
    }),
    EditorView.domEventHandlers({
      scroll: () => {
        callbacks.onScroll?.()
        return false
      },
    }),
  ]
}

export function createEditor(options: CreateEditorOptions): EditorHandle {
  const extensions = baseExtensions(options)
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.initialText ?? '',
      extensions,
    }),
  })

  return {
    view,
    getText: () => view.state.doc.toString(),
    currentState: () => view.state,
    newStateFor: (text) => EditorState.create({ doc: text, extensions }),
    useState(state) {
      view.setState(state)
    },
    resetDoc(text) {
      // 打开 / 切换文档时重建整个 state：彻底清空撤销历史。
      // 仅用 Transaction.remote 不够——旧文档的编辑记录还在历史里，
      // undo 会一路回退到上一个打开的文档内容
      view.setState(EditorState.create({ doc: text, extensions }))
    },
    setText(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        annotations: [
          ExternalUpdate.of(true),
          // 整篇替换（打开文档 / 采纳外部改写）不进撤销历史，
          // 否则撤销会一路回退到上一个打开的文档内容
          Transaction.remote.of(true),
        ],
      })
    },
    focus: () => view.focus(),
    scrollToLine(line) {
      const target = Math.min(Math.max(line, 1), view.state.doc.lines)
      const pos = view.state.doc.line(target).from
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }) })
    },
    topVisibleLine() {
      const scrollTop = view.scrollDOM.scrollTop
      const block = view.lineBlockAtHeight(scrollTop + 4)
      return view.state.doc.lineAt(block.from).number
    },
    destroy: () => view.destroy(),
  }
}
