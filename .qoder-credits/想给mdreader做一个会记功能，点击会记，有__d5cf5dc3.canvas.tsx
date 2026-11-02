import {
  BarChart,
  Callout,
  ChartComparisonGrid,
  ChartContainer,
  H1,
  LineChart,
  MetricsGrid,
  PieChart,
  ReportSection,
  ReportShell,
  Stack,
  Table,
  Text,
  type MetricItem,
} from "qoder/canvas";

// —— 报告数据契约（由 scripts/lib/breakdown.mjs 产出，plugin 注入）——
interface CatRow {
  key: string;
  label: string;
  tokens: number;
  share: number;
}
interface ToolRow {
  tool: string;
  tokens: number;
  calls: number;
  /** 平均每次调用带来的重发 token；无调用记录时 null（不给 0） */
  perCall?: number | null;
  share: number;
}
interface FileRow {
  attr: string;
  label: string;
  kind: string;
  tool: string | null;
  selfTokens: number;
  reads: number;
  trips: number;
  billed: number;
  /** 单次读取的总代价（含此后每一程重发）；reads=0 时 null */
  perRead?: number | null;
  share: number;
}
interface ReqRow {
  index: number;
  time: string | null;
  ratio: number;
  inputTokens: number;
  /** 代理或转录任一有真值即非 null；两者都没则 null（不写 0） */
  outputTokens?: number | null;
  /** proxy=代理实测 / transcript-tokens=转录 input_tokens / transcript-ratio=转录 ratio×window */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "transcript";
  credits: number;
  originalCredits: number;
  afterCompact: boolean;
}
interface CatChild {
  tool: string | null;
  label: string;
  kind: string | null;
  tokens: number;
  share: number;
  catShare: number;
  trips: number;
}
interface CatDetail {
  key: string;
  label: string;
  tokens: number;
  share: number;
  children: CatChild[];
}
interface SubagentRow {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  roundTrips: number;
  billedInputTokens: number;
  peakContextRatio: number;
  credits: number;
  originalCredits: number;
  error: string | null;
}
interface SubagentTotals {
  roundTrips: number;
  billedInputTokens: number;
  credits: number;
  originalCredits: number;
}
interface Subagents {
  scanned: boolean;
  dir: string | null;
  /** 试过的候选目录；用于区分「真没子代理」与「路径没找对」。 */
  probedPaths?: string[];
  /** ok=已汇总 / no-dir=无子代理目录 / dir-empty=目录在但无 agent 文件 / no-usage=有文件但转录无 usage / error=读取抛错 */
  reason?: string;
  count: number;
  items: SubagentRow[];
  totals: SubagentTotals;
  combined: SubagentTotals;
}
/** 逐项可用性：报告里每个数字到底是模型上报的真值、按真值推导、回退默认、手工录入，还是本地根本没有。
 *  v2 旧报告没这个对象，故全部字段可选，读取时一律走默认值（旧报告只可能来自桌面端富转录）。 */
type Avail = "measured" | "derived" | "fallback" | "manual" | "unavailable";
interface Availability {
  credits?: Avail;
  roundTrips?: Avail;
  contextRatio?: Avail;
  tokens?: Avail;
  /** 输出 token：代理或转录 output_tokens 任一有真值即 measured */
  outputTokens?: Avail;
  /** 缓存命中 token：代理或转录 cache_read_input_tokens 任一有真值即 measured */
  cachedTokens?: Avail;
  categoryShare?: Avail;
  toolShare?: Avail;
  fileShare?: Avail;
  systemPrompt?: Avail;
  contextWindow?: Avail;
  compactions?: Avail;
  compactionCost?: Avail;
  model?: Avail;
  title?: Avail;
  toolCalls?: Avail;
  fileReads?: Avail;
  userTurns?: Avail;
  /** 用户压缩阈值：manual 覆盖 → manual；默认 200K → fallback */
  userContextLimit?: Avail;
}
/** 官方 UI 真值（手工录入，来自 .qoder-credits/overrides/<sessionId>.json）。
 *  IDE 端转录不含 usage，本地算不出 Credits，这是唯一的真值通道；绝不覆盖 totals，只并列展示。 */
interface ManualTruth {
  file?: string;
  credits: number | null;
  originalCredits: number | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  note: string | null;
  /** 手工锁定模型窗口（如 qwen3-max=1000000），优先于 runtime-config / 反推 / fallback */
  contextWindow?: number | null;
  /** 手工指定 Qoder 压缩触发阈值（默认 200000），驱动 peakUserAdvice */
  userContextLimit?: number | null;
  /** 本地 credits ÷ 官方真值。有子代理时拿 combined 比（官方 UI 扣费 = 主链 + 子代理），
   *  否则覆盖率会被系统性低估（实测 ca2f7834：主链比 0.46、combined 比 0.89）。 */
  localCoverage?: number | null;
  /** main=只比主链 / combined=比主链+子代理 */
  localScope?: "main" | "combined";
  /** 参与对账的本地 credits（按 localScope 取 totals.credits 或 subagents.combined.credits） */
  localCredits?: number | null;
}
/** 峰值占比的「该不该压」结论。阈值算在数据层（breakdown.mjs peakAdvice），
 *  这里只管展示——否则 Canvas 与终端各持一套阈值迟早走偏。tone 直接喂 Callout。 */
interface PeakAdvice {
  level: "low" | "mid" | "sweet" | "high" | "over";
  tone: "info" | "success" | "warning" | "danger";
  text: string;
}
/** 一次压缩 = 一笔普通模型调用（整份上下文当 prompt、摘要当 completion），是会话里单笔最贵的开销。
 *  pre/post 是客户端自估口径；proxy 是能在代理日志里唯一对上时回填的供应商实测值，对不上就 null。 */
interface CompactionEvent {
  index: number;
  at: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  messagesSummarized: number | null;
  /** 压缩后首轮的往返序号与实测输入 = 压缩把上下文压到的地板 */
  nextRequestIndex: number | null;
  nextInputTokens: number | null;
  savedTokens: number | null;
  /** 数据层归一后的生效值：有代理实测就用实测，否则是客户端自估。
   *  渲染端直接取这两个，别自己按 proxy 分支——否则会与合计的口径分叉。 */
  effectiveInputTokens?: number | null;
  effectiveOutputTokens?: number | null;
  proxy?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    ms: number | null;
    matchedBy: string;
  } | null;
}
interface CompactionCost {
  count: number;
  items: CompactionEvent[];
  /** measured = items 里有几笔拿到了供应商实测（其余为客户端自估） */
  totals: { preTokens: number; postTokens: number; savedTokens: number; measured?: number };
}
/** 链路健康度：代理覆盖率 + 最近记录时间 + 最近若干笔的三方归因计数。
 *  逐笔明细属于排障（CLI --request-log），报告只给一行结论。 */
interface LinkHealth {
  matched: number;
  requests: number;
  coverage: number;
  /** proxy / transcript-tokens / transcript-ratio / mixed / transcript（v3 旧报告）/ null */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
  breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
  logRecords?: number;
  lastRecordAt?: string | null;
  /** 参与归因的最近笔数；0 = 运行中的代理是旧版或还没记到诊断 */
  recentRequests?: number;
  proxyErrors?: number | null;
  upstreamRejected?: number | null;
  aborted?: number | null;
  truncated?: number | null;
  noUsage?: number | null;
  slowestMs?: number | null;
  /** 被更新流量推翻的那条陈旧拉起失败记录；null = 没有 */
  supersededFailure?: { error: string; port?: number; at?: string | null } | null;
}
interface Report {
  schemaVersion: number;
  generatedAt: string;
  pluginVersion?: string;
  /** 转录来自哪一代客户端：桌面端富转录有 usage 真值，IDE 端精简转录没有。v2 旧报告无此字段。 */
  source?: "desktop-rich" | "ide-lite" | "unknown";
  /** usage 数字的来源：proxy=代理实测 / transcript-tokens=转录 input_tokens 真值 /
   *  transcript-ratio=转录 ratio×window 推导 / mixed=多档混合 / transcript=v3 旧报告兼容。无 usage 时 null。 */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 可直接粘贴执行的插件入口命令（generate.mjs 用 proxy.mjs 的 selfCmd() 注入）。
   *  Windows 上是插件自带启动器的绝对路径，不要求用户装 Node；模板是静态文本，拿不到就只能硬编码。 */
  selfCmd?: string | null;
  /** 链路健康度一行结论（逐笔明细留给 CLI --request-log） */
  linkHealth?: LinkHealth | null;
  /** 代理 join 诊断（lib/proxylog.mjs）+ 配置/状态（generate.mjs 注入） */
  proxy?: {
    matched: number;
    requests: number;
    /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
    breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
    logPath?: string;
    logExists?: boolean;
    logRecords?: number;
    /** config.json 里 upstream 合法 = 用户已配置代理 */
    configured?: boolean;
    enabled?: boolean;
    port?: number;
    /** 最近一条代理记录的时间；null = 从无流量 */
    lastRecordAt?: string | null;
    /** 已配置但长期零流量（多半已改回官方模型）——软提示可 --stop-proxy */
    dormant?: boolean;
    /** 最近一次自动拉起失败（如端口被占）；ok 时为 null */
    status?: { error: string; port?: number; at?: string | null } | null;
    /** status 那条失败记录是否已被更新的流量推翻（代理在它之后还记到了流量）。
     *  status.json 只写不清，陈旧失败会把用户推去改本来正确的 Base URL，故必须判掉。 */
    statusSuperseded?: boolean;
  };
  availability?: Availability;
  manual?: ManualTruth | null;
  session: {
    id: string | null;
    title: string | null;
    /** custom-title / first-user / session-id —— 令产物文件名可解释 */
    titleSource?: string;
    model: string | null;
    /** runtime-config / manual / unavailable */
    modelSource?: string;
    cwd: string | null;
    turns: number;
    roundTrips: number;
    compactions: number;
    startedAt: string | null;
    endedAt: string | null;
  };
  context: {
    contextWindow: number;
    /** runtime-config=实测 / derived-from-usage=从 usage 反推 / manual=ManualTruth 手工锁定 /
     *  fallback=读不到静默回退 200000 / caller=调用方传入（旧枚举，兼容）。
     *  报告里每个 token 数字都要乘它，回退时必须标出来。 */
    contextWindowSource?: string;
    systemPromptTokens: number;
    netContextTokens: number;
    /** 峰值 = 当前窗口口径：自最近一次压缩起算，压缩边界处归零重新累积 */
    peakContextTokens: number;
    peakContextRatio: number;
    /** 本场历史峰值（跨压缩）；整场没压缩过时与上面相等 */
    peakSessionTokens?: number;
    peakSessionRatio?: number;
    /** 历史峰值是否值得单独交代（与当前窗口峰值相差 ≥1 个百分点），渲染端直接取用不再自判 */
    peakSessionNotable?: boolean;
    /** 峰值占比的「该不该压」结论（对模型窗口）；无有效占比时 null */
    peakAdvice?: PeakAdvice | null;
    /** 用户压缩阈值（Qoder 自动触发点），与模型窗口独立。默认 200000，ManualTruth 可覆盖 */
    userContextLimit?: number;
    /** default=内置 200K / manual=overrides 手写 / config=插件配置 / derived=实测反推 */
    userContextLimitSource?: "default" | "manual" | "config" | "derived";
    /** peakContextTokens ÷ userContextLimit */
    peakUserRatio?: number;
    /** 对用户阈值的「快自动压缩了吗」结论；与 peakAdvice 可矛盾（模型窗口未满但用户阈值已超） */
    peakUserAdvice?: PeakAdvice | null;
    /** v3.2 当前占用头条口径：段内单调递增 ⇒ 峰值≡当前，故以 netContextTokens 作头条，peak 退灰字 */
    currentContextTokens?: number;
    netUserRatio?: number;
    netUserAdvice?: PeakAdvice | null;
    netWindowRatio?: number;
    /** v3.2 自动压缩自校准：本场 trigger=auto 的实际触发点（无需外部配置）与「阈值是否被强制」判定 */
    observedAutoCompactions?: number;
    observedAutoTriggerTokens?: number | null;
    autoTriggerRatio?: number | null;
    thresholdNotEnforced?: boolean;
  };
  totals: {
    billedInputTokens: number;
    netContextTokens: number;
    peakContextTokens: number;
    amplification: number;
    attributedTokens: number;
    coverage: number;
    credits: number;
    originalCredits: number;
    /** 输出 token 总量：仅代理路径有真值，否则 0 且 availability.outputTokens=unavailable */
    outputTokens?: number;
    /** 供应商上下文缓存命中的那部分 prompt：仅代理路径有真值 */
    cachedTokens?: number;
    cachedTrips?: number;
    /** 缓存命中 ÷ 计费输入总量（全局实测约 91.5%：重复叠加的前缀正是缓存的命中对象） */
    cachedShare?: number;
    /** 两个不依赖 usage 的计数，IDE 端占比全缺时仍有可展示的真值 */
    toolCalls?: number;
    fileReads?: number;
  };
  /** credits 的分子到底覆盖了多少：与计费输入总量并排展示时，部分覆盖不说就等于把局部真值当全量。 */
  creditsCoverage?: {
    /** 真正累加进 totals.credits 的往返数 */
    trips: number;
    roundTrips: number;
    /** 这些往返的计费输入之和 */
    tokens: number;
    tokenShare: number;
    /** trips === roundTrips：全覆盖时不必再啰嗦覆盖范围 */
    full: boolean;
  };
  /** 压缩单笔成本（此前只显示「压缩 N 次」，而它是会话里单笔最贵的调用） */
  compactionCost?: CompactionCost;
  byCategory: CatRow[];
  byCategoryDetail: CatDetail[];
  byTool: ToolRow[];
  byFile: FileRow[];
  byRequest: ReqRow[];
  subagents?: Subagents;
  identity: { sumAttributed: number; billedInputTokens: number; absDiff: number; ok: boolean | null };
}

