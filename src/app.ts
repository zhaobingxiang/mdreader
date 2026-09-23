import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { MarkdownDocument } from './core/document'
import { fsAccessAdapter, isFsAccessSupported } from './core/file/fs-access'
import {
  createHostHandle,
  isWebViewHost,
  notifyTitle,
  onHostEvent,
  revealInExplorer,
  webviewAdapter,
} from './core/file/webview'
import { collectTodos, computeStats } from './core/stats'
import { ViewModeController, type ViewMode } from './core/view-mode'
import { WELCOME_DOC } from './core/welcome'
import { createZoomController, formatZoom, MAX_ZOOM, MIN_ZOOM } from './core/zoom'
import { createEditor, type EditorHandle } from './editor/create'
import { setHighlights, type HighlightKind } from './editor/extensions/highlight'
import { analyzeLinesCached, type LineInfo } from './editor/extensions/lint'
import { ScrollSync } from './editor/sync-scroll'
import { copyMarkdown, copyRichText, exportHtml, printPreview } from './features/export'
import { createDefaultRegistry, MarkdownEngine, type OutlineNode } from './render/markdown'
import { PreviewPipeline } from './render/pipeline'
import { debounce } from './render/util'
import { showDiffModal } from './ui/diff-view'
import { clearPreviewHighlight, highlightPreviewRange, mapPreviewSelection } from './ui/highlight'
import { createLayout } from './ui/layout'
import {
  highlightOutline,
  renderHints,
  renderOutline,
  renderTodos,
  resolveActiveOutlineId,
  type HintEntry,
} from './ui/panels'

const RENDER_DEBOUNCE_MS = 180
const FILE_NAME_RE = /\.(md|markdown|mdown|mkd|txt)$/i

