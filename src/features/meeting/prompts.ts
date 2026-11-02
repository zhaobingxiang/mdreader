import type { AiToolSpec } from '../../core/ai/types'
import { MAX_DOC_CHARS } from '../../core/ai/prompts'
import { formatDuration, transcriptText, type Transcript } from './transcript'
import type { MeetingDocContext } from './types'

/**
 * 会记各轮的提示词与 JSON 结构约定。
 *
 * 每轮都挂一个 emit_* 工具，把「要什么结构」写进 schema：
 * 比在正文里口头约定 JSON 稳得多，小模型也照着字段填。
 */

/**
 * 抽取轮一段转写最多这么多字。
 * 上限压太狠会让模型一轮说不完（输出被长度上限截断），整条链只能重新切细；
 * 2500 字实测一轮能出完整 JSON，长会议靠多段而不是大段。
 */
export const MAX_TRANSCRIPT_CHARS_PER_WINDOW = 2_500

/**
 * 归并/检查轮要一次看到全稿，但两小时会议的转写有 4 万字以上。
 * 超预算时保头尾（开场定调、收尾分工最重要），中段用抽取轮的结果兜底。
 */
export const MAX_FULL_TRANSCRIPT_CHARS = 40_000

const ROW_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一句话概括，不超过 30 字' },
      detail: { type: 'string', description: '具体说明，保留原话里的数字、名称、条件' },
      owner: { type: 'string', description: '负责人；转写里没提到就留空' },
      due: { type: 'string', description: '时间要求；转写里没提到就留空' },
      refs: { type: 'array', items: { type: 'string' }, description: '依据的时间戳，如 ["00:12:30"]；没有时间就留空数组' },
      uncertain: { type: 'boolean', description: '内容有歧义、疑似同音字错误或信息不全时置为 true' },
    },
    required: ['title', 'detail'],
  },
}

/** 归并/修订轮一次要吐完整纪要，不设预算就会被长度上限截断，整轮作废 */
const OUTPUT_BUDGET = `输出预算（必须守住，超了会被截断，整轮作废）：每类最多 16 条，detail 每条不超过 60 字，report 每节 2-3 段、每段不超过 120 字，timeline 最多 20 条，terms 最多 12 条。内容多就合并条目，不要靠删字段省长度。`

const COMMON_RULES = `你在 mdreader 的「会记」功能里工作，负责把会议转写整理成可信的材料。

铁律：
1. 只依据给出的材料。转写没说的、文档没写的，一律不编造，包括人名、时间、数字、结论和责任人。
2. 转写来自本地语音识别，很可能有同音字错误（例：会记/会计、部署/布署、结项/节相）。凡是对某个词没把握，就把 uncertain 置为 true 并在 terms 里列出该词和疑点。
3. 说话人不做声纹区分，转写里也不会标注是谁说的。只能根据称呼、自称、「你来负责」这类上下文推断，推断出来的一律标 uncertain。
4. 材料里带 [时:分:秒] 前缀的是转写原文，每条结论都要在 refs 里给出对应时间戳；没有时间戳的输入（纯文本稿）refs 留空。
5. 全部用简体中文，专有名词、系统名、英文缩写按原文保留，不要翻译。`

function docBlock(doc: MeetingDocContext): string {
  const text = doc.text.length > MAX_DOC_CHARS ? `${doc.text.slice(0, MAX_DOC_CHARS)}\n（文档过长，只送到这里）` : doc.text
  if (!text.trim()) return '《用户当前文档》：（空，用户还没写任何东西）'
  return `《用户当前文档》${doc.name}：\n<document>\n${text}\n</document>`
}

function transcriptBlock(transcript: Transcript, body: string, clipped: boolean): string {
  const head = transcript.timed
    ? `《会议转写》（${formatDuration(transcript.seconds)}，每行前缀是中括号里的相对时间）：`
    : '《会议转写》（无时间戳的文本稿）：'
  const text = clipped ? clipTranscript(body) : body
  return `${head}\n<transcript>\n${text}\n</transcript>`
}

