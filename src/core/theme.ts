/**
 * 主题控制：light / dark，默认跟随系统。
 * 用户手动切换后固定住，不再随系统变化。
 */

export type ThemeName = 'light' | 'dark'

const STORAGE_KEY = 'mdreader.theme'

function systemTheme(): ThemeName {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readSaved(): ThemeName | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    return null
  }
}

function apply(name: ThemeName): void {
  document.documentElement.dataset.theme = name
}

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function initTheme(): void {
  apply(readSaved() ?? systemTheme())
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (readSaved() === null) apply(event.matches ? 'dark' : 'light')
  })
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === 'dark' ? 'light' : 'dark'
  apply(next)
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 隐私模式，本次会话内仍生效
  }
  return next
}
