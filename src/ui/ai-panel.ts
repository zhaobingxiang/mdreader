import type { AiSessionState } from '../core/ai/session'
import { escapeHtml } from '../render/util'

/**
 * 底部 AI 面板的渲染。
 * 每次状态变化整体重绘会话区：消息量很小（一次会话几十条），
 * 换来实现简单可靠；流式增量由宿主 40ms 合并一次，不会造成肉眼可见的抖动。
 */

export interface AiPanelParts {
  conv: HTMLElement
  providerPick: HTMLSelectElement
  modelPick: HTMLSelectElement
  status: HTMLElement
  stop: HTMLElement
  optimize: HTMLElement
  input: HTMLTextAreaElement
}

export interface AiPanelView {
  state: AiSessionState
  /** 可切换的平台（内置平台固定三个） */
  providers: { id: string; label: string }[]
  activeProvider: string
  /** 当前平台下用户已添加的模型 */
  models: string[]
  activeModel: string
  configured: boolean
  inDesktop: boolean
  /** 提案生成后文档被改过 */
  proposalStale: boolean
}

const PLACEHOLDER = '告诉 AI 怎么改这份文档，或直接提问…'
const PLACEHOLDER_ASK = '回答上面的问题，回车发送…'

export function renderAiPanel(parts: AiPanelParts, view: AiPanelView): void {
  const { state } = view
  const running = state.phase === 'running'

  renderPicks(parts, view)
  parts.status.textContent = state.status
  parts.stop.hidden = !running
  parts.optimize.hidden = running
  parts.optimize.textContent = state.turns.length > 0 ? '重新优化' : '自动优化'
  parts.input.placeholder = state.phase === 'awaiting' ? PLACEHOLDER_ASK : PLACEHOLDER

  const conv = parts.conv
  const nearBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 48
  const firstRender = conv.dataset.rendered !== '1'
  conv.dataset.rendered = '1'
  conv.innerHTML = renderBody(view)
  if (nearBottom || firstRender || running) {
    conv.scrollTop = conv.scrollHeight
  }
}

/**
 * 头部两个下拉：选项只在内容变化时重建，避免流式刷新时把用户正在开的
 * 原生下拉关掉；未添加模型时留一条「去设置添加」占位项。
 */
function renderPicks(parts: AiPanelParts, view: AiPanelView): void {
  const provider = parts.providerPick
  const providerKey = view.providers.map((p) => p.id).join('\u0000')
  if (provider.dataset.key !== providerKey) {
    provider.innerHTML = view.providers
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      .join('')
    provider.dataset.key = providerKey
  }
  const locked = !view.inDesktop || view.state.phase === 'running'
  provider.disabled = locked
  if (provider.value !== view.activeProvider) provider.value = view.activeProvider

  const model = parts.modelPick
  const options = view.models.length > 0 ? view.models : ['']
  const modelKey = options.join('\u0000')
  if (model.dataset.key !== modelKey) {
    model.innerHTML =
      view.models.length > 0
        ? view.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
        : '<option value="">去设置添加模型</option>'
    model.dataset.key = modelKey
  }
  model.disabled = locked || view.models.length === 0
  model.classList.toggle('is-empty', view.models.length === 0)
  model.classList.toggle('is-warn', !view.configured && view.models.length > 0)
  if (view.models.length > 0 && model.value !== view.activeModel) model.value = view.activeModel
}