/** 超预算的转写保头尾、省中段：开场与收尾信息密度最高，中段细节由分段抽取兜住 */
function clipTranscript(body: string): string {
  if (body.length <= MAX_FULL_TRANSCRIPT_CHARS) return body
  const head = Math.floor(MAX_FULL_TRANSCRIPT_CHARS * 0.6)
  const tail = MAX_FULL_TRANSCRIPT_CHARS - head
  const omitted = body.length - head - tail
  return `${body.slice(0, head)}\n……（中段约 ${omitted} 字因长度上限省略，请以分段抽取结果为准）……\n${body.slice(body.length - tail)}`
}

// ---------- 第 1 轮：分段抽取 ----------

export function extractTool(): AiToolSpec {
  return {
    type: 'function',
    function: {
      name: 'emit_extract',
      description: '提交这一段转写的抽取结果。必须是合法 JSON 对象，不要包代码围栏。',
      parameters: {
        type: 'object',
        properties: {
          topics: ROW_SCHEMA,
          decisions: ROW_SCHEMA,
          actions: ROW_SCHEMA,
          risks: ROW_SCHEMA,
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'string', description: '时间戳 mm:ss 或 hh:mm:ss；没有时间就写「未计时」' },
                text: { type: 'string', description: '这一时刻发生的一件事' },
              },
              required: ['text'],
            },
          },
          terms: {
            type: 'array',
            description: '本段里疑似识别错的词',
            items: {
              type: 'object',
              properties: {
                word: { type: 'string' },
                note: { type: 'string', description: '怀疑的正确写法或为什么存疑' },
              },
              required: ['word', 'note'],
            },
          },
        },
        required: ['topics', 'decisions', 'actions', 'risks'],
      },
    },
  }
}

export function buildExtractPrompt(
  doc: MeetingDocContext,
  transcript: Transcript,
  windowBody: string,
  index: number,
  total: number,
): { system: string; user: string } {
  return {
    system: `${COMMON_RULES}

这一轮做「分段抽取」：只处理下面给你的这一段转写，把它拆成议题、决议、行动项、风险、时间线和存疑词。
不要总结整场会议，不要写这一轮没要求的内容，不要因为信息不全就留空字段——没有就返回空数组。
输出预算（必须守住，超了会被截断导致这段白抽）：每类最多 10 条，detail 每条不超过 60 字，同一件事只记一次。
这是第 ${index + 1}/${total} 段。`,
    user: `${docBlock(doc)}

${transcriptBlock(transcript, windowBody, false)}

请按 emit_extract 的结构返回本段结果。用户文档只用来对齐术语和人名，不要把它的内容当成会议结论。`,
  }
}

// ---------- 第 2 轮：归并成完整纪要 ----------

export function digestTool(): AiToolSpec {
  return {
    type: 'function',
    function: {
      name: 'emit_digest',
      description: '提交归并后的完整会议纪要与报告素材。必须是合法 JSON 对象，不要包代码围栏。',
      parameters: {
        type: 'object',
        properties: {
          info: {
            type: 'array',
            description: '会议基本信息，按 主题/时间/时长/地点/组织者/参会人 顺序，缺的项不要编造',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                uncertain: { type: 'boolean' },
              },
              required: ['label', 'value'],
            },
          },
          summary: {
            type: 'array',
            description: '执行摘要，3-6 条，每条一句话讲清一个结论',
            items: { type: 'string' },
          },
          topics: ROW_SCHEMA,
          decisions: ROW_SCHEMA,
          actions: ROW_SCHEMA,
          risks: ROW_SCHEMA,
          openQuestions: { type: 'array', description: '会上没定下来、需要后续确认的事', items: { type: 'string' } },
          report: {
            type: 'array',
            description: '总结报告正文，按议题分节；每节 2-5 段，写清背景、讨论过程、结论与影响',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
              },
              required: ['heading', 'paragraphs'],
            },
          },
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              properties: { time: { type: 'string' }, text: { type: 'string' } },
              required: ['text'],
            },
          },
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: { word: { type: 'string' }, note: { type: 'string' } },
              required: ['word', 'note'],
            },
          },
        },
        required: ['info', 'summary', 'topics', 'decisions', 'actions', 'report'],
      },
    },
  }
}

