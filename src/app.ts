import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { MarkdownDocument, type DocumentEvent } from './core/document'
import { fsAccessAdapter, isFsAccessSupported } from './core/file/fs-access'
import {
  callHost,
  createHostHandle,
  DESKTOP_ASSET_BASE,
  isWebViewHost,
  notifyTitle,
  onHostEvent,
  revealInExplorer,
  webviewAdapter,
  type HostFilePayload,
} from './core/file/webview'
import { clearDraft, listDrafts, saveDraft } from './core/draft'
import { applyThemeSetting, currentTheme, type ThemeName } from './core/theme'
import { collectTodos, computeStats } from './core/stats'
import { getSettings, initSettings, patchSettings, subscribeSettings } from './core/settings'
import { ViewModeController, VIEW_MODES, type ViewMode } from './core/view-mode'
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
import { showConfirmModal, showDiffModal } from './ui/diff-view'
import { showMessageModal } from './ui/modal'
import { showSettingsModal } from './ui/settings-modal'
import { clearPreviewHighlight, highlightPreviewRange, mapPreviewSelection } from './ui/highlight'
import { createLayout } from './ui/layout'
import { renderTabs } from './ui/tabbar'
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
const SESSION_KEY = 'mdreader.session'

/** 一个标签页：文档模型 + 视图模式 + 编辑器状态与滚动位置的快照 */
interface TabRecord {
  id: number
  doc: MarkdownDocument
  mode: ViewMode
  /** 切走时保存的编辑器状态（含撤销历史）；null 表示还没挂载过或内容被整体重建 */
  editorState: import('@codemirror/state').EditorState | null
  editorScrollTop: number
  previewScrollTop: number
  /** 未动的欢迎页占位，可被第一个打开的文件接管 */
  welcome: boolean
}

