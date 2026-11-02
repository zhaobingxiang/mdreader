import type { AiSettings } from '../settings'

/** 各平台打开深度思考的方式：vLLM 系走 chat_template_kwargs，OpenAI 系走 reasoning_effort */
export type ThinkingParam = 'chat_template' | 'reasoning_effort' | 'none'

export interface BuiltinModel {
  id: string
  hint?: string
}

export interface BuiltinProvider {
  id: 'lanz' | 'maas' | 'custom'
  label: string
  baseUrl: string
  thinkingParam: ThinkingParam
  /** 内置模型清单；MaaS 为空 → 运行时从 /models 拉取 */
  models: BuiltinModel[]
  hint: string
  /** 模型在平台上不存在时改用哪个模型（只有 MaaS 给了兜底） */
  fallbackModel?: string
  /** 宿主内置了该平台的公共 Key，用户不填也能直接用 */
  builtinKey?: boolean
  /** 接口地址是否允许用户改写（只有自定义端点需要） */
  editableBaseUrl: boolean
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    id: 'lanz',
    label: 'Lanz',
    baseUrl: 'http://lanz.hikvision.com/v3/openai/v1',
    thinkingParam: 'none',
    hint: '内网直连，思考过程默认开启；高峰时段可能排队',
    editableBaseUrl: false,
    models: [
      { id: 'Lanz-Auto', hint: '自动路由 · 256K' },
      { id: 'Lanz-Medium', hint: '深度推理 · 512K / 低峰 1M' },
      { id: 'Lanz-Medium-V', hint: '深度推理 · 与 Medium 相同' },
      { id: 'Lanz-Flash', hint: '视频/安防知识 · 256K' },
    ],
  },
  {
    id: 'maas',
    label: 'MaaS',
    baseUrl: 'https://maas.hikvision.com.cn/v1',
    thinkingParam: 'chat_template',
    hint: '自带公共 Key，开箱可用；模型清单从平台实时拉取，可在设置里刷新',
    editableBaseUrl: false,
    models: [
      { id: 'GLM-5.3', hint: '默认 · 平台不可达时自动改用 DeepSeek-V4-Flash-0731' },
      { id: 'DeepSeek-V4-Flash-0731', hint: '回退模型' },
    ],
    fallbackModel: 'DeepSeek-V4-Flash-0731',
    builtinKey: true,
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    thinkingParam: 'none',
    hint: '任意 OpenAI 兼容端点，填写接口地址与模型名',
    editableBaseUrl: true,
    models: [],
  },
]

export function getProvider(id: string): BuiltinProvider {
  return BUILTIN_PROVIDERS.find((p) => p.id === id) ?? BUILTIN_PROVIDERS[1]!
}

export interface AiSelection {
  providerId: string
  providerLabel: string
  baseUrl: string
  model: string
  thinkingParam: ThinkingParam
  fallbackModel: string
}

/** 当前生效的平台与模型；缺地址或缺模型时返回 null，由调用方提示去设置里补齐 */
export function resolveSelection(ai: AiSettings): AiSelection | null {
  const provider = getProvider(ai.active)
  const configured = ai.providers[ai.active]
  const baseUrl = (configured?.baseUrl ?? '').trim()
  const model = (configured?.model ?? '').trim()
  if (!baseUrl || !model) return null
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    baseUrl,
    model,
    thinkingParam: provider.thinkingParam,
    fallbackModel: provider.fallbackModel ?? '',
  }
}

export function describeSelection(ai: AiSettings): string {
  const selection = resolveSelection(ai)
  return selection ? `${selection.providerLabel} · ${selection.model}` : '未配置模型'
}
