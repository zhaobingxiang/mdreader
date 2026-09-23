import type { ViewMode } from '../core/view-mode'

export interface AppLayout {
  root: HTMLElement
  workspace: HTMLElement
  splitter: HTMLElement
  docName: HTMLElement
  dirtyDot: HTMLElement
  modeSwitch: HTMLElement
  outlinePanel: HTMLElement
  outlineList: HTMLElement
  hintPanel: HTMLElement
  hintSummary: HTMLElement
  fixAll: HTMLElement
  hintList: HTMLElement
  hintTodos: HTMLElement
  editorPane: HTMLElement
  editorHost: HTMLElement
  previewPane: HTMLElement
  previewHost: HTMLElement
  statusLeft: HTMLElement
  statusRight: HTMLElement
  statWords: HTMLElement
  statLines: HTMLElement
  statReading: HTMLElement
  statPath: HTMLElement
  statNotice: HTMLElement
  statCursor: HTMLElement
  dropHint: HTMLElement
  exportMenu: HTMLElement
  externalBanner: HTMLElement
  zoomValue: HTMLElement
}

function need<T extends HTMLElement>(root: HTMLElement, role: string): T {
  const el = root.querySelector<T>(`[data-role="${role}"]`)
  if (!el) throw new Error(`布局缺少节点：${role}`)
  return el
}

const MODE_LABEL: Record<ViewMode, string> = {
  edit: '编辑',
  split: '分屏',
  preview: '预览',
}

export function createLayout(mount: HTMLElement): AppLayout {
  mount.classList.add('app')
  mount.dataset.mode = 'split'
  mount.innerHTML = `
  <header class="topbar">
    <div class="topbar__group">
      <button class="btn" data-action="open" title="打开本地文件 Ctrl+O">打开</button>
      <button class="btn" data-action="new" title="新建 Ctrl+N">新建</button>
      <button class="btn" data-action="save" title="保存 Ctrl+S">保存</button>
      <span class="doc-title">
        <span class="doc-title__name" data-role="doc-name">未命名.md</span>
        <span class="doc-title__dot" data-role="dirty-dot" hidden title="有未保存修改"></span>
      </span>
    </div>

    <div class="segmented" data-role="mode-switch" role="tablist" aria-label="视图模式">
      ${(['edit', 'split', 'preview'] as ViewMode[])
        .map(
          (m) =>
            `<button class="segmented__item" role="tab" data-mode="${m}">${MODE_LABEL[m]}</button>`,
        )
        .join('')}
    </div>

    <div class="topbar__group topbar__group--end">
      <button class="btn btn--icon" data-action="undo" title="撤销（Ctrl+Z）" aria-label="撤销">⟲</button>
      <button class="btn btn--icon" data-action="redo" title="重做（Ctrl+Y）" aria-label="重做">⟳</button>
      <div class="zoom" data-role="zoom">
        <button class="zoom__btn" data-action="zoom-out" title="缩小（Ctrl+减号 / Ctrl+滚轮）">−</button>
        <button class="zoom__value" data-role="zoom-value" data-action="zoom-edit" title="点击输入缩放比例">100%</button>
        <button class="zoom__btn" data-action="zoom-in" title="放大（Ctrl+加号 / Ctrl+滚轮）">+</button>
      </div>
      <button class="btn" data-action="toggle-outline" title="显示 / 隐藏大纲">大纲</button>
      <button class="btn" data-action="toggle-hints" title="显示 / 隐藏书写提示">提示</button>
      <div class="menu" data-role="export-menu">
        <button class="btn btn--primary" data-action="export" title="导出">导出</button>
        <div class="menu__list" hidden>
          <button class="menu__item" data-export="html">导出 HTML 单文件</button>
          <button class="menu__item" data-export="pdf">打印 / 存为 PDF</button>
          <button class="menu__item" data-export="rich">复制为富文本</button>
          <button class="menu__item" data-export="markdown">复制 Markdown 源码</button>
        </div>
      </div>
    </div>
  </header>

  <div class="external-banner" data-role="external-banner" hidden>
    <span class="external-banner__text">检测到文件被外部改写</span>
    <div class="external-banner__actions">
      <button class="btn btn--small" data-action="diff-external">查看差异</button>
      <button class="btn btn--small btn--primary" data-action="accept-external">采纳</button>
      <button class="btn btn--small" data-action="dismiss-external">忽略</button>
    </div>
  </div>

  <div class="workspace" data-role="workspace">
    <aside class="panel panel--left" data-role="outline-panel">
      <div class="panel__head">大纲</div>
      <nav class="outline" data-role="outline-list"></nav>
    </aside>

    <section class="pane pane--editor" data-role="editor-pane">
      <div class="pane__host" data-role="editor-host"></div>
    </section>

    <div class="splitter" data-role="splitter" hidden title="拖动调整宽度"></div>

    <section class="pane pane--preview" data-role="preview-pane">
      <article class="markdown-body" data-role="preview-host"></article>
    </section>

    <aside class="panel panel--right" data-role="hint-panel">
      <div class="panel__head">
        <span>书写提示</span>
        <span class="panel__badge" data-role="hint-summary"></span>
        <button
          type="button"
          class="panel__action"
          data-role="fix-all"
          data-action="fix-all"
          title="把能自动修的建议一次性全部应用"
          hidden
        >应用全部</button>
      </div>
      <div class="hint-list" data-role="hint-list"></div>
      <div class="hint-todos" data-role="hint-todos"></div>
    </aside>
  </div>

  <footer class="statusbar">
    <div class="statusbar__left" data-role="status-left">
      <span class="statusbar__item" data-role="stat-words"></span>
      <span class="statusbar__item" data-role="stat-lines"></span>
      <span class="statusbar__item" data-role="stat-reading"></span>
    </div>
    <div class="statusbar__right" data-role="status-right">
      <span class="statusbar__item" data-role="stat-path"></span>
      <span class="statusbar__item" data-role="stat-notice"></span>
      <span class="statusbar__item statusbar__item--mono" data-role="stat-cursor"></span>
    </div>
  </footer>

  <div class="drop-hint" data-role="drop-hint" hidden>松开以打开 Markdown 文件</div>`

  return {
    root: mount,
    workspace: need(mount, 'workspace'),
    splitter: need(mount, 'splitter'),
    docName: need(mount, 'doc-name'),
    dirtyDot: need(mount, 'dirty-dot'),
    modeSwitch: need(mount, 'mode-switch'),
    outlinePanel: need(mount, 'outline-panel'),
    outlineList: need(mount, 'outline-list'),
    hintPanel: need(mount, 'hint-panel'),
    hintSummary: need(mount, 'hint-summary'),
    fixAll: need(mount, 'fix-all'),
    hintList: need(mount, 'hint-list'),
    hintTodos: need(mount, 'hint-todos'),
    editorPane: need(mount, 'editor-pane'),
    editorHost: need(mount, 'editor-host'),
    previewPane: need(mount, 'preview-pane'),
    previewHost: need(mount, 'preview-host'),
    statusLeft: need(mount, 'status-left'),
    statusRight: need(mount, 'status-right'),
    statWords: need(mount, 'stat-words'),
    statLines: need(mount, 'stat-lines'),
    statReading: need(mount, 'stat-reading'),
    statPath: need(mount, 'stat-path'),
    statNotice: need(mount, 'stat-notice'),
    statCursor: need(mount, 'stat-cursor'),
    dropHint: need(mount, 'drop-hint'),
    exportMenu: need(mount, 'export-menu'),
    externalBanner: need(mount, 'external-banner'),
    zoomValue: need(mount, 'zoom-value'),
  }
}