export function buildMergePrompt(
  doc: MeetingDocContext,
  transcript: Transcript,
  partialsJson: string,
): { system: string; user: string } {
  return {
    system: `${COMMON_RULES}

这一轮做「归并」：把分段抽取的结果合成一份完整纪要和报告素材。
要求：
1. 合并同义条目（同一件事被两段提到，只留一条，refs 取并集）；互相冲突的结论都保留并标 uncertain，在 openQuestions 里写清冲突。
2. 行动项必须有负责人或时间才写进 actions；两者都没有的降级为 openQuestions。
3. report 是给人读的总结，按议题成段，不要重复罗列要点，也不要写「本次会上大家积极发言」这类空话。
4. info 里只能出现材料能支持的项，缺了就整条不写，靠猜的项 uncertain 置 true。
5. ${OUTPUT_BUDGET}`,
    user: `${docBlock(doc)}

${transcriptBlock(transcript, transcriptText(transcript), true)}

分段抽取结果（按时间顺序）：
<partials>
${partialsJson}
</partials>

请按 emit_digest 的结构返回归并结果。转写原文在这里用于核对 refs 与用词，不要照抄大段原文。`,
  }
}

// ---------- 第 3 轮：内容检查 ----------

export function issuesTool(): AiToolSpec {
  return {
    type: 'function',
    function: {
      name: 'emit_issues',
      description: '提交对纪要稿的检查结果。必须是合法 JSON 对象，不要包代码围栏。',
      parameters: {
        type: 'object',
        properties: {
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                where: { type: 'string', description: '位置，如「行动项第 3 条」「报告：二期上线」' },
                problem: { type: 'string', description: '问题：无依据、疑似同音字、时间与数字不符、遗漏议题、术语与文档不一致等' },
                fix: { type: 'string', description: '具体改法；没把握就写「标为存疑，人工核对」' },
                severity: { type: 'string', enum: ['warning', 'info'] },
              },
              required: ['where', 'problem', 'fix', 'severity'],
            },
          },
        },
        required: ['issues'],
      },
    },
  }
}

export function buildCheckPrompt(
  doc: MeetingDocContext,
  transcript: Transcript,
  digestJson: string,
): { system: string; user: string } {
  return {
    system: `${COMMON_RULES}

这一轮做「内容检查」：你不再整理内容，只挑毛病。逐条核对下面的纪要稿与报告素材，重点查：
1. 每条决议/行动项是否真能在转写原文里找到依据，refs 对不对得上；找不到依据的就是编造，必须报。
2. 疑似同音字与专名：把纪要里的人名、系统名、产品名和用户文档里的写法逐一比对，不一致就是问题。
3. 数字、日期、版本号、百分比是否与转写原文一致。
4. 转写里明显是结论或待办的内容，纪要里有没有漏掉。
5. 归因错误：把「有人提议」写成「会议决定」，把「待定」写成「已确认」。
没问题就返回空数组，不要为凑数编问题；最多 10 条，按严重度排序，problem 和 fix 各不超过 40 字。`,
    user: `${docBlock(doc)}

${transcriptBlock(transcript, transcriptText(transcript), true)}

待检查的纪要稿：
<digest>
${digestJson}
</digest>

请按 emit_issues 的结构返回检查结果。`,
  }
}

// ---------- 第 4 轮：修订 ----------

export function buildRevisePrompt(
  doc: MeetingDocContext,
  transcript: Transcript,
  digestJson: string,
  issuesJson: string,
): { system: string; user: string } {
  return {
    system: `${COMMON_RULES}

这一轮做「修订」：按检查结果修改上一轮的纪要，产出最终版本，结构与 emit_digest 相同。
要求：
1. 逐条落实 issues：能在转写里找到正确说法的就改，找不到依据的直接删掉，删不掉但存疑的保留并把 uncertain 置 true、在 terms 里说明。
2. 不要顺手改检查结果没提到的内容，不要新增条目。
3. 修订后仍然要完整：没被 issue 涉及的字段原样保留。
4. ${OUTPUT_BUDGET}`,
    user: `${docBlock(doc)}

${transcriptBlock(transcript, transcriptText(transcript), true)}

上一轮纪要：
<digest>
${digestJson}
</digest>

检查结果：
<issues>
${issuesJson}
</issues>

请调用 emit_digest 返回修订后的完整纪要。`,
  }
}
