/**
 * 字号体检：把指定 Markdown 灌进阅读器，报告字号分布与异常偏小的元素。
 *
 * 用途：排查「某些文字显示很小」这类渲染问题。
 * 典型病征是字号呈等比递减（如 11.4 → 9.9 → 8.6），说明有相对单位在嵌套中累乘。
 *
 * 用法：
 *   npm run dev                      （另开终端）
 *   node scripts/check-fonts.cjs "D:/path/to/doc.md"
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { chromium } = require('playwright-core')

const MD_PATH = process.argv[2]
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5178/'
const OUT = path.resolve(__dirname, '../.preview')
const MIN_OK = 12

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright')
  if (!fs.existsSync(base)) return undefined
  for (const dir of fs.readdirSync(base).filter((d) => d.startsWith('chromium-') && !d.includes('headless')).sort().reverse()) {
    for (const [sub, exe] of [
      ['chrome-win64', 'chrome.exe'],
      ['chrome-win', 'chrome.exe'],
      ['chrome-linux', 'chrome'],
      ['chrome-mac', 'chrome'],
    ]) {
      const candidate = path.join(base, dir, sub, exe)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}

;(async () => {
  if (!MD_PATH) {
    console.error('用法：node scripts/check-fonts.cjs <markdown 文件路径>')
    process.exit(1)
  }

  const source = fs.readFileSync(MD_PATH, 'utf8')
  console.log(`文档: ${path.basename(MD_PATH)}  ${(source.length / 1024).toFixed(1)} KB\n`)

  const exe = findChromium()
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  const page = await browser.newPage({ viewport: { width: 1480, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(4000)

  await page.click('.cm-content')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(source)
  await page.waitForTimeout(5000)

  const report = await page.evaluate((minOk) => {
    const histogram = {}
    const small = []

    const walk = (el) => {
      const size = Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10
      const hasOwnText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 1,
      )
      if (hasOwnText) {
        histogram[size] = (histogram[size] || 0) + 1
        if (size < minOk) {
          small.push({
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 40),
            size,
            text: el.textContent.trim().slice(0, 42),
          })
        }
      }
      for (const child of el.children) walk(child)
    }
    walk(document.querySelector('.markdown-body'))

    return {
      histogram,
      small,
      leak: document.querySelectorAll(
        '.md-code-inline .md-block, .md-code-inline table, .md-code-inline pre, .md-code-inline h1, .md-code-inline h2, .md-code-inline h3',
      ).length,
      blocks: {
        code: document.querySelectorAll('.md-code').length,
        table: document.querySelectorAll('.md-table').length,
        mermaid: document.querySelectorAll('.md-embed--mermaid svg').length,
        katex: document.querySelectorAll('.katex').length,
        inlineCode: document.querySelectorAll('.md-code-inline').length,
      },
    }
  }, MIN_OK)

  console.log('=== 块统计 ===')
  console.log(JSON.stringify(report.blocks))
  console.log('\n=== 字号分布（字号: 元素数） ===')
  console.log(JSON.stringify(report.histogram))

  console.log(`\n=== 小于 ${MIN_OK}px 的元素（共 ${report.small.length} 个） ===`)
  for (const item of report.small.slice(0, 30)) {
    console.log(`  ${String(item.size).padStart(6)}px  <${item.tag}> .${item.cls}`)
    console.log(`             「${item.text}」`)
  }

  const bad = report.small.filter((s) => !s.cls.includes('md-code__'))
  console.log('')
  if (report.leak > 0) {
    console.log(`✗ 行内代码吞掉了 ${report.leak} 个块级元素（renderToken 误用）`)
  }
  if (bad.length > 0) {
    console.log(`✗ 有 ${bad.length} 处非工具条文字小于 ${MIN_OK}px，请检查是否有相对字号在累乘`)
  }
  if (report.leak === 0 && bad.length === 0) {
    console.log('✓ 字号正常')
  }
  if (errors.length) console.log('运行时错误:', errors.join(' | '))

  await page.screenshot({ path: path.join(OUT, 'check-fonts.png') })
  await browser.close()
  process.exit(report.leak > 0 || bad.length > 0 ? 1 : 0)
})().catch((e) => {
  console.error('体检失败：', e && e.message)
  process.exit(1)
})
