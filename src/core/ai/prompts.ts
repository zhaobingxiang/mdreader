import type { AiSelection } from './providers'

/** 单次请求带上的文档上限。超出部分不发给模型，界面会明确提示只优化了前面部分 */
export const MAX_DOC_CHARS = 60_000

export interface DocContext {
  name: string
  text: string
  /** 文档因长度被截断时，告诉模型只收到了前一部分 */
  truncated: boolean
}

const DOC_RULES = `你在 mdreader 里工作，任务是把用户当前的 Markdown 文档改得更好。

必须遵守：
1. 不编造事实、数字、引用和人名；不删减技术细节；链接、图片、代码块内容、YAML front matter 原样保留。
2. 格式：标题层级逐级递进；能用列表/表格就别堆长段落；一段只讲一件事；代码围栏标注语言；中英文之间留一个空格；中文语境使用全角标点。
3. 表述：删掉套话和重复；统一术语；把冗长的被动句、名词化句式改顺；保留作者原有语气，不翻译专有名词，不改变文档语言。
4. 不确定文档意图、目标读者或修改范围，且猜错会造成大改时，先调用 ask_user 提问：一次问完（最多 3 个问题合并成一条），给出可点选的选项。已有足够信息时不要多问。
5. 改完整篇后调用 propose_document 提交完整文档（不是 diff，不要包代码围栏）。content 里用一两句话说明改了什么，不要重复文档内容。`

const SUGGEST_RULES = `你在 mdreader 里做 Markdown 书写检查。

通读用户当前的文档，给出最值得改的格式与表述建议：标题层级、列表/表格的使用、段落长度、代码围栏、标点与中英文空格、冗余表述、术语不一致、结构顺序。

要求：
1. 只调用 report_suggestions，不要改写文档，不要调用 propose_document。
2. 每条建议一句话，具体到「哪里改成什么」，不要泛泛而谈。
3. 尽量带上出问题的行号（从 1 开始，按给出的文档行号计）。
4. 最多 12 条，按重要性排序；没发现问题就返回空数组。`

function docBlock(doc: DocContext): string {
  const header = doc.truncated
    ? `当前文档《${doc.name}》（过长，只提供前 ${MAX_DOC_CHARS} 个字符）：`
    : `当前文档《${doc.name}》：`
  return `${header}\n<document>\n${doc.text}\n</document>`
}

export function buildSystemPrompt(
  mode: 'document' | 'suggestions',
  doc: DocContext,
  selection: AiSelection | null,
): string {
  const parts = [mode === 'document' ? DOC_RULES : SUGGEST_RULES, docBlock(doc)]
  if (mode === 'document' && selection) {
    // 小模型容易一口气把整篇改飞，这里按模型档位收一收
    if (/flash|mini|small|9b|27b/i.test(selection.model)) {
      parts.push('本次模型规模较小：优先做确定性高的句式与格式修正，不要重写段落结构。')
    }
  }
  return parts.join('\n\n')
}

export function buildOptimizeInstruction(extra?: string): string {
  const base =
    '请优化这份文档：先判断结构和表述上最需要改的地方，再给出完整的优化稿。读者默认是需要快速读懂这份文档的同事。'
  const trimmed = extra?.trim()
  return trimmed ? `${base}\n用户补充的优化方向：${trimmed}` : base
}

export function buildSuggestInstruction(): string {
  return '请检查这份文档的格式与表述，只给出建议，不要改写文档。'
}

export function buildAskAnswer(answer: string): string {
  return `用户的回答：${answer}\n请据此继续优化，改完整篇后调用 propose_document。`
}

export function clipDocument(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOC_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_DOC_CHARS), truncated: true }
}
