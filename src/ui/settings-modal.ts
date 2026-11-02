/**
 * 设置弹窗：与消息 / 差异弹窗同一套应用内风格。
 * 改动即时生效并持久化，没有「确定 / 取消」——关窗即完成。
 *
 * AI 平台的密钥走宿主单独通道（DPAPI），这里只显示「已保存 · 尾号」，
 * 输入框永远不回显明文，也不进 settings.json / localStorage。
 */

import { getSettings, patchSettings, type AppSettings, type AiProviderSettings, type MeetingSettings, type ThemeSetting } from '../core/settings'
import { aiListModels, aiSetKey, aiStatus, type AiKeyStatus } from '../core/ai/host'
import { BUILTIN_PROVIDERS, getProvider } from '../core/ai/providers'
import { asrCancel, asrInstall, asrInstallFromZip, asrStatus, onAsrEvent } from '../features/meeting/asr'
import { nextMeetingRequestId } from '../features/meeting/types'
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

/** 本次打开设置窗口期间拉到的模型清单，切换平台再切回来不用重拉 */
const fetchedModels = new Map<string, string[]>()

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
        ? `<div data-role="ai-section">${aiSectionHtml()}</div>
    <div class="setting__group">打开与启动</div>

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
    </div>
    ${meetingSectionHtml(s.meeting)}`
        : ''
    }
  </div>