export function bootstrapApp(mount: HTMLElement): void {
  const layout = createLayout(mount)
  const model = new MarkdownDocument()
  const viewMode = new ViewModeController('split')
  const engine = new MarkdownEngine(createDefaultRegistry())
  const pipeline = new PreviewPipeline(engine)
  /** 跑在 .NET + WebView2 桌面壳里时，文件能力由宿主提供 */
  const inDesktopShell = isWebViewHost()
  model.setAdapter(inDesktopShell ? webviewAdapter : fsAccessAdapter)

  /** 编辑器和滚动同步就绪标志。zoom 的 subscribe 会立即同步回调一次，
   *  它引用的 let 必须在此之前声明，否则回调会踩进暂时性死区 */
  let editorReady = false
  const zoom = createZoomController()
  zoom.subscribe((factor) => {
    layout.zoomValue.textContent = formatZoom(factor)
    // subscribe 会立即同步回调一次，那时编辑器还没创建，先跳过
    if (!editorReady) return
    // 字号缩放会改变排版：编辑器要重新测量，滚动锚点要重建
    editor.view.requestMeasure()
    scrollSync.refreshAnchors()
  })

  let outline: OutlineNode[] = []
  let activeOutlineId: string | null = null
  let editor!: EditorHandle
  /** 最近一次分析出的书写提示，供「应用建议」按索引取用 */
  let currentHints: HintEntry[] = []

  /**
   * 程序化改动编辑器选区时置位。
   * 否则「定位到某行」「预览反向选区」会被当成用户选择，
   * 反过来把提示高亮覆盖成普通选区色，或形成双向回环。
   */
  let suppressSelectionSync = false

  /** 编辑器选区 → 预览对应块高亮 */
  const syncEditorSelectionToPreview = debounce((from: number, to: number) => {
    if (viewMode.current !== 'split') return
    if (from === to) {
      clearPreviewHighlight(layout.previewHost)
      return
    }
    const state = editor.view.state.doc
    highlightPreviewRange(
      layout.previewHost,
      state.lineAt(from).number,
      state.lineAt(to).number,
      'selection',
    )
  }, 120)

  /** 预览选区 → 编辑器选区 */
  const syncPreviewSelectionToEditor = debounce(() => {
    if (viewMode.current !== 'split') return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    if (!layout.previewHost.contains(selection.anchorNode)) return

    const mapped = mapPreviewSelection(layout.previewHost, (fromLine, toLine) => {
      const state = editor.view.state.doc
      // data-line 已经是 1-based，可直接当行号用
      const lo = Math.min(Math.max(Math.min(fromLine, toLine), 1), state.lines)
      const hi = Math.min(Math.max(Math.max(fromLine, toLine), 1), state.lines)
      const start = state.line(lo)
      const end = state.line(hi)
      return { from: start.from, to: end.to, text: state.sliceString(start.from, end.to) }
    })
    if (!mapped) return

    suppressSelectionSync = true
    editor.view.dispatch({
      selection: { anchor: mapped.from, head: mapped.to },
      effects: EditorView.scrollIntoView(mapped.from, { y: 'nearest' }),
    })
    suppressSelectionSync = false
  }, 180)

  model.createUntitled('未命名.md')
  model.setText(WELCOME_DOC)
  // 欢迎文档是内置内容，不该以「未保存」状态开场
  model.markSaved()

  editor = createEditor({
    parent: layout.editorHost,
    initialText: model.currentText,
    callbacks: {
      onChange: (text) => model.setText(text),
      onCursor: (line, column, selected) => {
        layout.statCursor.textContent =
          selected > 0 ? `${line}:${column} · 选中 ${selected}` : `${line}:${column}`
      },
      onSelection: (from, to) => {
        if (suppressSelectionSync) return
        syncEditorSelectionToPreview(from, to)
      },
      onScroll: () => scheduleOutlineSync(),
    },
  })

  const scrollSync = new ScrollSync(
    {
      scroller: editor.view.scrollDOM,
      topLine: () => editor.topVisibleLine(),
      scrollToLine: (line) => editor.scrollToLine(line),
    },
    layout.previewPane,
  )
  editorReady = true

  const scheduleRender = debounce(() => void renderAll(), RENDER_DEBOUNCE_MS)

  // ---------- 渲染 ----------

  async function renderAll(): Promise<void> {
    const result = await pipeline.renderInto(layout.previewHost, model.currentText, '')
    if (result.stale) return

    outline = result.outline
    renderOutline(layout.outlineList, outline, activeOutlineId)
    scrollSync.refreshAnchors()
    updateHints()
    updateStatus()
  }

  function updateHints(): void {
    const lines = currentLineInfos()
    const diagnostics = analyzeLinesCached(lines)
    currentHints = diagnostics
      .filter((d) => d.severity !== 'hint')
      .map((d) => ({
        severity: d.severity as HintEntry['severity'],
        message: d.message,
        line: lineOf(lines, d.from),
        fix: d.fix,
      }))
    renderHints(layout.hintList, layout.hintSummary, currentHints)
    renderTodos(layout.hintTodos, collectTodos(model.currentText))

    const fixable = currentHints.filter((hint) => hint.fix).length
    layout.fixAll.hidden = fixable === 0
    layout.fixAll.textContent = `应用全部 (${fixable})`
  }

  function updateStatus(): void {
    const stats = computeStats(model.currentText)
    layout.statWords.textContent = `${stats.words} 字`
    layout.statLines.textContent = `${stats.lines} 行`
    layout.statReading.textContent = stats.readingMinutes > 0 ? `约 ${stats.readingMinutes} 分钟` : ''
    const snapshot = model.snapshot
    layout.statPath.textContent = snapshot.path || snapshot.name
    layout.docName.textContent = snapshot.name
    layout.dirtyDot.hidden = !snapshot.dirty
    layout.statNotice.textContent = snapshot.notice ?? ''
    if (inDesktopShell) notifyTitle(snapshot.name, snapshot.dirty)
  }

  function currentLineInfos(): LineInfo[] {
    const doc = editor.view.state.doc
    const out: LineInfo[] = []
    for (let i = 1; i <= doc.lines; i += 1) {
      const line = doc.line(i)
      out.push({ text: line.text, from: line.from, to: line.to, number: i })
    }
    return out
  }

  function lineOf(lines: LineInfo[], pos: number): number {
    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((lines[mid]?.from ?? 0) <= pos) lo = mid
      else hi = mid - 1
    }
    return lines[lo]?.number ?? 1
  }

  const scheduleOutlineSync = debounce(() => {
    const id = resolveActiveOutlineId(layout.outlineList, editor.topVisibleLine())
    if (id === activeOutlineId) return
    activeOutlineId = id
    highlightOutline(layout.outlineList, id)
  }, 90)

  // ---------- 文档事件 ----------

  model.subscribe((event) => {
    if (event.type === 'doc-switched') {
      // 打开 / 切换文档：重建编辑器状态，清空撤销历史
      editor.resetDoc(model.currentText)
      scheduleRender()
      clearPreviewHighlight(layout.previewHost)
      updateStatus()
      return
    }
    if (event.type === 'text') {
      if (editor.getText() !== model.currentText) editor.setText(model.currentText)
      scheduleRender()
      return
    }
    if (event.type === 'external') {
      layout.externalBanner.hidden = false
      updateStatus()
      return
    }
    layout.externalBanner.hidden = model.snapshot.pendingExternal === null
    updateStatus()
  })

  // ---------- 桌面壳事件 ----------

  if (inDesktopShell) {
    onHostEvent((event) => {
      if (event.event === 'openFile') {
        // 双击 .md、启动参数、第二个实例的转发都走这里
        void model.open(createHostHandle(event))
      } else if (event.event === 'error') {
        model.setNotice(event.message)
      }
    })
  }

  // ---------- 视图模式 ----------

  function applyMode(mode: ViewMode): void {
    layout.root.dataset.mode = mode
    for (const el of layout.modeSwitch.querySelectorAll<HTMLElement>('.segmented__item')) {
      const active = el.dataset.mode === mode
      el.classList.toggle('is-active', active)
      el.setAttribute('aria-selected', String(active))
    }
    layout.splitter.hidden = mode !== 'split'
    if (mode === 'split') {
      scrollSync.enable()
      scrollSync.refreshAnchors()
    } else {
      scrollSync.disable()
    }
    if (mode !== 'edit') scheduleRender()
  }

  viewMode.subscribe(applyMode)

  layout.modeSwitch.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('.segmented__item')
    const mode = btn?.dataset.mode as ViewMode | undefined
    if (mode) viewMode.set(mode)
  })

  // ---------- 文件操作 ----------

  async function openFile(): Promise<void> {
    if (!isFsAccessSupported()) {
      model.setNotice('当前浏览器不支持直接打开本地文件，请把文件拖进窗口')
      return
    }
    await model.openViaPicker()
    model.setNotice('已打开')
  }

  async function saveFile(): Promise<void> {
    await model.save()
  }

  // ---------- 顶栏与导出 ----------

  const menuList = layout.exportMenu.querySelector<HTMLElement>('.menu__list')

  /** 点百分比就地变成输入框，回车或失焦应用 */
  function startZoomEdit(): void {
    const button = layout.zoomValue
    if (button.nextElementSibling?.classList.contains('zoom__input')) return

    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'zoom__input'
    input.min = String(Math.round(MIN_ZOOM * 100))
    input.max = String(Math.round(MAX_ZOOM * 100))
    input.step = '5'
    input.value = String(Math.round(zoom.get() * 100))

    button.replaceWith(input)
    input.focus()
    input.select()

    let done = false
    const commit = (apply: boolean): void => {
      if (done) return
      done = true
      if (apply) {
        const percent = Number(input.value)
        if (Number.isFinite(percent) && percent > 0) zoom.set(percent / 100)
      }
      input.replaceWith(button)
      layout.zoomValue.textContent = formatZoom(zoom.get())
    }

    input.addEventListener('blur', () => commit(true))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        commit(false)
      }
    })
  }

  async function handleExport(kind: string): Promise<void> {
    const name = model.snapshot.name
    switch (kind) {
      case 'html':
        exportHtml(layout.previewHost.innerHTML, name)
        model.setNotice('已导出 HTML')
        break
      case 'pdf':
        printPreview()
        break
      case 'rich': {
        const ok = await copyRichText(layout.previewHost.innerHTML, model.currentText)
        model.setNotice(ok ? '已复制为富文本' : '浏览器不支持富文本剪贴板，已复制纯文本')
        break
      }
      case 'markdown':
        await copyMarkdown(model.currentText)
        model.setNotice('已复制 Markdown 源码')
        break
      default:
        break
    }
  }

  layout.root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const exportItem = target.closest<HTMLElement>('[data-export]')
    if (exportItem) {
      if (menuList) menuList.hidden = true
      void handleExport(exportItem.dataset.export ?? '')
      return
    }

    const actionBtn = target.closest<HTMLElement>('[data-action]')
    if (!actionBtn) return
    switch (actionBtn.dataset.action) {
      case 'open':
        void openFile()
        break
      case 'new':
        model.createUntitled()
        break
      case 'save':
        void saveFile()
        break
      case 'toggle-outline':
        layout.outlinePanel.classList.toggle('is-collapsed')
        break
      case 'toggle-hints':
        layout.hintPanel.classList.toggle('is-collapsed')
        break
      case 'export':
        if (menuList) menuList.hidden = !menuList.hidden
        break
      case 'zoom-in':
        zoom.zoomIn()
        break
      case 'zoom-out':
        zoom.zoomOut()
        break
      case 'zoom-edit':
        startZoomEdit()
        break
      case 'undo':
        undo(editor.view)
        break
      case 'redo':
        redo(editor.view)
        break
      case 'fix-all': {
        const fixes = currentHints
          .filter((hint) => hint.fix)
          .map((hint) => hint.fix!)
        const applied = applyFixes(fixes)
        model.setNotice(applied > 0 ? `已应用 ${applied} 条建议` : '没有可自动应用的修改')
        break
      }
      case 'accept-external':
        model.acceptExternal()
        break
      case 'dismiss-external':
        model.dismissExternal()
        break
      case 'diff-external': {
        const incoming = model.pendingExternalText
        if (incoming === null) break
        showDiffModal({
          title: `${model.snapshot.name} 的外部改动`,
          before: model.currentText,
          after: incoming,
          onAccept: () => model.acceptExternal(),
          onDismiss: () => model.dismissExternal(),
        })
        break
      }
      default:
        break
    }
  })

  document.addEventListener('click', (event) => {
    if (!layout.exportMenu.contains(event.target as Node) && menuList) menuList.hidden = true
  })

  // ---------- 侧栏交互 ----------

  layout.outlineList.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('.outline__item')
    if (!btn) return
    const line = Number(btn.dataset.line ?? '1')
    if (viewMode.current === 'edit') {
      editor.scrollToLine(line)
    } else {
      const id = btn.dataset.id ?? ''
      layout.previewHost
        .querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    editor.focus()
  })

  /** 定位到某一行，并在编辑区与预览区同时用对应底色标出位置 */
  function locateLine(line: number, kind: HighlightKind): void {
    const state = editor.view.state.doc
    const safe = Math.min(Math.max(line, 1), state.lines)
    const info = state.line(safe)

    // 抑制选区同步：否则这次程序化选中会立刻把提示色覆盖成普通选区色
    suppressSelectionSync = true
    editor.view.dispatch({
      selection: { anchor: info.from, head: info.to },
      effects: [
        setHighlights.of([{ from: info.from, to: info.to, kind }]),
        EditorView.scrollIntoView(info.from, { y: 'center' }),
      ],
    })
    suppressSelectionSync = false

    editor.focus()
    const hits = highlightPreviewRange(layout.previewHost, safe, safe, kind)
    const target =
      hits[0] ?? layout.previewHost.querySelector<HTMLElement>(`[data-line="${safe}"]`)
    target?.scrollIntoView({ block: 'center' })
  }

  /** 应用一批文本替换。位置重叠的会被丢弃，否则 CodeMirror 会直接抛错 */
  function applyFixes(fixes: { from: number; to: number; insert: string }[]): number {
    if (fixes.length === 0) return 0

    const sorted = [...fixes].sort((a, b) => a.from - b.from || a.to - b.to)
    const accepted: typeof sorted = []
    let lastEnd = -1
    for (const fix of sorted) {
      if (fix.from < lastEnd) continue
      accepted.push(fix)
      lastEnd = fix.to
    }
    if (accepted.length === 0) return 0

    editor.view.dispatch({
      changes: accepted.map((fix) => ({ from: fix.from, to: fix.to, insert: fix.insert })),
    })
    editor.focus()
    return accepted.length
  }

  layout.hintPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    // 「应用」按钮：直接改文档
    const fixButton = target.closest<HTMLElement>('[data-hint-fix]')
    if (fixButton) {
      const hint = currentHints[Number(fixButton.dataset.hintFix)]
      if (hint?.fix) {
        const applied = applyFixes([hint.fix])
        model.setNotice(applied > 0 ? `已应用：${hint.fix.label}` : '该建议无法应用')
      }
      return
    }

    // 其余区域：定位到问题所在
    const clickTarget = target.closest<HTMLElement>('.hint__main, .todo')
    if (!clickTarget) return
    const container = clickTarget.closest<HTMLElement>('.hint, .todo') ?? clickTarget
    const line = Number(container.dataset.line ?? '1')
    const kind = (container.dataset.severity as HighlightKind | undefined) ?? 'info'

    // 单栏时看不到对照关系，自动切到分屏
    if (viewMode.current !== 'split') viewMode.set('split')
    locateLine(line, kind)
  })

  // 回到编辑器操作时撤掉提示高亮，避免长期干扰阅读
  layout.editorHost.addEventListener('mousedown', () => {
    editor.view.dispatch({ effects: setHighlights.of([]) })
  })

  // 预览里选中文字 → 反向标记到编辑器
  document.addEventListener('selectionchange', () => {
    syncPreviewSelectionToEditor()
  })

  layout.statPath.addEventListener('click', () => {
    const path = model.snapshot.path
    if (inDesktopShell && path) revealInExplorer(path)
  })

  // ---------- 分栏拖拽 ----------

  layout.splitter.addEventListener('pointerdown', (event) => {
    if (viewMode.current !== 'split') return
    const startX = event.clientX
    const startWidth = layout.editorPane.getBoundingClientRect().width
    const total = layout.workspace.getBoundingClientRect().width

    const onMove = (moveEvent: PointerEvent): void => {
      const next = Math.min(Math.max(startWidth + (moveEvent.clientX - startX), 240), total - 260)
      layout.root.style.setProperty('--editor-width', `${Math.round(next)}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('is-resizing')
      scrollSync.refreshAnchors()
    }

    document.body.classList.add('is-resizing')
    layout.root.classList.add('is-resized')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

  // ---------- 拖入文件 ----------

  let dragDepth = 0
  document.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (!event.dataTransfer?.types.includes('Files')) return
    layout.dropHint.hidden = false
  })
  document.addEventListener('dragenter', () => {
    dragDepth += 1
    layout.dropHint.hidden = false
  })
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) layout.dropHint.hidden = true
  })
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    layout.dropHint.hidden = true
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    if (!FILE_NAME_RE.test(file.name)) {
      model.setNotice('只支持 .md / .markdown / .txt 文件')
      return
    }
    void model.openDroppedFile(file)
  })

  // ---------- 快捷键 ----------

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    // 缩放输入框里不拦按键
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    const key = event.key.toLowerCase()

    if (key === '0') {
      event.preventDefault()
      zoom.reset()
      return
    }
    if (key === '=' || key === '+') {
      event.preventDefault()
      zoom.zoomIn()
      return
    }
    if (key === '-' || key === '_') {
      event.preventDefault()
      zoom.zoomOut()
      return
    }

    if (key === 'e') {
      event.preventDefault()
      if (event.shiftKey) viewMode.toggleSplit()
      else viewMode.toggleEditPreview()
      return
    }
    if (key === 's') {
      event.preventDefault()
      void saveFile()
      return
    }
    if (key === 'o') {
      event.preventDefault()
      void openFile()
      return
    }
    if (key === 'n') {
      event.preventDefault()
      model.createUntitled()
    }
  })

  // Ctrl + 滚轮缩放（两个环境都拦下来自己处理，只缩内容区字号）。
  // 桌面壳已在宿主侧关闭内置缩放（IsZoomControlEnabled = false），
  // 否则它会连同菜单栏一起缩放。
  document.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      if (event.deltaY < 0) zoom.zoomIn()
      else zoom.zoomOut()
    },
    { passive: false },
  )

  window.addEventListener('beforeunload', (event) => {
    if (!model.snapshot.dirty) return
    event.preventDefault()
    event.returnValue = ''
  })

  // ---------- 启动 ----------

  layout.previewPane.addEventListener('scroll', () => scheduleOutlineSync(), { passive: true })
  applyMode(viewMode.current)
  void renderAll()
  updateStatus()
  editor.focus()
}
