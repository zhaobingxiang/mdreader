import { diffLines } from '../render/util'

/**
 * 外部改写审阅：并排/行级 diff 弹窗。
 * 场景是 AI 或别的编辑器改了磁盘上的文件，用户需要先看清楚再决定采纳。
 */
export function showDiffModal(options: {
  title: string
  before: string
  after: string
  onAccept(): void
  onDismiss(): void
}): void {
  const { title, before, after, onAccept, onDismiss } = options
  const lines = diffLines(before, after)
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length

  const overlay = document.createElement('div')
  overlay.className = 'modal'
  overlay.innerHTML = `
<div class="modal__panel" role="dialog" aria-modal="true" aria-label="${title}">
  <div class="modal__head">
    <span class="modal__title">${title}</span>
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
    <button class="btn" data-close>先不处理</button>
    <button class="btn btn--primary" data-accept>采纳外部版本</button>
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

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}