</div>`

  const close = (): void => {
    stopAsrWatch()
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
    if (target === overlay || target.closest('[data-close]')) {
      close()
      return
    }
    if (!desktop) return
    if (target.closest('[data-ai-key-save]')) {
      void saveKey(overlay)
      return
    }
    if (target.closest('[data-ai-key-clear]')) {
      void saveKey(overlay, '')
      return
    }
    const pick = target.closest<HTMLElement>('[data-ai-model-pick]')
    if (pick) {
      selectProviderModel(pick.dataset.aiModelPick ?? '')
      rerenderAiSection(overlay)
      return
    }
    const remove = target.closest<HTMLElement>('[data-ai-model-remove]')
    if (remove) {
      removeProviderModel(remove.dataset.aiModelRemove ?? '')
      rerenderAiSection(overlay)
      return
    }
    if (target.closest('[data-ai-model-add-btn]')) {
      addProviderModel(overlay)
      return
    }
    if (target.closest('[data-ai-refresh]')) {
      void refreshModels(overlay)
      return
    }
    if (target.closest('[data-asr-install]')) {
      void startAsrInstall(overlay, false)
      return
    }
    if (target.closest('[data-asr-install-zip]')) {
      void startAsrInstall(overlay, true)
      return
    }
    if (target.closest('[data-asr-cancel]')) {
      if (asrRequest) asrCancel(asrRequest)
      asrNote(overlay, '正在取消下载…', true)
    }
  })

  // 手填模型名时回车即添加
  overlay.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if (event.key !== 'Enter' || !target.matches('[data-ai-model-custom]')) return
    event.preventDefault()
    addProviderModel(overlay)
  })

  // select 在原生下拉里选完只发 change，不发 click；checkbox 同理
  overlay.addEventListener('change', (event) => {
    const input = event.target as HTMLElement
    if (input instanceof HTMLInputElement && input.type === 'number' && input.dataset.setting === 'zoom') {
      const percent = Number(input.value)
      if (Number.isFinite(percent) && percent > 0) {
        patchSettings({ zoom: percent / 100 } as Partial<AppSettings>)
      }
      return
    }

    if (input instanceof HTMLSelectElement && input.dataset.aiProvider !== undefined) {
      patchAi((ai) => ({ ...ai, active: input.value }))
      rerenderAiSection(overlay)
      return
    }
    if (input instanceof HTMLInputElement && input.dataset.aiBase !== undefined) {
      patchProvider((p) => ({ ...p, baseUrl: input.value.trim() }))
      return
    }
    if (input instanceof HTMLInputElement && input.dataset.aiDeep !== undefined) {
      patchAi((ai) => ({ ...ai, deepThinking: input.checked }))
      return
    }

    if (input instanceof HTMLInputElement && input.dataset.asrUrl !== undefined) {
      patchMeeting((m) => ({ ...m, engineUrl: input.value.trim() }))
      return
    }
    if (input instanceof HTMLInputElement && input.dataset.asrThreads !== undefined) {
      const raw = Number(input.value)
      const threads = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), 64) : 0
      input.value = String(threads)
      patchMeeting((m) => ({ ...m, threads }))
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
  if (desktop) {
    void refreshKeyState(overlay)
    void refreshAsrState(overlay)
  }
}

// ---------- AI 设置区 ----------

function patchAi(update: (ai: AppSettings['ai']) => AppSettings['ai']): void {
  patchSettings({ ai: update(getSettings().ai) })
}

function patchProvider(update: (p: AiProviderSettings) => AiProviderSettings): void {
  const ai = getSettings().ai
  const id = ai.active
  const current = ai.providers[id] ?? { baseUrl: '', models: [], model: '' }
  patchSettings({ ai: { ...ai, providers: { ...ai.providers, [id]: update(current) } } })
}

function selectProviderModel(id: string): void {
  if (!id) return
  patchProvider((p) => (p.models.includes(id) ? { ...p, model: id } : p))
}

function removeProviderModel(id: string): void {
  patchProvider((p) => {
    const models = p.models.filter((m) => m !== id)
    return { ...p, models, model: p.model === id ? (models[0] ?? '') : p.model }
  })
}

function addProviderModel(overlay: HTMLElement): void {
  const select = overlay.querySelector<HTMLSelectElement>('[data-ai-model-add]')
  const custom = overlay.querySelector<HTMLInputElement>('[data-ai-model-custom]')
  const value = (select?.value ?? custom?.value ?? '').trim()
  const ai = getSettings().ai
  const config = ai.providers[ai.active]
  if (!config) return
  if (!value) {
    modelNote(overlay, custom ? '先填模型名' : '先选一个模型', true)
    return
  }
  if (config.models.includes(value)) {
    modelNote(overlay, '这个模型已经在清单里了', true)
    return
  }
  patchProvider((p) => ({ ...p, models: [...p.models, value], model: p.model || value }))
  rerenderAiSection(overlay)
  modelNote(overlay, `已添加 ${value}`)
}

function modelNote(overlay: HTMLElement, text: string, isError = false): void {
  const note = overlay.querySelector<HTMLElement>('[data-role="ai-model-note"]')
  if (!note) return
  note.textContent = text
  note.classList.toggle('is-error', isError)
}

function aiSectionHtml(): string {
  const ai = getSettings().ai
  const provider = getProvider(ai.active)
  const config = ai.providers[ai.active] ?? { baseUrl: '', models: [], model: '' }
  // MaaS 的清单是拉回来的，内置默认模型（GLM-5.3 之类）不一定在里面，合并后才能选到
  const known = [
    ...new Set([
      ...provider.models.map((m) => m.id),
      ...(provider.id === 'maas' ? fetchedModels.get(provider.id) ?? [] : []),
    ]),
  ]
  const hintById = new Map(provider.models.map((m) => [m.id, m.hint ?? '']))
  const available = known.filter((id) => !config.models.includes(id))

  const providerOptions = BUILTIN_PROVIDERS.map(
    (p) => `<option value="${p.id}"${p.id === provider.id ? ' selected' : ''}>${esc(p.label)}</option>`,
  ).join('')

  const baseField = provider.editableBaseUrl
    ? `<input class="input input--wide" type="text" data-ai-base placeholder="https://example.com/v1" value="${esc(config.baseUrl)}" />`
    : `<code class="setting__code">${esc(config.baseUrl || '（未填写）')}</code>`

  const tags =
    config.models.length > 0
      ? config.models
          .map(
            (id) => `<span class="model-tag${id === config.model ? ' is-current' : ''}">
  <button type="button" class="model-tag__pick" data-ai-model-pick="${esc(id)}" title="${
    id === config.model ? '当前模型' : '设为当前模型'
  }">${esc(id)}</button>
  <button type="button" class="model-tag__remove" data-ai-model-remove="${esc(id)}" aria-label="移除 ${esc(id)}">✕</button>
