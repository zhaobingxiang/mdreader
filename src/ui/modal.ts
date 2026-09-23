/**
 * 应用内消息弹窗：替代 window.confirm / 原生 MessageBox，
 * 风格与主程序一致（CSS 变量驱动，自动适配深浅主题）。
 */

export function showMessageModal(options: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = '确定',
    cancelLabel = '取消',
  } = options

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal'
    overlay.innerHTML = `
<div class="modal__panel modal__panel--message" role="dialog" aria-modal="true" aria-label="${escapeHtmlAttr(title)}">
  <div class="modal__head">
    <span class="modal__title">${escapeHtmlAttr(title)}</span>
  </div>
  <div class="modal__body"><p class="message__text">${escapeHtmlAttr(message)}</p></div>
  <div class="modal__foot">
    <button class="btn" data-close>${escapeHtmlAttr(cancelLabel)}</button>
    <button class="btn btn--primary" data-confirm>${escapeHtmlAttr(confirmLabel)}</button>
  </div>
</div>`

    const finish = (result: boolean): void => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        finish(false)
      } else if (event.key === 'Enter') {
        event.stopPropagation()
        finish(true)
      }
    }
    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target === overlay || target.closest('[data-close]')) {
        finish(false)
        return
      }
      if (target.closest('[data-confirm]')) finish(true)
    })

    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
    overlay.querySelector<HTMLElement>('[data-confirm]')?.focus()
  })
}

function escapeHtmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
