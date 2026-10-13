/**
 * 主题控制：light / dark / system。
 * system 跟随 prefers-color-scheme 实时变化；
 * 用户手动切换后固定为 light / dark，不再随系统变化。
 * 主题值统一持久化在设置模块（settings.theme）。
 */

import type { ThemeSetting } from './settings'

export type ThemeName = 'light' | 'dark'

let setting: ThemeSetting = 'system'

function systemTheme(): ThemeName {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(name: ThemeName): void {
  document.documentElement.dataset.theme = name
}

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function resolveTheme(s: ThemeSetting): ThemeName {
  return s === 'system' ? systemTheme() : s
}

/** 设置变更（本窗口或其他来源）统一从这里落地 */
export function applyThemeSetting(next: ThemeSetting): void {
  setting = next
  apply(resolveTheme(next))
}

export function getThemeSetting(): ThemeSetting {
  return setting
}

// 单元测试在 node 环境跑，没有 window
if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (setting === 'system') apply(systemTheme())
  })
}
