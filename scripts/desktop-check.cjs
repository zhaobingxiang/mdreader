/**
 * 桌面壳验收：通过 WebView2 的远程调试端口接入运行中的 mdreader.exe，
 * 检查前端渲染结果与宿主消息桥是否正常。
 *
 * 前置：先带调试端口启动程序
 *   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *   desktop\publish\mdreader.exe
 */
const { chromium } = require('playwright-core')

const OUT = 'D:/ide/mdreader/.preview'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'

;(async () => {
  const browser = await chromium.connectOverCDP(CDP)
  const context = browser.contexts()[0]
  const page =
    context.pages().find((p) => p.url().includes('mdreader.local')) ?? context.pages()[0]
  if (!page) throw new Error('未找到 mdreader 页面，请确认程序已启动')

  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(`[console] ${m.text()}`)
  })

  await page.waitForTimeout(1800)

  const info = await page.evaluate(() => ({
    url: location.href,
    secureContext: window.isSecureContext,
    hostBridge: !!(window.chrome && window.chrome.webview),
    mode: document.getElementById('app')?.dataset.mode ?? null,
    outline: document.querySelectorAll('.outline__item').length,
    todos: document.querySelectorAll('.todo').length,
    blocks: {
      code: document.querySelectorAll('.md-code').length,
      table: document.querySelectorAll('.md-table').length,
      callout: document.querySelectorAll('.md-callout').length,
      katex: document.querySelectorAll('.katex').length,
      mermaidSvg: document.querySelectorAll('.md-embed--mermaid svg').length,
    },
    status: document.querySelector('.statusbar')?.innerText.replace(/\n/g, ' | ') ?? null,
  }))

  console.log('=== 前端渲染 ===')
  console.log(JSON.stringify(info, null, 2))

  const call = (id, action, payload) =>
    page.evaluate(
      ([msgId, act, extra]) =>
        new Promise((resolve) => {
          const handler = (event) => {
            if (!event.data || event.data.id !== msgId) return
            window.chrome.webview.removeEventListener('message', handler)
            resolve(event.data)
          }
          window.chrome.webview.addEventListener('message', handler)
          window.chrome.webview.postMessage(Object.assign({ id: msgId, action: act }, extra))
        }),
      [id, action, payload ?? {}],
    )

  console.log('\n=== 宿主桥 ===')

  const pong = await call(99001, 'ping')
  console.log(`ping        -> ${JSON.stringify(pong)}`)

  const read = await call(99002, 'readFile', { path: 'D:/ide/mdreader/package.json' })
  console.log(
    `readFile    -> ok=${read.ok} name=${read.result?.name} 长度=${read.result?.text?.length}`,
  )

  const write = await call(99003, 'writeFile', {
    path: 'D:/ide/mdreader/.preview/bridge-test.md',
    text: '# 桥接写入测试\n\n这段内容由 .NET 宿主写入磁盘。\n',
  })
  console.log(`writeFile   -> ok=${write.ok} path=${write.result?.path ?? write.error}`)

  const missing = await call(99004, 'readFile', { path: 'D:/ide/mdreader/不存在的文件.md' })
  console.log(`readFile(缺失) -> ok=${missing.ok} error=${missing.error}`)

  await page.screenshot({ path: `${OUT}/desktop-shell.png` })

  console.log('\n=== 运行时错误 ===')
  console.log(errors.length ? errors.join('\n') : '(无)')

  // 只断开调试连接，不关闭程序本身
  await browser.close().catch(() => undefined)
})().catch((err) => {
  console.error('桌面壳验收失败：', err && err.message)
  process.exit(1)
})
