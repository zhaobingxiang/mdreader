import { escapeHtml } from '../../render/util'
import { formatDuration, transcriptText, type Transcript, type TranscriptSource } from './transcript'
import type { CheckIssue, MeetingDigest, MinutesRow } from './types'

/**
 * 会记的两份产物：Markdown 纪要（表格为主，进标签页继续编辑）和
 * 单文件 HTML 总结报告（落盘，直接发给没装 mdreader 的人）。
 *
 * 表格与页面结构由代码拼，模型只给字段——让模型自己写 Markdown 表格
 * 十次里有一次列数对不齐，渲染层不该赌这件事。
 */

export interface RenderMeta {
  title: string
  /** 生成时刻，本地时区 */
  generatedAt: string
  transcript: Transcript
  /** 用户在 mdreader 里的那份文档名，报告里注明参考了它 */
  docName: string
  model: string
  rounds: number
  issues: CheckIssue[]
}

const SOURCE_LABEL: Record<TranscriptSource, string> = {
  mic: '会记现场录音',
  upload: '上传的录音文件',
  import: '导入的转写文本',
}

// ---------- Markdown 纪要 ----------

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim() || '—'
}

function refCell(row: MinutesRow): string {
  return row.refs.length > 0 ? row.refs.map((r) => `\`${r}\``).join(' ') : '—'
}

function markUncertain(row: MinutesRow, text: string): string {
  return row.uncertain ? `${text}（存疑）` : text
}

function rowTable(rows: MinutesRow[], columns: string[]): string {
  if (rows.length === 0) return '_本次没有记录到相关内容。_\n'
  const header = `| # | ${columns.join(' | ')} |\n| --- | ${columns.map(() => '---').join(' | ')} |`
  const body = rows
    .map((row, index) => {
      const cells = tableCells(row, columns)
      return `| ${index + 1} | ${cells.map(cell).join(' | ')} |`
    })
    .join('\n')
  return `${header}\n${body}\n`
}

/** 行动项多两列（负责人 / 完成时间），其余表统一是「标题 · 要点 · 依据」 */
function tableCells(row: MinutesRow, columns: string[]): string[] {
  if (columns.includes('负责人')) {
    return [markUncertain(row, row.title), row.detail, row.owner || '—', row.due || '—', refCell(row)]
  }
  return [markUncertain(row, row.title), row.detail, refCell(row)]
}

export function renderMinutesMarkdown(digest: MeetingDigest, meta: RenderMeta): string {
  const { transcript } = meta
  const parts: string[] = []

  parts.push(`# 会议纪要：${meta.title}\n`)
  parts.push(
    `> 由 mdreader 会记生成 · ${meta.generatedAt} · 来源：${SOURCE_LABEL[transcript.source]}${
      transcript.seconds > 0 ? `（${formatDuration(transcript.seconds)}）` : ''
    } · 分析模型：${meta.model}（${meta.rounds} 轮）\n`,
  )

  const uncertain = countUncertain(digest)
  if (uncertain > 0 || digest.terms.length > 0) {
    parts.push(
      `> [!warning] 转写稿由本地语音识别生成，可能存在同音字与专名错误。` +
        `本次有 ${uncertain} 条内容被标为「存疑」，${digest.terms.length > 0 ? `另有 ${digest.terms.length} 个用词待核对` : '未发现可疑用词'}。请先人工核对再对外发出。\n`,
    )
  }

  if (digest.info.length > 0) {
    parts.push('## 会议信息\n')
    parts.push(
      `| 项目 | 内容 |\n| --- | --- |\n${digest.info
        .map((item) => `| ${cell(item.label)} | ${cell(item.uncertain ? `${item.value}（存疑）` : item.value)} |`)
        .join('\n')}\n`,
    )
  }

  if (digest.summary.length > 0) {
    parts.push('## 摘要\n')
    parts.push(`${digest.summary.map((line) => `- ${line}`).join('\n')}\n`)
  }

  parts.push('## 议题与讨论\n')
  parts.push(rowTable(digest.topics, ['议题', '讨论要点', '依据']))

  parts.push('## 决议\n')
  parts.push(rowTable(digest.decisions, ['议题', '讨论要点', '依据']))

  parts.push('## 行动项\n')
  parts.push(rowTable(digest.actions, ['事项', '内容', '负责人', '完成时间', '时间戳']))

  if (digest.risks.length > 0) {
    parts.push('## 风险与阻塞\n')
    parts.push(rowTable(digest.risks, ['风险 / 问题', '说明', '依据']))
  }

  if (digest.openQuestions.length > 0) {
    parts.push('## 待确认问题\n')
    parts.push(`${digest.openQuestions.map((line) => `- [ ] ${line}`).join('\n')}\n`)
  }

  if (digest.timeline.length > 0) {
    parts.push('## 时间线\n')
    parts.push(
      `| 时间 | 事件 |\n| --- | --- |\n${digest.timeline
        .map((event) => `| ${cell(event.time || '—')} | ${cell(event.text)} |`)
        .join('\n')}\n`,
    )
  }

  if (digest.terms.length > 0) {
    parts.push('## 存疑用词\n')
    parts.push(
      `| 词 | 疑点 |\n| --- | --- |\n${digest.terms
        .map((term) => `| ${cell(term.word)} | ${cell(term.note)} |`)
        .join('\n')}\n`,
    )
  }

  if (meta.issues.length > 0) {
    parts.push('## 内容检查结论\n')
    parts.push(
      `${meta.issues
        .map((issue) => `- **${issue.where}**：${issue.problem}${issue.fix ? ` → ${issue.fix}` : ''}`)
        .join('\n')}\n`,
    )
  }

  parts.push('## 转写原文\n')
  parts.push(
    transcript.timed
      ? '下面的时间戳是相对录音开始的秒数，可回到录音里核对原话。\n'
      : '导入的文本稿没有时间戳，以下按段落原样列出。\n',
  )
  parts.push(`\`\`\`text\n${transcriptText(transcript)}\n\`\`\`\n`)

  return parts.join('\n')
}

