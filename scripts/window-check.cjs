/**
 * 无边框窗口 + 应用内标题栏 + 统一弹窗的验收脚本。
 * 前置：带 --remote-debugging-port=9222 启动 mdreader.exe
 */
const { chromium } = require('playwright-core')

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const path = require('path')
const OUT = path.resolve(__dirname, '../.preview')

const ok = (name, pass, extra) =>
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)

;(async () => {
  const browser = await chromium.connectOverCDP(CDP)
  const context = browser.contexts()[0]
  const page = context.pages().find((p) => p.url().includes('mdreader.local'))
  if (!page) throw new Error('未找到 mdreader 页面')

  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.waitForTimeout(1500)

  // 上一轮测试留下的草稿恢复弹窗：先删掉草稿再继续
  await page.evaluate(() => {
    const m = document.querySelector('.modal')
    if (m) m.querySelector('[data-close]')?.click()
  })
  await page.waitForTimeout(300)

  // 1. 桌面模式 + 标题栏可见
  const tb = await page.evaluate(() => {
    const bar = document.querySelector('.titlebar')
    const cs = bar ? getComputedStyle(bar) : null
    return {
      desktop: document.querySelector('.app')?.classList.contains('is-desktop') ?? false,
      display: cs?.display ?? null,
      height: bar?.getBoundingClientRect().height ?? 0,
      bg: cs?.backgroundColor ?? null,
    }
  })
  ok('标题栏显示（桌面模式）', tb.desktop && tb.display === 'flex' && tb.height > 20, JSON.stringify(tb))

  // 2. 最大化 / 还原（依赖宿主回推 windowState 事件）
  await page.click('[data-win="max"]')
  let st = await page.waitForFunction(
    () => document.querySelector('.app')?.classList.contains('is-maximized') === true,
    null,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  const glyphMax = await page.evaluate(() => document.querySelector('[data-win="max"]')?.textContent)
  ok('最大化：windowState 回推 + 图标切换', st && glyphMax === '❐', `glyph=${glyphMax}`)

  await page.click('[data-win="max"]')
  st = await page.waitForFunction(
    () => document.querySelector('.app')?.classList.contains('is-maximized') === false,
    null,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  ok('还原', st)

  // 3. 「打开」下拉菜单完整可见（不被裁剪）
  await page.click('[data-action="open-menu"]')
  await page.waitForTimeout(400)
  const menu = await page.evaluate(() => {
    const list = document.querySelector('[data-role="open-list"]')
    if (!list || list.hidden) return { shown: false }
    const r = list.getBoundingClientRect()
    return {
      shown: true,
      items: list.querySelectorAll('.menu__item').length,
      fits: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
      vp: { w: innerWidth, h: innerHeight },
    }
  })
  ok('打开菜单完整显示', menu.shown && menu.fits && menu.items > 0, JSON.stringify(menu))
  await page.screenshot({ path: `${OUT}/win-menu.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // 4. 主题切换时标题栏跟随变色
  const before = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')).backgroundColor)
  await page.click('[data-action="toggle-theme"]')
  await page.waitForTimeout(600)
  const after = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')).backgroundColor)
  ok('标题栏随主题变色', before !== after, `${before} -> ${after}`)
  await page.click('[data-action="toggle-theme"]')
  await page.waitForTimeout(400)

  // 5. 弄脏文档 → 新建时弹统一确认框
  await page.click('.cm-content')
  await page.keyboard.type('测试文字')
  await page.waitForTimeout(400)
  await page.click('[data-action="new"]')
  await page.waitForTimeout(400)
  const discard = await page.evaluate(() => {
    const m = document.querySelector('.modal .modal__panel--message')
    return m ? { title: m.querySelector('.modal__title')?.textContent, buttons: m.querySelectorAll('button').length } : null
  })
  ok('未保存确认弹窗（应用内样式）', !!discard && discard.buttons >= 2, JSON.stringify(discard))
  await page.screenshot({ path: `${OUT}/win-modal-discard.png` })
  await page.click('.modal [data-close]')
  await page.waitForTimeout(300)
  const stillDirty = await page.evaluate(() => !!document.querySelector('.cm-content'))
  ok('取消后文档仍在', stillDirty)

  // 6. 关闭窗口 → 宿主推送 confirmExit → 应用内弹窗，先「继续编辑」
  await page.click('[data-win="close"]')
  const exitModal = await page.waitForFunction(
    () => !!document.querySelector('.modal .modal__panel--message'),
    null,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  ok('退出确认走应用内弹窗', exitModal)
  await page.screenshot({ path: `${OUT}/win-modal-exit.png` })
  await page.click('.modal [data-close]')
  await page.waitForTimeout(400)
  const alive = await page.evaluate(() => !!document.querySelector('.app'))
  ok('继续编辑后窗口保留', alive)

  console.log('\n运行时错误:', errors.length ? errors.join('\n') : '(无)')
  await browser.close().catch(() => undefined)
})().catch((err) => {
  console.error('验收失败：', err && err.message)
  process.exit(1)
})