export function bootstrapApp(mount: HTMLElement): void {
  const layout = createLayout(mount)
  const engine = new MarkdownEngine(createDefaultRegistry())
  const pipeline = new PreviewPipeline(engine)
  /** 跑在 .NET + WebView2 桌面壳里时，文件能力由宿主提供 */
  const inDesktopShell = isWebViewHost()
  /** md 里相对路径的图片等资源，桌面壳交给宿主按文档目录解析；浏览器版没有这个能力 */
  const assetBaseDir = inDesktopShell ? DESKTOP_ASSET_BASE : ''
  const adapter = inDesktopShell ? webviewAdapter : fsAccessAdapter

  // ---------- 状态提示 ----------

  let noticeTimer = 0
  /** 短暂提示：几秒后自动消失，避免状态栏被旧消息占住 */
  function flashNotice(message: string | null): void {
    activeDoc().setNotice(message)
    window.clearTimeout(noticeTimer)
    if (message) {
      noticeTimer = window.setTimeout(() => activeDoc().setNotice(null), 4000)
    }
  }

  interface UiState {
    editorWidthPx: number | null
  }

  const UI_KEY = 'mdreader.ui'

  function readUiState(): UiState | null {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<UiState>
      return {
        editorWidthPx: typeof parsed.editorWidthPx === 'number' ? parsed.editorWidthPx : null,
      }
    } catch {
      return null
    }
  }

  function saveUiState(): void {
    try {
      const widthRaw = layout.root.style.getPropertyValue('--editor-width')
      const width = Number.parseInt(widthRaw, 10)
      localStorage.setItem(
        UI_KEY,
        JSON.stringify({ editorWidthPx: Number.isFinite(width) ? width : null } satisfies UiState),
      )
    } catch {
      // 存储配额满 / 无痕模式下失败都不影响使用
    }
  }

  // ---------- 标签页 ----------

  const tabs: TabRecord[] = []
  let activeTab: TabRecord | null = null
  let tabSeq = 1

  function activeDoc(): MarkdownDocument {
    if (!activeTab) throw new Error('还没有活动标签页')
    return activeTab.doc
  }

  function tabPath(t: TabRecord): string {
    return t.doc.snapshot.rawPath
  }

  function hasAnyDirty(): boolean {
    return tabs.some((t) => t.doc.snapshot.dirty)
  }

  /** 视图层的文档事件订阅：只关心当前标签页；其他页的变更只刷新标签栏角标 */
  const modelListeners = new Set<(e: DocumentEvent) => void>()

  function emitDocEvent(e: DocumentEvent): void {
    for (const fn of modelListeners) fn(e)
  }

  function routeDocEvent(t: TabRecord, e: DocumentEvent): void {
    if (t === activeTab) {
      emitDocEvent(e)
      return
    }
    if (e.type === 'text' || e.type === 'meta' || e.type === 'external') {
      renderTabBar()
    }
  }

  function createTab(mode: ViewMode): TabRecord {
    const doc = new MarkdownDocument()
    doc.setAdapter(adapter)
    const t: TabRecord = {
      id: tabSeq++,
      doc,
      mode,
      editorState: null,
      editorScrollTop: 0,
      previewScrollTop: 0,
      welcome: false,
    }
    doc.subscribe((e) => routeDocEvent(t, e))
    tabs.push(t)
    renderTabBar()
    return t
  }

  function createWelcomeTab(): TabRecord {
    const t = createTab(getSettings().defaultMode)
    t.doc.createUntitled()
    t.doc.setText(WELCOME_DOC)
    t.doc.markSaved()
    t.welcome = true
    return t
  }

  // 对上层逻辑而言「当前文档」仍是唯一的 model：委托到活动标签页，
  // 事件仍经 modelListeners 分发
  const model = {
    subscribe(fn: (e: DocumentEvent) => void): () => void {
      modelListeners.add(fn)
      return () => {
        modelListeners.delete(fn)
      }
    },
    get snapshot() {
      return activeDoc().snapshot
    },
    get currentText(): string {
      return activeDoc().currentText
    },
    get pendingExternalText(): string | null {
      return activeDoc().pendingExternalText
    },
    setNotice(message: string | null): void {
      activeDoc().setNotice(message)
    },
    setText(text: string): void {
      activeDoc().setText(text)
    },
    acceptExternal(): void {
      activeDoc().acceptExternal()
    },
    dismissExternal(): void {
      activeDoc().dismissExternal()
    },
    async save(): Promise<boolean> {
      const ok = await activeDoc().save()
      if (ok && activeTab) activeTab.editorState = null
      return ok
    },
  }

  const scheduleDraft = debounce(() => {
    const doc = activeDoc()
    const snapshot = doc.snapshot
    if (!snapshot.dirty) {
      clearDraft(snapshot.rawPath, snapshot.name)
      return
    }
    if (!snapshot.text.trim()) return
    saveDraft({
      name: snapshot.name,
      path: snapshot.rawPath,
      text: snapshot.text,
      savedAt: Date.now(),
    })
  }, 1200)

  const scheduleSessionSave = debounce(() => {
    try {
      const payload = {
        tabs: tabs.map((t) => ({ path: tabPath(t), mode: t.mode })),
        activeIndex: activeTab ? tabs.indexOf(activeTab) : -1,
      }
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload))
    } catch {
      // 存不下就算了
    }
  }, 400)

  /** 宿主恢复会话时按路径预置每个 tab 的模式 */
  let restoreModes = new Map<string, ViewMode>()
  let restoreExpected = 0
  let restoreWantActive = ''
  /** 恢复计划里的路径（小写键，Windows 路径大小写不定），用来区分
   *  「恢复推送」和「用户真正打开的那个文件」 */
  let restorePlan = new Set<string>()
  /** 启动时用户显式打开的文件：必须压过会话恢复的活动页，否则「双击 A 却显示 B」 */
  let startupExplicitPath = ''
  /** 宿主已推送过的路径（小写键，同步记录）：tab 真正建好要等异步 open，会话恢复
   *  只查 tabs 的话初始文件还没落地就被算进恢复计划，既重复开又让恢复抢回活动页 */
  const hostPushed = new Set<string>()

  /** 会话恢复要落的活动页：显式打开优先于上次关闭时的活动 tab */
  function activateRestoreTarget(): void {
    const target = startupExplicitPath || restoreWantActive
    if (!target) return
    const lower = target.toLowerCase()
    const t = tabs.find((x) => tabPath(x).toLowerCase() === lower)
    if (t && t !== activeTab) switchTab(t.id)
  }

  // ---------- 缩放（值持久化在设置里） ----------

  /** 跑在编辑器创建之前，zoom 的 subscribe 会立即同步回调一次，
   *  它引用的 let 必须在此之前声明，否则回调会踩进暂时性死区 */
  let editorReady = false
  const zoom = createZoomController(getSettings().zoom, (factor) => {
    patchSettings({ zoom: factor })
  })
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
  /** 待应用给预览区的滚动位置（切 tab 后等渲染完成再落） */
  let pendingPreviewScroll: number | null = null
  /** 编辑器重建 / 状态切换期间，doc-switched 处理器要改走恢复路径 */
  let restoringTab = false
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

  const welcomeTab = createWelcomeTab()
  activeTab = welcomeTab

  editor = createEditor({
    parent: layout.editorHost,
    initialText: welcomeTab.doc.currentText,
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
    const result = await pipeline.renderInto(layout.previewHost, model.currentText, assetBaseDir)
    if (result.stale) return

    outline = result.outline
    renderOutline(layout.outlineList, outline, activeOutlineId)
    scrollSync.refreshAnchors()
    if (pendingPreviewScroll !== null) {
      layout.previewPane.scrollTop = pendingPreviewScroll
      pendingPreviewScroll = null
    }
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
    if (inDesktopShell && activeTab) {
      // 关闭拦截看的是「所有标签页有没有脏」，资源目录要跟着当前页走
      notifyTitle(
        snapshot.name,
        hasAnyDirty(),
        currentTheme() === 'dark',
        tabPath(activeTab),
      )
    }
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

  // ---------- 标签页切换与关闭 ----------

  function renderTabBar(): void {
    renderTabs(
      layout.tabList,
      tabs.map((t) => ({
        id: t.id,
        name: t.doc.snapshot.name,
        dirty: t.doc.snapshot.dirty,
        active: t === activeTab,
        path: tabPath(t),
      })),
    )
  }

  function snapshotActive(): void {
    if (!activeTab || !tabs.includes(activeTab)) return
    activeTab.editorState = editor.currentState()
    activeTab.editorScrollTop = editor.view.scrollDOM.scrollTop
    activeTab.previewScrollTop = layout.previewPane.scrollTop
  }

  /** 把活动标签页文档挂到界面上：恢复状态快照，或整体重建 */
  function bindActiveTab(): void {
    restoringTab = true
    emitDocEvent({ type: 'doc-switched', snapshot: activeDoc().snapshot })
    restoringTab = false
    if (activeTab) {
      viewMode.loadMode(activeTab.mode)
      pendingPreviewScroll = activeTab.previewScrollTop
      if (activeTab.mode !== 'preview') editor.focus()
    }
    scheduleOutlineSync()
    scheduleSessionSave()
  }

  function switchTab(id: number): void {
    const t = tabs.find((x) => x.id === id)
    if (!t || t === activeTab) {
      renderTabBar()
      return
    }
    snapshotActive()
    activeTab = t
    bindActiveTab()
    renderTabBar()
  }

  function removeTab(t: TabRecord): void {
    const idx = tabs.indexOf(t)
    if (idx < 0) return
    t.doc.dispose()
    tabs.splice(idx, 1)
    if (t === activeTab) {
      if (tabs.length === 0) {
        activeTab = createWelcomeTab()
      } else {
        activeTab = tabs[Math.min(idx, tabs.length - 1)]
      }
      bindActiveTab()
    }
    renderTabBar()
    updateStatus()
    scheduleSessionSave()
  }

  async function closeTab(id: number): Promise<void> {
    const t = tabs.find((x) => x.id === id)
    if (!t) return
    if (t.doc.snapshot.dirty) {
      const ok = await showMessageModal({
        title: '关闭标签页',
        message: `「${t.doc.snapshot.name}」有未保存的修改，关闭将丢失这些改动。`,
        confirmLabel: '关闭',
        cancelLabel: '取消',
      })
      if (!ok) return
    }
    // 用户确认丢弃后，草稿也不该再冒出来
    clearDraft(tabPath(t), t.doc.snapshot.name)
    removeTab(t)
  }

  function cycleTab(step: number): void {
    if (!activeTab || tabs.length < 2) return
    const idx = (tabs.indexOf(activeTab) + step + tabs.length) % tabs.length
    const next = tabs[idx]
    if (next) switchTab(next.id)
  }

  // ---------- 打开文件（宿主推送 / 选择器 / 拖入） ----------

  /** 当前页是没人动过的欢迎页时，就地接管而不是新开标签 */
  function canTakeOverWelcome(): boolean {
    return tabs.length === 1 && !!activeTab?.welcome && !activeTab.doc.snapshot.dirty
  }

  function noteRestoredTab(): void {
    if (restoreExpected <= 0) return
    restoreExpected -= 1
    if (restoreExpected === 0 && restoreWantActive) activateRestoreTarget()
  }

  async function openFromHost(payload: HostFilePayload): Promise<void> {
    const planned = restorePlan.has(payload.path.toLowerCase())
    const existing = tabs.find((t) => tabPath(t) === payload.path)
    if (existing) {
      // 双击已打开的文件：切过去即可；本地没改动时顺带刷新成磁盘上的新内容
      if (existing !== activeTab) switchTab(existing.id)
      if (!existing.doc.snapshot.dirty && payload.text !== existing.doc.currentText) {
        existing.doc.setText(payload.text)
        existing.doc.markSaved()
      }
      // 若已被恢复计数吸收（它排在前面），就不该再消耗一个计数
      if (planned) noteRestoredTab()
      return
    }
    if (canTakeOverWelcome() && activeTab) {
      activeTab.welcome = false
      await activeTab.doc.open(createHostHandle(payload))
      if (planned) noteRestoredTab()
      return
    }
    const mode = restoreModes.get(payload.path) ?? getSettings().defaultMode
    const t = createTab(mode)
    await t.doc.open(createHostHandle(payload))
    // 必须走 switchTab：先把界面绑定到新页，不能提前改 activeTab（会让 switchTab 提前返回）
    switchTab(t.id)
    if (planned) noteRestoredTab()
  }

  async function openFile(): Promise<void> {
    if (inDesktopShell || isFsAccessSupported()) {
      const t = createTab(getSettings().defaultMode)
      switchTab(t.id)
      const opened = await t.doc.openViaPicker()
      if (!opened) {
        removeTab(t)
        return
      }
      t.welcome = false
      // 选中了已打开的文件：合并回原标签页
      const dup = tabs.find((x) => x !== t && tabPath(x) === tabPath(t))
      if (dup) {
        removeTab(t)
        switchTab(dup.id)
        return
      }
      scheduleSessionSave()
      flashNotice('已打开')
      return
    }
    flashNotice('当前浏览器不支持直接打开本地文件，请把文件拖进窗口')
  }

  async function saveFile(): Promise<void> {
    const ok = await model.save()
    // 用模型刚写入的提示文案，同时重启自动消失计时
    if (ok) flashNotice(model.snapshot.notice ?? '已保存')
  }

  // ---------- 文档事件 ----------

  model.subscribe((event) => {
    if (event.type === 'doc-switched') {
      if (restoringTab && activeTab?.editorState) {
        // 切回标签页：还原撤销历史与选区
        editor.useState(activeTab.editorState)
        editor.view.scrollDOM.scrollTop = activeTab.editorScrollTop
      } else {
        // 打开 / 重建文档：清空撤销历史，防止撤销跨文档回退
        editor.resetDoc(model.currentText)
        if (activeTab) activeTab.editorState = null
      }
      scheduleRender()
      clearPreviewHighlight(layout.previewHost)
      activeOutlineId = null
      layout.externalBanner.hidden = model.snapshot.pendingExternal === null
      updateStatus()
      return
    }
    if (event.type === 'text') {
      if (editor.getText() !== model.currentText) editor.setText(model.currentText)
      scheduleRender()
      scheduleDraft()
      renderTabBar()
      return
    }
    if (event.type === 'external') {
      layout.externalBanner.hidden = false
      updateStatus()
      return
    }
    layout.externalBanner.hidden = model.snapshot.pendingExternal === null
    // 保存成功（dirty 被清掉）后这份草稿就没有意义了
    if (!model.snapshot.dirty) {
      clearDraft(model.snapshot.rawPath, model.snapshot.name)
      scheduleSessionSave()
    }
    renderTabBar()
    updateStatus()
  })

  // ---------- 桌面壳事件 ----------

  if (inDesktopShell) {
    layout.root.classList.add('is-desktop')
    onHostEvent((event) => {
      if (event.event === 'openFile') {
        // 双击 .md、启动参数、第二个实例的转发、会话恢复都走这里 → 落成标签页
        if (!hostPushed.has(event.path.toLowerCase())) {
          // 同步记两笔账：openFromHost 要等异步读盘才建 tab，恢复逻辑若只看
          // tabs 会漏算还没落地的初始文件；不在恢复计划里的就是用户显式打开的
          hostPushed.add(event.path.toLowerCase())
          if (restoreExpected <= 0 && !restorePlan.has(event.path.toLowerCase())) {
            startupExplicitPath = event.path
          }
        }
        void openFromHost(event).catch((err: unknown) => {
          model.setNotice(`打开失败：${(err as Error).message}`)
        })
      } else if (event.event === 'error') {
        model.setNotice(event.message)
      } else if (event.event === 'windowState') {
        setMaximizedUi(event.maximized)
      } else if (event.event === 'confirmExit') {
        void (async () => {
          const dirtyNames = tabs.filter((t) => t.doc.snapshot.dirty).map((t) => t.doc.snapshot.name)
          const message =
            dirtyNames.length > 0
              ? `以下文档有未保存的修改：${dirtyNames.join('、')}。\n确定退出吗？`
              : '确定退出 mdreader 吗？'
          const proceed = await showMessageModal({
            title: '退出 mdreader',
            message,
            confirmLabel: '退出',
            cancelLabel: '继续编辑',
          })
          await callHost('exitResult', { proceed }).catch(() => undefined)
        })()
      }
    })
    // 事件监听已就位：ping 一次让宿主露出窗口并补发窗口状态（启动即最大化时按钮字形要靠它）。
    // 必须等首帧真正合成上屏（两轮 rAF）再发：脚本末尾同步 postMessage 会抢在
    // WebView2 第一次合成之前，宿主提前露窗就是一屏白底。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void callHost('ping').catch(() => undefined)
      })
    })
  }

  // ---------- 自绘标题栏（桌面壳） ----------

  function setMaximizedUi(maximized: boolean): void {
    layout.root.classList.toggle('is-maximized', maximized)
    const btn = layout.tabStrip.querySelector<HTMLElement>('[data-win="max"]')
    if (!btn) return
    btn.textContent = maximized ? '❐' : '□'
    btn.title = maximized ? '向下还原' : '最大化'
  }

  // 无边框窗口的拖动由宿主配合：按下后指针移动超过阈值才交回系统标题栏逻辑。
  // 不能按下即 beginDrag：系统模态拖动循环会吞掉后续点击，真人双击必带几像素
  // 位移，会被当成微拖动，dblclick 永远发不出来（最大化就失效）。
  // tab 行就是标题栏：空白处可拖动，标签和按钮除外
  layout.tabStrip.addEventListener('pointerdown', (event) => {
    const mouse = event as PointerEvent
    if (mouse.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-win], .tab, .tabstrip__new')) return
    const sx = mouse.clientX
    const sy = mouse.clientY
    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', detach)
    }
    const onMove = (move: PointerEvent) => {
      if (Math.abs(move.clientX - sx) + Math.abs(move.clientY - sy) > 4) {
        detach()
        void callHost('beginDrag').catch(() => undefined)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', detach)
  })
  layout.tabStrip.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('[data-win], .tab, .tabstrip__new')) return
    void callHost('winMax').catch(() => undefined)
  })

  // ---------- 视图模式（每标签页一个） ----------

  const viewMode = new ViewModeController(welcomeTab.mode)

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

  viewMode.subscribe((mode) => {
    applyMode(mode)
    if (activeTab && activeTab.mode !== mode) {
      activeTab.mode = mode
      scheduleSessionSave()
    }
  })

  layout.modeSwitch.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('.segmented__item')
    const mode = btn?.dataset.mode as ViewMode | undefined
    if (mode) viewMode.set(mode)
  })

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
        flashNotice('已导出 HTML')
        break
      case 'pdf':
        await printPreview()
        break
      case 'rich': {
        const ok = await copyRichText(layout.previewHost.innerHTML, model.currentText)
        flashNotice(ok ? '已复制为富文本' : '浏览器不支持富文本剪贴板，已复制纯文本')
        break
      }
      case 'markdown':
        await copyMarkdown(model.currentText)
        flashNotice('已复制 Markdown 源码')
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

    // 最近文件条目（路径只回给宿主做白名单校验，由宿主推送 openFile 落成标签页）
    const recentItem = target.closest<HTMLElement>('[data-open-recent]')
    if (recentItem) {
      layout.openList.hidden = true
      const path = recentItem.dataset.openRecent ?? ''
      if (inDesktopShell && path) {
        callHost('openRecent', { path }).catch((err: unknown) => {
          model.setNotice(`打开失败：${(err as Error).message}`)
        })
      }
      return
    }

    // 标题栏窗口按钮（桌面壳）
    const winBtn = target.closest<HTMLElement>('[data-win]')
    if (winBtn) {
      const kind = winBtn.dataset.win
      const action = kind === 'min' ? 'winMin' : kind === 'max' ? 'winMax' : 'winClose'
      void callHost(action).catch(() => undefined)
      return
    }

    const actionBtn = target.closest<HTMLElement>('[data-action]')
    if (!actionBtn) return
    switch (actionBtn.dataset.action) {
      case 'open-menu': {
        const willShow = layout.openList.hidden
        layout.openList.hidden = !willShow
        if (menuList) menuList.hidden = true
        if (willShow) void fillOpenMenu()
        break
      }
      case 'open-dialog':
        layout.openList.hidden = true
        void openFile()
        break
      case 'tab-new':
        void openFile()
        break
      case 'toggle-theme': {
        const next = currentTheme() === 'dark' ? 'light' : 'dark'
        patchSettings({ theme: next })
        break
      }
      case 'new': {
        const t = createTab(getSettings().defaultMode)
        t.doc.createUntitled()
        switchTab(t.id)
        editor.focus()
        break
      }
      case 'save':
        void saveFile()
        break
      case 'settings':
        showSettingsModal(inDesktopShell)
        break
      case 'toggle-outline': {
        layout.outlinePanel.classList.toggle('is-collapsed')
        patchSettings({
          outlineVisible: !layout.outlinePanel.classList.contains('is-collapsed'),
        })
        break
      }
      case 'toggle-hints': {
        layout.hintPanel.classList.toggle('is-collapsed')
        patchSettings({ hintsVisible: !layout.hintPanel.classList.contains('is-collapsed') })
        break
      }
      case 'export':
        if (menuList) menuList.hidden = !menuList.hidden
        layout.openList.hidden = true
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
        const items = currentHints
          .filter((hint) => hint.fix)
          .map((hint) => ({ line: hint.line, label: hint.fix!.label }))
        if (items.length === 0) {
          flashNotice('没有可自动应用的修改')
          break
        }
        // 应用前先列清单，让用户知道将要改动什么
        showConfirmModal({
          title: `应用 ${items.length} 条建议`,
          lines: items.map((item) => `第 ${item.line} 行 · ${item.label}`),
          confirmLabel: '全部应用',
          onConfirm: () => {
            const fixes = currentHints
              .filter((hint) => hint.fix)
              .map((hint) => hint.fix!)
            const applied = applyFixes(fixes)
            flashNotice(applied > 0 ? `已应用 ${applied} 条建议` : '该建议无法应用')
          },
        })
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

  /** 填充「打开」下拉：固定项 + 桌面壳下的最近文件 */
  async function fillOpenMenu(): Promise<void> {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    let html = `<button class="menu__item" data-action="open-dialog">打开文件…</button>`
    if (inDesktopShell) {
      try {
        const result = await callHost<{ items: { path: string; name: string }[] }>('recent')
        const items = result.items ?? []
        if (items.length > 0) {
          html += `<div class="menu__sep"></div>`
          for (const item of items) {
            html += `<button class="menu__item" data-open-recent="${esc(item.path)}" title="${esc(item.path)}">${esc(item.name)}</button>`
          }
        }
      } catch {
        // 宿主不支持时静默降级为只有「打开文件…」
      }
    }
    layout.openList.innerHTML = html
  }

  document.addEventListener('click', (event) => {
    if (!layout.exportMenu.contains(event.target as Node) && menuList) menuList.hidden = true
    if (!layout.openMenu.contains(event.target as Node)) layout.openList.hidden = true
  })

  // ---------- 标签栏交互 ----------

  layout.tabList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const closeBtn = target.closest<HTMLElement>('[data-tab-close]')
    if (closeBtn) {
      void closeTab(Number(closeBtn.dataset.tabClose))
      return
    }
    const tabEl = target.closest<HTMLElement>('[data-tab]')
    if (tabEl) switchTab(Number(tabEl.dataset.tab))
  })
  layout.tabList.addEventListener('auxclick', (event) => {
    const mouse = event as MouseEvent
    if (mouse.button !== 1) return
    const tabEl = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (tabEl) {
      mouse.preventDefault()
      void closeTab(Number(tabEl.dataset.tab))
    }
  })

  // 拖动排序：dragstart 记住源标签，drop 时按落点左/右半边插入
  let dragTabId: number | null = null
  layout.tabList.addEventListener('dragstart', (event) => {
    const drag = event as DragEvent
    const tabEl = (drag.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!tabEl) return
    dragTabId = Number(tabEl.dataset.tab)
    if (drag.dataTransfer) {
      drag.dataTransfer.effectAllowed = 'move'
      drag.dataTransfer.setData('text/plain', String(dragTabId))
    }
    tabEl.classList.add('is-dragging')
  })
  layout.tabList.addEventListener('dragover', (event) => {
    if (dragTabId === null) return
    const drag = event as DragEvent
    drag.preventDefault()
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'move'
  })
  layout.tabList.addEventListener('drop', (event) => {
    const drag = event as DragEvent
    if (dragTabId === null) return
    drag.preventDefault()
    const from = tabs.findIndex((t) => t.id === dragTabId)
    dragTabId = null
    if (from < 0) return
    const tabEl = (drag.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!tabEl) return
    const toId = Number(tabEl.dataset.tab)
    let to = tabs.findIndex((t) => t.id === toId)
    if (to < 0 || to === from) return
    const rect = tabEl.getBoundingClientRect()
    const after = drag.clientX > rect.left + rect.width / 2
    const [moved] = tabs.splice(from, 1)
    if (to > from) to -= 1
    tabs.splice(after ? to + 1 : to, 0, moved)
    renderTabBar()
    scheduleSessionSave()
  })
  layout.tabList.addEventListener('dragend', () => {
    dragTabId = null
    renderTabBar()
  })

  // 右键菜单：关闭其他 / 关闭右侧 / 关闭未保存
  let tabMenu: HTMLElement | null = null
  const hideTabMenu = (): void => {
    if (!tabMenu) return
    tabMenu.remove()
    tabMenu = null
    document.removeEventListener('pointerdown', onTabMenuAway, true)
  }
  function onTabMenuAway(event: Event): void {
    if (tabMenu && !tabMenu.contains(event.target as Node)) hideTabMenu()
  }
  function showTabMenu(x: number, y: number, items: { label: string; disabled: boolean; run: () => void }[]): void {
    hideTabMenu()
    const el = document.createElement('div')
    el.className = 'tabmenu'
    for (const it of items) {
      const btn = document.createElement('button')
      btn.className = 'tabmenu__item'
      btn.textContent = it.label
      btn.disabled = it.disabled
      btn.addEventListener('click', () => {
        hideTabMenu()
        it.run()
      })
      el.appendChild(btn)
    }
    document.body.appendChild(el)
    // 先量尺寸再定位，避免菜单超出窗口右缘 / 底缘
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`
    tabMenu = el
    document.addEventListener('pointerdown', onTabMenuAway, true)
  }

  /** 批量关闭：dirty 的合并成一次确认，确认后连同草稿一起丢弃 */
  async function closeTabsBatch(targets: TabRecord[], title: string, anchorId: number): Promise<void> {
    const list = targets.filter((t) => tabs.includes(t))
    if (list.length === 0) return
    const dirty = list.filter((t) => t.doc.snapshot.dirty)
    if (dirty.length > 0) {
      const names = dirty.map((t) => `「${t.doc.snapshot.name}」`).join('、')
      const ok = await showMessageModal({
        title,
        message: `${names} 有未保存的修改，关闭将丢失这些改动。`,
        confirmLabel: '全部关闭',
        cancelLabel: '取消',
      })
      if (!ok) return
    }
    for (const t of list) {
      clearDraft(tabPath(t), t.doc.snapshot.name)
      removeTab(t)
    }
    // 右键的那个标签还活着时，把视图切回它
    const anchor = tabs.find((t) => t.id === anchorId)
    if (anchor && anchor !== activeTab) switchTab(anchorId)
  }

  layout.tabList.addEventListener('contextmenu', (event) => {
    const mouse = event as MouseEvent
    const tabEl = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!tabEl) return
    mouse.preventDefault()
    const id = Number(tabEl.dataset.tab)
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const anchor = tabs[idx]
    showTabMenu(mouse.clientX, mouse.clientY, [
      {
        label: '关闭其他标签',
        disabled: tabs.length <= 1,
        run: () => void closeTabsBatch(tabs.filter((t) => t !== anchor), '关闭其他标签', id),
      },
      {
        label: '关闭右侧标签',
        disabled: idx === tabs.length - 1,
        run: () => void closeTabsBatch(tabs.slice(idx + 1), '关闭右侧标签', id),
      },
      {
        label: '关闭未保存标签',
        disabled: !tabs.some((t) => t.doc.snapshot.dirty),
        run: () => void closeTabsBatch(tabs.filter((t) => t.doc.snapshot.dirty), '关闭未保存标签', id),
      },
    ])
  })

  // ---------- 侧栏交互 ----------

  layout.outlineList.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('.outline__item')
    if (!btn) return
    const line = Number(btn.dataset.line ?? '1')
    if (viewMode.current === 'edit') {
      editor.scrollToLine(line)
      editor.focus()
    } else {
      const id = btn.dataset.id ?? ''
      layout.previewHost
        .querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // 纯预览模式下抢焦点没有意义，反而会把用户滚读的位置弄乱
      if (viewMode.current === 'split') editor.focus()
    }
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
        flashNotice(applied > 0 ? `已应用：${hint.fix.label}` : '该建议无法应用')
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
      saveUiState()
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
      flashNotice('只支持 .md / .markdown / .txt 文件')
      return
    }
    // 拖入一律开新标签页，当前页的未保存内容不受影响
    const t = createTab(getSettings().defaultMode)
    void (async () => {
      await t.doc.openDroppedFile(file)
      switchTab(t.id)
      scheduleSessionSave()
    })()
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
      const t = createTab(getSettings().defaultMode)
      t.doc.createUntitled()
      switchTab(t.id)
      editor.focus()
      return
    }
    if (key === 'p') {
      event.preventDefault()
      void printPreview()
      return
    }
    if (key === 'w') {
      event.preventDefault()
      if (activeTab) void closeTab(activeTab.id)
      return
    }
    if (key === 'tab') {
      event.preventDefault()
      cycleTab(event.shiftKey ? -1 : 1)
      return
    }
    if (/^[1-9]$/.test(event.key)) {
      const idx = Number(event.key) - 1
      if (idx < tabs.length) {
        event.preventDefault()
        switchTab(tabs[idx].id)
      }
      return
    }
  })

  // Ctrl + 滚轮缩放（两个环境都拦下来自己处理，只缩内容区字号）。
  // 桌面壳已在宿主侧关闭内置缩放（IsZoomControlEnabled = false），
  // 否则它会连同菜单栏一起放大缩小
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
    if (!hasAnyDirty()) return
    event.preventDefault()
    event.returnValue = ''
  })

  // ---------- 设置联动 ----------

  let lastTheme: ThemeName = currentTheme()
  subscribeSettings((s) => {
    applyThemeSetting(s.theme)
    // Mermaid 图表配色不跟随 CSS 变量，深浅切换后要重渲染
    if (currentTheme() !== lastTheme) {
      lastTheme = currentTheme()
      void renderAll()
    }
    if (Math.abs(s.zoom - zoom.get()) > 0.001) zoom.set(s.zoom)
    const collapsed = layout.outlinePanel.classList.contains('is-collapsed')
    if (collapsed === s.outlineVisible) {
      layout.outlinePanel.classList.toggle('is-collapsed', !s.outlineVisible)
    }
    const hintsCollapsed = layout.hintPanel.classList.contains('is-collapsed')
    if (hintsCollapsed === s.hintsVisible) {
      layout.hintPanel.classList.toggle('is-collapsed', !s.hintsVisible)
    }
  })

  // ---------- 启动 ----------

  layout.previewPane.addEventListener('scroll', () => scheduleOutlineSync(), { passive: true })

  // 恢复上次的面板折叠状态、分栏宽度与缩放（都来自设置 + ui 键）
  const restored = readUiState()
  if (restored?.editorWidthPx) {
    layout.root.style.setProperty('--editor-width', `${restored.editorWidthPx}px`)
    layout.root.classList.add('is-resized')
  }

  void renderAll()
  updateStatus()

  // 宿主真源 → 会话恢复 → 草稿检查，依次进行
  void initSettings()
    .then(() => restoreSession())
    .catch(() => undefined)

  function validMode(v: unknown): v is ViewMode {
    return typeof v === 'string' && (VIEW_MODES as string[]).includes(v)
  }

  async function restoreSession(): Promise<void> {
    if (!inDesktopShell || !getSettings().restoreSession) {
      await runDraftCheck()
      return
    }
    // 先问宿主「这次启动显式打开了哪个文件」：push 消息是宏任务，会排在
    // restoreSession 之后，页面自己的记账赶不上，只能由宿主先给个准信
    try {
      const startup = await callHost<{ path?: string }>('startupPath')
      if (startup.path) {
        startupExplicitPath = startup.path
        hostPushed.add(startup.path.toLowerCase())
      }
    } catch {
      // 问不到就按老流程走
    }
    let entries: { path: string; mode: ViewMode }[] = []
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          tabs?: { path?: unknown; mode?: unknown }[]
          activeIndex?: number
        }
        entries = (parsed.tabs ?? [])
          .filter((e) => typeof e.path === 'string' && e.path)
          .map((e) => ({ path: e.path as string, mode: validMode(e.mode) ? e.mode : 'preview' }))
        const activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : -1
        restoreWantActive = entries[activeIndex]?.path ?? ''
      }
    } catch {
      entries = []
    }
    restoreModes = new Map(entries.map((e) => [e.path, e.mode]))
    restorePlan = new Set(entries.map((e) => e.path.toLowerCase()))
    const paths = entries
      .map((e) => e.path)
      .filter((p) => !tabs.some((t) => tabPath(t) === p) && !hostPushed.has(p.toLowerCase()))
    if (paths.length > 0) {
      restoreExpected = paths.length
      callHost('openPaths', { paths })
        .catch(() => {
          restoreExpected = 0
        })
        .finally(() => void runDraftCheck())
      // 兜底：个别路径打开失败时计数不归零，超时后把活动页落回上次位置
      window.setTimeout(() => {
        if (restoreExpected > 0) {
          restoreExpected = 0
          activateRestoreTarget()
        }
      }, 2500)
    } else {
      activateRestoreTarget()
      await runDraftCheck()
    }
  }

  let draftCheckShown = false
  async function runDraftCheck(): Promise<void> {
    if (draftCheckShown) return
    draftCheckShown = true
    const drafts = listDrafts().filter((d) => {
      const t = d.path ? tabs.find((x) => tabPath(x) === d.path) : undefined
      if (t && t.doc.currentText === d.text) {
        clearDraft(d.path, d.name)
        return false
      }
      return d.text.trim() !== '' && d.text !== WELCOME_DOC
    })
    if (drafts.length === 0) return
    const names = drafts.map((d) => `「${d.name}」`).join('、')
    const when = new Date(Math.max(...drafts.map((d) => d.savedAt))).toLocaleString()
    const restore = await showMessageModal({
      title: '恢复未保存的草稿',
      message: `发现 ${drafts.length} 份未保存的草稿：${names}（${when}）。\n「恢复」将把内容写回对应文档；「删除」将丢弃这些草稿。`,
      confirmLabel: '恢复草稿',
      cancelLabel: '删除草稿',
    })
    for (const d of drafts) {
      if (restore) {
        const t = d.path ? tabs.find((x) => tabPath(x) === d.path) : undefined
        if (t) {
          if (t !== activeTab) switchTab(t.id)
          t.doc.setText(d.text)
        } else {
          const nt = createTab(getSettings().defaultMode)
          nt.doc.createUntitled(d.name)
          nt.doc.setText(d.text)
          switchTab(nt.id)
        }
      }
      clearDraft(d.path, d.name)
    }
    flashNotice(restore ? `已恢复 ${drafts.length} 份草稿` : '已删除旧草稿')
  }

  editor.focus()
}