function countUncertain(digest: MeetingDigest): number {
  return [...digest.topics, ...digest.decisions, ...digest.actions, ...digest.risks].filter(
    (row) => row.uncertain,
  ).length
}

// ---------- HTML 报告 ----------

const REPORT_CSS = `
:root {
  --fg:#1c1e21; --dim:#5b6470; --line:#e2e6ea; --bg:#f6f7f9; --card:#fff;
  --accent:#2f6fed; --warn:#b45309; --warn-bg:#fff7ed; --ok:#0f766e;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:16px; line-height:1.75; }
.wrap { max-width:900px; margin:0 auto; padding:40px 24px 96px; }
header.rpt { border-left:4px solid var(--accent); padding-left:16px; margin-bottom:28px; }
header.rpt h1 { margin:0 0 6px; font-size:26px; line-height:1.35; }
header.rpt .meta { color:var(--dim); font-size:13px; }
.notice { background:var(--warn-bg); border:1px solid #fdba74; color:var(--warn);
  border-radius:10px; padding:12px 16px; font-size:14px; margin-bottom:24px; }
h2 { font-size:19px; margin:34px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:18px; }
ul.kv { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:110px 1fr; gap:6px 14px; }
ul.kv li:nth-child(odd) { color:var(--dim); }
ol.summary { margin:0; padding-left:1.4em; }
ol.summary li { margin:.4em 0; }
table { width:100%; border-collapse:collapse; font-size:14.5px; }
th,td { border:1px solid var(--line); padding:8px 11px; text-align:left; vertical-align:top; }
th { background:#f0f3f7; font-weight:600; white-space:nowrap; }
td .refs, td.refs { color:var(--dim); font-size:12.5px; }
td.refs { white-space:nowrap; }
.empty { color:var(--dim); font-size:14px; }
.tag { display:inline-block; font-size:12px; padding:1px 7px; border-radius:999px;
  background:#eef2ff; color:var(--accent); margin-left:6px; vertical-align:1px; }
.tag--warn { background:var(--warn-bg); color:var(--warn); }
section.p { margin:0 0 14px; }
section.p h3 { font-size:16px; margin:0 0 6px; }
section.p p { margin:0 0 .6em; }
dl.timeline { margin:0; padding:0; }
dl.timeline dt { font-variant-numeric:tabular-nums; color:var(--dim); font-size:13px; margin-top:10px; }
dl.timeline dd { margin:2px 0 0; font-size:14.5px; }
details { margin-top:10px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
details summary { cursor:pointer; padding:10px 14px; font-size:14px; color:var(--dim); }
pre.raw { margin:0; padding:14px 16px; border-top:1px solid var(--line);
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; white-space:pre-wrap; word-break:break-word; }
footer.rpt { margin-top:34px; color:var(--dim); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px; }
@media print { body { background:#fff; } .wrap { max-width:none; padding:0; } }
`

function refsHtml(row: MinutesRow): string {
  return row.refs.length > 0 ? row.refs.join(' ') : '—'
}

