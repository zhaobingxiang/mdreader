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
  /** 书写提示里的「语法速查」折叠区 */
  syntaxToggle: HTMLElement
  syntaxBody: HTMLElement
  /** 书写提示里的 AI 建议区 */
  aiSuggest: HTMLElement
  aiPanel: HTMLElement
  aiResizer: HTMLElement
  aiConv: HTMLElement
  aiInput: HTMLTextAreaElement
  aiProviderPick: HTMLSelectElement
  aiModelPick: HTMLSelectElement
  aiStatus: HTMLElement
  aiOptimize: HTMLElement
  aiStop: HTMLElement
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
  openMenu: HTMLElement
  openList: HTMLElement
  externalBanner: HTMLElement
  zoomValue: HTMLElement
  tabStrip: HTMLElement
  tabList: HTMLElement
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
  mount.dataset.mode = 'preview'
  mount.innerHTML = `
  <div class="tabstrip" data-role="tabstrip">
    <div class="tabstrip__list" data-role="tab-list"></div>
    <button class="tabstrip__new" data-action="tab-new" title="打开新标签页" aria-label="新标签页">＋</button>
    <span class="tabstrip__spacer" aria-hidden="true"></span>
    <div class="tabstrip__controls">
      <button class="tb-btn" data-win="min" title="最小化" aria-label="最小化">─</button>
      <button class="tb-btn" data-win="max" title="最大化" aria-label="最大化">□</button>
      <button class="tb-btn tb-btn--close" data-win="close" title="关闭" aria-label="关闭">✕</button>
    </div>
  </div>

  <header class="topbar">
    <div class="topbar__group">
      <div class="menu" data-role="open-menu">
        <button class="btn" data-action="open-menu" title="打开文件 Ctrl+O">打开 ▾</button>
        <div class="menu__list" hidden data-role="open-list"></div>
      </div>
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
      <button class="btn btn--icon" data-action="toggle-theme" title="切换深色 / 浅色主题" aria-label="切换主题">◐</button>
      <button class="btn btn--icon" data-action="undo" title="撤销（Ctrl+Z）" aria-label="撤销">⟲</button>
      <button class="btn btn--icon" data-action="redo" title="重做（Ctrl+Y）" aria-label="重做">⟳</button>
      <div class="zoom" data-role="zoom">
        <button class="zoom__btn" data-action="zoom-out" title="缩小（Ctrl+减号 / Ctrl+滚轮）">−</button>
        <button class="zoom__value" data-role="zoom-value" data-action="zoom-edit" title="点击输入缩放比例">100%</button>
        <button class="zoom__btn" data-action="zoom-in" title="放大（Ctrl+加号 / Ctrl+滚轮）">+</button>
      </div>
      <button class="btn" data-action="toggle-outline" title="显示 / 隐藏大纲">大纲</button>
      <button class="btn" data-action="toggle-hints" title="显示 / 隐藏书写提示">提示</button>
      <button class="btn" data-action="toggle-ai" title="显示 / 隐藏 AI 优化面板">AI</button>
      <button class="btn" data-action="meeting" title="会记：录音或导入转写，生成会议纪要与总结报告">会记</button>
      <button class="btn" data-action="settings" title="设置">设置</button>
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
      <div class="panel__body" data-role="hint-body">
        <button type="button" class="panel__fold" data-role="syntax-toggle" data-action="toggle-syntax" aria-expanded="false">
          <span class="panel__fold-caret">▸</span><span>Markdown 语法速查</span>
        </button>
        <div class="syntax" data-role="syntax" hidden></div>
        <div class="ai-suggest" data-role="ai-suggest"></div>
        <div class="hint-list" data-role="hint-list"></div>
        <div class="hint-todos" data-role="hint-todos"></div>
      </div>
    </aside>
  </div>

  <section class="ai-panel" data-role="ai-panel" hidden aria-label="AI 优化">
    <div class="ai-panel__resizer" data-role="ai-resizer" title="拖动调整高度"></div>
    <div class="ai-panel__head">
      <span class="ai-panel__title">AI 优化</span>
      <select class="ai-panel__pick" data-role="ai-provider-pick" aria-label="模型平台" title="切换平台"></select>
      <select class="ai-panel__pick ai-panel__pick--model" data-role="ai-model-pick" aria-label="模型" title="切换模型"></select>
      <span class="ai-panel__status" data-role="ai-status"></span>
      <div class="ai-panel__actions">
        <button class="btn btn--small btn--primary" data-role="ai-optimize" data-action="ai-optimize" title="通读全文，给出格式与表述的完整优化稿">自动优化</button>
        <button class="btn btn--small" data-role="ai-stop" data-action="ai-stop" hidden>停止</button>
        <button class="btn btn--small" data-action="ai-clear" title="清空本页对话与产物">清空</button>
        <button class="btn btn--small btn--icon" data-action="ai-close" title="收起 AI 面板" aria-label="收起">✕</button>
      </div>
    </div>
    <div class="ai-panel__body">
      <div class="ai-conv" data-role="ai-conv"></div>
      <div class="ai-compose">
        <textarea class="ai-compose__input" data-role="ai-input" rows="1" placeholder="告诉 AI 怎么改这份文档，或直接提问…"></textarea>
        <button class="btn btn--primary" data-action="ai-send">发送</button>
      </div>
    </div>
  </section>

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
    syntaxToggle: need(mount, 'syntax-toggle'),
    syntaxBody: need(mount, 'syntax'),
    aiSuggest: need(mount, 'ai-suggest'),
    aiPanel: need(mount, 'ai-panel'),
    aiResizer: need(mount, 'ai-resizer'),
    aiConv: need(mount, 'ai-conv'),
    aiInput: need<HTMLTextAreaElement>(mount, 'ai-input'),
    aiProviderPick: need<HTMLSelectElement>(mount, 'ai-provider-pick'),
    aiModelPick: need<HTMLSelectElement>(mount, 'ai-model-pick'),
    aiStatus: need(mount, 'ai-status'),
    aiOptimize: need(mount, 'ai-optimize'),
    aiStop: need(mount, 'ai-stop'),
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
    openMenu: need(mount, 'open-menu'),
    openList: need(mount, 'open-list'),
    externalBanner: need(mount, 'external-banner'),
    zoomValue: need(mount, 'zoom-value'),
    tabStrip: need(mount, 'tabstrip'),
    tabList: need(mount, 'tab-list'),
  }
}