// 注入点：下一行的 REPORT 初值会被 render-canvas.mjs 按整行替换为真实报告 JSON。
const REPORT = {"schemaVersion":3.2,"generatedAt":"2026-11-02T02:00:19.964Z","source":"desktop-rich","usageSource":"transcript-ratio","availability":{"credits":"measured","roundTrips":"measured","contextRatio":"measured","tokens":"derived","outputTokens":"unavailable","cachedTokens":"unavailable","categoryShare":"derived","toolShare":"derived","fileShare":"derived","systemPrompt":"derived","contextWindow":"fallback","compactions":"measured","compactionCost":"measured","model":"measured","title":"measured","toolCalls":"measured","fileReads":"measured","userTurns":"measured","userContextLimit":"fallback"},"session":{"id":"d5cf5dc3-cde9-4d4b-ab00-6784aa5a8166","title":"想给mdreader做一个会记功能，点击会记，有","titleSource":"first-user","model":"qfmodel","modelSource":"runtime-config","cwd":"D:\\ide\\mdreader","turns":11,"roundTrips":688,"compactions":5,"startedAt":"2026-10-30T06:21:29.907Z","endedAt":"2026-11-02T02:00:19.057Z"},"context":{"contextWindow":200000,"contextWindowSource":"fallback","systemPromptTokens":20828,"netContextTokens":126099,"peakContextTokens":126099,"peakContextRatio":0.630495,"peakSessionTokens":167015,"peakSessionRatio":0.835075,"peakSessionNotable":true,"peakAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"userContextLimit":200000,"userContextLimitSource":"default","peakUserRatio":0.630495,"peakUserAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"currentContextTokens":126099,"netUserRatio":0.630495,"netUserAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"netWindowRatio":0.630495,"observedAutoCompactions":5,"observedAutoTriggerTokens":168221,"autoTriggerRatio":0.841105,"thresholdNotEnforced":false},"totals":{"billedInputTokens":73973875,"netContextTokens":126099,"peakContextTokens":126099,"amplification":586.63,"attributedTokens":73973875,"coverage":1,"credits":225.78,"originalCredits":225.78,"outputTokens":0,"cachedTokens":0,"cachedTrips":0,"cachedShare":0,"toolCalls":739,"fileReads":377},"creditsCoverage":{"trips":688,"roundTrips":688,"tokens":73973875,"tokenShare":1,"full":true},"compactionCost":{"count":5,"items":[{"index":1,"at":"2026-10-30T07:41:14.295Z","trigger":"auto","preTokens":167739,"postTokens":4404,"messagesSummarized":313,"nextRequestIndex":69,"nextInputTokens":44543,"savedTokens":123196,"proxy":null,"effectiveInputTokens":167739,"effectiveOutputTokens":4404},{"index":2,"at":"2026-10-30T08:13:49.609Z","trigger":"auto","preTokens":168221,"postTokens":5498,"messagesSummarized":330,"nextRequestIndex":165,"nextInputTokens":43867,"savedTokens":124354,"proxy":null,"effectiveInputTokens":168221,"effectiveOutputTokens":5498},{"index":3,"at":"2026-10-30T08:47:25.645Z","trigger":"auto","preTokens":168442,"postTokens":5985,"messagesSummarized":363,"nextRequestIndex":273,"nextInputTokens":45893,"savedTokens":122549,"proxy":null,"effectiveInputTokens":168442,"effectiveOutputTokens":5985},{"index":4,"at":"2026-10-30T10:04:45.927Z","trigger":"auto","preTokens":168792,"postTokens":5632,"messagesSummarized":569,"nextRequestIndex":428,"nextInputTokens":44325,"savedTokens":124467,"proxy":null,"effectiveInputTokens":168792,"effectiveOutputTokens":5632},{"index":5,"at":"2026-10-30T17:57:26.211Z","trigger":"auto","preTokens":167059,"postTokens":5920,"messagesSummarized":508,"nextRequestIndex":564,"nextInputTokens":42163,"savedTokens":124896,"proxy":null,"effectiveInputTokens":167059,"effectiveOutputTokens":5920}],"totals":{"preTokens":840253,"postTokens":27439,"savedTokens":619462,"measured":0}},"proxy":{"matched":0,"requests":688,"breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":688},"logPath":"C:\\Users\\zhaobingxiang\\.qoder-credits-proxy\\usage.jsonl","logExists":false,"logRecords":0,"configured":false,"enabled":true,"port":49787,"lastRecordAt":null,"dormant":false,"status":null,"statusSuperseded":false},"byCategory":[{"key":"tool_result","label":"工具返回","tokens":18143661,"share":0.24527120026134389},{"key":"system","label":"系统提示词","tokens":14329664,"share":0.19371249647257224},{"key":"compact_summary","label":"压缩摘要","tokens":3225630,"share":0.043604994475947075},{"key":"assistant_thinking","label":"模型思考","tokens":9790272,"share":0.1323476990535036},{"key":"assistant_tool_use","label":"工具调用","tokens":6448081,"share":0.08716699684820717},{"key":"assistant_text","label":"模型回复","tokens":277273,"share":0.0037482489667583904},{"key":"user_input","label":"用户输入","tokens":3152842,"share":0.04262102628225085},{"key":"attachment","label":"附件/技能","tokens":18606452,"share":0.2515273376394273}],"byCategoryDetail":[{"key":"tool_result","label":"工具返回","tokens":18143661,"share":0.24527120026134389,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":5535086,"share":0.07482487301369635,"catShare":0.3050699508705799,"trips":21308},{"tool":"Read","label":"src/ui/settings-modal.ts","kind":"read","tokens":953950,"share":0.012895771284371017,"catShare":0.05257760091943197,"trips":272},{"tool":"Read","label":"src/features/meeting/panel.ts","kind":"read","tokens":947802,"share":0.012812651784970345,"catShare":0.05223871278534976,"trips":525},{"tool":"Read","label":"src/core/settings.ts","kind":"read","tokens":863085,"share":0.011667427422508456,"catShare":0.04756949617434277,"trips":281},{"tool":"Read","label":"src/app.ts","kind":"read","tokens":853361,"share":0.011535976155395698,"catShare":0.047033553646346433,"trips":1099},{"tool":"Read","label":"src/features/meeting/analyze.ts","kind":"read","tokens":850694,"share":0.011499923461901328,"catShare":0.046886562505699045,"trips":1043},{"tool":"Read","label":"src/core/ai/session.ts","kind":"read","tokens":771699,"share":0.010432049663363259,"catShare":0.04253271338929151,"trips":154},{"tool":"Read","label":"desktop/AsrEngine.cs","kind":"read","tokens":745339,"share":0.010075709507097576,"catShare":0.04107987197992101,"trips":1062},{"tool":"Read","label":"src/ui/layout.ts","kind":"read","tokens":628094,"share":0.008490751662742066,"catShare":0.034617809403203116,"trips":189},{"tool":"Read","label":"desktop/HostBridge.cs","kind":"read","tokens":575326,"share":0.007777417227576256,"catShare":0.03170945964829618,"trips":522},{"tool":"Read","label":"src/features/meeting/prompts.ts","kind":"read","tokens":573476,"share":0.007752412546688077,"catShare":0.031607512575580206,"trips":149},{"tool":"Read","label":"desktop/AiClient.cs","kind":"read","tokens":525237,"share":0.007100304063377633,"catShare":0.028948788344542873,"trips":64},{"tool":"Read","label":"tmp-meeting.test.ts","kind":"read","tokens":514952,"share":0.006961266652050482,"catShare":0.02838191619983529,"trips":254},{"tool":"Read","label":".preview/meeting-e2e/netdisk-install.mjs","kind":"read","tokens":394234,"share":0.005329374076888273,"catShare":0.0217284951156502,"trips":342},{"tool":"Read","label":"src/features/meeting/transcript.ts","kind":"read","tokens":334122,"share":0.004516763016449676,"catShare":0.018415382693267406,"trips":192},{"tool":null,"label":"其他 98 项","kind":null,"tokens":3077204,"share":0.0415985287222639,"catShare":0.16960217374864808,"trips":17183}]},{"key":"system","label":"系统提示词","tokens":14329664,"share":0.19371249647257224,"children":[]},{"key":"compact_summary","label":"压缩摘要","tokens":3225630,"share":0.043604994475947075,"children":[]},{"key":"assistant_thinking","label":"模型思考","tokens":9790272,"share":0.1323476990535036,"children":[]},{"key":"assistant_tool_use","label":"工具调用","tokens":6448081,"share":0.08716699684820717,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":1373939,"share":0.018573303977720296,"catShare":0.21307724998331531,"trips":21308},{"tool":"Edit","label":"src/features/meeting/analyze.ts","kind":"write","tokens":667601,"share":0.009024819678475909,"catShare":0.1035348240136316,"trips":1953},{"tool":"Write","label":"desktop/AsrEngine.cs","kind":"write","tokens":312778,"share":0.00422822764119014,"catShare":0.048507207935053524,"trips":35},{"tool":"Edit","label":"tmp-meeting.test.ts","kind":"write","tokens":275849,"share":0.0037290081259248927,"catShare":0.04278004589763024,"trips":1189},{"tool":"Edit","label":"src/ui/settings-modal.ts","kind":"write","tokens":257309,"share":0.003478378738709773,"catShare":0.03990476745191796,"trips":958},{"tool":"Edit","label":"desktop/AsrEngine.cs","kind":"write","tokens":247145,"share":0.003340974513926514,"catShare":0.03832843432411117,"trips":1108},{"tool":"Edit","label":".preview/meeting-e2e/run.mjs","kind":"write","tokens":246248,"share":0.0033288528335358816,"catShare":0.03818937159591209,"trips":831},{"tool":"Write","label":"src/features/meeting/audio.ts","kind":"write","tokens":175664,"share":0.002374679936449998,"catShare":0.027242878868309207,"trips":67},{"tool":"Edit","label":"src/features/meeting/prompts.ts","kind":"write","tokens":166808,"share":0.0022549543914311275,"catShare":0.025869359654066216,"trips":930},{"tool":"Write","label":"src/features/meeting/types.ts","kind":"write","tokens":163467,"share":0.002209787929948329,"catShare":0.025351199534801677,"trips":59},{"tool":"Write","label":"tmp-meeting.test.ts","kind":"write","tokens":160455,"share":0.0021690779336641765,"catShare":0.024884165017654728,"trips":43},{"tool":"Write","label":"src/features/meeting/prompts.ts","kind":"write","tokens":160311,"share":0.0021671292169917543,"catShare":0.024861808888123088,"trips":43},{"tool":"Write","label":"src/features/meeting/panel.ts","kind":"write","tokens":133489,"share":0.001804537993554347,"catShare":0.020702078295719812,"trips":19},{"tool":"Edit","label":".preview/meeting-e2e/netdisk-install.mjs","kind":"write","tokens":131466,"share":0.0017771980976804152,"catShare":0.020388428670718488,"trips":1061},{"tool":"Write","label":"src/features/meeting/render.ts","kind":"write","tokens":113812,"share":0.0015385430426453567,"catShare":0.017650522540366736,"trips":29},{"tool":null,"label":"其他 98 项","kind":null,"tokens":1861739,"share":0.02516752279635835,"catShare":0.28872765732866923,"trips":15006}]},{"key":"assistant_text","label":"模型回复","tokens":277273,"share":0.0037482489667583904,"children":[]},{"key":"user_input","label":"用户输入","tokens":3152842,"share":0.04262102628225085,"children":[]},{"key":"attachment","label":"附件/技能","tokens":18606452,"share":0.2515273376394273,"children":[]}],"byTool":[{"tool":"Read","tokens":11898706,"calls":126,"perCall":94434,"share":0.16085010464620297},{"tool":"Bash","tokens":6909025,"calls":333,"perCall":20748,"share":0.09339817699141702},{"tool":"Edit","tokens":2950201,"calls":206,"perCall":14321,"share":0.03988166119337135},{"tool":"Write","tokens":2132059,"calls":29,"perCall":73519,"share":0.028821783105081062},{"tool":"Grep","tokens":472602,"calls":14,"perCall":33757,"share":0.006388763881914707},{"tool":"AskUserQuestion","tokens":76147,"calls":1,"perCall":76147,"share":0.0010293804478685954},{"tool":"TaskCreate","tokens":66197,"calls":8,"perCall":8275,"share":0.0008948647135472905},{"tool":"Agent","tokens":52424,"calls":1,"perCall":52424,"share":0.0007086867304710254},{"tool":"mcp_call","tokens":19742,"calls":8,"perCall":2468,"share":0.00026687555330597495},{"tool":"TaskUpdate","tokens":9772,"calls":11,"perCall":888,"share":0.0001321019839586997},{"tool":"SearchKnowledge","tokens":4867,"calls":1,"perCall":4867,"share":0.00006579786240937874},{"tool":"WebSearch","tokens":0,"calls":1,"perCall":0,"share":0}],"byFile":[{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\analyze.ts","label":"src/features/meeting/analyze.ts","kind":"write","tool":"Write","selfTokens":21200,"reads":38,"trips":6060,"billed":1660985,"perRead":43710,"share":0.022453666611964452},{"attr":"file:D:\\ide\\mdreader\\desktop\\AsrEngine.cs","label":"desktop/AsrEngine.cs","kind":"write","tool":"Write","selfTokens":39628,"reads":50,"trips":4410,"billed":1348633,"perRead":26973,"share":0.018231212489614134},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\settings-modal.ts","label":"src/ui/settings-modal.ts","kind":"read","tool":"Read","selfTokens":16166,"reads":19,"trips":2460,"billed":1247399,"perRead":65653,"share":0.016862694088069757},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\panel.ts","label":"src/features/meeting/panel.ts","kind":"write","tool":"Write","selfTokens":20397,"reads":22,"trips":1538,"billed":1135888,"perRead":51631,"share":0.015355260052922504},{"attr":"file:D:\\ide\\mdreader\\src\\app.ts","label":"src/app.ts","kind":"read","tool":"Read","selfTokens":12088,"reads":16,"trips":2914,"billed":1073369,"perRead":67086,"share":0.014510106950554998},{"attr":"file:D:\\ide\\mdreader\\tmp-meeting.test.ts","label":"tmp-meeting.test.ts","kind":"write","tool":"Write","selfTokens":12703,"reads":21,"trips":2972,"billed":990596,"perRead":47171,"share":0.013391155883984377},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\prompts.ts","label":"src/features/meeting/prompts.ts","kind":"write","tool":"Write","selfTokens":11004,"reads":15,"trips":2244,"billed":938809,"perRead":62587,"share":0.012691091200321893},{"attr":"file:D:\\ide\\mdreader\\src\\core\\settings.ts","label":"src/core/settings.ts","kind":"read","tool":"Read","selfTokens":13968,"reads":14,"trips":1118,"billed":921723,"perRead":65837,"share":0.012460109838074326},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\session.ts","label":"src/core/ai/session.ts","kind":"read","tool":"Read","selfTokens":9546,"reads":2,"trips":308,"billed":774132,"perRead":387066,"share":0.010464937587900978},{"attr":"file:D:\\ide\\mdreader\\desktop\\HostBridge.cs","label":"desktop/HostBridge.cs","kind":"read","tool":"Read","selfTokens":17009,"reads":19,"trips":1846,"billed":727003,"perRead":38263,"share":0.00982783988694921},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\layout.ts","label":"src/ui/layout.ts","kind":"read","tool":"Read","selfTokens":6844,"reads":3,"trips":576,"billed":652111,"perRead":217370,"share":0.008815424092295096},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\run.mjs","label":".preview/meeting-e2e/run.mjs","kind":"write","tool":"Write","selfTokens":10034,"reads":22,"trips":2338,"billed":602254,"perRead":27375,"share":0.008141446501732383},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\netdisk-install.mjs","label":".preview/meeting-e2e/netdisk-install.mjs","kind":"write","tool":"Write","selfTokens":9013,"reads":18,"trips":2832,"billed":590395,"perRead":32800,"share":0.007981122993059035},{"attr":"file:D:\\ide\\mdreader\\desktop\\AiClient.cs","label":"desktop/AiClient.cs","kind":"read","tool":"Read","selfTokens":7342,"reads":1,"trips":128,"billed":526240,"perRead":526240,"share":0.00711386905476509},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\transcript.ts","label":"src/features/meeting/transcript.ts","kind":"write","tool":"Write","selfTokens":5980,"reads":5,"trips":804,"billed":470477,"perRead":94095,"share":0.006360046785965029},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\render.ts","label":"src/features/meeting/render.ts","kind":"write","tool":"Write","selfTokens":11270,"reads":15,"trips":1088,"billed":430407,"perRead":28694,"share":0.005818371149169456},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\types.ts","label":"src/features/meeting/types.ts","kind":"write","tool":"Write","selfTokens":6933,"reads":7,"trips":818,"billed":404936,"perRead":57848,"share":0.005474042312435005},{"attr":"file:D:\\ide\\mdreader\\src\\core\\file\\webview.ts","label":"src/core/file/webview.ts","kind":"read","tool":"Read","selfTokens":6041,"reads":9,"trips":1044,"billed":376017,"perRead":41780,"share":0.005083105878771425},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\audio.ts","label":"src/features/meeting/audio.ts","kind":"write","tool":"Write","selfTokens":4687,"reads":8,"trips":1020,"billed":306969,"perRead":38371,"share":0.004149698593815084},{"attr":"file:D:\\ide\\mdreader\\src\\core\\document.ts","label":"src/core/document.ts","kind":"read","tool":"Read","selfTokens":3204,"reads":3,"trips":540,"billed":277023,"perRead":92341,"share":0.003744870960806111},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\ai.ts","label":"src/features/meeting/ai.ts","kind":"write","tool":"Write","selfTokens":5753,"reads":13,"trips":1016,"billed":198654,"perRead":15281,"share":0.002685463353158038},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\prompts.ts","label":"src/core/ai/prompts.ts","kind":"read","tool":"Read","selfTokens":2646,"reads":2,"trips":234,"billed":159305,"perRead":79652,"share":0.0021535254110952606},{"attr":"file:D:\\ide\\mdreader\\src\\features\\meeting\\asr.ts","label":"src/features/meeting/asr.ts","kind":"write","tool":"Write","selfTokens":2135,"reads":3,"trips":412,"billed":154578,"perRead":51526,"share":0.002089631601027329},{"attr":"file:D:\\ide\\mdreader\\desktop","label":"desktop","kind":"search","tool":"Grep","selfTokens":1540,"reads":2,"trips":394,"billed":150655,"perRead":75328,"share":0.002036603358971026},{"attr":"file:D:\\ide\\mdreader\\src\\features\\export.ts","label":"src/features/export.ts","kind":"read","tool":"Read","selfTokens":1495,"reads":2,"trips":318,"billed":129046,"perRead":64523,"share":0.0017444795178220508},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\save-probe.mjs","label":".preview/meeting-e2e/save-probe.mjs","kind":"write","tool":"Write","selfTokens":1852,"reads":2,"trips":248,"billed":108649,"perRead":54324,"share":0.001468743239031497},{"attr":"file:D:\\ide\\mdreader\\desktop\\SettingsStore.cs","label":"desktop/SettingsStore.cs","kind":"read","tool":"Read","selfTokens":861,"reads":1,"trips":204,"billed":88352,"perRead":88352,"share":0.00119437037528676},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\patch-probe.mjs","label":".preview/meeting-e2e/patch-probe.mjs","kind":"write","tool":"Write","selfTokens":1084,"reads":2,"trips":346,"billed":84534,"perRead":42267,"share":0.001142751899517692},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\providers.ts","label":"src/core/ai/providers.ts","kind":"read","tool":"Read","selfTokens":1029,"reads":1,"trips":130,"billed":74877,"perRead":74877,"share":0.0010122098236142062},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\install-run.mjs","label":".preview/meeting-e2e/install-run.mjs","kind":"write","tool":"Write","selfTokens":2009,"reads":1,"trips":80,"billed":72683,"perRead":72683,"share":0.0009825463494758553},{"attr":"file:D:\\ide\\mdreader\\node_modules\\@codemirror\\view\\dist\\index.d.ts","label":"node_modules/@codemirror/view/dist/index.d.ts","kind":"search","tool":"Grep","selfTokens":596,"reads":1,"trips":264,"billed":70250,"perRead":70250,"share":0.0009496616176718117},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\host.ts","label":"src/core/ai/host.ts","kind":"read","tool":"Read","selfTokens":746,"reads":1,"trips":180,"billed":67524,"perRead":67524,"share":0.0009128058583154797},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\asr-dl\\listing.txt","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/asr-dl/listing.txt","kind":"read","tool":"Read","selfTokens":1383,"reads":1,"trips":86,"billed":66664,"perRead":66664,"share":0.0009011864760663091},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\transcript.txt","label":".preview/meeting-e2e/transcript.txt","kind":"write","tool":"Write","selfTokens":3597,"reads":1,"trips":34,"billed":60966,"perRead":60966,"share":0.0008241563862792705},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\modal.ts","label":"src/ui/modal.ts","kind":"read","tool":"Read","selfTokens":603,"reads":1,"trips":174,"billed":52815,"perRead":52815,"share":0.0007139667611067103},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--ide-seeinp\\cc091d1f-55a9-411f-b65f-500cabdad76d\\tasks\\b3dlkh3s1.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/D--ide-seeinp/cc091d1f-55a9-411f-b65f-500cabdad76d/tasks/b3dlkh3s1.output","kind":"read","tool":"Read","selfTokens":932,"reads":1,"trips":96,"billed":50226,"perRead":50226,"share":0.0006789711410084265},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\asr-dl\\pkg\\licenses\\notice.txt","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/asr-dl/pkg/licenses/notice.txt","kind":"write","tool":"Write","selfTokens":471,"reads":1,"trips":212,"billed":45352,"perRead":45352,"share":0.0006130856668219913},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\wire-probe.mjs","label":".preview/meeting-e2e/wire-probe.mjs","kind":"write","tool":"Write","selfTokens":799,"reads":1,"trips":116,"billed":41658,"perRead":41658,"share":0.0005631452968088524},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\asr-dl\\repack.py","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/asr-dl/repack.py","kind":"write","tool":"Write","selfTokens":402,"reads":1,"trips":202,"billed":36852,"perRead":36852,"share":0.0004981821600446085},{"attr":"file:D:\\ide\\mdreader\\src\\styles\\widgets.css","label":"src/styles/widgets.css","kind":"read","tool":"Read","selfTokens":519,"reads":1,"trips":134,"billed":35212,"perRead":35212,"share":0.0004760011480803136},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\types.ts","label":"src/core/ai/types.ts","kind":"read","tool":"Read","selfTokens":1196,"reads":1,"trips":40,"billed":26005,"perRead":26005,"share":0.0003515410191195741},{"attr":"file:D:\\ide\\mdreader\\desktop\\MainForm.cs","label":"desktop/MainForm.cs","kind":"search","tool":"Grep","selfTokens":1430,"reads":3,"trips":82,"billed":24847,"perRead":8282,"share":0.00033588447790596204},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\repro.mjs","label":".preview/meeting-e2e/repro.mjs","kind":"write","tool":"Write","selfTokens":1089,"reads":2,"trips":88,"billed":22428,"perRead":11214,"share":0.00030319135960694304},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\asr-dl\\netdisk-probe.mjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/asr-dl/netdisk-probe.mjs","kind":"write","tool":"Write","selfTokens":593,"reads":1,"trips":80,"billed":21503,"perRead":21503,"share":0.00029067748030809287},{"attr":"file:D:\\ide\\mdreader\\src\\styles","label":"src/styles","kind":"search","tool":"Grep","selfTokens":315,"reads":2,"trips":266,"billed":21164,"perRead":10582,"share":0.00028610449831588646},{"attr":"file:D:\\ide\\mdreader\\desktop\\Workfile.cs","label":"desktop/Workfile.cs","kind":"read","tool":"Read","selfTokens":730,"reads":1,"trips":44,"billed":17531,"perRead":17531,"share":0.00023699551935247792},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\tiny.txt","label":".preview/meeting-e2e/tiny.txt","kind":"write","tool":"Write","selfTokens":258,"reads":1,"trips":138,"billed":15927,"perRead":15927,"share":0.00021530275495554158},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\close-dialog.ps1","label":".preview/meeting-e2e/close-dialog.ps1","kind":"write","tool":"Write","selfTokens":825,"reads":2,"trips":58,"billed":12033,"perRead":6017,"share":0.00016266604656989142},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--ide-seeinp\\dcbc3b58-b81e-4616-9f9a-b828aba28ab0\\tasks\\b7gztz8ce.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/D--ide-seeinp/dcbc3b58-b81e-4616-9f9a-b828aba28ab0/tasks/b7gztz8ce.output","kind":"read","tool":"Read","selfTokens":235,"reads":1,"trips":80,"billed":10513,"perRead":10513,"share":0.00014211594240579384},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--ide-seeinp\\4dd50fc8-4225-42de-b0a0-6bc5f882dcb0\\tasks\\bcom5pn1a.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/D--ide-seeinp/4dd50fc8-4225-42de-b0a0-6bc5f882dcb0/tasks/bcom5pn1a.output","kind":"read","tool":"Read","selfTokens":202,"reads":1,"trips":90,"billed":10198,"perRead":10198,"share":0.00013786550823216228},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\peek.mjs","label":".preview/meeting-e2e/peek.mjs","kind":"write","tool":"Write","selfTokens":335,"reads":1,"trips":66,"billed":9990,"perRead":9990,"share":0.00013504839105242002},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\minutes.md","label":".preview/meeting-e2e/minutes.md","kind":"search","tool":"Grep","selfTokens":154,"reads":1,"trips":128,"billed":8834,"perRead":8834,"share":0.00011942411140202336},{"attr":"file:D:\\ide\\mdreader\\desktop\\Program.cs","label":"desktop/Program.cs","kind":"read","tool":"Read","selfTokens":684,"reads":2,"trips":32,"billed":7778,"perRead":3889,"share":0.00010513900542591259},{"attr":"file:/d/ide/mdreader/src","label":"/d/ide/mdreader/src","kind":"search","tool":"Grep","selfTokens":101,"reads":1,"trips":132,"billed":7457,"perRead":7457,"share":0.00010081239759080161},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\agenda.md","label":".preview/meeting-e2e/agenda.md","kind":"write","tool":"Write","selfTokens":416,"reads":1,"trips":32,"billed":6635,"perRead":6635,"share":0.00008969808251788277},{"attr":"file:D:\\ide\\mdreader","label":"D:/ide/mdreader","kind":"search","tool":"Grep","selfTokens":70,"reads":1,"trips":126,"billed":4941,"perRead":4941,"share":0.00006678921355308463},{"attr":"file:mdreader 架构 技术栈 设置中配置模型 调用 LLM","label":"mdreader 架构 技术栈 设置中配置模型 调用 LLM","kind":"other","tool":"SearchKnowledge","selfTokens":65,"reads":1,"trips":134,"billed":4867,"perRead":4867,"share":0.00006579786240937874},{"attr":"file:D:\\ide\\mdreader\\.preview\\meeting-e2e\\events.ps1","label":".preview/meeting-e2e/events.ps1","kind":"write","tool":"Write","selfTokens":185,"reads":1,"trips":52,"billed":4346,"perRead":4346,"share":0.000058756792311792385},{"attr":"file:D:\\ide\\mdreader\\src","label":"src","kind":"search","tool":"Grep","selfTokens":37,"reads":1,"trips":260,"billed":4292,"perRead":4292,"share":0.00005801507936592392},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--ide-seeinp\\4dd50fc8-4225-42de-b0a0-6bc5f882dcb0\\tasks\\b392o01xl.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/D--ide-seeinp/4dd50fc8-4225-42de-b0a0-6bc5f882dcb0/tasks/b392o01xl.output","kind":"read","tool":"Read","selfTokens":78,"reads":1,"trips":90,"billed":3938,"perRead":3938,"share":0.00005323519624806265},{"attr":"file:D:\\ide\\mdreader\\tmp-dom.ts","label":"tmp-dom.ts","kind":"write","tool":"Write","selfTokens":107,"reads":1,"trips":70,"billed":3784,"perRead":3784,"share":0.00005115764960363901},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\C--Users-zhaobingxiang\\0c13f3e1-4efb-4933-a106-4b579d0e07eb\\tasks\\b544r4vbi.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/C--Users-zhaobingxiang/0c13f3e1-4efb-4933-a106-4b579d0e07eb/tasks/b544r4vbi.output","kind":"read","tool":"Read","selfTokens":569,"reads":1,"trips":12,"billed":3405,"perRead":3405,"share":0.00004603197069424515},{"attr":"file:/tmp/asr-dl/listing.txt","label":"/tmp/asr-dl/listing.txt","kind":"read","tool":"Read","selfTokens":31,"reads":1,"trips":88,"billed":1530,"perRead":1530,"share":0.000020679029219144245},{"attr":"file:C:\\Users\\ZHAOBI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--ide-seeinp\\50559864-bf6a-4cf1-b1ad-f5c070e6ac4f\\tasks\\bcmezbqse.output","label":"C:/Users/ZHAOBI~1/AppData/Local/Temp/qoder-cli-cn/D--ide-seeinp/50559864-bf6a-4cf1-b1ad-f5c070e6ac4f/tasks/bcmezbqse.output","kind":"read","tool":"Read","selfTokens":59,"reads":1,"trips":10,"billed":268,"perRead":268,"share":0.000003620946438587902},{"attr":"file:SenseVoiceSmall model license non-commercial CC BY-NC 4.0 FunAudioLLM ModelScope","label":"SenseVoiceSmall model license non-commercial CC BY-NC 4.0 FunAudioLLM ModelScope","kind":"other","tool":"WebSearch","selfTokens":3394,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0}],"byAttr":[{"attr":"attachment","tokens":18606452,"share":0.2515273376394273},{"attr":"system","tokens":14329664,"share":0.19371249647257224},{"attr":"tool_result|Read","tokens":11739662,"share":0.15870011113885568},{"attr":"assistant_thinking","tokens":9790272,"share":0.1323476990535036},{"attr":"tool_result|Bash","tokens":5535086,"share":0.07482487301369635},{"attr":"compact_summary","tokens":3225630,"share":0.043604994475947075},{"attr":"user_input","tokens":3152842,"share":0.04262102628225085},{"attr":"tool_use|Edit","tokens":2628098,"share":0.035527378674665475},{"attr":"tool_use|Write","tokens":2087383,"share":0.028217840132760116},{"attr":"tool_use|Bash","tokens":1373939,"share":0.018573303977720296},{"attr":"tool_result|Grep","tokens":431072,"share":0.0058273578060333425},{"attr":"tool_result|Edit","tokens":322103,"share":0.004354282518706458},{"attr":"assistant_text","tokens":277273,"share":0.0037482489667583904},{"attr":"tool_use|Read","tokens":159043,"share":0.002149993507347126},{"attr":"tool_use|AskUserQuestion","tokens":62465,"share":0.0008444136486422075},{"attr":"tool_use|TaskCreate","tokens":57087,"share":0.000771722797365125},{"attr":"tool_result|Write","tokens":44676,"share":0.0006039429723210033},{"attr":"tool_use|Grep","tokens":41529,"share":0.0005614060758813586},{"attr":"tool_result|Agent","tokens":31468,"share":0.00042539133916319},{"attr":"tool_use|Agent","tokens":20956,"share":0.00028329539130783567},{"attr":"tool_result|AskUserQuestion","tokens":13683,"share":0.00018496679922638834},{"attr":"tool_result|mcp_call","tokens":11697,"share":0.00015811827430736494},{"attr":"tool_result|TaskCreate","tokens":9109,"share":0.00012314191618216573},{"attr":"tool_use|mcp_call","tokens":8045,"share":0.00010875727899861035},{"attr":"tool_use|TaskUpdate","tokens":6389,"share":0.00008636982165456287},{"attr":"tool_result|TaskUpdate","tokens":3383,"share":0.00004573216230413732},{"attr":"tool_use|SearchKnowledge","tokens":3145,"share":0.00004251554186452165},{"attr":"tool_result|SearchKnowledge","tokens":1722,"share":0.000023282320544857095}],"byRequest":[{"index":1,"time":"14:21","ratio":0.17769,"inputTokens":35538,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.023,"originalCredits":1.023,"afterCompact":false},{"index":2,"time":"14:21","ratio":0.18804,"inputTokens":37608,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.148,"originalCredits":0.148,"afterCompact":false},{"index":3,"time":"14:22","ratio":0.194085,"inputTokens":38817,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":4,"time":"14:22","ratio":0.21879,"inputTokens":43758,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":5,"time":"14:23","ratio":0.29175,"inputTokens":58350,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.591,"originalCredits":0.591,"afterCompact":false},{"index":6,"time":"14:24","ratio":0.30621,"inputTokens":61242,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":7,"time":"14:57","ratio":0.31943,"inputTokens":63886,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.872,"originalCredits":1.872,"afterCompact":false},{"index":8,"time":"14:58","ratio":0.33122,"inputTokens":66244,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":9,"time":"14:58","ratio":0.33856,"inputTokens":67712,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.254,"originalCredits":0.254,"afterCompact":false},{"index":10,"time":"14:59","ratio":0.34932,"inputTokens":69864,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.275,"originalCredits":0.275,"afterCompact":false},{"index":11,"time":"15:00","ratio":0.356765,"inputTokens":71353,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.241,"originalCredits":0.241,"afterCompact":false},{"index":12,"time":"15:00","ratio":0.365825,"inputTokens":73165,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":13,"time":"15:01","ratio":0.381065,"inputTokens":76213,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":14,"time":"15:02","ratio":0.387985,"inputTokens":77597,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":15,"time":"15:02","ratio":0.394555,"inputTokens":78911,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.298,"originalCredits":0.298,"afterCompact":false},{"index":16,"time":"15:11","ratio":0.403915,"inputTokens":80783,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.262,"originalCredits":2.262,"afterCompact":false},{"index":17,"time":"15:13","ratio":0.406505,"inputTokens":81301,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":18,"time":"15:14","ratio":0.41872,"inputTokens":83744,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.276,"originalCredits":0.276,"afterCompact":false},{"index":19,"time":"15:14","ratio":0.42132,"inputTokens":84264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":20,"time":"15:14","ratio":0.42428,"inputTokens":84856,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":21,"time":"15:15","ratio":0.43227,"inputTokens":86454,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.26,"originalCredits":0.26,"afterCompact":false},{"index":22,"time":"15:17","ratio":0.43511,"inputTokens":87022,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.243,"originalCredits":0.243,"afterCompact":false},{"index":23,"time":"15:18","ratio":0.44135,"inputTokens":88270,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":24,"time":"15:18","ratio":0.444375,"inputTokens":88875,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":25,"time":"15:18","ratio":0.445795,"inputTokens":89159,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.213,"originalCredits":0.213,"afterCompact":false},{"index":26,"time":"15:19","ratio":0.45766,"inputTokens":91532,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.314,"originalCredits":0.314,"afterCompact":false},{"index":27,"time":"15:21","ratio":0.462375,"inputTokens":92475,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":28,"time":"15:21","ratio":0.46614,"inputTokens":93228,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":29,"time":"15:21","ratio":0.47003,"inputTokens":94006,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.256,"originalCredits":0.256,"afterCompact":false},{"index":30,"time":"15:22","ratio":0.47493,"inputTokens":94986,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.248,"originalCredits":0.248,"afterCompact":false},{"index":31,"time":"15:22","ratio":0.480415,"inputTokens":96083,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.306,"originalCredits":0.306,"afterCompact":false},{"index":32,"time":"15:22","ratio":0.486105,"inputTokens":97221,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":33,"time":"15:22","ratio":0.48947,"inputTokens":97894,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.25,"originalCredits":0.25,"afterCompact":false},{"index":34,"time":"15:23","ratio":0.498165,"inputTokens":99633,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":35,"time":"15:23","ratio":0.50937,"inputTokens":101874,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":36,"time":"15:24","ratio":0.514675,"inputTokens":102935,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.269,"originalCredits":0.269,"afterCompact":false},{"index":37,"time":"15:24","ratio":0.51594,"inputTokens":103188,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.252,"originalCredits":0.252,"afterCompact":false},{"index":38,"time":"15:24","ratio":0.51823,"inputTokens":103646,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":39,"time":"15:27","ratio":0.543425,"inputTokens":108685,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.393,"originalCredits":0.393,"afterCompact":false},{"index":40,"time":"15:27","ratio":0.55753,"inputTokens":111506,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.395,"originalCredits":0.395,"afterCompact":false},{"index":41,"time":"15:28","ratio":0.571865,"inputTokens":114373,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.39,"originalCredits":0.39,"afterCompact":false},{"index":42,"time":"15:28","ratio":0.57743,"inputTokens":115486,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.313,"originalCredits":0.313,"afterCompact":false},{"index":43,"time":"15:28","ratio":0.581445,"inputTokens":116289,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.291,"originalCredits":0.291,"afterCompact":false},{"index":44,"time":"15:28","ratio":0.595015,"inputTokens":119003,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.357,"originalCredits":0.357,"afterCompact":false},{"index":45,"time":"15:29","ratio":0.59742,"inputTokens":119484,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.327,"originalCredits":0.327,"afterCompact":false},{"index":46,"time":"15:29","ratio":0.60214,"inputTokens":120428,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":47,"time":"15:29","ratio":0.62452,"inputTokens":124904,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.407,"originalCredits":0.407,"afterCompact":false},{"index":48,"time":"15:30","ratio":0.644115,"inputTokens":128823,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.581,"originalCredits":0.581,"afterCompact":false},{"index":49,"time":"15:30","ratio":0.6678,"inputTokens":133560,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.423,"originalCredits":0.423,"afterCompact":false},{"index":50,"time":"15:32","ratio":0.672405,"inputTokens":134481,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.873,"originalCredits":0.873,"afterCompact":false},{"index":51,"time":"15:34","ratio":0.718555,"inputTokens":143711,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.08,"originalCredits":1.08,"afterCompact":false},{"index":52,"time":"15:34","ratio":0.76256,"inputTokens":152512,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.623,"originalCredits":0.623,"afterCompact":false},{"index":53,"time":"15:34","ratio":0.76776,"inputTokens":153552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":54,"time":"15:34","ratio":0.77057,"inputTokens":154114,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.372,"originalCredits":0.372,"afterCompact":false},{"index":55,"time":"15:35","ratio":0.77422,"inputTokens":154844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.41,"originalCredits":0.41,"afterCompact":false},{"index":56,"time":"15:35","ratio":0.779835,"inputTokens":155967,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.416,"originalCredits":0.416,"afterCompact":false},{"index":57,"time":"15:35","ratio":0.78749,"inputTokens":157498,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.422,"originalCredits":0.422,"afterCompact":false},{"index":58,"time":"15:36","ratio":0.798475,"inputTokens":159695,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.451,"originalCredits":0.451,"afterCompact":false},{"index":59,"time":"15:36","ratio":0.80417,"inputTokens":160834,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.409,"originalCredits":0.409,"afterCompact":false},{"index":60,"time":"15:36","ratio":0.807585,"inputTokens":161517,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":61,"time":"15:36","ratio":0.808615,"inputTokens":161723,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":62,"time":"15:37","ratio":0.81083,"inputTokens":162166,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.425,"originalCredits":0.425,"afterCompact":false},{"index":63,"time":"15:37","ratio":0.81542,"inputTokens":163084,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.482,"originalCredits":0.482,"afterCompact":false},{"index":64,"time":"15:37","ratio":0.82376,"inputTokens":164752,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.427,"originalCredits":0.427,"afterCompact":false},{"index":65,"time":"15:38","ratio":0.82543,"inputTokens":165086,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.399,"originalCredits":0.399,"afterCompact":false},{"index":66,"time":"15:38","ratio":0.827615,"inputTokens":165523,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.418,"originalCredits":0.418,"afterCompact":false},{"index":67,"time":"15:38","ratio":0.83246,"inputTokens":166492,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.411,"originalCredits":0.411,"afterCompact":false},{"index":68,"time":"15:38","ratio":0.83389,"inputTokens":166778,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":69,"time":"15:41","ratio":0.222715,"inputTokens":44543,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.672,"originalCredits":0.672,"afterCompact":true},{"index":70,"time":"15:41","ratio":0.237795,"inputTokens":47559,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.198,"originalCredits":0.198,"afterCompact":false},{"index":71,"time":"15:41","ratio":0.244745,"inputTokens":48949,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":72,"time":"15:41","ratio":0.25568,"inputTokens":51136,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.176,"originalCredits":0.176,"afterCompact":false},{"index":73,"time":"15:42","ratio":0.262475,"inputTokens":52495,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":74,"time":"15:42","ratio":0.26537,"inputTokens":53074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.142,"originalCredits":0.142,"afterCompact":false},{"index":75,"time":"15:42","ratio":0.300015,"inputTokens":60003,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":76,"time":"15:42","ratio":0.324355,"inputTokens":64871,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":77,"time":"15:42","ratio":0.354305,"inputTokens":70861,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":78,"time":"15:42","ratio":0.366925,"inputTokens":73385,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.237,"originalCredits":0.237,"afterCompact":false},{"index":79,"time":"15:43","ratio":0.373545,"inputTokens":74709,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":80,"time":"15:43","ratio":0.39104,"inputTokens":78208,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":81,"time":"15:43","ratio":0.407435,"inputTokens":81487,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.274,"originalCredits":0.274,"afterCompact":false},{"index":82,"time":"15:44","ratio":0.45319,"inputTokens":90638,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.556,"originalCredits":0.556,"afterCompact":false},{"index":83,"time":"15:44","ratio":0.46841,"inputTokens":93682,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.33,"originalCredits":0.33,"afterCompact":false},{"index":84,"time":"15:45","ratio":0.47573,"inputTokens":95146,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.346,"originalCredits":0.346,"afterCompact":false},{"index":85,"time":"15:45","ratio":0.493195,"inputTokens":98639,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.333,"originalCredits":0.333,"afterCompact":false},{"index":86,"time":"15:45","ratio":0.49538,"inputTokens":99076,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.254,"originalCredits":0.254,"afterCompact":false},{"index":87,"time":"15:45","ratio":0.49755,"inputTokens":99510,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":88,"time":"15:45","ratio":0.49994,"inputTokens":99988,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.269,"originalCredits":0.269,"afterCompact":false},{"index":89,"time":"15:46","ratio":0.503055,"inputTokens":100611,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":90,"time":"15:46","ratio":0.50775,"inputTokens":101550,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":91,"time":"15:46","ratio":0.50918,"inputTokens":101836,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":92,"time":"15:46","ratio":0.510275,"inputTokens":102055,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.261,"originalCredits":0.261,"afterCompact":false},{"index":93,"time":"15:46","ratio":0.51281,"inputTokens":102562,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.254,"originalCredits":0.254,"afterCompact":false},{"index":94,"time":"15:47","ratio":0.514065,"inputTokens":102813,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":95,"time":"15:47","ratio":0.522445,"inputTokens":104489,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.409,"originalCredits":0.409,"afterCompact":false},{"index":96,"time":"15:48","ratio":0.54134,"inputTokens":108268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.418,"originalCredits":0.418,"afterCompact":false},{"index":97,"time":"15:49","ratio":0.548335,"inputTokens":109667,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.491,"originalCredits":0.491,"afterCompact":false},{"index":98,"time":"15:49","ratio":0.56618,"inputTokens":113236,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.357,"originalCredits":0.357,"afterCompact":false},{"index":99,"time":"15:49","ratio":0.567645,"inputTokens":113529,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":100,"time":"15:49","ratio":0.57126,"inputTokens":114252,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":101,"time":"15:49","ratio":0.57242,"inputTokens":114484,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":102,"time":"15:50","ratio":0.574165,"inputTokens":114833,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.291,"originalCredits":0.291,"afterCompact":false},{"index":103,"time":"15:50","ratio":0.576705,"inputTokens":115341,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.408,"originalCredits":0.408,"afterCompact":false},{"index":104,"time":"15:51","ratio":0.58849,"inputTokens":117698,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":105,"time":"15:52","ratio":0.595955,"inputTokens":119191,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.485,"originalCredits":0.485,"afterCompact":false},{"index":106,"time":"15:52","ratio":0.612625,"inputTokens":122525,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.372,"originalCredits":0.372,"afterCompact":false},{"index":107,"time":"15:52","ratio":0.614135,"inputTokens":122827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":108,"time":"15:52","ratio":0.6159,"inputTokens":123180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.291,"originalCredits":0.291,"afterCompact":false},{"index":109,"time":"15:52","ratio":0.616785,"inputTokens":123357,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":110,"time":"15:53","ratio":0.619225,"inputTokens":123845,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.427,"originalCredits":0.427,"afterCompact":false},{"index":111,"time":"15:53","ratio":0.631065,"inputTokens":126213,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.366,"originalCredits":0.366,"afterCompact":false},{"index":112,"time":"15:53","ratio":0.63345,"inputTokens":126690,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.306,"originalCredits":0.306,"afterCompact":false},{"index":113,"time":"15:54","ratio":0.634775,"inputTokens":126955,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":114,"time":"15:54","ratio":0.636325,"inputTokens":127265,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.298,"originalCredits":0.298,"afterCompact":false},{"index":115,"time":"15:54","ratio":0.63814,"inputTokens":127628,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":116,"time":"15:54","ratio":0.641575,"inputTokens":128315,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":117,"time":"15:54","ratio":0.64292,"inputTokens":128584,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.308,"originalCredits":0.308,"afterCompact":false},{"index":118,"time":"15:55","ratio":0.644505,"inputTokens":128901,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.301,"originalCredits":0.301,"afterCompact":false},{"index":119,"time":"15:55","ratio":0.64741,"inputTokens":129482,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":120,"time":"15:55","ratio":0.64838,"inputTokens":129676,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.303,"originalCredits":0.303,"afterCompact":false},{"index":121,"time":"15:56","ratio":0.64938,"inputTokens":129876,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.49,"originalCredits":0.49,"afterCompact":false},{"index":122,"time":"15:57","ratio":0.665995,"inputTokens":133199,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.43,"originalCredits":0.43,"afterCompact":false},{"index":123,"time":"15:57","ratio":0.67037,"inputTokens":134074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":124,"time":"15:57","ratio":0.67404,"inputTokens":134808,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.328,"originalCredits":0.328,"afterCompact":false},{"index":125,"time":"15:57","ratio":0.67533,"inputTokens":135066,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":126,"time":"15:58","ratio":0.677665,"inputTokens":135533,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.323,"originalCredits":0.323,"afterCompact":false},{"index":127,"time":"15:58","ratio":0.67877,"inputTokens":135754,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.314,"originalCredits":0.314,"afterCompact":false},{"index":128,"time":"15:58","ratio":0.67948,"inputTokens":135896,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":129,"time":"15:58","ratio":0.68058,"inputTokens":136116,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.333,"originalCredits":0.333,"afterCompact":false},{"index":130,"time":"15:59","ratio":0.68286,"inputTokens":136572,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.469,"originalCredits":0.469,"afterCompact":false},{"index":131,"time":"15:59","ratio":0.695925,"inputTokens":139185,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":132,"time":"15:59","ratio":0.698275,"inputTokens":139655,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":133,"time":"16:00","ratio":0.699535,"inputTokens":139907,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":134,"time":"16:00","ratio":0.70172,"inputTokens":140344,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.346,"originalCredits":0.346,"afterCompact":false},{"index":135,"time":"16:01","ratio":0.703905,"inputTokens":140781,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.626,"originalCredits":0.626,"afterCompact":false},{"index":136,"time":"16:01","ratio":0.730545,"inputTokens":146109,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.483,"originalCredits":0.483,"afterCompact":false},{"index":137,"time":"16:01","ratio":0.732695,"inputTokens":146539,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.387,"originalCredits":0.387,"afterCompact":false},{"index":138,"time":"16:02","ratio":0.73713,"inputTokens":147426,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.4,"originalCredits":0.4,"afterCompact":false},{"index":139,"time":"16:02","ratio":0.741555,"inputTokens":148311,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.378,"originalCredits":0.378,"afterCompact":false},{"index":140,"time":"16:02","ratio":0.74398,"inputTokens":148796,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.355,"originalCredits":0.355,"afterCompact":false},{"index":141,"time":"16:03","ratio":0.745465,"inputTokens":149093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.35,"originalCredits":0.35,"afterCompact":false},{"index":142,"time":"16:03","ratio":0.74662,"inputTokens":149324,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.347,"originalCredits":0.347,"afterCompact":false},{"index":143,"time":"16:03","ratio":0.74834,"inputTokens":149668,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.353,"originalCredits":0.353,"afterCompact":false},{"index":144,"time":"16:04","ratio":0.74955,"inputTokens":149910,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":145,"time":"16:06","ratio":0.75162,"inputTokens":150324,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.824,"originalCredits":0.824,"afterCompact":false},{"index":146,"time":"16:06","ratio":0.793505,"inputTokens":158701,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.615,"originalCredits":0.615,"afterCompact":false},{"index":147,"time":"16:06","ratio":0.797805,"inputTokens":159561,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":148,"time":"16:07","ratio":0.80008,"inputTokens":160016,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.394,"originalCredits":0.394,"afterCompact":false},{"index":149,"time":"16:07","ratio":0.802565,"inputTokens":160513,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":150,"time":"16:07","ratio":0.804715,"inputTokens":160943,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.387,"originalCredits":0.387,"afterCompact":false},{"index":151,"time":"16:07","ratio":0.806555,"inputTokens":161311,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":152,"time":"16:08","ratio":0.80826,"inputTokens":161652,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.379,"originalCredits":0.379,"afterCompact":false},{"index":153,"time":"16:08","ratio":0.809775,"inputTokens":161955,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":154,"time":"16:08","ratio":0.811685,"inputTokens":162337,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.381,"originalCredits":0.381,"afterCompact":false},{"index":155,"time":"16:08","ratio":0.81274,"inputTokens":162548,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":156,"time":"16:08","ratio":0.81538,"inputTokens":163076,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":157,"time":"16:09","ratio":0.817625,"inputTokens":163525,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.389,"originalCredits":0.389,"afterCompact":false},{"index":158,"time":"16:09","ratio":0.818965,"inputTokens":163793,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":159,"time":"16:09","ratio":0.820575,"inputTokens":164115,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.391,"originalCredits":0.391,"afterCompact":false},{"index":160,"time":"16:10","ratio":0.82239,"inputTokens":164478,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.415,"originalCredits":0.415,"afterCompact":false},{"index":161,"time":"16:10","ratio":0.826005,"inputTokens":165201,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":162,"time":"16:10","ratio":0.830175,"inputTokens":166035,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.411,"originalCredits":0.411,"afterCompact":false},{"index":163,"time":"16:11","ratio":0.83217,"inputTokens":166434,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":164,"time":"16:11","ratio":0.83341,"inputTokens":166682,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":165,"time":"16:13","ratio":0.219335,"inputTokens":43867,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.656,"originalCredits":0.656,"afterCompact":true},{"index":166,"time":"16:14","ratio":0.240125,"inputTokens":48025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.221,"originalCredits":0.221,"afterCompact":false},{"index":167,"time":"16:14","ratio":0.241035,"inputTokens":48207,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.13,"originalCredits":0.13,"afterCompact":false},{"index":168,"time":"16:14","ratio":0.242845,"inputTokens":48569,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":169,"time":"16:14","ratio":0.247135,"inputTokens":49427,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.139,"originalCredits":0.139,"afterCompact":false},{"index":170,"time":"16:14","ratio":0.253075,"inputTokens":50615,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":171,"time":"16:15","ratio":0.258175,"inputTokens":51635,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":172,"time":"16:15","ratio":0.27881,"inputTokens":55762,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":173,"time":"16:15","ratio":0.32516,"inputTokens":65032,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.395,"originalCredits":0.395,"afterCompact":false},{"index":174,"time":"16:15","ratio":0.32656,"inputTokens":65312,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":175,"time":"16:15","ratio":0.338745,"inputTokens":67749,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.22,"originalCredits":0.22,"afterCompact":false},{"index":176,"time":"16:15","ratio":0.34302,"inputTokens":68604,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":177,"time":"16:15","ratio":0.34629,"inputTokens":69258,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":178,"time":"16:16","ratio":0.35124,"inputTokens":70248,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.189,"originalCredits":0.189,"afterCompact":false},{"index":179,"time":"16:16","ratio":0.35277,"inputTokens":70554,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.173,"originalCredits":0.173,"afterCompact":false},{"index":180,"time":"16:16","ratio":0.357915,"inputTokens":71583,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.208,"originalCredits":0.208,"afterCompact":false},{"index":181,"time":"16:16","ratio":0.361445,"inputTokens":72289,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.185,"originalCredits":0.185,"afterCompact":false},{"index":182,"time":"16:16","ratio":0.363825,"inputTokens":72765,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.188,"originalCredits":0.188,"afterCompact":false},{"index":183,"time":"16:17","ratio":0.3683,"inputTokens":73660,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":184,"time":"16:17","ratio":0.37194,"inputTokens":74388,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":185,"time":"16:17","ratio":0.37481,"inputTokens":74962,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.191,"originalCredits":0.191,"afterCompact":false},{"index":186,"time":"16:17","ratio":0.375795,"inputTokens":75159,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":187,"time":"16:17","ratio":0.3775,"inputTokens":75500,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.188,"originalCredits":0.188,"afterCompact":false},{"index":188,"time":"16:18","ratio":0.37859,"inputTokens":75718,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":189,"time":"16:18","ratio":0.410945,"inputTokens":82189,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":190,"time":"16:18","ratio":0.417035,"inputTokens":83407,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":191,"time":"16:18","ratio":0.421795,"inputTokens":84359,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.234,"originalCredits":0.234,"afterCompact":false},{"index":192,"time":"16:19","ratio":0.423945,"inputTokens":84789,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":193,"time":"16:19","ratio":0.43343,"inputTokens":86686,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.25,"originalCredits":0.25,"afterCompact":false},{"index":194,"time":"16:19","ratio":0.43976,"inputTokens":87952,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.244,"originalCredits":0.244,"afterCompact":false},{"index":195,"time":"16:19","ratio":0.44261,"inputTokens":88522,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.234,"originalCredits":0.234,"afterCompact":false},{"index":196,"time":"16:20","ratio":0.44477,"inputTokens":88954,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":197,"time":"16:20","ratio":0.446115,"inputTokens":89223,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.217,"originalCredits":0.217,"afterCompact":false},{"index":198,"time":"16:20","ratio":0.4474,"inputTokens":89480,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.215,"originalCredits":0.215,"afterCompact":false},{"index":199,"time":"16:20","ratio":0.448465,"inputTokens":89693,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.213,"originalCredits":0.213,"afterCompact":false},{"index":200,"time":"16:20","ratio":0.449455,"inputTokens":89891,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":201,"time":"16:21","ratio":0.45288,"inputTokens":90576,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.323,"originalCredits":0.323,"afterCompact":false},{"index":202,"time":"16:21","ratio":0.46173,"inputTokens":92346,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":203,"time":"16:21","ratio":0.4642,"inputTokens":92840,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":204,"time":"16:21","ratio":0.46601,"inputTokens":93202,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.232,"originalCredits":0.232,"afterCompact":false},{"index":205,"time":"16:22","ratio":0.46927,"inputTokens":93854,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.233,"originalCredits":0.233,"afterCompact":false},{"index":206,"time":"16:22","ratio":0.47487,"inputTokens":94974,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":207,"time":"16:22","ratio":0.476415,"inputTokens":95283,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.231,"originalCredits":0.231,"afterCompact":false},{"index":208,"time":"16:23","ratio":0.47877,"inputTokens":95754,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":209,"time":"16:23","ratio":0.486875,"inputTokens":97375,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.265,"originalCredits":0.265,"afterCompact":false},{"index":210,"time":"16:23","ratio":0.48935,"inputTokens":97870,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":211,"time":"16:23","ratio":0.49222,"inputTokens":98444,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.243,"originalCredits":0.243,"afterCompact":false},{"index":212,"time":"16:24","ratio":0.49324,"inputTokens":98648,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.232,"originalCredits":0.232,"afterCompact":false},{"index":213,"time":"16:24","ratio":0.502105,"inputTokens":100421,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.336,"originalCredits":0.336,"afterCompact":false},{"index":214,"time":"16:24","ratio":0.50791,"inputTokens":101582,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":215,"time":"16:24","ratio":0.51019,"inputTokens":102038,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":216,"time":"16:25","ratio":0.51168,"inputTokens":102336,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":217,"time":"16:25","ratio":0.51935,"inputTokens":103870,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":218,"time":"16:26","ratio":0.5232,"inputTokens":104640,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.269,"originalCredits":0.269,"afterCompact":false},{"index":219,"time":"16:26","ratio":0.527015,"inputTokens":105403,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.261,"originalCredits":0.261,"afterCompact":false},{"index":220,"time":"16:26","ratio":0.52816,"inputTokens":105632,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":221,"time":"16:26","ratio":0.53201,"inputTokens":106402,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.284,"originalCredits":0.284,"afterCompact":false},{"index":222,"time":"16:27","ratio":0.54732,"inputTokens":109464,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.338,"originalCredits":0.338,"afterCompact":false},{"index":223,"time":"16:27","ratio":0.549515,"inputTokens":109903,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":224,"time":"16:27","ratio":0.569345,"inputTokens":113869,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.358,"originalCredits":0.358,"afterCompact":false},{"index":225,"time":"16:28","ratio":0.581735,"inputTokens":116347,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":226,"time":"16:28","ratio":0.58886,"inputTokens":117772,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":227,"time":"16:28","ratio":0.60169,"inputTokens":120338,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":228,"time":"16:28","ratio":0.61055,"inputTokens":122110,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":229,"time":"16:29","ratio":0.612155,"inputTokens":122431,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.527,"originalCredits":0.527,"afterCompact":false},{"index":230,"time":"16:30","ratio":0.632965,"inputTokens":126593,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.521,"originalCredits":0.521,"afterCompact":false},{"index":231,"time":"16:30","ratio":0.64432,"inputTokens":128864,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.354,"originalCredits":0.354,"afterCompact":false},{"index":232,"time":"16:30","ratio":0.645415,"inputTokens":129083,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.308,"originalCredits":0.308,"afterCompact":false},{"index":233,"time":"16:31","ratio":0.646975,"inputTokens":129395,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.327,"originalCredits":0.327,"afterCompact":false},{"index":234,"time":"16:31","ratio":0.65106,"inputTokens":130212,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":235,"time":"16:31","ratio":0.65266,"inputTokens":130532,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":236,"time":"16:31","ratio":0.655565,"inputTokens":131113,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":237,"time":"16:32","ratio":0.65891,"inputTokens":131782,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.342,"originalCredits":0.342,"afterCompact":false},{"index":238,"time":"16:32","ratio":0.66181,"inputTokens":132362,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":239,"time":"16:32","ratio":0.662745,"inputTokens":132549,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":240,"time":"16:33","ratio":0.664315,"inputTokens":132863,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":241,"time":"16:33","ratio":0.66974,"inputTokens":133948,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":242,"time":"16:33","ratio":0.67364,"inputTokens":134728,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.335,"originalCredits":0.335,"afterCompact":false},{"index":243,"time":"16:33","ratio":0.675005,"inputTokens":135001,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":244,"time":"16:34","ratio":0.677205,"inputTokens":135441,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.32,"originalCredits":0.32,"afterCompact":false},{"index":245,"time":"16:34","ratio":0.68108,"inputTokens":136216,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":246,"time":"16:34","ratio":0.685125,"inputTokens":137025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.341,"originalCredits":0.341,"afterCompact":false},{"index":247,"time":"16:34","ratio":0.686685,"inputTokens":137337,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.32,"originalCredits":0.32,"afterCompact":false},{"index":248,"time":"16:35","ratio":0.68779,"inputTokens":137558,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":249,"time":"16:35","ratio":0.690475,"inputTokens":138095,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.354,"originalCredits":0.354,"afterCompact":false},{"index":250,"time":"16:36","ratio":0.70664,"inputTokens":141328,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.503,"originalCredits":0.503,"afterCompact":false},{"index":251,"time":"16:37","ratio":0.71616,"inputTokens":143232,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.408,"originalCredits":0.408,"afterCompact":false},{"index":252,"time":"16:37","ratio":0.71991,"inputTokens":143982,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.347,"originalCredits":0.347,"afterCompact":false},{"index":253,"time":"16:38","ratio":0.724925,"inputTokens":144985,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.355,"originalCredits":0.355,"afterCompact":false},{"index":254,"time":"16:38","ratio":0.727875,"inputTokens":145575,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.389,"originalCredits":0.389,"afterCompact":false},{"index":255,"time":"16:39","ratio":0.732645,"inputTokens":146529,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.48,"originalCredits":0.48,"afterCompact":false},{"index":256,"time":"16:39","ratio":0.74375,"inputTokens":148750,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.407,"originalCredits":0.407,"afterCompact":false},{"index":257,"time":"16:40","ratio":0.74569,"inputTokens":149138,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.436,"originalCredits":0.436,"afterCompact":false},{"index":258,"time":"16:40","ratio":0.75387,"inputTokens":150774,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.402,"originalCredits":0.402,"afterCompact":false},{"index":259,"time":"16:41","ratio":0.756215,"inputTokens":151243,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.476,"originalCredits":0.476,"afterCompact":false},{"index":260,"time":"16:42","ratio":0.76769,"inputTokens":153538,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.461,"originalCredits":0.461,"afterCompact":false},{"index":261,"time":"16:42","ratio":0.77306,"inputTokens":154612,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":262,"time":"16:42","ratio":0.774115,"inputTokens":154823,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":263,"time":"16:43","ratio":0.77647,"inputTokens":155294,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.371,"originalCredits":0.371,"afterCompact":false},{"index":264,"time":"16:43","ratio":0.77828,"inputTokens":155656,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":265,"time":"16:43","ratio":0.79033,"inputTokens":158066,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.425,"originalCredits":0.425,"afterCompact":false},{"index":266,"time":"16:43","ratio":0.795915,"inputTokens":159183,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.389,"originalCredits":0.389,"afterCompact":false},{"index":267,"time":"16:44","ratio":0.80007,"inputTokens":160014,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":268,"time":"16:44","ratio":0.80235,"inputTokens":160470,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.379,"originalCredits":0.379,"afterCompact":false},{"index":269,"time":"16:44","ratio":0.803885,"inputTokens":160777,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":270,"time":"16:44","ratio":0.808775,"inputTokens":161755,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":271,"time":"16:45","ratio":0.8128,"inputTokens":162560,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.413,"originalCredits":0.413,"afterCompact":false},{"index":272,"time":"16:45","ratio":0.820845,"inputTokens":164169,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":273,"time":"16:47","ratio":0.229465,"inputTokens":45893,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.704,"originalCredits":0.704,"afterCompact":true},{"index":274,"time":"16:47","ratio":0.231385,"inputTokens":46277,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.117,"originalCredits":0.117,"afterCompact":false},{"index":275,"time":"16:47","ratio":0.234195,"inputTokens":46839,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":276,"time":"16:48","ratio":0.23801,"inputTokens":47602,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":277,"time":"16:48","ratio":0.24191,"inputTokens":48382,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":278,"time":"16:48","ratio":0.255525,"inputTokens":51105,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.199,"originalCredits":0.199,"afterCompact":false},{"index":279,"time":"16:49","ratio":0.278345,"inputTokens":55669,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.295,"originalCredits":0.295,"afterCompact":false},{"index":280,"time":"16:49","ratio":0.28328,"inputTokens":56656,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":281,"time":"16:49","ratio":0.28458,"inputTokens":56916,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.144,"originalCredits":0.144,"afterCompact":false},{"index":282,"time":"16:50","ratio":0.28792,"inputTokens":57584,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":283,"time":"16:50","ratio":0.296295,"inputTokens":59259,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":284,"time":"16:51","ratio":0.3129,"inputTokens":62580,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":285,"time":"16:52","ratio":0.32081,"inputTokens":64162,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":286,"time":"16:52","ratio":0.332485,"inputTokens":66497,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":287,"time":"16:53","ratio":0.336075,"inputTokens":67215,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.242,"originalCredits":0.242,"afterCompact":false},{"index":288,"time":"16:53","ratio":0.34254,"inputTokens":68508,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.209,"originalCredits":0.209,"afterCompact":false},{"index":289,"time":"16:54","ratio":0.35044,"inputTokens":70088,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":290,"time":"16:54","ratio":0.358405,"inputTokens":71681,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":291,"time":"16:54","ratio":0.362985,"inputTokens":72597,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":292,"time":"16:55","ratio":0.365535,"inputTokens":73107,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":293,"time":"16:55","ratio":0.36755,"inputTokens":73510,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.189,"originalCredits":0.189,"afterCompact":false},{"index":294,"time":"16:55","ratio":0.369135,"inputTokens":73827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":295,"time":"16:56","ratio":0.36999,"inputTokens":73998,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.192,"originalCredits":0.192,"afterCompact":false},{"index":296,"time":"16:56","ratio":0.37408,"inputTokens":74816,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.205,"originalCredits":0.205,"afterCompact":false},{"index":297,"time":"16:57","ratio":0.399705,"inputTokens":79941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":298,"time":"16:57","ratio":0.41034,"inputTokens":82068,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.275,"originalCredits":0.275,"afterCompact":false},{"index":299,"time":"16:57","ratio":0.41381,"inputTokens":82762,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.214,"originalCredits":0.214,"afterCompact":false},{"index":300,"time":"16:58","ratio":0.41752,"inputTokens":83504,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.265,"originalCredits":0.265,"afterCompact":false},{"index":301,"time":"16:58","ratio":0.422845,"inputTokens":84569,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":302,"time":"16:58","ratio":0.425465,"inputTokens":85093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":303,"time":"16:58","ratio":0.43947,"inputTokens":87894,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":304,"time":"16:59","ratio":0.44168,"inputTokens":88336,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":305,"time":"16:59","ratio":0.44349,"inputTokens":88698,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":306,"time":"17:00","ratio":0.447,"inputTokens":89400,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":307,"time":"17:00","ratio":0.448625,"inputTokens":89725,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.26,"originalCredits":0.26,"afterCompact":false},{"index":308,"time":"17:01","ratio":0.45315,"inputTokens":90630,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":309,"time":"17:01","ratio":0.45577,"inputTokens":91154,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.227,"originalCredits":0.227,"afterCompact":false},{"index":310,"time":"17:01","ratio":0.457175,"inputTokens":91435,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.22,"originalCredits":0.22,"afterCompact":false},{"index":311,"time":"17:01","ratio":0.46148,"inputTokens":92296,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.244,"originalCredits":0.244,"afterCompact":false},{"index":312,"time":"17:02","ratio":0.46637,"inputTokens":93274,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":313,"time":"17:02","ratio":0.470885,"inputTokens":94177,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":314,"time":"17:03","ratio":0.473095,"inputTokens":94619,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.249,"originalCredits":0.249,"afterCompact":false},{"index":315,"time":"17:04","ratio":0.47699,"inputTokens":95398,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":316,"time":"17:04","ratio":0.478905,"inputTokens":95781,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.244,"originalCredits":0.244,"afterCompact":false},{"index":317,"time":"17:04","ratio":0.4809,"inputTokens":96180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.232,"originalCredits":0.232,"afterCompact":false},{"index":318,"time":"17:04","ratio":0.483845,"inputTokens":96769,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":319,"time":"17:05","ratio":0.4874,"inputTokens":97480,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":320,"time":"17:05","ratio":0.489305,"inputTokens":97861,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.275,"originalCredits":0.275,"afterCompact":false},{"index":321,"time":"17:05","ratio":0.496345,"inputTokens":99269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":322,"time":"17:06","ratio":0.499775,"inputTokens":99955,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":323,"time":"17:06","ratio":0.500935,"inputTokens":100187,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.248,"originalCredits":0.248,"afterCompact":false},{"index":324,"time":"17:06","ratio":0.50274,"inputTokens":100548,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":325,"time":"17:07","ratio":0.50578,"inputTokens":101156,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":326,"time":"17:07","ratio":0.51004,"inputTokens":102008,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":327,"time":"17:07","ratio":0.513185,"inputTokens":102637,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.254,"originalCredits":0.254,"afterCompact":false},{"index":328,"time":"17:07","ratio":0.515505,"inputTokens":103101,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.255,"originalCredits":0.255,"afterCompact":false},{"index":329,"time":"17:08","ratio":0.517915,"inputTokens":103583,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.287,"originalCredits":0.287,"afterCompact":false},{"index":330,"time":"17:08","ratio":0.522875,"inputTokens":104575,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":331,"time":"17:08","ratio":0.52852,"inputTokens":105704,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":332,"time":"17:09","ratio":0.53199,"inputTokens":106398,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":333,"time":"17:09","ratio":0.53918,"inputTokens":107836,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":334,"time":"17:09","ratio":0.54171,"inputTokens":108342,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.262,"originalCredits":0.262,"afterCompact":false},{"index":335,"time":"17:10","ratio":0.54319,"inputTokens":108638,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.287,"originalCredits":0.287,"afterCompact":false},{"index":336,"time":"17:10","ratio":0.54762,"inputTokens":109524,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":337,"time":"17:10","ratio":0.548885,"inputTokens":109777,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":338,"time":"17:11","ratio":0.55318,"inputTokens":110636,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":339,"time":"17:11","ratio":0.558185,"inputTokens":111637,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.306,"originalCredits":0.306,"afterCompact":false},{"index":340,"time":"17:11","ratio":0.561055,"inputTokens":112211,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":341,"time":"17:11","ratio":0.564785,"inputTokens":112957,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":342,"time":"17:12","ratio":0.56645,"inputTokens":113290,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.269,"originalCredits":0.269,"afterCompact":false},{"index":343,"time":"17:12","ratio":0.572115,"inputTokens":114423,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.313,"originalCredits":0.313,"afterCompact":false},{"index":344,"time":"17:12","ratio":0.57479,"inputTokens":114958,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":345,"time":"17:12","ratio":0.575705,"inputTokens":115141,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.267,"originalCredits":0.267,"afterCompact":false},{"index":346,"time":"17:13","ratio":0.57771,"inputTokens":115542,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":347,"time":"17:13","ratio":0.578935,"inputTokens":115787,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":348,"time":"17:13","ratio":0.581345,"inputTokens":116269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.295,"originalCredits":0.295,"afterCompact":false},{"index":349,"time":"17:14","ratio":0.583655,"inputTokens":116731,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":350,"time":"17:14","ratio":0.58509,"inputTokens":117018,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":351,"time":"17:14","ratio":0.588055,"inputTokens":117611,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":352,"time":"17:14","ratio":0.591225,"inputTokens":118245,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":353,"time":"17:15","ratio":0.59229,"inputTokens":118458,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.276,"originalCredits":0.276,"afterCompact":false},{"index":354,"time":"17:15","ratio":0.5932,"inputTokens":118640,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":355,"time":"17:15","ratio":0.598925,"inputTokens":119785,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.323,"originalCredits":0.323,"afterCompact":false},{"index":356,"time":"17:16","ratio":0.6017,"inputTokens":120340,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.336,"originalCredits":0.336,"afterCompact":false},{"index":357,"time":"17:16","ratio":0.606425,"inputTokens":121285,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.315,"originalCredits":0.315,"afterCompact":false},{"index":358,"time":"17:16","ratio":0.60838,"inputTokens":121676,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":359,"time":"17:16","ratio":0.609745,"inputTokens":121949,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":360,"time":"17:17","ratio":0.613955,"inputTokens":122791,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.314,"originalCredits":0.314,"afterCompact":false},{"index":361,"time":"17:17","ratio":0.61698,"inputTokens":123396,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.295,"originalCredits":0.295,"afterCompact":false},{"index":362,"time":"17:17","ratio":0.61933,"inputTokens":123866,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":363,"time":"17:17","ratio":0.621445,"inputTokens":124289,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.298,"originalCredits":0.298,"afterCompact":false},{"index":364,"time":"17:18","ratio":0.623015,"inputTokens":124603,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.336,"originalCredits":0.336,"afterCompact":false},{"index":365,"time":"17:18","ratio":0.62752,"inputTokens":125504,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":366,"time":"17:18","ratio":0.631165,"inputTokens":126233,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":367,"time":"17:18","ratio":0.63385,"inputTokens":126770,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.324,"originalCredits":0.324,"afterCompact":false},{"index":368,"time":"17:19","ratio":0.63639,"inputTokens":127278,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.322,"originalCredits":0.322,"afterCompact":false},{"index":369,"time":"17:19","ratio":0.638745,"inputTokens":127749,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":370,"time":"17:20","ratio":0.640015,"inputTokens":128003,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false},{"index":371,"time":"17:20","ratio":0.646525,"inputTokens":129305,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.359,"originalCredits":0.359,"afterCompact":false},{"index":372,"time":"17:20","ratio":0.649815,"inputTokens":129963,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.315,"originalCredits":0.315,"afterCompact":false},{"index":373,"time":"17:20","ratio":0.65075,"inputTokens":130150,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.306,"originalCredits":0.306,"afterCompact":false},{"index":374,"time":"17:21","ratio":0.65299,"inputTokens":130598,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":375,"time":"17:21","ratio":0.658125,"inputTokens":131625,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.355,"originalCredits":0.355,"afterCompact":false},{"index":376,"time":"17:21","ratio":0.661415,"inputTokens":132283,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":377,"time":"17:21","ratio":0.66268,"inputTokens":132536,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":378,"time":"17:22","ratio":0.66363,"inputTokens":132726,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":379,"time":"17:22","ratio":0.665345,"inputTokens":133069,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.315,"originalCredits":0.315,"afterCompact":false},{"index":380,"time":"17:22","ratio":0.66763,"inputTokens":133526,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.353,"originalCredits":0.353,"afterCompact":false},{"index":381,"time":"17:23","ratio":0.672755,"inputTokens":134551,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":382,"time":"17:23","ratio":0.673905,"inputTokens":134781,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":383,"time":"17:24","ratio":0.67544,"inputTokens":135088,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.335,"originalCredits":0.335,"afterCompact":false},{"index":384,"time":"17:25","ratio":0.67801,"inputTokens":135602,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":385,"time":"17:25","ratio":0.67871,"inputTokens":135742,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.341,"originalCredits":0.341,"afterCompact":false},{"index":386,"time":"17:25","ratio":0.68524,"inputTokens":137048,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":387,"time":"17:26","ratio":0.69252,"inputTokens":138504,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.508,"originalCredits":0.508,"afterCompact":false},{"index":388,"time":"17:27","ratio":0.70694,"inputTokens":141388,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.397,"originalCredits":0.397,"afterCompact":false},{"index":389,"time":"17:27","ratio":0.709575,"inputTokens":141915,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.347,"originalCredits":0.347,"afterCompact":false},{"index":390,"time":"17:27","ratio":0.71649,"inputTokens":143298,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":391,"time":"17:28","ratio":0.72174,"inputTokens":144348,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":392,"time":"17:28","ratio":0.72372,"inputTokens":144744,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":393,"time":"17:28","ratio":0.724765,"inputTokens":144953,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.354,"originalCredits":0.354,"afterCompact":false},{"index":394,"time":"17:29","ratio":0.728005,"inputTokens":145601,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.387,"originalCredits":0.387,"afterCompact":false},{"index":395,"time":"17:29","ratio":0.733395,"inputTokens":146679,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.383,"originalCredits":0.383,"afterCompact":false},{"index":396,"time":"17:29","ratio":0.736315,"inputTokens":147263,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.35,"originalCredits":0.35,"afterCompact":false},{"index":397,"time":"17:30","ratio":0.73767,"inputTokens":147534,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.358,"originalCredits":0.358,"afterCompact":false},{"index":398,"time":"17:30","ratio":0.739755,"inputTokens":147951,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.382,"originalCredits":0.382,"afterCompact":false},{"index":399,"time":"17:30","ratio":0.74357,"inputTokens":148714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.358,"originalCredits":0.358,"afterCompact":false},{"index":400,"time":"17:31","ratio":0.746425,"inputTokens":149285,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":401,"time":"17:31","ratio":0.752885,"inputTokens":150577,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.413,"originalCredits":0.413,"afterCompact":false},{"index":402,"time":"17:32","ratio":0.756905,"inputTokens":151381,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.502,"originalCredits":0.502,"afterCompact":false},{"index":403,"time":"17:32","ratio":0.769125,"inputTokens":153825,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.442,"originalCredits":0.442,"afterCompact":false},{"index":404,"time":"17:33","ratio":0.773905,"inputTokens":154781,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.479,"originalCredits":0.479,"afterCompact":false},{"index":405,"time":"17:33","ratio":0.7834,"inputTokens":156680,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.41,"originalCredits":0.41,"afterCompact":false},{"index":406,"time":"17:34","ratio":0.78584,"inputTokens":157168,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.371,"originalCredits":0.371,"afterCompact":false},{"index":407,"time":"17:34","ratio":0.786895,"inputTokens":157379,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.366,"originalCredits":0.366,"afterCompact":false},{"index":408,"time":"17:34","ratio":0.78845,"inputTokens":157690,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":409,"time":"17:35","ratio":0.791475,"inputTokens":158295,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.383,"originalCredits":0.383,"afterCompact":false},{"index":410,"time":"17:35","ratio":0.793945,"inputTokens":158789,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":411,"time":"17:35","ratio":0.79868,"inputTokens":159736,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.394,"originalCredits":0.394,"afterCompact":false},{"index":412,"time":"17:35","ratio":0.8,"inputTokens":160000,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.37,"originalCredits":0.37,"afterCompact":false},{"index":413,"time":"17:36","ratio":0.800875,"inputTokens":160175,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.373,"originalCredits":0.373,"afterCompact":false},{"index":414,"time":"17:36","ratio":0.80422,"inputTokens":160844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":415,"time":"17:38","ratio":0.80632,"inputTokens":161264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":416,"time":"17:44","ratio":0.809225,"inputTokens":161845,"outputTokens":null,"usageSource":"transcript-ratio","credits":4.51,"originalCredits":4.51,"afterCompact":false},{"index":417,"time":"17:51","ratio":0.810735,"inputTokens":162147,"outputTokens":null,"usageSource":"transcript-ratio","credits":4.525,"originalCredits":4.525,"afterCompact":false},{"index":418,"time":"17:55","ratio":0.812835,"inputTokens":162567,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.39,"originalCredits":0.39,"afterCompact":false},{"index":419,"time":"17:57","ratio":0.814965,"inputTokens":162993,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":420,"time":"17:57","ratio":0.81868,"inputTokens":163736,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":421,"time":"17:58","ratio":0.82078,"inputTokens":164156,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":422,"time":"17:58","ratio":0.822025,"inputTokens":164405,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":423,"time":"17:58","ratio":0.823275,"inputTokens":164655,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.409,"originalCredits":0.409,"afterCompact":false},{"index":424,"time":"17:59","ratio":0.827745,"inputTokens":165549,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.418,"originalCredits":0.418,"afterCompact":false},{"index":425,"time":"18:00","ratio":0.83129,"inputTokens":166258,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.398,"originalCredits":0.398,"afterCompact":false},{"index":426,"time":"18:02","ratio":0.83403,"inputTokens":166806,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":427,"time":"18:02","ratio":0.835075,"inputTokens":167015,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":428,"time":"18:04","ratio":0.221625,"inputTokens":44325,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.666,"originalCredits":0.666,"afterCompact":true},{"index":429,"time":"18:05","ratio":0.23355,"inputTokens":46710,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":430,"time":"18:07","ratio":0.24208,"inputTokens":48416,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":431,"time":"18:09","ratio":0.248615,"inputTokens":49723,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":432,"time":"18:09","ratio":0.25805,"inputTokens":51610,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":433,"time":"18:10","ratio":0.260765,"inputTokens":52153,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":434,"time":"18:11","ratio":0.26384,"inputTokens":52768,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":435,"time":"18:11","ratio":0.265435,"inputTokens":53087,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.138,"originalCredits":0.138,"afterCompact":false},{"index":436,"time":"18:12","ratio":0.26823,"inputTokens":53646,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":437,"time":"18:12","ratio":0.272695,"inputTokens":54539,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.154,"originalCredits":0.154,"afterCompact":false},{"index":438,"time":"18:13","ratio":0.27832,"inputTokens":55664,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":439,"time":"18:13","ratio":0.27929,"inputTokens":55858,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":440,"time":"18:14","ratio":0.280935,"inputTokens":56187,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":441,"time":"18:14","ratio":0.287525,"inputTokens":57505,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":442,"time":"18:15","ratio":0.291275,"inputTokens":58255,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.165,"originalCredits":0.165,"afterCompact":false},{"index":443,"time":"18:16","ratio":0.2941,"inputTokens":58820,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":444,"time":"18:16","ratio":0.296695,"inputTokens":59339,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":445,"time":"18:17","ratio":0.299205,"inputTokens":59841,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.155,"originalCredits":0.155,"afterCompact":false},{"index":446,"time":"18:17","ratio":0.30263,"inputTokens":60526,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":447,"time":"18:17","ratio":0.306725,"inputTokens":61345,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":448,"time":"18:18","ratio":0.310035,"inputTokens":62007,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.165,"originalCredits":0.165,"afterCompact":false},{"index":449,"time":"18:19","ratio":0.31591,"inputTokens":63182,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.19,"originalCredits":0.19,"afterCompact":false},{"index":450,"time":"18:19","ratio":0.318825,"inputTokens":63765,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":451,"time":"18:21","ratio":0.322505,"inputTokens":64501,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.174,"originalCredits":0.174,"afterCompact":false},{"index":452,"time":"18:22","ratio":0.32368,"inputTokens":64736,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":453,"time":"18:23","ratio":0.324855,"inputTokens":64971,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.166,"originalCredits":0.166,"afterCompact":false},{"index":454,"time":"18:25","ratio":0.32694,"inputTokens":65388,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":455,"time":"18:25","ratio":0.328075,"inputTokens":65615,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":456,"time":"18:27","ratio":0.32931,"inputTokens":65862,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":457,"time":"18:28","ratio":0.33131,"inputTokens":66262,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":458,"time":"18:31","ratio":0.333245,"inputTokens":66649,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":459,"time":"18:32","ratio":0.335405,"inputTokens":67081,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":460,"time":"18:52","ratio":0.375795,"inputTokens":75159,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.116,"originalCredits":2.116,"afterCompact":false},{"index":461,"time":"18:54","ratio":0.382355,"inputTokens":76471,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":462,"time":"18:54","ratio":0.386095,"inputTokens":77219,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":463,"time":"18:56","ratio":0.387875,"inputTokens":77575,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":464,"time":"18:57","ratio":0.3893,"inputTokens":77860,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.192,"originalCredits":0.192,"afterCompact":false},{"index":465,"time":"18:58","ratio":0.390885,"inputTokens":78177,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":466,"time":"18:58","ratio":0.39944,"inputTokens":79888,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.235,"originalCredits":0.235,"afterCompact":false},{"index":467,"time":"18:59","ratio":0.401485,"inputTokens":80297,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":468,"time":"19:00","ratio":0.40404,"inputTokens":80808,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":469,"time":"19:00","ratio":0.40496,"inputTokens":80992,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":470,"time":"19:01","ratio":0.41085,"inputTokens":82170,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.227,"originalCredits":0.227,"afterCompact":false},{"index":471,"time":"19:02","ratio":0.41334,"inputTokens":82668,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.251,"originalCredits":0.251,"afterCompact":false},{"index":472,"time":"19:02","ratio":0.421195,"inputTokens":84239,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.257,"originalCredits":0.257,"afterCompact":false},{"index":473,"time":"19:03","ratio":0.425315,"inputTokens":85063,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":474,"time":"19:04","ratio":0.429335,"inputTokens":85867,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":475,"time":"19:05","ratio":0.43727,"inputTokens":87454,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":476,"time":"19:05","ratio":0.43821,"inputTokens":87642,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":477,"time":"19:06","ratio":0.44151,"inputTokens":88302,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":478,"time":"19:06","ratio":0.444165,"inputTokens":88833,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":479,"time":"19:07","ratio":0.445505,"inputTokens":89101,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":480,"time":"19:07","ratio":0.44981,"inputTokens":89962,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":481,"time":"19:09","ratio":0.4509,"inputTokens":90180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":482,"time":"19:09","ratio":0.45798,"inputTokens":91596,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.271,"originalCredits":0.271,"afterCompact":false},{"index":483,"time":"19:10","ratio":0.46079,"inputTokens":92158,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.235,"originalCredits":0.235,"afterCompact":false},{"index":484,"time":"19:10","ratio":0.4623,"inputTokens":92460,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.231,"originalCredits":0.231,"afterCompact":false},{"index":485,"time":"19:13","ratio":0.46563,"inputTokens":93126,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.232,"originalCredits":0.232,"afterCompact":false},{"index":486,"time":"19:14","ratio":0.46684,"inputTokens":93368,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":487,"time":"19:15","ratio":0.468385,"inputTokens":93677,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":488,"time":"19:16","ratio":0.47046,"inputTokens":94092,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.23,"originalCredits":0.23,"afterCompact":false},{"index":489,"time":"19:19","ratio":0.471935,"inputTokens":94387,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":490,"time":"19:19","ratio":0.48255,"inputTokens":96510,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":491,"time":"19:20","ratio":0.485435,"inputTokens":97087,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":492,"time":"19:21","ratio":0.493015,"inputTokens":98603,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":493,"time":"19:21","ratio":0.4978,"inputTokens":99560,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.254,"originalCredits":0.254,"afterCompact":false},{"index":494,"time":"19:22","ratio":0.501385,"inputTokens":100277,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.286,"originalCredits":0.286,"afterCompact":false},{"index":495,"time":"19:23","ratio":0.505345,"inputTokens":101069,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.363,"originalCredits":0.363,"afterCompact":false},{"index":496,"time":"19:23","ratio":0.51606,"inputTokens":103212,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":497,"time":"19:24","ratio":0.517355,"inputTokens":103471,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":498,"time":"19:26","ratio":0.52638,"inputTokens":105276,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.301,"originalCredits":0.301,"afterCompact":false},{"index":499,"time":"19:26","ratio":0.529425,"inputTokens":105885,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":500,"time":"19:27","ratio":0.5322,"inputTokens":106440,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":501,"time":"19:27","ratio":0.536625,"inputTokens":107325,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.328,"originalCredits":0.328,"afterCompact":false},{"index":502,"time":"19:27","ratio":0.54559,"inputTokens":109118,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.297,"originalCredits":0.297,"afterCompact":false},{"index":503,"time":"19:29","ratio":0.547065,"inputTokens":109413,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":504,"time":"19:29","ratio":0.55531,"inputTokens":111062,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":505,"time":"19:30","ratio":0.56258,"inputTokens":112516,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.399,"originalCredits":0.399,"afterCompact":false},{"index":506,"time":"19:30","ratio":0.572785,"inputTokens":114557,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.325,"originalCredits":0.325,"afterCompact":false},{"index":507,"time":"19:30","ratio":0.57506,"inputTokens":115012,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":508,"time":"19:33","ratio":0.57952,"inputTokens":115904,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":509,"time":"19:33","ratio":0.58226,"inputTokens":116452,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":510,"time":"01:35","ratio":0.58672,"inputTokens":117344,"outputTokens":null,"usageSource":"transcript-ratio","credits":3.303,"originalCredits":3.303,"afterCompact":false},{"index":511,"time":"01:35","ratio":0.59148,"inputTokens":118296,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.33,"originalCredits":0.33,"afterCompact":false},{"index":512,"time":"01:37","ratio":0.595245,"inputTokens":119049,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":513,"time":"01:38","ratio":0.599975,"inputTokens":119995,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.322,"originalCredits":0.322,"afterCompact":false},{"index":514,"time":"01:38","ratio":0.604165,"inputTokens":120833,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":515,"time":"01:38","ratio":0.611985,"inputTokens":122397,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.328,"originalCredits":0.328,"afterCompact":false},{"index":516,"time":"01:38","ratio":0.615285,"inputTokens":123057,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":517,"time":"01:39","ratio":0.618065,"inputTokens":123613,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.302,"originalCredits":0.302,"afterCompact":false},{"index":518,"time":"01:41","ratio":0.6197,"inputTokens":123940,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":519,"time":"01:41","ratio":0.62639,"inputTokens":125278,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":520,"time":"01:42","ratio":0.63844,"inputTokens":127688,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":521,"time":"01:42","ratio":0.64371,"inputTokens":128742,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.342,"originalCredits":0.342,"afterCompact":false},{"index":522,"time":"01:42","ratio":0.650385,"inputTokens":130077,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.362,"originalCredits":0.362,"afterCompact":false},{"index":523,"time":"01:43","ratio":0.658935,"inputTokens":131787,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":524,"time":"01:43","ratio":0.66422,"inputTokens":132844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.331,"originalCredits":0.331,"afterCompact":false},{"index":525,"time":"01:43","ratio":0.66657,"inputTokens":133314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.342,"originalCredits":0.342,"afterCompact":false},{"index":526,"time":"01:43","ratio":0.67711,"inputTokens":135422,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":527,"time":"01:44","ratio":0.682755,"inputTokens":136551,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.345,"originalCredits":0.345,"afterCompact":false},{"index":528,"time":"01:44","ratio":0.691415,"inputTokens":138283,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.429,"originalCredits":0.429,"afterCompact":false},{"index":529,"time":"01:45","ratio":0.70116,"inputTokens":140232,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.516,"originalCredits":0.516,"afterCompact":false},{"index":530,"time":"01:45","ratio":0.71472,"inputTokens":142944,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.416,"originalCredits":0.416,"afterCompact":false},{"index":531,"time":"01:46","ratio":0.717295,"inputTokens":143459,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":532,"time":"01:46","ratio":0.722115,"inputTokens":144423,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.358,"originalCredits":0.358,"afterCompact":false},{"index":533,"time":"01:46","ratio":0.723335,"inputTokens":144667,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.341,"originalCredits":0.341,"afterCompact":false},{"index":534,"time":"01:46","ratio":0.72459,"inputTokens":144918,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.344,"originalCredits":0.344,"afterCompact":false},{"index":535,"time":"01:47","ratio":0.7261,"inputTokens":145220,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":536,"time":"01:47","ratio":0.72838,"inputTokens":145676,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":537,"time":"01:47","ratio":0.733785,"inputTokens":146757,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.365,"originalCredits":0.365,"afterCompact":false},{"index":538,"time":"01:47","ratio":0.735125,"inputTokens":147025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.348,"originalCredits":0.348,"afterCompact":false},{"index":539,"time":"01:47","ratio":0.73895,"inputTokens":147790,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.37,"originalCredits":0.37,"afterCompact":false},{"index":540,"time":"01:48","ratio":0.74093,"inputTokens":148186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.347,"originalCredits":0.347,"afterCompact":false},{"index":541,"time":"01:48","ratio":0.742575,"inputTokens":148515,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.364,"originalCredits":0.364,"afterCompact":false},{"index":542,"time":"01:48","ratio":0.745015,"inputTokens":149003,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.362,"originalCredits":0.362,"afterCompact":false},{"index":543,"time":"01:48","ratio":0.746735,"inputTokens":149347,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.349,"originalCredits":0.349,"afterCompact":false},{"index":544,"time":"01:49","ratio":0.749745,"inputTokens":149949,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.398,"originalCredits":0.398,"afterCompact":false},{"index":545,"time":"01:49","ratio":0.75401,"inputTokens":150802,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":546,"time":"01:49","ratio":0.75611,"inputTokens":151222,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":547,"time":"01:50","ratio":0.761345,"inputTokens":152269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.399,"originalCredits":0.399,"afterCompact":false},{"index":548,"time":"01:50","ratio":0.766345,"inputTokens":153269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.376,"originalCredits":0.376,"afterCompact":false},{"index":549,"time":"01:50","ratio":0.7688,"inputTokens":153760,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.37,"originalCredits":0.37,"afterCompact":false},{"index":550,"time":"01:51","ratio":0.770485,"inputTokens":154097,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.523,"originalCredits":0.523,"afterCompact":false},{"index":551,"time":"01:51","ratio":0.785645,"inputTokens":157129,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.443,"originalCredits":0.443,"afterCompact":false},{"index":552,"time":"01:52","ratio":0.789555,"inputTokens":157911,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.439,"originalCredits":0.439,"afterCompact":false},{"index":553,"time":"01:52","ratio":0.79687,"inputTokens":159374,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.448,"originalCredits":0.448,"afterCompact":false},{"index":554,"time":"01:52","ratio":0.80183,"inputTokens":160366,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.402,"originalCredits":0.402,"afterCompact":false},{"index":555,"time":"01:53","ratio":0.803825,"inputTokens":160765,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.382,"originalCredits":0.382,"afterCompact":false},{"index":556,"time":"01:53","ratio":0.805295,"inputTokens":161059,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":557,"time":"01:53","ratio":0.807505,"inputTokens":161501,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":558,"time":"01:53","ratio":0.8109,"inputTokens":162180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.399,"originalCredits":0.399,"afterCompact":false},{"index":559,"time":"01:54","ratio":0.812815,"inputTokens":162563,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":560,"time":"01:54","ratio":0.81472,"inputTokens":162944,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.383,"originalCredits":0.383,"afterCompact":false},{"index":561,"time":"01:54","ratio":0.816885,"inputTokens":163377,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":562,"time":"01:54","ratio":0.82417,"inputTokens":164834,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.425,"originalCredits":0.425,"afterCompact":false},{"index":563,"time":"01:55","ratio":0.831925,"inputTokens":166385,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.447,"originalCredits":0.447,"afterCompact":false},{"index":564,"time":"01:57","ratio":0.210815,"inputTokens":42163,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.6,"originalCredits":0.6,"afterCompact":true},{"index":565,"time":"01:57","ratio":0.226115,"inputTokens":45223,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":566,"time":"01:57","ratio":0.227905,"inputTokens":45581,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.124,"originalCredits":0.124,"afterCompact":false},{"index":567,"time":"01:58","ratio":0.2293,"inputTokens":45860,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.118,"originalCredits":0.118,"afterCompact":false},{"index":568,"time":"01:58","ratio":0.230375,"inputTokens":46075,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.116,"originalCredits":0.116,"afterCompact":false},{"index":569,"time":"01:58","ratio":0.233995,"inputTokens":46799,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.145,"originalCredits":0.145,"afterCompact":false},{"index":570,"time":"01:58","ratio":0.23611,"inputTokens":47222,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":571,"time":"01:58","ratio":0.23733,"inputTokens":47466,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":572,"time":"01:59","ratio":0.238815,"inputTokens":47763,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.131,"originalCredits":0.131,"afterCompact":false},{"index":573,"time":"01:59","ratio":0.24163,"inputTokens":48326,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.131,"originalCredits":0.131,"afterCompact":false},{"index":574,"time":"01:59","ratio":0.247155,"inputTokens":49431,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":575,"time":"01:59","ratio":0.24808,"inputTokens":49616,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":576,"time":"01:59","ratio":0.24961,"inputTokens":49922,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":577,"time":"02:00","ratio":0.255225,"inputTokens":51045,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":578,"time":"02:00","ratio":0.256975,"inputTokens":51395,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.143,"originalCredits":0.143,"afterCompact":false},{"index":579,"time":"02:00","ratio":0.2596,"inputTokens":51920,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":580,"time":"02:01","ratio":0.263155,"inputTokens":52631,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":581,"time":"02:01","ratio":0.26797,"inputTokens":53594,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.152,"originalCredits":0.152,"afterCompact":false},{"index":582,"time":"02:01","ratio":0.26891,"inputTokens":53782,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.144,"originalCredits":0.144,"afterCompact":false},{"index":583,"time":"02:02","ratio":0.27102,"inputTokens":54204,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.139,"originalCredits":0.139,"afterCompact":false},{"index":584,"time":"02:02","ratio":0.27523,"inputTokens":55046,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":585,"time":"02:02","ratio":0.277695,"inputTokens":55539,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":586,"time":"02:02","ratio":0.282315,"inputTokens":56463,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":587,"time":"02:02","ratio":0.287385,"inputTokens":57477,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":588,"time":"02:02","ratio":0.28852,"inputTokens":57704,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.142,"originalCredits":0.142,"afterCompact":false},{"index":589,"time":"02:03","ratio":0.290715,"inputTokens":58143,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":590,"time":"02:03","ratio":0.29348,"inputTokens":58696,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":591,"time":"02:03","ratio":0.29913,"inputTokens":59826,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.2,"originalCredits":0.2,"afterCompact":false},{"index":592,"time":"02:03","ratio":0.302505,"inputTokens":60501,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":593,"time":"02:03","ratio":0.304035,"inputTokens":60807,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.151,"originalCredits":0.151,"afterCompact":false},{"index":594,"time":"02:05","ratio":0.310085,"inputTokens":62017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.19,"originalCredits":0.19,"afterCompact":false},{"index":595,"time":"02:05","ratio":0.31451,"inputTokens":62902,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":596,"time":"02:05","ratio":0.32055,"inputTokens":64110,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.193,"originalCredits":0.193,"afterCompact":false},{"index":597,"time":"02:06","ratio":0.329305,"inputTokens":65861,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.231,"originalCredits":0.231,"afterCompact":false},{"index":598,"time":"02:06","ratio":0.33537,"inputTokens":67074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.211,"originalCredits":0.211,"afterCompact":false},{"index":599,"time":"02:06","ratio":0.347025,"inputTokens":69405,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.255,"originalCredits":0.255,"afterCompact":false},{"index":600,"time":"02:07","ratio":0.350905,"inputTokens":70181,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.22,"originalCredits":0.22,"afterCompact":false},{"index":601,"time":"02:07","ratio":0.358805,"inputTokens":71761,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":602,"time":"02:07","ratio":0.362995,"inputTokens":72599,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.265,"originalCredits":0.265,"afterCompact":false},{"index":603,"time":"02:07","ratio":0.37219,"inputTokens":74438,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":604,"time":"02:08","ratio":0.382625,"inputTokens":76525,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.237,"originalCredits":0.237,"afterCompact":false},{"index":605,"time":"02:08","ratio":0.3852,"inputTokens":77040,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.215,"originalCredits":0.215,"afterCompact":false},{"index":606,"time":"02:08","ratio":0.38791,"inputTokens":77582,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.205,"originalCredits":0.205,"afterCompact":false},{"index":607,"time":"02:09","ratio":0.391535,"inputTokens":78307,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.213,"originalCredits":0.213,"afterCompact":false},{"index":608,"time":"02:09","ratio":0.39343,"inputTokens":78686,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":609,"time":"02:09","ratio":0.39463,"inputTokens":78926,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.201,"originalCredits":0.201,"afterCompact":false},{"index":610,"time":"02:09","ratio":0.39659,"inputTokens":79318,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.236,"originalCredits":0.236,"afterCompact":false},{"index":611,"time":"02:10","ratio":0.40089,"inputTokens":80178,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.209,"originalCredits":0.209,"afterCompact":false},{"index":612,"time":"02:10","ratio":0.40217,"inputTokens":80434,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":613,"time":"02:10","ratio":0.404615,"inputTokens":80923,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.205,"originalCredits":0.205,"afterCompact":false},{"index":614,"time":"02:10","ratio":0.407175,"inputTokens":81435,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.209,"originalCredits":0.209,"afterCompact":false},{"index":615,"time":"02:10","ratio":0.40857,"inputTokens":81714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.205,"originalCredits":0.205,"afterCompact":false},{"index":616,"time":"02:11","ratio":0.4138,"inputTokens":82760,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":617,"time":"02:11","ratio":0.418545,"inputTokens":83709,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.221,"originalCredits":0.221,"afterCompact":false},{"index":618,"time":"02:12","ratio":0.419645,"inputTokens":83929,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":619,"time":"02:12","ratio":0.420735,"inputTokens":84147,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.205,"originalCredits":0.205,"afterCompact":false},{"index":620,"time":"02:13","ratio":0.427055,"inputTokens":85411,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":621,"time":"02:13","ratio":0.43076,"inputTokens":86152,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.226,"originalCredits":0.226,"afterCompact":false},{"index":622,"time":"02:14","ratio":0.43347,"inputTokens":86694,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.227,"originalCredits":0.227,"afterCompact":false},{"index":623,"time":"02:14","ratio":0.435885,"inputTokens":87177,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.213,"originalCredits":0.213,"afterCompact":false},{"index":624,"time":"02:14","ratio":0.439245,"inputTokens":87849,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":625,"time":"02:14","ratio":0.440695,"inputTokens":88139,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":626,"time":"02:14","ratio":0.442105,"inputTokens":88421,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.267,"originalCredits":0.267,"afterCompact":false},{"index":627,"time":"02:15","ratio":0.448185,"inputTokens":89637,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":628,"time":"02:15","ratio":0.452045,"inputTokens":90409,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.231,"originalCredits":0.231,"afterCompact":false},{"index":629,"time":"02:15","ratio":0.45301,"inputTokens":90602,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":630,"time":"02:15","ratio":0.45357,"inputTokens":90714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.211,"originalCredits":0.211,"afterCompact":false},{"index":631,"time":"02:16","ratio":0.454225,"inputTokens":90845,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":632,"time":"02:16","ratio":0.454705,"inputTokens":90941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.208,"originalCredits":0.208,"afterCompact":false},{"index":633,"time":"02:16","ratio":0.455055,"inputTokens":91011,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":634,"time":"02:16","ratio":0.458565,"inputTokens":91713,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":635,"time":"09:43","ratio":0.467145,"inputTokens":93429,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.626,"originalCredits":2.626,"afterCompact":false},{"index":636,"time":"09:44","ratio":0.471085,"inputTokens":94217,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.257,"originalCredits":0.257,"afterCompact":false},{"index":637,"time":"09:44","ratio":0.474865,"inputTokens":94973,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":638,"time":"09:44","ratio":0.47645,"inputTokens":95290,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.23,"originalCredits":0.23,"afterCompact":false},{"index":639,"time":"09:44","ratio":0.47742,"inputTokens":95484,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.223,"originalCredits":0.223,"afterCompact":false},{"index":640,"time":"09:45","ratio":0.478165,"inputTokens":95633,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":641,"time":"09:45","ratio":0.478975,"inputTokens":95795,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":642,"time":"09:45","ratio":0.480905,"inputTokens":96181,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":643,"time":"09:45","ratio":0.48154,"inputTokens":96308,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":644,"time":"09:45","ratio":0.48258,"inputTokens":96516,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.234,"originalCredits":0.234,"afterCompact":false},{"index":645,"time":"09:45","ratio":0.485375,"inputTokens":97075,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.239,"originalCredits":0.239,"afterCompact":false},{"index":646,"time":"09:46","ratio":0.48858,"inputTokens":97716,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":647,"time":"09:46","ratio":0.490155,"inputTokens":98031,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.236,"originalCredits":0.236,"afterCompact":false},{"index":648,"time":"09:47","ratio":0.493245,"inputTokens":98649,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":649,"time":"09:47","ratio":0.4961,"inputTokens":99220,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.252,"originalCredits":0.252,"afterCompact":false},{"index":650,"time":"09:47","ratio":0.49769,"inputTokens":99538,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":651,"time":"09:47","ratio":0.498775,"inputTokens":99755,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.236,"originalCredits":0.236,"afterCompact":false},{"index":652,"time":"09:47","ratio":0.502135,"inputTokens":100427,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":653,"time":"09:48","ratio":0.5058,"inputTokens":101160,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":654,"time":"09:48","ratio":0.51071,"inputTokens":102142,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":655,"time":"09:48","ratio":0.517925,"inputTokens":103585,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":656,"time":"09:49","ratio":0.52348,"inputTokens":104696,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.441,"originalCredits":0.441,"afterCompact":false},{"index":657,"time":"09:50","ratio":0.538695,"inputTokens":107739,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.336,"originalCredits":0.336,"afterCompact":false},{"index":658,"time":"09:50","ratio":0.542785,"inputTokens":108557,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.273,"originalCredits":0.273,"afterCompact":false},{"index":659,"time":"09:50","ratio":0.543875,"inputTokens":108775,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.282,"originalCredits":0.282,"afterCompact":false},{"index":660,"time":"09:51","ratio":0.54692,"inputTokens":109384,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.308,"originalCredits":0.308,"afterCompact":false},{"index":661,"time":"09:51","ratio":0.551205,"inputTokens":110241,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.274,"originalCredits":0.274,"afterCompact":false},{"index":662,"time":"09:51","ratio":0.55853,"inputTokens":111706,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":663,"time":"09:51","ratio":0.560665,"inputTokens":112133,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":664,"time":"09:51","ratio":0.562725,"inputTokens":112545,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.274,"originalCredits":0.274,"afterCompact":false},{"index":665,"time":"09:52","ratio":0.564045,"inputTokens":112809,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":666,"time":"09:52","ratio":0.565235,"inputTokens":113047,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.263,"originalCredits":0.263,"afterCompact":false},{"index":667,"time":"09:53","ratio":0.58067,"inputTokens":116134,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.356,"originalCredits":0.356,"afterCompact":false},{"index":668,"time":"09:53","ratio":0.583255,"inputTokens":116651,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":669,"time":"09:53","ratio":0.585125,"inputTokens":117025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.28,"originalCredits":0.28,"afterCompact":false},{"index":670,"time":"09:53","ratio":0.586205,"inputTokens":117241,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.277,"originalCredits":0.277,"afterCompact":false},{"index":671,"time":"09:54","ratio":0.58749,"inputTokens":117498,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.299,"originalCredits":0.299,"afterCompact":false},{"index":672,"time":"09:54","ratio":0.59189,"inputTokens":118378,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":673,"time":"09:54","ratio":0.592715,"inputTokens":118543,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.282,"originalCredits":0.282,"afterCompact":false},{"index":674,"time":"09:55","ratio":0.594265,"inputTokens":118853,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":675,"time":"09:55","ratio":0.59663,"inputTokens":119326,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":676,"time":"09:56","ratio":0.59782,"inputTokens":119564,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.284,"originalCredits":0.284,"afterCompact":false},{"index":677,"time":"09:56","ratio":0.599465,"inputTokens":119893,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":678,"time":"09:57","ratio":0.6046,"inputTokens":120920,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":679,"time":"09:57","ratio":0.60878,"inputTokens":121756,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.303,"originalCredits":0.303,"afterCompact":false},{"index":680,"time":"09:57","ratio":0.610125,"inputTokens":122025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":681,"time":"09:58","ratio":0.612995,"inputTokens":122599,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":682,"time":"09:58","ratio":0.61469,"inputTokens":122938,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.287,"originalCredits":0.287,"afterCompact":false},{"index":683,"time":"09:58","ratio":0.62093,"inputTokens":124186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.322,"originalCredits":0.322,"afterCompact":false},{"index":684,"time":"09:58","ratio":0.623355,"inputTokens":124671,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.297,"originalCredits":0.297,"afterCompact":false},{"index":685,"time":"09:58","ratio":0.62593,"inputTokens":125186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":686,"time":"09:59","ratio":0.62793,"inputTokens":125586,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.302,"originalCredits":0.302,"afterCompact":false},{"index":687,"time":"09:59","ratio":0.629085,"inputTokens":125817,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.301,"originalCredits":0.301,"afterCompact":false},{"index":688,"time":"10:00","ratio":0.630495,"inputTokens":126099,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false}],"identity":{"sumAttributed":73973875,"billedInputTokens":73973875,"absDiff":0,"ok":true},"pluginVersion":"2.7.4","selfCmd":"\"C:\\Users\\zhaobingxiang\\.qoder-cn\\plugins\\cache\\qoder-marketplace\\qoder-credits-inspector\\2.7.4\\bin\\credits-inspector.cmd\" cli","linkHealth":{"matched":0,"requests":688,"coverage":0,"usageSource":"transcript-ratio","breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":688},"logRecords":0,"lastRecordAt":null,"recentRequests":0,"proxyErrors":null,"clientAbort":null,"clientAbortMaxMs":null,"upstreamRejected":null,"aborted":null,"truncated":null,"noUsage":null,"slowestMs":null,"supersededFailure":null},"subagents":{"scanned":true,"dir":"C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\D--ide-mdreader\\d5cf5dc3-cde9-4d4b-ab00-6784aa5a8166\\subagents","probedPaths":["C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\D--ide-mdreader\\d5cf5dc3-cde9-4d4b-ab00-6784aa5a8166\\subagents","C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\d5cf5dc3-cde9-4d4b-ab00-6784aa5a8166\\subagents"],"reason":"ok","count":1,"items":[{"agentId":"aExplore-63181013473996b1","agentType":"Explore","description":"Locate mdreader UI wiring points","toolUseId":"call_52c7116f979846d19e492aa8","roundTrips":10,"billedInputTokens":262114,"peakContextRatio":0.1783,"credits":1.795,"originalCredits":1.795,"error":null}],"totals":{"roundTrips":10,"billedInputTokens":262114,"credits":1.795,"originalCredits":1.795},"combined":{"roundTrips":698,"billedInputTokens":74235989,"credits":227.575,"originalCredits":227.575}},"manual":null,"artifacts":{"report":"report.json","canvas":"想给mdreader做一个会记功能，点击会记，有__d5cf5dc3.canvas.tsx"}} as unknown as Report;