</span>`,
          )
          .join('')
      : '<span class="setting__hint">还没有添加模型</span>'

  const addField =
    available.length > 0
      ? `<select class="input input--wide" data-ai-model-add>
    ${available
      .map((id) => `<option value="${esc(id)}">${esc(id)}${hintById.get(id) ? `　${esc(hintById.get(id)!)}` : ''}</option>`)
      .join('')}
  </select>`
      : known.length > 0
        ? '<span class="setting__hint">平台的模型都添加过了</span>'
        : `<input class="input input--wide" type="text" data-ai-model-custom autocomplete="off" placeholder="${
            provider.id === 'maas' ? '先刷新清单，或直接手填模型名' : '输入模型名'
          }" />`
  const canAdd = available.length > 0 || known.length === 0

  return `
<div class="setting__group">AI 优化</div>

<div class="setting">
  <div class="setting__label">平台<select class="input" data-ai-provider>
    ${providerOptions}
  </select></div>
  <span class="setting__hint">${esc(provider.hint)}</span>
</div>

<div class="setting">
  <div class="setting__label">接口地址</div>
  ${baseField}
</div>

<div class="setting">
  <div class="setting__label">API Key<span class="setting__state" data-role="ai-key-state">未配置</span></div>
  <div class="setting__row">
    <input class="input input--wide" type="password" data-ai-key autocomplete="off" placeholder="粘贴 API Key" />
    <button type="button" class="btn btn--small" data-ai-key-save>保存</button>
    <button type="button" class="btn btn--small" data-ai-key-clear>清除</button>
  </div>
  <span class="setting__hint" data-role="ai-key-note">${
    provider.builtinKey
      ? '不填也能用：平台自带公共 Key。粘贴自己的 Key 会加密保存在本机并覆盖它，仅当前用户可解密'
      : '用 Windows 当前用户加密保存在本机；不会写进设置文件，也不会在页面上回显'
  }</span>
</div>

<div class="setting">
  <div class="setting__label">我的模型
    ${provider.id === 'maas' ? '<button type="button" class="btn btn--small" data-ai-refresh>刷新清单</button>' : ''}
  </div>
  <div class="setting__models">${tags}</div>
  <div class="setting__row">
    ${addField}
    ${canAdd ? '<button type="button" class="btn btn--small" data-ai-model-add-btn>添加</button>' : ''}
  </div>
  <span class="setting__hint" data-role="ai-model-note">${
    known.length === 0 && provider.id === 'maas'
      ? '点「刷新清单」拉取平台模型，或直接手填；点标签设为当前模型'
      : '点标签设为当前模型，✕ 从清单移除；底部 AI 面板里可随时切换'
  }</span>
</div>

<label class="setting setting--row">
  <input type="checkbox" data-ai-deep${ai.deepThinking ? ' checked' : ''} />
  <span>深度思考<div class="setting__hint">会先输出思考过程再改写，更稳但更慢；Lanz 默认开启思考，此项控制 MaaS / 兼容端点</div></span>
</label>

<label class="setting setting--row">
  <input type="checkbox" data-setting="aiPanelVisible"${getSettings().aiPanelVisible ? ' checked' : ''} />
  <span>显示底部 AI 优化面板</span>
</label>

<div class="setting">
  <span class="setting__hint">对话与优化稿存放在 %APPDATA%\\mdreader\\workfile\\&lt;会话&gt;\\，不写进文档所在目录，7 天后自动清理。首次优化前会再确认一次是否把文档内容发给模型。</span>
</div>`
}

function rerenderAiSection(overlay: HTMLElement): void {
  const section = overlay.querySelector<HTMLElement>('[data-role="ai-section"]')
  if (!section) return
  section.innerHTML = aiSectionHtml()
  void refreshKeyState(overlay)
}

function providerId(): string {
  return getSettings().ai.active
}

/** 内置公共 Key 也算「已配置」，但要说明是自带的，免得用户以为自己配过 */
function keyStatusText(status: AiKeyStatus): string {
  if (!status.hasKey) return '未配置'
  return status.builtin ? `内置 Key ${status.tail}` : `已保存 ${status.tail}`
}

async function refreshKeyState(overlay: HTMLElement): Promise<void> {
  const state = overlay.querySelector<HTMLElement>('[data-role="ai-key-state"]')
  if (!state) return
  try {
    const status = await aiStatus(providerId())
    if (!overlay.isConnected) return
    state.textContent = keyStatusText(status)
    state.classList.toggle('is-ok', status.hasKey)
  } catch {
    state.textContent = '状态未知'
  }
}

