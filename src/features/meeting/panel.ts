import { getSettings } from '../../core/settings'
import {
  isWebViewHost,
  openExternally,
  revealInExplorer,
  saveHostFile,
  type AsrSegment,
} from '../../core/file/webview'
import { showMessageModal } from '../../ui/modal'
import { analyzeTranscript, type AnalyzeProgress } from './analyze'
import {
  asrAudioClear,
  asrCancel,
  asrInstall,
  asrInstallFromZip,
  asrStatus,
  asrTranscribe,
  onAsrEvent,
  type AsrHostEvent,
  type AsrStatus,
} from './asr'
import { AudioStreamError, MeetingRecorder, sendFile } from './audio'
import { fromPlainText, fromSegments, formatDuration, type Transcript, type TranscriptSource } from './transcript'
import { renderMinutesMarkdown, renderReportHtml, type RenderMeta } from './render'
import { describeSelection } from '../../core/ai/providers'
import { nextMeetingKey, nextMeetingRequestId, type CheckIssue, type MeetingContext, type MeetingDigest } from './types'

/**
 * 会记面板：三条入口（现场录音 / 上传录音 / 导入转写文本）+ 转写 + 多轮分析 + 产物落地。
 *
 * 面板只做编排与展示，重活都在宿主：音频落盘、sherpa-onnx 转写、模型请求。
 * 页面里任何时刻最多只留一小段 PCM，两小时会议也不会把渲染进程顶爆。
 */

type View = 'home' | 'working' | 'finished' | 'failed'

const IMPORT_ACCEPT = '.txt,.md,.markdown,.srt,.vtt,.log'
const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.webm,.flac,.amr'

export function openMeetingModal(ctx: MeetingContext): void {
  if (document.querySelector('.modal--meeting')) return
  new MeetingPanel(ctx).mount()
}

class MeetingPanel {
  private overlay: HTMLElement | null = null
  private view: View = 'home'
  private status: AsrStatus = { ready: false, dir: '', version: 0, error: '', threads: 4 }
  private progress = { label: '', percent: -1, detail: '' }
  private error = ''
  private recorder: MeetingRecorder | null = null
  private recordKey = ''
  private recordTimer = 0
  private controller: AbortController | null = null
  private transcript: Transcript | null = null
  private sourceKind: TranscriptSource = 'mic'
  private reportPath = ''
  private closing = false
  /** 安装/转写的 requestId：面板只跟踪一个后台任务，取消按钮按它下发 */
  private backgroundRequest = 0
  private offAsrEvent: (() => void) | null = null
  private result: { minutesName: string; meta: RenderMeta; markdown: string; html: string } | null = null

  constructor(private readonly ctx: MeetingContext) {}

  // ---------- 挂载 ----------

