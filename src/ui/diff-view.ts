import { diffLines } from '../render/util'

/**
 * 外部改写审阅：并排/行级 diff 弹窗。
 * 场景是 AI 或别的编辑器改了磁盘上的文件，用户需要先看清楚再决定采纳。
 */
export function showDiffModal(options: {
  title: string
  before: string
  after: string
  /** 底部按钮文案：外部改写是「采纳」，AI 稿是「应用」 */
  acceptLabel?: string
  dismissLabel?: string
  onAccept(): void
  onDismiss(): void
}): void {
  const {
    title,
    before,
    after,
    acceptLabel = '采纳外部版本',
    dismissLabel = '忽略外部版本',
    onAccept,
    onDismiss,
  } = options
  const lines = diffLines(before, after)
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  const safeTitle = escapeHtmlAttr(title)

  const overlay = document.createElement('div')
  overlay.className = 'modal'
  overlay.innerHTML = `
<div class="modal__panel" role="dialog" aria-modal="true" aria-label="${safeTitle}">
  <div class="modal__head">
    <span class="modal__title">${safeTitle}</span>
    <span class="modal__stat"><b class="is-add">+${added}</b> <b class="is-del">−${removed}</b></span>
    <button class="btn btn--small" data-close>关闭</button>
  </div>
  <div class="modal__body">
    <pre class="diff">${lines
      .map(
        (line) =>
          `<div class="diff__line diff__line--${line.kind}"><span class="diff__sign">${
            line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
          }</span><span class="diff__text">${escape(line.text)}</span></div>`,
      )
      .join('')}</pre>
  </div>
  <div class="modal__foot">
    <button class="btn" data-dismiss>${escapeHtmlAttr(dismissLabel)}</button>
    <button class="btn btn--primary" data-accept>${escapeHtmlAttr(acceptLabel)}</button>
  </div>
</div>`

  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }

  // 关闭（按钮 / 遮罩 / Esc）只是收起弹窗，待审状态保留，横幅还在；
  // 「忽略外部版本」才真正丢弃。看完 diff 继续编辑是高频操作，不能顺手丢内容。
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target === overlay || target.closest('[data-close]')) {
      close()
      return
    }
    if (target.closest('[data-dismiss]')) {
      close()
      onDismiss()
      return
    }
    if (target.closest('[data-accept]')) {
      close()
      onAccept()
    }
  })
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}

/** 批量操作前的确认弹窗：列出将要发生的事，确认后才执行 */
export function showConfirmModal(options: {
  title: string
  lines: string[]
  confirmLabel: string
  onConfirm(): void
}): void {
  const { title, lines, confirmLabel, onConfirm } = options
  const MAX_PREVIEW = 30

  const overlay = document.createElement('div')
  overlay.className = 'modal'
  const shown = lines.slice(0, MAX_PREVIEW)
  const rest = lines.length - shown.length
  overlay.innerHTML = `
<div class="modal__panel" role="dialog" aria-modal="true" aria-label="${escapeHtmlAttr(title)}">
  <div class="modal__head">
    <span class="modal__title">${escapeHtmlAttr(title)}</span>
    <button class="btn btn--small" data-close>取消</button>
  </div>
  <div class="modal__body">
    <ul class="confirm__list">${shown.map((l) => `<li>${escapeHtmlAttr(l)}</li>`).join('')}${
      rest > 0 ? `<li class="confirm__more">…另有 ${rest} 条</li>` : ''
    }</ul>
  </div>
  <div class="modal__foot">
    <button class="btn" data-close>取消</button>
    <button class="btn btn--primary" data-confirm>${escapeHtmlAttr(confirmLabel)}</button>
  </div>
</div>`

  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target === overlay || target.closest('[data-close]')) {
      close()
      return
    }
    if (target.closest('[data-confirm]')) {
      close()
      onConfirm()
    }
  })
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function escapeHtmlAttr(text: string): string {
  return escape(text).replace(/"/g, '&quot;')
}