function keyNote(overlay: HTMLElement, text: string, isError = false): void {
  const note = overlay.querySelector<HTMLElement>('[data-role="ai-key-note"]')
  if (!note) return
  note.textContent = text
  note.classList.toggle('is-error', isError)
}

async function saveKey(overlay: HTMLElement, forced?: string): Promise<void> {
  const input = overlay.querySelector<HTMLInputElement>('[data-ai-key]')
  const value = forced !== undefined ? forced : (input?.value ?? '')
  if (forced === undefined && !value.trim()) {
    keyNote(overlay, '先粘贴 API Key 再保存', true)
    return
  }
  try {
    const status = await aiSetKey(providerId(), value)
    if (!overlay.isConnected) return
    if (input) input.value = ''
    const state = overlay.querySelector<HTMLElement>('[data-role="ai-key-state"]')
    if (state) {
      state.textContent = keyStatusText(status)
      state.classList.toggle('is-ok', status.hasKey)
    }
    keyNote(
      overlay,
      status.hasKey
        ? status.builtin
          ? '已清除自己的 Key，改用内置公共 Key'
          : '已加密保存，仅本机当前用户可解密'
        : '已清除该平台的 Key',
    )
    // 存好 Key 后顺手拉一次模型清单，省得用户还要多点一次
    if (status.hasKey) void refreshModels(overlay, false)
  } catch (err) {
    keyNote(overlay, `保存失败：${err instanceof Error ? err.message : String(err)}`, true)
  }
}