function human(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// —— 可用性口径：把 report.availability 翻成人话，并决定某个数字该显示值、「≈」还是「—」——
const AVAIL_LABEL: Record<string, string> = {
  measured: "实测",
  derived: "推导",
  fallback: "回退",
  manual: "手工",
  unavailable: "不可用",
};

const SOURCE_LABEL: Record<string, string> = {
  "desktop-rich": "桌面端富转录",
  "ide-lite": "IDE 端精简转录",
  unknown: "来源未知",
};

function availOf(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): Avail {
  return (av?.[key] as Avail | undefined) ?? dflt;
}

/** 段标题旁的性质标注：实测不标（默认就是实测），其余标出来。 */
function availTag(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): string {
  const v = availOf(av, key, dflt);
  return v === "measured" ? "" : `（${AVAIL_LABEL[v]}）`;
}

/** 不可用的量显示「—」而不是 0：IDE 端的 0 是「读不到」，不是「没发生」。 */
function orDash(
  v: number,
  av: Availability | undefined,
  key: keyof Availability,
  fmt: (n: number) => string = String
): string {
  return availOf(av, key) === "unavailable" ? "—" : fmt(v);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "search":
      return "搜索";
    case "shell":
      return "命令";
    default:
      return "其他";
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SessionTokensReport() {
  if (!REPORT) {
    return (
      <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
        <Stack gap="component">
          <H1>会话 token 消耗截析</H1>
          <Text tone="secondary">报告数据尚未注入。请在会话中触发一次 Stop 钩子，或运行 CLI 生成 report.json。</Text>
        </Stack>
      </ReportShell>
    );
  }

  const r = REPORT;
  const s = r.session;
  const c = r.context;
  const t = r.totals;
  const av = r.availability;
  const manual = r.manual ?? null;
  const sourceLabel = SOURCE_LABEL[r.source ?? "unknown"] ?? "来源未知";
  // 有没有 usage 决定整份报告是「真值/推导」还是「一律 —」。手工回填的 credits 不算有 usage，
  // 否则下面按 ratio 推导的图表会照画一堆 0。
  const hasUsage = availOf(av, "roundTrips") === "measured";
  const manualCredits = manual?.credits ?? null;

  // 报告里出现的命令一律用数据层注入的插件入口（Windows 上是自带启动器的绝对路径，免装 Node）。
  // 旧报告没有这个字段时回退原写法，不比改动前更差。
  const CLI = r.selfCmd || "node scripts/cli.mjs";

  // credits 覆盖范围：credits 与「计费输入总量」并排放在头部，读者一除就得到单价。
  // 混合会话里 credits 只来自转录路径的那几笔（实测某会话 413 笔里只有 1 笔带 credits），
  // 部分覆盖不说出来 = 把局部真值当全量展示。
  const cov = r.creditsCoverage ?? null;
  const covPartial = !!(cov && !cov.full && cov.roundTrips > 0);
  const covNote = covPartial ? ` · 仅覆盖 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}）` : "";

  // 缓存命中：代理记录里一直带着 cachedTokens，此前采集了却从不呈现。
  const cachedMeasured = availOf(av, "cachedTokens") === "measured";
  const cachedText = cachedMeasured
    ? `输入 ${human(t.billedInputTokens)}，其中缓存命中 ${human(t.cachedTokens ?? 0)}（${pct(t.cachedShare ?? 0)}，${t.cachedTrips ?? 0} 笔往返带缓存）——供应商对重复叠加的前缀打折，故按 token 数的节省大于按计费的节省。`
    : "";

  // 代理告警只在「失败记录仍然成立」时才报：status.json 只写不清，陈旧失败会把用户推去改
  // 本来正确的 Base URL，越修越坏；而同一份报告里的 lastRecordAt / matched 是它在跑的硬证据。
  const proxyAlarm = r.proxy?.status && !r.proxy.statusSuperseded ? r.proxy.status : null;
  const proxyAlive = !proxyAlarm && (r.proxy?.logRecords ?? 0) > 0;

  // 官方 UI 一场会话扣费 = 主链 + 子代理，故有子代理时 headline 必须给 combined，否则比 UI 少一截
  const creditScope =
    r.subagents && r.subagents.count > 0
      ? {
          credits: r.subagents.combined.credits,
          note: `主链 ${t.credits} + 子代理 ${r.subagents.totals.credits} · 原始 ${r.subagents.combined.originalCredits}`,
        }
      : { credits: t.credits, note: `原始 ${t.originalCredits}（实测）` };

  const headline: MetricItem[] = [
    {
      label: "计费输入总量",
      value: hasUsage ? human(t.billedInputTokens) : "—",
      description: hasUsage
        ? availOf(av, "tokens") === "measured"
          ? `Σ prompt_tokens（实测真值）${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
          : `Σ 上下文 × 往返${availTag(av, "tokens", "derived")}${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
        : "转录无 usage",
    },
    {
      label: "当前上下文",
      value: hasUsage ? human(t.netContextTokens) : "—",
      description: hasUsage
        ? `峰值 ${pct(c.peakContextRatio)}${s.compactions ? "（压缩后起算）" : ""}`
        : "转录无 usage",
    },
    {
      label: "重发放大",
      value: hasUsage ? `${t.amplification}×` : "—",
      description: `往返 ${hasUsage ? `${s.roundTrips} 次` : "—"}`,
    },
    {
      label: "Credits",
      // 代理路径（自定义模型）token 是实测真值但 credits 无来源：hasUsage 为真也要显示「—」，
      // 否则 t.credits=0 会被读成「这次没花钱」。
      value:
        manualCredits != null
          ? `${manualCredits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.credits}`
            : "—",
      description:
        manualCredits != null
          ? `官方 UI 手工录入 · 本地 ${creditScope.credits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.note}${covNote}`
            : r.usageSource === "proxy" || r.usageSource === "transcript-tokens" || r.usageSource === "mixed"
              ? "自定义模型（BYOK）不经 Qoder 计费网关，无 credits 真值"
              : hasUsage
                ? "转录带 usage 但没有 credits 字段，本地无计费真值"
                : "本地不可用，见下方告警",
    },
  ];

  const pieData = r.byCategory.map((x) => ({ label: x.label, value: x.tokens }));

  // 系统提示词是报告里少数「用户能直接动」的一项：它每轮被完整重发，总量 = 每请求规模 × 往返数，
  // 而它的大小由装了多少插件与技能决定。占比小时不必啰嗦。
  const sysCat = r.byCategory.find((x) => x.key === "system");
  const sysNote =
    hasUsage && sysCat && sysCat.share >= 0.1
      ? ` 系统提示词占 ${pct(sysCat.share)}（${human(c.systemPromptTokens)}/请求 × ${s.roundTrips} 次往返 = ${human(sysCat.tokens)}）：它每轮都被完整重发，大小由你装了多少插件与技能决定，精简技能能直接压低这一项——本插件自己的技能描述也常驻在里面（约 170 token）。`
      : "";

  const tools = r.byTool.slice(0, 8);
  const toolCategories = tools.map((x) => x.tool);
  const toolSeries = [{ name: "重发 tokens", data: tools.map((x) => x.tokens) }];
  // 「单次」= 平均每次调用带来的重发 token。总量榜会埋掉次数少但每次极贵的工具：
  // 实测 Read 只 29 次却吃 335 万，单次是 Edit 的 2.6 倍。
  const toolRows = tools.map((x) => [
    x.tool,
    human(x.tokens),
    pct(x.share),
    String(x.calls),
    x.perCall == null ? "—" : human(x.perCall),
  ]);

  const files = r.byFile.slice(0, 20);
  const fileRows = files.map((f) => [
    f.label,
    kindLabel(f.kind),
    human(f.billed),
    pct(f.share),
    f.perRead == null ? "—" : human(f.perRead),
    String(f.trips),
    String(f.reads),
  ]);

  const byReq = r.byRequest ?? [];
  const reqLabels = byReq.map((x, i) => x.time || `#${x.index ?? i + 1}`);
  const reqInputs = byReq.map((x) => x.inputTokens);
  const reqCredits = byReq.map((x) => x.credits);
  // credits 只在覆盖全部往返时才画曲线：部分覆盖（BYOK 混合会话实测 413 笔里 1 笔有 credits）
  // 画出来是一地零，既读不出形状，还会暗示「其余往返没花钱」。
  const showCreditsChart = hasUsage && !covPartial && availOf(av, "credits") !== "unavailable";

  // 按类别下钻：类别小计行（accent/neutral）+ 其工具/文件明细行（default），用 rowTone 分组着色。
  const catDetail = r.byCategoryDetail ?? [];
  const detailRows: string[][] = [];
  const detailTones: ("accent" | "neutral" | "default")[] = [];
  for (const cc of catDetail) {
    const hasKids = cc.children.length > 0;
    detailRows.push([cc.label, "—", hasKids ? "小计" : "（整体，无工具/文件归属）", human(cc.tokens), pct(cc.share), "100%", "—"]);
    detailTones.push(hasKids ? "accent" : "neutral");
    for (const k of cc.children) {
      detailRows.push(["", k.tool || "—", k.label, human(k.tokens), pct(k.share), pct(k.catShare), String(k.trips)]);
      detailTones.push("default");
    }
  }

  // 子代理账：Agent 派发的子代理消耗不在主链里，单独一段呈现（无子代理则整段不渲染）。
  const sub = r.subagents;
  const subItems = sub?.items ?? [];
  const subRows: string[][] = [];
  const subTones: ("accent" | "default")[] = [];
  for (const a of subItems) {
    subRows.push([
      a.description || a.agentId,
      a.agentType || "—",
      String(a.roundTrips),
      human(a.billedInputTokens),
      pct(a.peakContextRatio),
      String(a.credits),
      String(a.originalCredits),
      a.error || "—",
    ]);
    subTones.push("default");
  }
  if (sub && subItems.length > 0) {
    subRows.push([
      "合计（主链 + 子代理）",
      "—",
      String(sub.combined.roundTrips),
      human(sub.combined.billedInputTokens),
      "—",
      String(sub.combined.credits),
      String(sub.combined.originalCredits),
      `主链 ${t.credits} / 子代理 ${sub.totals.credits}`,
    ]);
    subTones.push("accent");
  }

  // 压缩单笔成本：输入/摘要一律取数据层归一后的生效值（有代理实测就是实测，否则是客户端自估），
  // 并用「口径」列把两者分开——混着显示会让自估值被当成实测。
  const ccost = r.compactionCost;
  const ccItems = ccost?.items ?? [];
  const compactRows: string[][] = ccItems.map((e) => [
    `#${e.index}`,
    shortTime(e.at),
    e.trigger || "—",
    e.effectiveInputTokens == null ? "—" : human(e.effectiveInputTokens),
    e.effectiveOutputTokens == null ? "—" : human(e.effectiveOutputTokens),
    e.nextInputTokens == null ? "—" : human(e.nextInputTokens),
    e.savedTokens == null ? "—" : human(e.savedTokens),
    e.proxy && e.proxy.ms != null ? `${Math.round(e.proxy.ms / 1000)}s` : "—",
    e.proxy ? "实测" : "自估",
  ]);

  // IDE 端仅剩的真值：工具调用次数与文件读取次数（不依赖 usage，两种转录都写 tool_use 块）。
  const residueRows: string[][] = [];
  if (!hasUsage) {
    for (const x of r.byTool.filter((v) => v.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 15)) {
      residueRows.push([x.tool, "工具", String(x.calls), "—", "—"]);
    }
    for (const f of r.byFile.filter((v) => v.reads > 0).sort((a, b) => b.reads - a.reads).slice(0, 15)) {
      residueRows.push([f.label, kindLabel(f.kind), "—", String(f.reads), String(f.trips)]);
    }
  }

  // A1 三值：一次带 usage 的往返都没有时 0 <= max(2,0) 恒成立，会把「没数据」判成「校验通过」，
  // 故 breakdown.mjs 在 reqCount===0 时给 null；这里必须显示「不适用」而不是绿色通过。
  const identityText =
    r.identity.ok == null
      ? "恒等式 A1 不适用（本转录没有一次带 usage 的往返）。"
      : r.identity.ok
        ? `归因覆盖 ${pct(t.coverage)}${availTag(av, "categoryShare", "derived")}，恒等式 A1 通过（|Δ|=${r.identity.absDiff}）。`
        : `归因覆盖 ${pct(t.coverage)}，恒等式 A1 未通过（|Δ|=${r.identity.absDiff}）。`;
  // 窗口读不到时是静默回退的 200000，而所有 token 数字都乘它 —— 必须显式标 ≈ 与来源。
  const cwIsFallback = availOf(av, "contextWindow") === "fallback";
  const cwText = cwIsFallback ? `≈${human(c.contextWindow)}（回退值）` : human(c.contextWindow);
  // 当前占用头条：以最新上下文（currentContextTokens）为准；段内单调递增 ⇒ 旧版峰值与当前恒等，故合并为一条。
  const curCtx = c.currentContextTokens ?? c.peakContextTokens;
  const netAdv = c.netUserAdvice || c.peakUserAdvice || c.peakAdvice || null;
  const limitSrcLabel =
    c.userContextLimitSource === "manual" ? "手工"
    : c.userContextLimitSource === "config" ? "配置"
    : c.userContextLimitSource === "derived" ? "实测反推"
    : "默认";
  // 阈值来源非 manual/config/derived ⇒ 用的是内置兜底 200K，不是用户在 Qoder 设的真值，需显式提示如何改。
  const limitIsDefault = c.userContextLimitSource !== "manual" && c.userContextLimitSource !== "config" && c.userContextLimitSource !== "derived";
  // 上下文对比表：把旧版挤成一段小字的「界面显示 / 自动压缩实况 / 历史高点」拆成可扫读的行，无数据不占位。
  const ctxRows: string[][] = [];
  if (c.userContextLimit != null && Number.isFinite(c.contextWindow)) {
    ctxRows.push(
      c.contextWindow > c.userContextLimit
        ? ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型物理窗口 ${cwText} 算，比你真实占比低约 ${(c.contextWindow / c.userContextLimit).toFixed(1)} 倍——界面显得偏空、有迷惑性，别信它`]
        : ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型窗口 ${cwText} 算，与你实设上限一致，显示无偏差`],
    );
  }
  if (c.observedAutoCompactions != null && c.observedAutoCompactions > 0 && c.observedAutoTriggerTokens != null) {
    ctxRows.push(["自动压缩实况", `自动 ${c.observedAutoCompactions} 次`, `触发点在 ~${human(c.observedAutoTriggerTokens)}（窗口的 ${pct(c.autoTriggerRatio ?? 0)}）`]);
  } else if (s.compactions > 0) {
    ctxRows.push(["压缩实况", `手动 ${s.compactions} 次`, "本场未见自动压缩，均为你手动触发"]);
  }
  if (c.peakSessionNotable) {
    ctxRows.push(["压缩前历史高点", `${pct(c.peakSessionRatio ?? 0)}（${human(c.peakSessionTokens ?? 0)}）`, "本场曾达到的最高占用"]);
  }

  // 链路健康度：把 --request-log 的逐笔归因压成一行结论（明细属于排障，留在 CLI）。
  // 分两档：本会话确实走在代理链路上（proxy/mixed）才印「最近 N 笔」的失败统计与排障命令；
  // token 全来自转录的会话里，那些统计说的是别的会话，印成 warning + 命令是噪音，只留覆盖率与最近记录时间。
  // 纯官方模型用户从没配过代理，整行不渲染。
  const lhRaw = r.linkHealth ?? null;
  const lh = lhRaw && (r.proxy?.configured || lhRaw.matched > 0) ? lhRaw : null;
  const lhOnPath = !!lh && (lh.matched > 0 || lh.usageSource === "proxy" || lh.usageSource === "mixed");
  const lhErrors = lh ? lh.proxyErrors ?? 0 : 0;
  const lhBad = lhOnPath && lhErrors > 0;
  const lhTone: "info" | "warning" = lhBad ? "warning" : "info";
  // 三档拆分一行说清：代理实测 / 转录 input_tokens / 转录 ratio×window 各多少笔。
  // 旧报告（v3）无 breakdown 字段时退回到只报 matched。
  const lhBd = lh?.breakdown ?? null;
  const lhBdText = lhBd
    ? `拆分：代理 ${lhBd.proxy} 笔 · 转录 input_tokens ${lhBd.transcriptTokens} 笔 · 转录 ratio×窗口 ${lhBd.transcriptRatio} 笔`
    : "";
  const lhSrcNote = !lh
    ? ""
    : lh.usageSource === "proxy"
      ? "：全部为供应商实测"
      : lh.usageSource === "transcript-tokens"
        ? "：本会话 token 全来自转录 input_tokens（BYOK，代理未在链路上）"
        : lh.usageSource === "transcript-ratio"
          ? "：本会话 token 由 ratio×窗口推导（官方模型）"
          : lh.usageSource === "mixed"
            ? "：多源混合，以下拆分列为准"
            : lh.usageSource === "transcript"
              ? "：本会话 token 全部来自转录，代理不在链路上"
              : "";
  const lhText = !lh
    ? ""
    : [
        lh.requests > 0
          ? `代理覆盖 ${lh.matched}/${lh.requests} 笔往返（${pct(lh.coverage)}）${lhSrcNote}`
          : "本会话没有带 usage 的往返，代理无从覆盖",
        lhBdText,
        lh.lastRecordAt ? `代理最近记录 ${shortTime(lh.lastRecordAt)}` : proxyAlive ? "代理有记录但无时间戳" : "代理从未记到流量",
        lhOnPath && lh.recentRequests
          ? `最近 ${lh.recentRequests} 笔：代理失败 ${lh.proxyErrors} · 上游报错 ${lh.upstreamRejected} · 客户端提前断开 ${lh.aborted} · 成功但无 usage ${lh.noUsage}${
              lh.slowestMs != null ? ` · 最慢 ${Math.round(lh.slowestMs / 1000)}s` : ""
            }`
          : lhOnPath
            ? "请求诊断日志为空（运行中的代理是旧版，或还没记到）"
            : "",
        lhBad ? `有「代理失败」= 请求没出得去或代理自己抛了，跑 ${CLI} --request-log 看归因` : "",
        !lhOnPath && lhErrors > 0 ? `代理另有 ${lhErrors} 笔失败，属于走代理的那些会话` : "",
        lh.supersededFailure
          ? `${shortTime(lh.supersededFailure.at ?? null)} 那条「拉起失败（${lh.supersededFailure.error}）」已被之后的流量推翻，无需处理`
          : "",
      ]
        .filter(Boolean)
        .join("。") + "。";

  return (
    <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
      <Stack gap="sectionCompact">
        <header>
          <Stack gap="component">
            <H1>会话 token 消耗截析</H1>
            <Text tone="secondary">
              {s.model || "未知模型"}
              {s.modelSource === "manual" ? "（手工录入）" : ""} · {sourceLabel} · 会话{" "}
              {String(s.id || "").slice(0, 8)}
              {s.title ? `「${s.title}」` : ""} · {shortTime(s.startedAt)} →{" "}
              {shortTime(s.endedAt)} · 压缩{" "}
              {availOf(av, "compactions") === "unavailable" ? "—" : `${s.compactions} 次`}
              {r.usageSource ? ` · usage 来源 ${
                r.usageSource === "proxy"
                  ? "代理实测"
                  : r.usageSource === "transcript-tokens"
                    ? "转录 input_tokens"
                    : r.usageSource === "transcript-ratio"
                      ? "转录 ratio×窗口"
                      : r.usageSource === "mixed"
                        ? "多源混合"
                        : "转录"
              }` : ""}
              {r.pluginVersion ? ` · v${r.pluginVersion}` : ""} · schema v{r.schemaVersion}
            </Text>
            <MetricsGrid variant="header" columns={4} items={headline} />
          </Stack>
        </header>

        {!hasUsage && r.source === "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：自定义模型（BYOK）不经 Qoder 计费网关">
            转录是桌面端富布局，但 assistant entry 里没有 message.usage——自定义模型（如千问
            tokenplan）的响应不经 Qoder 计费网关，credits / context_usage_ratio 无来源，提供商返回的
            usage 客户端也不落盘（已实测扫过 ~/.qoder-cn、~/.qoder、~/.qoder-cli 与 %APPDATA%\QoderCN）。
            本地补救（改一个配置文件即可，免装 Node、之后全自动）：编辑 {"`~/.qoder-credits-proxy/config.json`"}，
            把 {"`upstream`"} 填成你的供应商根地址（= Base URL 去掉结尾 /v1），再把自定义模型 Base URL 的 host:port
            换成 {`127.0.0.1:${r.proxy?.port ?? 49787}`}（路径保留），新开一个会话即自动拉起代理、按 message.id
            精确 join 出实测 token（credits 仍无真值）。装了 Node 也可用 {"`--setup-proxy`"} / {"`--check-proxy`"} 一步到位。
            手工回填通道同样可用：
            {"`.qoder-credits/overrides/<sessionId>.json`"}。
          </Callout>
        )}

        {!hasUsage && r.source !== "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：转录不含 message.usage">
            这是 {sourceLabel}（IDE 端客户端）。它的转录只写 session_meta / user / assistant / progress 四种 entry，
            message.usage 整个字段不存在，也不落到本地任何其它文件（已实测扫过 ~/.qoder-cn、~/.qoder、
            ~/.qoder-cli 与 %APPDATA%\QoderCN）。因此 Credits、token 与各类占比一律显示「—」而不是 0 ——
            0 会被误读成「这次没花钱」。真值只有官方 UI 有：把它填进{" "}
            {"`.qoder-credits/overrides/<sessionId>.json`"} 后重跑，上方会出现「官方 UI 真值」一段并与本地并列对账。
          </Callout>
        )}

        {manual && (
          <Callout tone="success" title="官方 UI 真值（手工录入，未覆盖任何本地数字）">
            Credits {manual.credits ?? "—"} · 原价 {manual.originalCredits ?? "—"}
            {manual.model ? ` · 模型 ${manual.model}` : ""}
            {manual.durationMin != null ? ` · 时长 ${manual.durationMin} min` : ""}
            {manual.startedAt ? ` · ${shortTime(manual.startedAt)}` : ""}
            {manual.localCoverage != null
              ? ` · 本地${manual.localScope === "combined" ? "合计（主链+子代理）" : "主链"} ${manual.localCredits ?? t.credits}，覆盖 ${pct(manual.localCoverage)}`
              : " · 本地无 usage，无法对账"}
            {manual.note ? `。备注：${manual.note}` : ""}
          </Callout>
        )}

        {sub && sub.count === 0 && sub.reason && sub.reason !== "no-dir" && (
          <Callout tone="warning" title={`子代理账未汇总（${sub.reason}）`}>
            探测过的候选目录：{(sub.probedPaths ?? []).join("  |  ") || "（无）"}
          </Callout>
        )}

        {proxyAlarm && (
          <Callout tone="warning" title={`代理自动启动失败（${proxyAlarm.error}）`}>
            {proxyAlarm.error === "EADDRINUSE"
              ? `端口 ${proxyAlarm.port ?? "—"} 被占用，自定义模型将无法对话。请换一个空闲端口重启代理：${CLI} --setup-proxy --port <新端口>，并把模型 Base URL 改成新端口。`
              : `代理未就绪（${proxyAlarm.error}），自定义模型可能无法对话。请运行 ${CLI} --check-proxy 查看链路状态。`}
          </Callout>
        )}

        {r.proxy?.dormant && !proxyAlarm && (
          <Callout tone="info" title="代理长期空闲">
            代理已配置但超过 14 天没有记录到流量（可能你已改回官方模型）。如不再使用自定义模型，可运行{" "}
            {CLI} --stop-proxy 停用代理；保留也不影响官方模型。
          </Callout>
        )}

        {cwIsFallback && (
          <Callout tone="warning" title="上下文窗口为回退值 200K（未从 runtime-config / usage 反推 / ManualTruth 拿到真值）">
            本会话所有以窗口为分母的占比与「峰值建议」都可能偏大，而绝对 token 数（已改以 S 真值为底）不受影响。
            建议在 {"`.qoder-credits/overrides/<sessionId>.json`"} 里手工填 {"`contextWindow`"}（如 qwen3-max=1000000），或等一笔带 input_tokens+ratio 的往返写入转录后自动反推生效。
          </Callout>
        )}

        {hasUsage && netAdv && c.userContextLimit != null && (
          <Stack gap="component">
            <Callout
              tone={netAdv.tone}
              title={`你真实的上下文占用 ${pct(c.netUserRatio ?? c.peakUserRatio ?? 0)}（${human(curCtx)} / 阈值 ${human(c.userContextLimit)}・${limitSrcLabel}）`}
            >
              {netAdv.text}
              {limitIsDefault && (
                <Text tone="secondary">
                  {` ⚙ 这里的 ${human(c.userContextLimit)} 是插件内置默认值，不是你在 Qoder「模型管理」里设的真实上限（插件读不到那个设置）。想按真实阈值算：在 ~/.qoder-credits-proxy/config.json 填 "userContextLimit": <你的上限>（对所有会话生效），或对本会话在 .qoder-credits/overrides/<会话id>.json 填同名字段，重跑报告即生效。`}
                </Text>
              )}
            </Callout>
            {ctxRows.length > 0 && (
              <Table
                headers={["对比口径", "数值", "说明"]}
                rows={ctxRows}
                density="compact"
              />
            )}
          </Stack>
        )}

        {c.thresholdNotEnforced && (
          <Callout tone="warning" title="⚠ 自动压缩不会在你设的阈值触发（本条最重要）">
            你的模型物理窗口是 {cwText}，Qoder 的自动压缩要等上下文涨到窗口 ~85%（≈{human(Math.round(c.contextWindow * 0.85))}）才触发；
            你在模型管理里设的 {human(c.userContextLimit)} 上限远在其下，永远不会触发自动压缩。
            请照上面「你真实的上下文占用」那条，到点自己手动压缩，别等它自动压。
          </Callout>
        )}

        {lh && (
          <Callout tone={lhTone} title="链路健康度">
            {lhText}
          </Callout>
        )}

        <Callout tone="info" title="度量口径">
          计费输入总量逐笔锁定真值（优先级：代理 promptTokens &gt; 转录 usage.input_tokens &gt; ratio{availTag(av, "contextRatio")} × {cwText}
          {cwIsFallback ? "，未拿到真窗口、全部 token 数字随之带 ≈" : ""}）；各类别/文件按块估算规模比例分摊
          {availTag(av, "categoryShare", "derived")}。{identityText}
          {cachedText ? ` ${cachedText}` : ""}
          {covPartial
            ? ` Credits 只来自 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}），其余往返走代理实测、不经 Qoder 计费，故不要拿 Credits 去除以计费输入总量算单价。`
            : ""}
        </Callout>

        {byReq.length > 0 && (
          <ReportSection
            title="逐请求明细（每一次往返）"
            description={
              showCreditsChart
                ? "每个 round-trip 的真实输入规模与 credits；曲线骤降处为上下文压缩重置（顶部四项为会话累计，此处为每一次）"
                : `每个 round-trip 的真实输入规模；曲线骤降处为上下文压缩重置。credits 曲线未画：本会话只有 ${cov?.trips ?? 0}/${cov?.roundTrips ?? byReq.length} 笔往返带 credits（其余走代理实测、不经 Qoder 计费），画出来是一地零。`
            }
            meta={`${byReq.length} 次往返 · 压缩 ${orDash(s.compactions, av, "compactions")} 次`}
            divided
          >
            {showCreditsChart ? (
              <ChartComparisonGrid>
                <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                    height={220}
                    valueFormatter={human}
                    ariaLabel="每次请求输入 tokens"
                  />
                </ChartContainer>
                <ChartContainer title="每次 credits" ariaLabel="每次 credits">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "credits", data: reqCredits, tone: "warning" }]}
                    height={220}
                    ariaLabel="每次请求 credits"
                  />
                </ChartContainer>
              </ChartComparisonGrid>
            ) : (
              <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                <LineChart
                  categories={reqLabels}
                  series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                  height={220}
                  valueFormatter={human}
                  ariaLabel="每次请求输入 tokens"
                />
              </ChartContainer>
            )}
          </ReportSection>
        )}

        {hasUsage && ccItems.length > 0 && (
          <ReportSection
            title="压缩单笔成本（会话里最贵的那几笔调用）"
            description="每次压缩本身就是一笔普通模型调用：整份上下文当 prompt 进去、摘要当 completion 出来。此前报告只显示「压缩 N 次」，把单笔最贵的开销藏成了一个计数。「省下」= 压缩前规模 − 压缩后首轮实测输入（地板）。口径列：实测=能在代理日志里唯一对上的供应商真值；自估=客户端在压缩边界里写的前后规模。"
            meta={`${ccItems.length} 次 · 输入累计 ${human(ccost?.totals.preTokens ?? 0)} · 摘要累计 ${human(ccost?.totals.postTokens ?? 0)} · 累计省下 ${human(ccost?.totals.savedTokens ?? 0)} · 其中 ${ccost?.totals.measured ?? 0} 笔为供应商实测`}
            divided
          >
            <Table
              headers={["第几次", "时刻", "触发", "输入", "摘要输出", "压缩后首轮", "省下", "耗时", "口径"]}
              rows={compactRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {sub && subItems.length > 0 && (
          <ReportSection
            title="子代理账（Agent 派发）"
            description="子代理的每次往返只写进它自己的独立转录，不计入上方主链任何数字；官方 UI 的一场会话扣费 = 主链 + 各子代理。"
            meta={`${subItems.length} 个子代理 · 主链 ${t.credits} + 子代理 ${sub.totals.credits} = 合计 ${sub.combined.credits} Credits`}
            divided
          >
            <Table
              headers={["子代理", "类型", "往返", "计费输入", "峰值占比", "Credits", "原价", "备注"]}
              rows={subRows}
              rowTone={subTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && r.byCategory.length > 0 && (
          <ReportSection
            title="按类别占比"
            description={`会话计费输入 token 在各来源间的分布（完整划分，占比之和 = 100%）${sysNote}`}
            meta={human(t.billedInputTokens) + ` tokens${availTag(av, "categoryShare", "derived")}`}
            divided
          >
            <ChartContainer ariaLabel="按类别占比">
              <PieChart donut data={pieData} centerLabel="计费输入" valueFormatter={human} />
            </ChartContainer>
          </ReportSection>
        )}

        {hasUsage && catDetail.length > 0 && (
          <ReportSection
            title="按类别下钻（工具 / 文件路径）"
            description="每个类别的消耗再拆到工具与具体文件/路径：工具返回、工具调用可精确到路径，其余类别为整体（无文件归属）。数值均为重发计费 token。"
            meta={`占总额=占计费输入总量 · 占本类=占该类别 · 程数=存活往返累计${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["类别", "工具", "文件 / 路径", "重发 tokens", "占总额", "占本类", "程数"]}
              rows={detailRows}
              rowTone={detailTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && tools.length > 0 && (
          <ReportSection
            title="按工具占比"
            description="各工具相关内容（调用参数 + 返回）重发累计的计费 token 占比（仅工具相关块，非完整划分，占比之和 < 100%）。「单次」= 平均每次调用带来的重发 token：总量榜会把「次数少但每次极贵」的工具埋掉，这一列专门把它捞出来。"
            meta={`token 占比${availTag(av, "toolShare", "derived")} · 调用次数为实测`}
            divided
          >
            <Stack gap="component">
              <ChartContainer ariaLabel="按工具占比">
                <BarChart horizontal categories={toolCategories} series={toolSeries} valueFormatter={human} ariaLabel="按工具占比" />
              </ChartContainer>
              <Table
                headers={["工具", "重发 tokens", "占比", "调用", "单次"]}
                rows={toolRows}
                density="compact"
                stickyHeader
              />
            </Stack>
          </ReportSection>
        )}

        {hasUsage && fileRows.length > 0 && (
          <ReportSection
            title="按文件占比"
            description="精确到路径/文件名：内容随上下文被重复发送累计的计费 token 占比（Top 20，仅可归因文件的块）。「单次读取」= 这个文件平均每次被读取最终烧掉多少（含此后每一程的重发）——读一次就烧掉十几万的文件，在按总量排序的榜上毫不起眼。"
            meta={`程数=存活往返累计 · 读取=返回次数（实测）${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["文件", "种类", "重发 tokens", "占比", "单次读取", "程数", "读取"]}
              rows={fileRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {!hasUsage && residueRows.length > 0 && (
          <ReportSection
            title="工具调用与文件读取（计数为实测）"
            description="占比与 token 一律不可用，但 tool_use 块两种转录都写，所以「谁被调了几次、谁被读了几次」仍是真值 —— IDE 端不是一无所有。"
            meta={`${t.toolCalls ?? 0} 次工具调用${availTag(av, "toolCalls")} · ${t.fileReads ?? 0} 次文件读取${availTag(av, "fileReads")} · ${s.turns} 轮对话`}
            divided
          >
            <Table
              headers={["工具 / 文件", "种类", "调用", "读取", "程数"]}
              rows={residueRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}
      </Stack>
    </ReportShell>
  );
}
