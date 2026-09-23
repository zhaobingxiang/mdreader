/**
 * 冒烟测试：用本地 Chromium 打开 dev server，验证三态布局、滚动同步、
 * Lint 规则与渲染注册表，并输出截图到 .preview/。
 *
 * 用法：
 *   npm run dev            （另开一个终端）
 *   npm run smoke
 *
 * 可选环境变量：TARGET_URL（默认 http://localhost:5178/）、CHROME_PATH
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { chromium } = require('playwright-core')

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5178/'
const OUT_DIR = path.resolve(__dirname, '../.preview')

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright')
  if (!fs.existsSync(base)) return undefined
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
    .sort()
    .reverse()
  for (const dir of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac']) {
      const exe = path.join(base, dir, sub, sub.startsWith('chrome-win') ? 'chrome.exe' : 'chrome')
      if (fs.existsSync(exe)) return exe
    }
  }
  return undefined
}

function readLayout() {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) }
  }
  return {
    mode: document.getElementById('app').dataset.mode,
    editor: r('.pane--editor'),
    preview: r('.pane--preview'),
  }
}

const failures = []
function check(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const executablePath = findChromium()
  const browser = await chromium.launch(executablePath ? { executablePath } : {})

  // 授权剪贴板，避免复制类交互抛权限错误
  const context = await browser.newContext({
    viewport: { width: 1480, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()

  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (text.includes('favicon') || text.includes('404')) return
    errors.push(`[console.error] ${text}`)
  })

  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(4500)

  console.log('\n▸ 渲染注册表')
  const render = await page.evaluate(() => ({
    code: document.querySelectorAll('.md-code').length,
    table: document.querySelectorAll('.md-table').length,
    callout: document.querySelectorAll('.md-callout').length,
    task: document.querySelectorAll('.md-task').length,
    katex: document.querySelectorAll('.katex').length,
    mermaidSvg: document.querySelectorAll('.md-embed--mermaid svg').length,
    heading: document.querySelectorAll('.md-heading').length,
    dataLine: document.querySelectorAll('[data-line]').length,
    outline: document.querySelectorAll('.outline__item').length,
    // 回归防线：行内代码绝不能吞掉块级元素（renderToken 误用会让 0.87em 逐级累乘）
    inlineCodeLeak: document.querySelectorAll(
      '.md-code-inline .md-block, .md-code-inline table, .md-code-inline pre, ' +
        '.md-code-inline ul, .md-code-inline ol, .md-code-inline h1, .md-code-inline h2, .md-code-inline h3',
    ).length,
    minFontSize: (() => {
      let min = 999
      for (const el of document.querySelectorAll('.markdown-body *')) {
        const hasText = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && n.textContent.trim().length > 1,
        )
        if (!hasText) continue
        const size = parseFloat(getComputedStyle(el).fontSize)
        if (size < min) min = size
      }
      return Math.round(min * 10) / 10
    })(),
  }))
  check('代码块渲染', render.code >= 1, `${render.code} 个`)
  check('表格渲染', render.table >= 1, `${render.table} 个`)
  check('callout 渲染', render.callout >= 1, `${render.callout} 个`)
  check('任务列表渲染', render.task >= 3, `${render.task} 项`)
  check('KaTeX 公式', render.katex >= 2, `${render.katex} 处`)
  check('Mermaid 出图', render.mermaidSvg >= 1, `${render.mermaidSvg} 个 SVG`)
  check('滚动锚点齐全', render.dataLine >= 30, `${render.dataLine} 个 data-line`)
  check('大纲生成', render.outline >= 5, `${render.outline} 项`)
  check('行内代码未吞掉块级元素', render.inlineCodeLeak === 0, `泄漏 ${render.inlineCodeLeak} 处`)
  check('无异常小字号', render.minFontSize >= 12, `最小 ${render.minFontSize}px`)

  console.log('\n▸ 三态视图')
  for (const mode of ['split', 'edit', 'preview']) {
    await page.click(`.segmented__item[data-mode="${mode}"]`)
    await page.waitForTimeout(800)
    const layout = await page.evaluate(readLayout)
    if (mode === 'split') {
      const gap = Math.abs(layout.editor.w - layout.preview.w)
      check('分屏两侧等宽', gap < 30, `编辑 ${layout.editor.w} / 预览 ${layout.preview.w}`)
      check('分屏无横向溢出', layout.preview.right <= 1480, `预览右边界 ${layout.preview.right}`)
    } else if (mode === 'edit') {
      check('编辑模式隐藏预览', layout.preview.w === 0 && layout.editor.w > 600, `编辑宽 ${layout.editor.w}`)
    } else {
      check('预览模式隐藏编辑', layout.editor.w === 0 && layout.preview.w > 600, `预览宽 ${layout.preview.w}`)
    }
    await page.screenshot({ path: path.join(OUT_DIR, `mode-${mode}.png`) })
  }

  await page.click('.segmented__item[data-mode="split"]')
  await page.waitForTimeout(600)

  console.log('\n▸ 滚动同步')
  await page.evaluate(() => {
    document.querySelector('.cm-scroller').scrollTop = 900
  })
  await page.waitForTimeout(800)
  const sync = await page.evaluate(() => ({
    editor: Math.round(document.querySelector('.cm-scroller').scrollTop),
    preview: Math.round(document.querySelector('.pane--preview').scrollTop),
  }))
  check('编辑滚动带动预览', sync.preview > 400, `编辑 ${sync.editor} → 预览 ${sync.preview}`)
  await page.screenshot({ path: path.join(OUT_DIR, 'scroll-synced.png') })

  console.log('\n▸ 书写提示（Lint）')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n#### 跳级标题\n\n[空链接]()\n\n```js\nconst a = 1\n')
  await page.waitForTimeout(3200)
  const lint = await page.evaluate(() => ({
    count: document.querySelectorAll('.hint').length,
    badge: document.querySelector('.panel__badge')?.textContent ?? '',
    messages: [...document.querySelectorAll('.hint')].map((el) => el.innerText.replace(/\n/g, ' ')),
  }))
  check('检出未闭合代码块', lint.messages.some((m) => m.includes('未闭合') || m.includes('结束围栏')), lint.messages[0])
  check('检出标题层级跳跃', lint.messages.some((m) => m.includes('层级')), lint.messages[1])
  check('检出空链接', lint.messages.some((m) => m.includes('链接地址为空')), lint.messages[2])
  check('汇总徽章更新', lint.badge.includes('错误'), lint.badge)
  void lint.count
  await page.screenshot({ path: path.join(OUT_DIR, 'lint-triggered.png') })

  console.log('\n▸ 撤销/重做')
  const lenBeforeType = await page.evaluate(
    () => (document.querySelector('.cm-content')?.innerText ?? '').length,
  )
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('冒烟撤销测试')
  await page.waitForTimeout(500)
  await page.click('[data-action="undo"]')
  await page.waitForTimeout(600)
  const lenAfterUndo = await page.evaluate(
    () => (document.querySelector('.cm-content')?.innerText ?? '').length,
  )
  check('撤销准确回退输入', lenAfterUndo === lenBeforeType, `输入前 ${lenBeforeType} → 撤销后 ${lenAfterUndo}`)

  console.log('\n▸ 运行时错误')
  check('无未捕获异常', errors.length === 0, errors.join(' | ') || '干净')

  await browser.close()

  console.log('')
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} 项未通过：${failures.join('、')}`)
    console.log(`  截图见 ${OUT_DIR}`)
    process.exit(1)
  }
  console.log(`✓ 全部通过，截图见 ${OUT_DIR}`)
})().catch((err) => {
  console.error('冒烟测试执行失败：', err && err.message)
  process.exit(1)
})