  mount(): void {
    const overlay = document.createElement('div')
    overlay.className = 'modal modal--meeting'
    overlay.innerHTML = `<div class="modal__panel modal__panel--meeting" role="dialog" aria-modal="true" aria-label="会记"></div>`
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) void this.requestClose()
    })
    overlay.addEventListener('click', (event) => this.onAction(event.target as HTMLElement))
    overlay.addEventListener('change', (event) => void this.onChange(event.target as HTMLElement))
    this.overlay = overlay
    document.body.appendChild(overlay)
    this.render()

    this.offAsrEvent = onAsrEvent((event) => this.onAsr(event))
    if (this.ctx.desktop) {
      void asrStatus()
        .then((status) => {
          this.status = status
          if (this.view === 'home') this.render()
        })
        .catch(() => undefined)
    }
  }

  private unmount(): void {
    this.offAsrEvent?.()
    this.offAsrEvent = null
    window.clearInterval(this.recordTimer)
    this.overlay?.remove()
    this.overlay = null
  }

  /** 关掉面板时把没收尾的工作停掉：录音丢盘、后台任务取消 */
  private async requestClose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.recorder?.active) {
      const ok = await showMessageModal({
        title: '会议还在录制',
        message: '关闭会记面板会丢弃这次录音，且不会生成纪要。确定关闭吗？',
        confirmLabel: '丢弃并关闭',
      })
      if (!ok) {
        this.closing = false
        return
      }
      await this.recorder.discard().catch(() => undefined)
      this.recorder = null
    }
    if (this.backgroundRequest) asrCancel(this.backgroundRequest)
    this.controller?.abort()
    if (this.recordKey && !this.transcript) asrAudioClear(this.recordKey)
    this.unmount()
  }

  // ---------- 动作分发 ----------

  private onAction(target: HTMLElement): void {
    const button = target.closest<HTMLElement>('[data-mtg]')
    if (!button) {
      if (target.closest('[data-mtg-close]')) void this.requestClose()
      return
    }
    switch (button.dataset.mtg) {
      case 'close':
        void this.requestClose()
        break
      case 'install':
        void this.install()
        break
      case 'install-zip':
        void this.installFromZip()
        break
      case 'record':
        void this.startRecording()
        break
      case 'record-stop':
        void this.finishRecording()
        break
      case 'record-cancel':
        void this.cancelRecording()
        break
      case 'pick-audio':
        this.overlay?.querySelector<HTMLInputElement>('[data-role="audio-input"]')?.click()
        break
      case 'pick-text':
        this.overlay?.querySelector<HTMLInputElement>('[data-role="text-input"]')?.click()
        break
      case 'analyze':
        void this.analyze()
        break
      case 'cancel-task':
        this.cancelBackground()
        break
      case 'save-report':
        void this.saveReport()
        break
      case 'open-report':
        openExternally(this.reportPath)
        break
      case 'reveal-report':
        revealInExplorer(this.reportPath)
        break
      case 'retry':
        this.view = 'home'
        this.error = ''
        this.render()
        break
      default:
        break
    }
  }

  private onChange(target: HTMLElement): void {
    if (target.matches('[data-role="audio-input"]')) {
      const input = target as HTMLInputElement
      const file = input.files?.[0]
      input.value = ''
      if (file) void this.uploadAudio(file)
      return
    }
    if (target.matches('[data-role="text-input"]')) {
      const input = target as HTMLInputElement
      const file = input.files?.[0]
      input.value = ''
      if (file) void this.importText(file)
    }
  }

  // ---------- 模型包安装 ----------

  private async install(): Promise<void> {
    const url = getSettings().meeting.engineUrl.trim()
    if (!url) {
      this.fail('还没有配置模型包下载地址：请在「设置 → 会记」里填写，或用「从本地压缩包安装」。')
      return
    }
    this.beginBackground('正在下载语音模型…')
    try {
      await asrInstall(url, this.backgroundRequest)
    } catch (err) {
      this.fail(messageOf(err))
    }
  }

  private async installFromZip(): Promise<void> {
    this.beginBackground('正在从本地压缩包安装…')
    try {
      await asrInstallFromZip(this.backgroundRequest)
    } catch (err) {
      this.fail(messageOf(err))
    }
  }

  private beginBackground(label: string): void {
    this.backgroundRequest = nextMeetingRequestId()
    this.view = 'working'
    this.progress = { label, percent: -1, detail: '' }
    this.error = ''
    this.render()
  }

  private cancelBackground(): void {
    if (this.backgroundRequest) {
      asrCancel(this.backgroundRequest)
      this.backgroundRequest = 0
    }
    this.controller?.abort()
    this.progress = { label: '正在取消…', percent: this.progress.percent, detail: '' }
    this.render()
  }

  private onAsr(event: AsrHostEvent): void {
    if (event.requestId !== this.backgroundRequest) return

    if (event.event === 'asrProgress') {
      const speed = event.speed > 0 ? ` · ${formatRate(event.speed)}` : ''
      this.progress = {
        label:
          event.phase === 'resolve'
            ? '正在取网盘下载地址…'
            : event.phase === 'download'
              ? '正在下载语音模型…'
              : '正在解包校验…',
        percent: Math.max(0, event.percent),
        detail:
          event.phase === 'resolve'
            ? '分享链接换成文件直链，稍候'
            : event.phase === 'download' && event.total > 0
              ? `${formatBytes(event.bytes)} / ${formatBytes(event.total)}${speed}`
              : `${event.percent}%`,
      }
      this.render()
      return
    }

    if (event.event === 'asrSegments') {
      this.progress = {
        label: `正在转写第 ${event.chunk}/${event.chunks} 段…`,
        percent: event.percent,
        detail: `已出 ${event.segments.length} 句`,
      }
      this.render()
      return
    }

    if (event.event === 'asrError') {
      this.backgroundRequest = 0
      this.fail(event.message)
      return
    }

    if (event.event === 'asrDone') {
      this.backgroundRequest = 0
      if (event.cancelled) {
        this.view = 'home'
        this.render()
        return
      }
      if (event.ready) {
        void asrStatus()
          .then((status) => {
            this.status = status
          })
          .catch(() => undefined)
        this.ctx.notice('语音模型已就绪，可以开始会议了')
        this.view = 'home'
        this.render()
        return
      }
      void this.onTranscriptReady(toSegments(event.segments), event.seconds ?? 0)
    }
  }

  // ---------- 录音 ----------

  private async startRecording(): Promise<void> {
    if (!this.engineReady()) return
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('当前环境取不到麦克风，请确认系统权限后重试。')
      return
    }
    const key = nextMeetingKey()
    this.recordKey = key
    this.sourceKind = 'mic'
    this.transcript = null
    const recorder = new MeetingRecorder(
      key,
      (p) => {
        this.progress = { label: '会议录制中…', percent: -1, detail: `已写入 ${formatDuration(p.seconds)}` }
      },
      (message) => this.fail(`录音中断：${message}`),
    )
    try {
      await recorder.start()
    } catch (err) {
      this.recordKey = ''
      this.fail(
        err instanceof AudioStreamError || err instanceof Error
          ? `麦克风不可用：${messageOf(err)}`
          : '麦克风不可用',
      )
      return
    }
    this.recorder = recorder
    this.view = 'working'
    this.progress = { label: '会议录制中…', percent: -1, detail: '已录 00:00' }
    this.error = ''
    this.render()
    window.clearInterval(this.recordTimer)
    this.recordTimer = window.setInterval(() => {
      if (!this.recorder) return
      this.progress = {
        label: '会议录制中…',
        percent: -1,
        detail: `已录 ${clockOf(this.recorder.elapsedSeconds())} · 音频边录边写盘`,
      }
      this.refreshProgress()
    }, 1000)
  }

  private async cancelRecording(): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    window.clearInterval(this.recordTimer)
    await recorder?.discard().catch(() => undefined)
    if (this.recordKey) asrAudioClear(this.recordKey)
    this.recordKey = ''
    this.view = 'home'
    this.render()
  }

  private async finishRecording(): Promise<void> {
    const recorder = this.recorder
    if (!recorder) return
    this.recorder = null
    window.clearInterval(this.recordTimer)
    this.progress = { label: '正在收尾并保存录音…', percent: -1, detail: '' }
    this.view = 'working'
    this.render()
    let seconds = 0
    try {
      seconds = await recorder.stop()
    } catch (err) {
      this.fail(`录音保存失败：${messageOf(err)}`)
      return
    }
    if (seconds < 3) {
      if (this.recordKey) asrAudioClear(this.recordKey)
      this.recordKey = ''
      this.view = 'home'
      this.render()
      this.ctx.notice('录音太短（不足 3 秒），没有保存')
      return
    }
    await this.transcribe(this.recordKey, seconds)
  }

  // ---------- 上传录音 ----------

  private async uploadAudio(file: File): Promise<void> {
    if (!this.engineReady()) return
    const key = nextMeetingKey()
    this.recordKey = key
    this.sourceKind = 'upload'
    this.view = 'working'
    this.progress = { label: `正在解码 ${escapeText(file.name)}…`, percent: -1, detail: '大文件解码需要一点时间' }
    this.error = ''
    this.render()
    try {
      const seconds = await sendFile(key, file)
      if (seconds < 3) throw new AudioStreamError('这段音频不足 3 秒，没有可分析的内容')
      await this.transcribe(key, seconds)
    } catch (err) {
      asrAudioClear(key)
      this.recordKey = ''
      this.fail(messageOf(err))
    }
  }

  private async transcribe(key: string, seconds: number): Promise<void> {
    const threads = getSettings().meeting.threads || this.status.threads
    this.beginBackground('正在本地转写…')
    this.progress = { label: '正在本地转写…', percent: 0, detail: formatDuration(seconds) }
    this.transcript = fromSegments([], seconds, this.sourceKind)
    try {
      await asrTranscribe(key, this.backgroundRequest, threads)
    } catch (err) {
      this.backgroundRequest = 0
      this.fail(messageOf(err))
    }
  }

  /** 转写完成：拿到片段后先让用户看一眼，再决定要不要发给模型 */
  private async onTranscriptReady(segments: AsrSegment[], seconds: number): Promise<void> {
    if (segments.length === 0) {
      this.fail('转写没有识别到任何语音：可能是静音，或录音设备没有采到声音。')
      return
    }
    this.transcript = fromSegments(segments, seconds, this.sourceKind)
    if (this.recordKey) asrAudioClear(this.recordKey)
    this.recordKey = ''
    await this.analyze()
  }

  // ---------- 导入转写文本 ----------

  private async importText(file: File): Promise<void> {
    this.view = 'working'
    this.progress = { label: `正在读取 ${escapeText(file.name)}…`, percent: -1, detail: '' }
    this.error = ''
    this.render()
    try {
      const text = await file.text()
      this.transcript = fromPlainText(file.name, text)
      await this.analyze()
    } catch (err) {
      this.fail(messageOf(err))
    }
  }

  // ---------- 分析与产物 ----------

  private async analyze(): Promise<void> {
    const transcript = this.transcript
    if (!transcript || transcript.segments.length === 0) {
      this.fail('还没有可分析的会议内容。')
      return
    }
    if (!(await this.ctx.ensureAiUsable())) {
      this.view = 'home'
      this.render()
      return
    }
    const controller = new AbortController()
    this.controller = controller
    this.view = 'working'
    this.progress = { label: '正在准备分析…', percent: 0, detail: `${transcript.segments.length} 段转写` }
    this.error = ''
    this.render()

    try {
      const outcome = await analyzeTranscript(
        transcript,
        this.ctx.readDocument(),
        controller.signal,
        (p: AnalyzeProgress) => {
          this.progress = { label: p.status, percent: p.percent, detail: p.detail }
          this.render()
        },
      )
      if (controller.signal.aborted) {
        this.view = 'home'
        this.render()
        return
      }
      const meta = this.metaOf(outcome.digest, outcome.rounds, outcome.issues)
      const markdown = renderMinutesMarkdown(outcome.digest, meta)
      const html = renderReportHtml(outcome.digest, meta)
      const minutesName = minutesFileName(meta.title)
      this.result = { minutesName, meta, markdown, html }
      this.ctx.openMinutes(markdown, minutesName)
      this.view = 'finished'
      this.progress = { label: '纪要已打开，报告待保存', percent: 100, detail: '' }
      this.render()
      await this.saveReport()
    } catch (err) {
      this.fail(messageOf(err))
    } finally {
      this.controller = null
    }
  }

  private metaOf(
    digest: MeetingDigest,
    rounds: number,
    issues: CheckIssue[],
  ): RenderMeta {
    const transcript = this.transcript
    const doc = this.ctx.readDocument()
    const settings = getSettings()
    const title = digest.info.find((item) => item.label.includes('主题'))?.value?.trim() || docBase(doc.name) || '会议'
    return {
      title,
      generatedAt: formatLocal(new Date()),
      transcript: transcript ?? fromSegments([], 0, this.sourceKind),
      docName: doc.name,
      model: describeSelection(settings.ai),
      rounds,
      issues,
    }
  }

  private async saveReport(): Promise<void> {
    if (!this.result) return
    if (!isWebViewHost()) {
      this.ctx.notice('浏览器版不能直接写盘，请在纪要标签页里用「导出 → HTML」保存报告')
      return
    }
    try {
      const path = await saveHostFile(this.result.html, `${reportBase(this.result.meta.title)}.html`, 'html')
      if (!path) {
        this.progress = { ...this.progress, label: '纪要已打开；报告未保存（可再点一次）' }
        this.render()
        return
      }
      this.reportPath = path
      this.progress = { label: `报告已保存：${path}`, percent: 100, detail: '' }
      openExternally(path)
      this.render()
    } catch (err) {
      this.progress = { ...this.progress, label: `报告保存失败：${messageOf(err)}` }
      this.render()
    }
  }

  // ---------- 状态与绘制 ----------

  private engineReady(): boolean {
    if (!this.ctx.desktop || !isWebViewHost()) {
      this.fail('会记的录音与转写只在桌面版 mdreader 里可用；浏览器版请用「导入转写文本」。')
      return false
    }
    if (this.status.ready) return true
    this.fail(
      `还没有安装本地语音模型（约 250 MB，只下载一次）。在「设置 → 会记」里填好下载地址后点「下载语音模型」，` +
        '或者把模型包拷到本机用「从本地压缩包安装」。',
    )
    return false
  }

  private fail(message: string): void {
    this.error = message
    this.view = 'failed'
    this.render()
  }

  private render(): void {
    const panel = this.overlay?.querySelector<HTMLElement>('.modal__panel--meeting')
    if (!panel) return
    panel.innerHTML = `
      <div class="modal__head">
        <span class="modal__title">会记</span>
        <span class="meeting__engine${this.status.ready ? ' is-ready' : ''}">${engineLabel(this.ctx, this.status)}</span>
        <button class="btn btn--small" data-mtg-close>关闭</button>
      </div>
      <div class="modal__body meeting__body">${this.bodyHtml()}</div>
    `
    this.refreshProgress()
  }

  /** 只改进度文案，不重建 DOM：录音期间定时器每秒都要动，重建会把文件输入框焦点打掉 */
  private refreshProgress(): void {
    const label = this.overlay?.querySelector<HTMLElement>('[data-role="progress-label"]')
    if (!label) return
    label.textContent = this.progress.label
    const detail = this.overlay?.querySelector<HTMLElement>('[data-role="progress-detail"]')
    if (detail) detail.textContent = this.progress.detail
    const bar = this.overlay?.querySelector<HTMLElement>('[data-role="progress-bar"]')
    if (bar) {
      const percent = this.progress.percent < 0 ? 100 : this.progress.percent
      bar.style.width = `${Math.min(100, Math.max(2, percent))}%`
      bar.parentElement?.classList.toggle('is-indeterminate', this.progress.percent < 0)
    }
  }

  private bodyHtml(): string {
    if (this.view === 'working') {
      return `
        <div class="meeting__progress">
          <div class="meeting__bar"><i data-role="progress-bar"></i></div>
          <div class="meeting__line" data-role="progress-label">${escapeText(this.progress.label)}</div>
          <div class="meeting__detail" data-role="progress-detail">${escapeText(this.progress.detail)}</div>
          <div class="meeting__actions">
            ${this.recorder?.active ? `
              <button class="btn btn--primary" data-mtg="record-stop">结束会议并分析</button>
              <button class="btn" data-mtg="record-cancel">丢弃这次录音</button>
            ` : `
              <button class="btn" data-mtg="cancel-task">取消</button>
            `}
          </div>
        </div>`
    }

    if (this.view === 'finished') {
      return `
        <div class="meeting__done">
          <p class="meeting__ok">会议纪要已在新标签页打开，可以继续编辑。</p>
          <div class="meeting__line" data-role="progress-label">${escapeText(this.progress.label)}</div>
          <div class="meeting__detail">${escapeText(this.progress.detail)}</div>
          <div class="meeting__actions">
            ${this.reportPath ? `
              <button class="btn btn--primary" data-mtg="open-report">打开报告</button>
              <button class="btn" data-mtg="reveal-report">在文件夹中显示</button>
            ` : `<button class="btn btn--primary" data-mtg="save-report">保存 HTML 报告</button>`}
            <button class="btn" data-mtg="close">完成</button>
          </div>
        </div>`
    }

    if (this.view === 'failed') {
      return `
        <div class="meeting__error">
          <p>${escapeText(this.error)}</p>
          <div class="meeting__actions">
            <button class="btn btn--primary" data-mtg="retry">返回</button>
            <button class="btn" data-mtg="close">关闭</button>
          </div>
        </div>`
    }

    return this.homeHtml()
  }

  private homeHtml(): string {
    const desktop = this.ctx.desktop && isWebViewHost()
    const installCard =
      desktop && !this.status.ready
        ? `<div class="meeting__install">
            <div class="meeting__install-text">
              还没有本地语音模型。模型（SenseVoice（FunASR）+ Silero VAD，约 250 MB）从内网网盘下载到本机，之后录音与转写全程离线、音频不出这台机器；各组件许可随包存在模型目录的 licenses 下。
              网盘地址取不到时，可在「设置 → 会记」改地址，或用「从本地压缩包安装」。
            </div>
            <div class="meeting__actions">
              <button class="btn btn--primary" data-mtg="install">下载语音模型</button>
              <button class="btn" data-mtg="install-zip">从本地压缩包安装</button>
            </div>
          </div>`
        : ''

    return `
      <p class="meeting__notice">录音前请确认已征得与会人同意。录音与转写都发生在这台机器上，只有分析用的文字会发给你配置的模型。</p>
      ${installCard}
      <div class="meeting__entries">
        <button class="meeting__entry" data-mtg="record" ${desktop && this.status.ready ? '' : 'disabled'}>
          <span class="meeting__entry-title">开始会议</span>
          <span class="meeting__entry-hint">${
            desktop ? (this.status.ready ? '开麦录制，结束后本地转写并分析' : '需要先安装语音模型') : '浏览器版不能录音，请用导入转写文本'
          }</span>
        </button>
        <label class="meeting__entry">
          <input type="file" accept="${AUDIO_ACCEPT}" data-role="audio-input" hidden />
          <span class="meeting__entry-title">上传录音</span>
          <span class="meeting__entry-hint">${
            desktop ? 'mp3 / wav / m4a / ogg / webm，120 MB 以内' : '需要桌面版做本地转写'
          }</span>
        </label>
        <label class="meeting__entry">
          <input type="file" accept="${IMPORT_ACCEPT}" data-role="text-input" hidden />
          <span class="meeting__entry-title">导入转写文本</span>
          <span class="meeting__entry-hint">已有文字稿（txt / md / srt / vtt）直接分析，任何版本可用</span>
        </label>
      </div>
      <p class="meeting__hint">纪要与报告都会综合你当前这篇文档：议程、术语表、在写的材料都算进去，模型不会另编内容。</p>
    `
  }
}

// ---------- 小工具 ----------

function engineLabel(ctx: MeetingContext, status: AsrStatus): string {
  if (!ctx.desktop || !isWebViewHost()) return '浏览器版：仅导入文本'
  return status.ready ? `语音模型 v${status.version} 已就绪` : '语音模型未安装'
}

function toSegments(segments: AsrSegment[] | undefined): AsrSegment[] {
  if (!Array.isArray(segments)) return []
  return segments.map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: typeof s.text === 'string' ? s.text : '',
  }))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

function clockOf(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function docBase(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '').trim()
}

function minutesFileName(title: string): string {
  const day = new Date().toISOString().slice(0, 10)
  const short = title.replace(/[\\/:*?"<>|]/g, '·').replace(/\s+/g, ' ').trim().slice(0, 24)
  return `会议纪要 ${short} ${day}.md`.replace(/\s+/g, ' ').trim()
}

function reportBase(title: string): string {
  const day = new Date().toISOString().slice(0, 10)
  return `会议总结报告 ${title}`.replace(/[\\/:*?"<>|]/g, '·').replace(/\s+/g, ' ').slice(0, 60) + ` ${day}`
}

function formatLocal(date: Date): string {
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