function renderBody(view: AiPanelView): string {
  const { state } = view
  const blocks: string[] = []

  if (!view.inDesktop) {
    blocks.push(
      infoCard('AI 优化需要在桌面版 mdreader 里使用', '浏览器预览没有宿主侧的网络与密钥能力。'),
    )
  } else if (!view.configured) {
    blocks.push(
      `<div class="ai-empty">
<div class="ai-empty__title">还没有选择模型</div>
<div class="ai-empty__text">在设置里选择 Lanz / MaaS 平台并填写 API Key，之后就能让 AI 通读全文、按你的方向改写。</div>
<button type="button" class="btn btn--small btn--primary" data-action="settings">打开设置</button>
</div>`,
    )
  } else if (state.turns.length === 0 && !state.ask && !state.proposal && state.phase !== 'running') {
    blocks.push(
      `<div class="ai-empty">
<div class="ai-empty__title">让 AI 帮你把这份文档写清楚</div>
<div class="ai-empty__text">点「自动优化」通读全文，改格式与表述；也可以在下面直接说要求，比如「把安装步骤改成分步清单」「语气改成面向运维的说明」。改动会先给出差异，由你决定是否应用。</div>
</div>`,
    )
  }

  for (const turn of state.turns) {
    blocks.push(
      `<div class="ai-turn ai-turn--${turn.role}"><div class="ai-bubble">${escapeHtml(turn.text)}</div></div>`,
    )
  }

  if (state.phase === 'running') {
    const stream = state.stream
    const think = stream.reasoning
      ? `<details class="ai-think" open><summary>思考过程</summary><pre>${escapeHtml(stream.reasoning)}</pre></details>`
      : ''
    const retry = stream.retryNote
      ? `<div class="ai-live__retry">${escapeHtml(stream.retryNote)}</div>`
      : ''
    const body = stream.content
      ? `<div class="ai-live__body">${escapeHtml(stream.content)}<span class="ai-live__caret"></span></div>`
      : ''
    blocks.push(
      `<div class="ai-live">
<div class="ai-live__head"><span class="spinner"></span><span>${escapeHtml(state.status || '正在思考…')}</span></div>
${retry}${think}${body}
</div>`,
    )
  }

  if (state.ask) {
    const options = state.ask.options
      .map(
        (text, index) =>
          `<button type="button" class="ai-ask__opt" data-action="ai-option" data-ai-option="${index}">${escapeHtml(text)}</button>`,
      )
      .join('')
    blocks.push(
      `<div class="ai-ask">
<div class="ai-ask__q">${escapeHtml(state.ask.question)}</div>
${options ? `<div class="ai-ask__opts">${options}</div>` : ''}
<div class="ai-ask__hint">在下面输入回答，或点上面的选项</div>
</div>`,
    )
  }

  if (state.proposal) {
    const lines = state.proposal.markdown.split('\n').length
    const chars = state.proposal.markdown.length
    blocks.push(
      `<div class="ai-proposal${view.proposalStale ? ' is-stale' : ''}">
<div class="ai-proposal__head">
<span class="ai-proposal__title">${escapeHtml(state.proposal.title)}</span>
<span class="ai-proposal__meta">${lines} 行 · ${chars} 字符</span>
</div>
${view.proposalStale ? '<div class="ai-proposal__stale">文档已改动，这份稿子基于旧内容，建议重新优化</div>' : ''}
<div class="ai-proposal__actions">
<button type="button" class="btn btn--small btn--primary" data-action="ai-apply"${view.proposalStale ? ' disabled' : ''}>应用</button>
<button type="button" class="btn btn--small" data-action="ai-diff">查看差异</button>
<button type="button" class="btn btn--small" data-action="ai-discard">丢弃</button>
</div>
</div>`,
    )
  }

  if (state.error) {
    blocks.push(`<div class="ai-error">${escapeHtml(state.error)}</div>`)
  }

  if (state.truncated && state.phase === 'running') {
    blocks.push('<div class="ai-note">文档过长，这次只送去了前面一部分</div>')
  }

  if (state.usage?.total_tokens) {
    blocks.push(`<div class="ai-note">本次消耗 ${state.usage.total_tokens} tokens</div>`)
  }

  return blocks.join('')
}

function infoCard(title: string, text: string): string {
  return `<div class="ai-empty">
<div class="ai-empty__title">${escapeHtml(title)}</div>
<div class="ai-empty__text">${escapeHtml(text)}</div>
</div>`
}