function rowTableHtml(rows: MinutesRow[], columns: string[]): string {
  if (rows.length === 0) return '<p class="empty">本次没有记录到相关内容。</p>'
  const withRefs = new Set(['依据', '时间戳'])
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
  const body = rows
    .map((row) => {
      const cells = columns.includes('负责人')
        ? [row.title, row.detail, row.owner || '—', row.due || '—', refsHtml(row)]
        : [row.title, row.detail, refsHtml(row)]
      return `<tr>${cells
        .map((value, index) => {
          const safe = escapeHtml(value)
          const content = index === 0 && row.uncertain ? `${safe}<span class="tag tag--warn">存疑</span>` : safe
          return `<td class="${withRefs.has(columns[index] ?? '') ? 'refs' : ''}">${content}</td>`
        })
        .join('')}</tr>`
    })
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

export function renderReportHtml(digest: MeetingDigest, meta: RenderMeta): string {
  const { transcript } = meta
  const uncertain = countUncertain(digest)
  const blocks: string[] = []

  if (uncertain > 0 || digest.terms.length > 0) {
    blocks.push(
      `<div class="notice">本报告依据本地语音识别的转写稿生成，可能存在同音字与专名错误。` +
        `标「存疑」的条目共 ${uncertain} 条${digest.terms.length > 0 ? `，待核对用词 ${digest.terms.length} 个` : ''}，` +
        `对外发出前请人工确认。</div>`,
    )
  }

  if (digest.info.length > 0) {
    blocks.push(
      `<h2>会议信息</h2><div class="card"><ul class="kv">${digest.info
        .map(
          (item) =>
            `<li>${escapeHtml(item.label)}</li><li>${escapeHtml(item.value)}${
              item.uncertain ? '<span class="tag tag--warn">存疑</span>' : ''
            }</li>`,
        )
        .join('')}</ul></div>`,
    )
  }

  if (digest.summary.length > 0) {
    blocks.push(
      `<h2>结论摘要</h2><div class="card"><ol class="summary">${digest.summary
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ol></div>`,
    )
  }

  blocks.push(`<h2>议题纪要</h2>${rowTableHtml(digest.topics, ['议题', '讨论要点', '依据'])}`)
  blocks.push(`<h2>决议</h2>${rowTableHtml(digest.decisions, ['议题', '讨论要点', '依据'])}`)
  blocks.push(`<h2>行动项</h2>${rowTableHtml(digest.actions, ['事项', '内容', '负责人', '完成时间', '时间戳'])}`)

  if (digest.risks.length > 0) {
    blocks.push(`<h2>风险与阻塞</h2>${rowTableHtml(digest.risks, ['风险 / 问题', '说明', '依据'])}`)
  }

  if (digest.report.length > 0) {
    const sections = digest.report
      .map(
        (section) =>
          `<section class="card p"><h3>${escapeHtml(section.heading)}</h3>${section.paragraphs
            .map((p) => `<p>${escapeHtml(p)}</p>`)
            .join('')}</section>`,
      )
      .join('')
    blocks.push(`<h2>总结</h2>${sections}`)
  }

  if (digest.openQuestions.length > 0) {
    blocks.push(
      `<h2>待确认问题</h2><div class="card"><ol class="summary">${digest.openQuestions
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ol></div>`,
    )
  }

  if (digest.timeline.length > 0) {
    blocks.push(
      `<h2>时间线</h2><div class="card"><dl class="timeline">${digest.timeline
        .map((event) => `<dt>${escapeHtml(event.time || '未计时')}</dt><dd>${escapeHtml(event.text)}</dd>`)
        .join('')}</dl></div>`,
    )
  }

  if (digest.terms.length > 0) {
    blocks.push(
      `<h2>存疑用词</h2>${rowTableHtml(
        digest.terms.map((term) => ({
          title: term.word,
          detail: term.note,
          owner: '',
          due: '',
          refs: [],
          uncertain: true,
        })),
        ['词', '疑点', '依据'],
      )}`,
    )
  }

  if (meta.issues.length > 0) {
    blocks.push(
      `<h2>内容检查</h2><div class="card"><ol class="summary">${meta.issues
        .map(
          (issue) =>
            `<li><strong>${escapeHtml(issue.where)}</strong>：${escapeHtml(issue.problem)}${
              issue.fix ? ` → ${escapeHtml(issue.fix)}` : ''
            }</li>`,
        )
        .join('')}</ol></div>`,
    )
  }

  const raw = transcriptText(transcript)
  blocks.push(
    `<details><summary>附：转写原文（${transcript.segments.length} 段${
      transcript.timed ? '，时间戳为相对录音开始的时刻' : ''
    }）</summary><pre class="raw">${escapeHtml(raw)}</pre></details>`,
  )

  const metaLine = [
    `生成时间 ${escapeHtml(meta.generatedAt)}`,
    `来源 ${escapeHtml(SOURCE_LABEL[transcript.source])}${
      transcript.seconds > 0 ? `（${escapeHtml(formatDuration(transcript.seconds))}）` : ''
    }`,
    `分析模型 ${escapeHtml(meta.model)} · ${meta.rounds} 轮`,
    meta.docName ? `参考文档 ${escapeHtml(meta.docName)}` : '',
  ]
    .filter((item) => item !== '')
    .join(' ｜ ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(meta.title)} · 会议总结报告</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="rpt">
<h1>${escapeHtml(meta.title)}</h1>
<div class="meta">${metaLine}</div>
</header>
${blocks.join('\n')}
<footer class="rpt">本文由 mdreader 会记生成。纪要与结论均取自会议转写与上面的参考文档，未补充任何材料之外的信息。</footer>
</div>
</body>
</html>`
}
