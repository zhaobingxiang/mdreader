/**
 * 标签栏渲染：纯展示，交互事件由 app.ts 在容器上代理。
 */

export interface TabItem {
  id: number
  name: string
  dirty: boolean
  active: boolean
  /** 悬停提示用的完整路径，可为空 */
  path: string
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderTabs(container: HTMLElement, items: TabItem[]): void {
  container.innerHTML = items
    .map(
      (tab) => `
<div class="tab${tab.active ? ' is-active' : ''}" data-tab="${tab.id}"${
        tab.path ? ` title="${esc(tab.path)}"` : ''
      }>
  <span class="tab__dot"${tab.dirty ? '' : ' hidden'}></span>
  <span class="tab__name">${esc(tab.name)}</span>
  <button class="tab__close" data-tab-close="${tab.id}" title="关闭（Ctrl+W）" aria-label="关闭标签">✕</button>
</div>`,
    )
    .join('')
}
