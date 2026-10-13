/**
 * 设置弹窗：与消息 / 差异弹窗同一套应用内风格。
 * 改动即时生效并持久化，没有「确定 / 取消」——关窗即完成。
 */

import { getSettings, patchSettings, type AppSettings, type ThemeSetting } from '../core/settings'
import type { ViewMode } from '../core/view-mode'

const MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'edit', label: '编辑' },
  { value: 'split', label: '分屏' },
  { value: 'preview', label: '预览' },
]

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function showSettingsModal(desktop: boolean): void {
  if (document.querySelector('.modal--settings')) return
  const s = getSettings()

  const overlay = document.createElement('div')
  overlay.className = 'modal modal--settings'
  overlay.innerHTML = `
<div class="modal__panel modal__panel--settings" role="dialog" aria-modal="true" aria-label="设置">
  <div class="modal__head">
    <span class="modal__title">设置</span>
    <button class="btn btn--small" data-close>关闭</button>
  </div>
  <div class="modal__body settings__body">
    <div class="setting__group">视图</div>

    <div class="setting">
      <div class="setting__label">打开文档时显示<select class="input" data-setting="defaultMode">
        ${MODE_OPTIONS.map(
          (o) =>
            `<option value="${o.value}"${o.value === s.defaultMode ? ' selected' : ''}>${esc(o.label)}</option>`,
        ).join('')}
      </select></div>
      <span class="setting__hint">新标签页的初始模式，当前页不受影响</span>
    </div>

    <div class="setting">
      <div class="setting__label">主题<select class="input" data-setting="theme">
        ${THEME_OPTIONS.map(
          (o) =>
            `<option value="${o.value}"${o.value === s.theme ? ' selected' : ''}>${esc(o.label)}</option>`,
        ).join('')}
      </select></div>
      <span class="setting__hint">手动切换深色 / 浅色按钮会覆盖此处选择</span>
    </div>

    <div class="setting">
      <div class="setting__label">默认内容缩放<input class="input input--narrow" type="number"
        data-setting="zoom" min="30" max="400" step="10" value="${Math.round(s.zoom * 100)}" /></div>
      <span class="setting__hint">Ctrl+滚轮调整缩放会同时更新这里</span>
    </div>

    <label class="setting setting--row">
      <input type="checkbox" data-setting="outlineVisible"${s.outlineVisible ? ' checked' : ''} />
      <span>打开时显示大纲面板</span>
    </label>
    <label class="setting setting--row">
      <input type="checkbox" data-setting="hintsVisible"${s.hintsVisible ? ' checked' : ''} />
      <span>打开时显示书写提示</span>
    </label>

    ${
      desktop
        ? `<div class="setting__group">打开与启动</div>

    <label class="setting setting--row">
      <input type="checkbox" data-setting="restoreSession"${s.restoreSession ? ' checked' : ''} />
      <span>启动时恢复上次打开的标签页</span>
    </label>
    <label class="setting setting--row">
      <input type="checkbox" data-setting="rememberWindow"${s.rememberWindow ? ' checked' : ''} />
      <span>记住窗口大小和位置</span>
    </label>
    <div class="setting setting--row">
      <input type="checkbox" data-setting="printHeaderFooter"${s.printHeaderFooter ? ' checked' : ''} />
      <span>打印默认带页眉页脚<div class="setting__hint">页眉页脚指日期、标题、网址、页码；改此项重启后生效，打印对话框里仍可单次调整</div></span>
    </div>`
        : ''
    }
  </div>
</div>`

  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }

  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target === overlay || target.closest('[data-close]')) close()
  })
  // select 在原生下拉里选完只发 change，不发 click；checkbox 同理
  overlay.addEventListener('change', (event) => {
    const input = event.target as HTMLElement
    if (input instanceof HTMLInputElement && input.type === 'number') {
      const percent = Number(input.value)
      if (Number.isFinite(percent) && percent > 0) {
        patchSettings({ zoom: percent / 100 } as Partial<AppSettings>)
      }
      return
    }
    const setting = input.closest<HTMLElement>('[data-setting]')
    if (!setting) return
    const key = setting.dataset.setting as keyof AppSettings
    if (setting instanceof HTMLInputElement) {
      if (setting.type === 'checkbox') {
        patchSettings({ [key]: setting.checked } as Partial<AppSettings>)
      }
    } else if (setting instanceof HTMLSelectElement) {
      patchSettings({ [key]: setting.value } as Partial<AppSettings>)
    }
  })

  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}