async function refreshModels(overlay: HTMLElement, manual = true): Promise<void> {
  const ai = getSettings().ai
  const provider = getProvider(ai.active)
  const baseUrl = (ai.providers[ai.active]?.baseUrl ?? '').trim()
  const note = overlay.querySelector<HTMLElement>('[data-role="ai-model-note"]')
  if (!baseUrl) {
    if (note && manual) note.textContent = '先填写接口地址'
    return
  }
  if (note) note.textContent = '正在拉取模型清单…'
  try {
    const result = await aiListModels(provider.id, baseUrl)
    if (!overlay.isConnected) return
    if (result.unsupported) {
      if (note) note.textContent = '该平台没有模型列表接口，请直接填写模型名'
      return
    }
    const models = result.models ?? []
    fetchedModels.set(provider.id, models)
    // 清单会改变添加区的可选下拉，整块重绘最省事
    rerenderAiSection(overlay)
    modelNote(
      overlay,
      models.length > 0 ? `已获取 ${models.length} 个模型，选一个点「添加」` : '平台没有返回模型，请手填',
    )
  } catch (err) {
    if (!overlay.isConnected) return
    if (note) note.textContent = `拉取失败：${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------- 会记设置区 ----------

/** 同一时刻只有一个设置窗，安装任务状态放在模块级就够了 */
let asrRequest = 0
let offAsrWatch: (() => void) | null = null

function patchMeeting(update: (m: AppSettings['meeting']) => MeetingSettings): void {
  patchSettings({ meeting: update(getSettings().meeting) })
}

function meetingSectionHtml(m: MeetingSettings): string {
  return `
<div class="setting__group">会记</div>

<div class="setting">
  <div class="setting__label">本地语音模型<span class="setting__state" data-role="asr-state">检查中…</span></div>
  <div class="setting__row">
    <button type="button" class="btn btn--small" data-asr-install>下载语音模型</button>
    <button type="button" class="btn btn--small" data-asr-install-zip>从本地压缩包安装</button>
    <button type="button" class="btn btn--small" data-asr-cancel hidden>取消</button>
  </div>
  <span class="setting__hint" data-role="asr-note">SenseVoice（FunASR）+ Silero VAD，约 250 MB，只下载一次；装好后录音与转写全程离线，音频不出这台机器。各组件许可随包存在模型目录的 licenses 下。</span>
  <span class="setting__hint" data-role="asr-dir"></span>
</div>

<div class="setting">
  <div class="setting__label">模型包地址<input class="input input--wide" type="text" data-asr-url autocomplete="off"
    placeholder="https://…/disk/fileDownload?link=… 或 .zip 直链" value="${esc(m.engineUrl)}" /></div>
  <span class="setting__hint">内网取不到默认地址时改这里；网盘文件夹分享会自动取目录里的 zip。下载完会逐个校验包内文件的 sha256，对不上不会启用。</span>
</div>

<div class="setting">
  <div class="setting__label">转写线程数<input class="input input--narrow" type="number" data-asr-threads
    min="0" max="64" step="1" value="${m.threads}" /></div>
  <span class="setting__hint">0 = 按 CPU 核心数自动；两小时会议转写约 10 分钟，线程给足可以快一些。</span>
</div>`
}

function asrNote(overlay: HTMLElement, text: string, isError = false): void {
  const note = overlay.querySelector<HTMLElement>('[data-role="asr-note"]')
  if (!note) return
  note.textContent = text
  note.classList.toggle('is-error', isError)
}

function setAsrBusy(overlay: HTMLElement, busy: boolean): void {
  for (const key of ['data-asr-install', 'data-asr-install-zip']) {
    overlay.querySelector<HTMLButtonElement>(`[${key}]`)!.hidden = busy
  }
  overlay.querySelector<HTMLButtonElement>('[data-asr-cancel]')!.hidden = !busy
}

async function refreshAsrState(overlay: HTMLElement): Promise<void> {
  const state = overlay.querySelector<HTMLElement>('[data-role="asr-state"]')
  const dir = overlay.querySelector<HTMLElement>('[data-role="asr-dir"]')
  if (!state) return
  try {
    const status = await asrStatus()
    if (!overlay.isConnected) return
    state.textContent = status.ready ? `已就绪 · v${status.version}` : '未安装'
    state.classList.toggle('is-ok', status.ready)
    if (dir) dir.textContent = status.ready ? `存放位置：${status.dir}` : status.error
    setAsrBusy(overlay, asrRequest !== 0)
  } catch {
    state.textContent = '状态未知'
  }
}

async function startAsrInstall(overlay: HTMLElement, fromZip: boolean): Promise<void> {
  if (asrRequest) return
  const url = getSettings().meeting.engineUrl.trim()
  if (!fromZip && !url) {
    asrNote(overlay, '先填写模型包下载地址', true)
    return
  }
  asrRequest = nextMeetingRequestId()
  setAsrBusy(overlay, true)
  asrNote(overlay, fromZip ? '正在从本地压缩包安装…' : '正在下载语音模型（约 250 MB）…')
  watchAsr(overlay)
  try {
    if (fromZip) await asrInstallFromZip(asrRequest)
    else await asrInstall(url, asrRequest)
  } catch (err) {
    asrRequest = 0
    setAsrBusy(overlay, false)
    asrNote(overlay, `安装失败：${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/** 宿主的下载/解包是后台任务，页面只收事件；转写事件不属于设置窗，按 requestId 过滤 */
function watchAsr(overlay: HTMLElement): void {
  offAsrWatch?.()
  offAsrWatch = onAsrEvent((event) => {
    if (event.requestId !== asrRequest) return
    if (!overlay.isConnected) {
      stopAsrWatch()
      return
    }
    if (event.event === 'asrProgress') {
      const size = event.total > 0 ? `${formatBytes(event.bytes)} / ${formatBytes(event.total)}` : `${Math.max(0, event.percent)}%`
      asrNote(
        overlay,
        event.phase === 'resolve'
          ? '正在取网盘下载地址…'
          : event.phase === 'download'
            ? `正在下载语音模型… ${size}`
            : `正在解包校验… ${size}`,
      )
      return
    }
    if (event.event === 'asrError') {
      asrRequest = 0
      setAsrBusy(overlay, false)
      asrNote(overlay, `安装失败：${event.message}`, true)
      return
    }
    if (event.event === 'asrDone') {
      asrRequest = 0
      setAsrBusy(overlay, false)
      asrNote(overlay, event.cancelled ? '已取消下载' : '语音模型已就绪，可以开始会议了')
      void refreshAsrState(overlay)
    }
  })
}

function stopAsrWatch(): void {
  offAsrWatch?.()
  offAsrWatch = null
  if (asrRequest) asrCancel(asrRequest)
  asrRequest = 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
