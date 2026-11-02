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
const REPORT = {"schemaVersion":3.2,"generatedAt":"2026-10-29T14:22:52.831Z","source":"desktop-rich","usageSource":"transcript-ratio","availability":{"credits":"measured","roundTrips":"measured","contextRatio":"measured","tokens":"derived","outputTokens":"unavailable","cachedTokens":"unavailable","categoryShare":"derived","toolShare":"derived","fileShare":"derived","systemPrompt":"derived","contextWindow":"fallback","compactions":"measured","compactionCost":"measured","model":"measured","title":"measured","toolCalls":"measured","fileReads":"measured","userTurns":"measured","userContextLimit":"fallback"},"session":{"id":"a5e077de-b700-412e-9340-8b9e9078b10b","title":"在设置中增加模型的配置，用户的书写提示中的内容可","titleSource":"first-user","model":"qfmodel","modelSource":"runtime-config","cwd":"D:\\ide\\mdreader","turns":21,"roundTrips":670,"compactions":5,"startedAt":"2026-10-29T08:02:15.425Z","endedAt":"2026-10-29T14:22:51.598Z"},"context":{"contextWindow":200000,"contextWindowSource":"fallback","systemPromptTokens":21003,"netContextTokens":65704,"peakContextTokens":65704,"peakContextRatio":0.32852,"peakSessionTokens":166796,"peakSessionRatio":0.83398,"peakSessionNotable":true,"peakAdvice":{"level":"low","tone":"info","text":"低于盈亏线（39%）。此时压缩在 token 上是亏的：省下的还不够付摘要输出加压缩后重读，别压"},"userContextLimit":200000,"userContextLimitSource":"default","peakUserRatio":0.32852,"peakUserAdvice":{"level":"low","tone":"info","text":"低于盈亏线（39%）。此时压缩在 token 上是亏的：省下的还不够付摘要输出加压缩后重读，别压"},"currentContextTokens":65704,"netUserRatio":0.32852,"netUserAdvice":{"level":"low","tone":"info","text":"低于盈亏线（39%）。此时压缩在 token 上是亏的：省下的还不够付摘要输出加压缩后重读，别压"},"netWindowRatio":0.32852,"observedAutoCompactions":5,"observedAutoTriggerTokens":167625,"autoTriggerRatio":0.838125,"thresholdNotEnforced":false},"totals":{"billedInputTokens":70478549,"netContextTokens":65704,"peakContextTokens":65704,"amplification":1072.67,"attributedTokens":70478549,"coverage":1,"credits":163.456,"originalCredits":163.456,"outputTokens":0,"cachedTokens":0,"cachedTrips":0,"cachedShare":0,"toolCalls":694,"fileReads":265},"creditsCoverage":{"trips":670,"roundTrips":670,"tokens":70478549,"tokenShare":1,"full":true},"compactionCost":{"count":5,"items":[{"index":1,"at":"2026-10-29T08:30:52.552Z","trigger":"auto","preTokens":169644,"postTokens":4811,"messagesSummarized":228,"nextRequestIndex":54,"nextInputTokens":48618,"savedTokens":121026,"proxy":null,"effectiveInputTokens":169644,"effectiveOutputTokens":4811},{"index":2,"at":"2026-10-29T08:42:54.386Z","trigger":"auto","preTokens":172061,"postTokens":6128,"messagesSummarized":240,"nextRequestIndex":127,"nextInputTokens":50178,"savedTokens":121883,"proxy":null,"effectiveInputTokens":172061,"effectiveOutputTokens":6128},{"index":3,"at":"2026-10-29T09:03:24.073Z","trigger":"auto","preTokens":167125,"postTokens":5706,"messagesSummarized":375,"nextRequestIndex":263,"nextInputTokens":45628,"savedTokens":121497,"proxy":null,"effectiveInputTokens":167125,"effectiveOutputTokens":5706},{"index":4,"at":"2026-10-29T09:57:31.635Z","trigger":"auto","preTokens":167056,"postTokens":4223,"messagesSummarized":489,"nextRequestIndex":443,"nextInputTokens":44380,"savedTokens":122676,"proxy":null,"effectiveInputTokens":167056,"effectiveOutputTokens":4223},{"index":5,"at":"2026-10-29T14:08:04.261Z","trigger":"auto","preTokens":167625,"postTokens":3091,"messagesSummarized":568,"nextRequestIndex":623,"nextInputTokens":41254,"savedTokens":126371,"proxy":null,"effectiveInputTokens":167625,"effectiveOutputTokens":3091}],"totals":{"preTokens":843511,"postTokens":23959,"savedTokens":613453,"measured":0}},"proxy":{"matched":0,"requests":670,"breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":670},"logPath":"C:\\Users\\zhaobingxiang\\.qoder-credits-proxy\\usage.jsonl","logExists":false,"logRecords":0,"configured":false,"enabled":true,"port":49787,"lastRecordAt":null,"dormant":false,"status":null,"statusSuperseded":false},"byCategory":[{"key":"tool_result","label":"工具返回","tokens":18775823,"share":0.26640478347572644},{"key":"system","label":"系统提示词","tokens":14072010,"share":0.1996637303075011},{"key":"compact_summary","label":"压缩摘要","tokens":3049448,"share":0.043267751207538216},{"key":"assistant_thinking","label":"模型思考","tokens":8474726,"share":0.1202454664414905},{"key":"assistant_tool_use","label":"工具调用","tokens":6061693,"share":0.08600763336079317},{"key":"assistant_text","label":"模型回复","tokens":468979,"share":0.006654212993501415},{"key":"user_input","label":"用户输入","tokens":3607430,"share":0.051184796249219074},{"key":"attachment","label":"附件/技能","tokens":15968439,"share":0.22657162596423294}],"byCategoryDetail":[{"key":"tool_result","label":"工具返回","tokens":18775823,"share":0.26640478347572644,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":9901246,"share":0.14048595577541356,"catShare":0.5273402149260357,"trips":29660},{"tool":"Read","label":"src/app.ts","kind":"read","tokens":2654746,"share":0.03766743099535207,"catShare":0.14139172166472813,"trips":1171},{"tool":"Read","label":"desktop/HostBridge.cs","kind":"read","tokens":582322,"share":0.008262403324492256,"catShare":0.031014470598817487,"trips":72},{"tool":"Read","label":"desktop/AiClient.cs","kind":"read","tokens":576018,"share":0.00817295363931628,"catShare":0.030678704536328125,"trips":411},{"tool":"Read","label":"src/core/ai/session.ts","kind":"read","tokens":507522,"share":0.007201089064903882,"catShare":0.0270306297467816,"trips":144},{"tool":"Read","label":"desktop/HostBridge.cs","kind":"read","tokens":391460,"share":0.005554308730784517,"catShare":0.02084913288086886,"trips":47},{"tool":"Read","label":"src/core/settings.ts","kind":"read","tokens":375417,"share":0.005326681842293163,"catShare":0.019994692936054225,"trips":282},{"tool":"Read","label":"src/ui/ai-panel.ts","kind":"read","tokens":348397,"share":0.00494330065782678,"catShare":0.01855560021607942,"trips":194},{"tool":"Read","label":"C:/Users/zhaobingxiang/.qoder-cn/projects/D--ide-mdreader/memory/desktop-verification-env.md","kind":"read","tokens":328344,"share":0.0046587798325945715,"catShare":0.017487598277374995,"trips":126},{"tool":"Read","label":"src/styles/layout.css","kind":"read","tokens":299277,"share":0.004246353704117972,"catShare":0.015939479947457025,"trips":574},{"tool":"Read","label":"src/ui/settings-modal.ts","kind":"read","tokens":299110,"share":0.004243989260721665,"catShare":0.015930604568548813,"trips":260},{"tool":"Read","label":"src/ui/layout.ts","kind":"read","tokens":229972,"share":0.0032630037428705606,"catShare":0.012248292618093588,"trips":177},{"tool":"Read","label":"src/app.ts","kind":"read","tokens":207823,"share":0.0029487472126845495,"catShare":0.011068672169519154,"trips":39},{"tool":"Read","label":"src/core/file/webview.ts","kind":"read","tokens":161841,"share":0.002296322591799855,"catShare":0.00861967477400452,"trips":118},{"tool":"Read","label":"src/editor/extensions/lint.ts","kind":"read","tokens":128201,"share":0.001819001292713155,"catShare":0.006827960327817815,"trips":46},{"tool":null,"label":"其他 94 项","kind":null,"tokens":1784127,"share":0.025314461807836246,"catShare":0.09502254981147057,"trips":13854}]},{"key":"system","label":"系统提示词","tokens":14072010,"share":0.1996637303075011,"children":[]},{"key":"compact_summary","label":"压缩摘要","tokens":3049448,"share":0.043267751207538216,"children":[]},{"key":"assistant_thinking","label":"模型思考","tokens":8474726,"share":0.1202454664414905,"children":[]},{"key":"assistant_tool_use","label":"工具调用","tokens":6061693,"share":0.08600763336079317,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":2207679,"share":0.031324119834267035,"catShare":0.3642016250216486,"trips":29660},{"tool":"Edit","label":"src/app.ts","kind":"write","tokens":500038,"share":0.007094894457315468,"catShare":0.0824914508175468,"trips":1700},{"tool":"Edit","label":"desktop/AiClient.cs","kind":"write","tokens":327615,"share":0.004648428726807879,"catShare":0.05404669963778911,"trips":1453},{"tool":"Edit","label":"src/styles/layout.css","kind":"write","tokens":299685,"share":0.004252141022621179,"catShare":0.0494391120469957,"trips":271},{"tool":"Write","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-maas.cjs","kind":"write","tokens":276530,"share":0.00392360936101693,"catShare":0.045619315492123724,"trips":172},{"tool":"Edit","label":"src/core/settings.ts","kind":"write","tokens":190887,"share":0.0027084463175499097,"catShare":0.031490766711231966,"trips":944},{"tool":"Edit","label":"desktop/HostBridge.cs","kind":"write","tokens":185013,"share":0.0026250922455204823,"catShare":0.03052161933707082,"trips":500},{"tool":"Write","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-ask.cjs","kind":"write","tokens":150778,"share":0.00213934865001474,"catShare":0.02487393928211456,"trips":114},{"tool":"Edit","label":"src/ui/settings-modal.ts","kind":"write","tokens":130654,"share":0.0018538098096007368,"catShare":0.021554014884053316,"trips":496},{"tool":"Edit","label":"src/core/ai/session.ts","kind":"write","tokens":125308,"share":0.0017779590926142752,"catShare":0.020672108080871374,"trips":872},{"tool":"Write","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-lanz-e2e.cjs","kind":"write","tokens":123079,"share":0.0017463344369118131,"catShare":0.020304412162884658,"trips":130},{"tool":"Write","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-test.cjs","kind":"write","tokens":118426,"share":0.0016803135027676729,"catShare":0.01953679501584389,"trips":46},{"tool":"Write","label":"src/core/ai/session.ts","kind":"write","tokens":110369,"share":0.0015659939804085231,"catShare":0.01820761622214786,"trips":28},{"tool":"AskUserQuestion","label":"（无路径）","kind":"other","tokens":84649,"share":0.0012010552533143252,"catShare":0.013964519268609822,"trips":301},{"tool":"Write","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-defaults.cjs","kind":"write","tokens":82843,"share":0.0011754362583087886,"catShare":0.01366665041668981,"trips":47},{"tool":null,"label":"其他 94 项","kind":null,"tokens":1148141,"share":0.016290650411754187,"catShare":0.18940935560238686,"trips":10441}]},{"key":"assistant_text","label":"模型回复","tokens":468979,"share":0.006654212993501415,"children":[]},{"key":"user_input","label":"用户输入","tokens":3607430,"share":0.051184796249219074,"children":[]},{"key":"attachment","label":"附件/技能","tokens":15968439,"share":0.22657162596423294,"children":[]}],"byTool":[{"tool":"Bash","tokens":12108925,"calls":395,"perCall":30656,"share":0.17181007560967804},{"tool":"Read","tokens":8558177,"calls":87,"perCall":98370,"share":0.12142953007431499},{"tool":"Edit","tokens":2474262,"calls":145,"perCall":17064,"share":0.035106590017548324},{"tool":"Write","tokens":1414795,"calls":27,"perCall":52400,"share":0.020074116166894872},{"tool":"AskUserQuestion","tokens":113116,"calls":7,"perCall":16159,"share":0.001604974101637501},{"tool":"Grep","tokens":74287,"calls":6,"perCall":12381,"share":0.0010540365242269372},{"tool":"TaskCreate","tokens":32398,"calls":9,"perCall":3600,"share":0.0004596795853355067},{"tool":"TaskList","tokens":27950,"calls":1,"perCall":27950,"share":0.0003965795804035255},{"tool":"Skill","tokens":16940,"calls":2,"perCall":8470,"share":0.00024036372621592865},{"tool":"TaskUpdate","tokens":16666,"calls":15,"perCall":1111,"share":0.0002364714502562688}],"byFile":[{"attr":"file:D:\\ide\\mdreader\\src\\app.ts","label":"src/app.ts","kind":"read","tool":"Read","selfTokens":40271,"reads":35,"trips":5742,"billed":3207433,"perRead":91641,"share":0.0455093472728547},{"attr":"file:D:\\ide\\mdreader\\desktop\\AiClient.cs","label":"desktop/AiClient.cs","kind":"read","tool":"Read","selfTokens":11330,"reads":20,"trips":3728,"billed":943092,"perRead":47155,"share":0.013381268816376603},{"attr":"file:D:\\ide\\mdreader\\desktop\\HostBridge.cs","label":"desktop/HostBridge.cs","kind":"read","tool":"Read","selfTokens":11107,"reads":8,"trips":1144,"billed":784305,"perRead":98038,"share":0.011128274012876386},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\session.ts","label":"src/core/ai/session.ts","kind":"write","tool":"Write","selfTokens":12142,"reads":19,"trips":2088,"billed":776367,"perRead":40861,"share":0.011015644552208121},{"attr":"file:D:\\ide\\mdreader\\src\\styles\\layout.css","label":"src/styles/layout.css","kind":"read","tool":"Read","selfTokens":8278,"reads":16,"trips":1690,"billed":616861,"perRead":38554,"share":0.008752461241833223},{"attr":"file:D:\\ide\\mdreader\\src\\core\\settings.ts","label":"src/core/settings.ts","kind":"read","tool":"Read","selfTokens":10889,"reads":18,"trips":2452,"billed":596430,"perRead":33135,"share":0.008462574554130969},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\settings-modal.ts","label":"src/ui/settings-modal.ts","kind":"read","tool":"Read","selfTokens":13711,"reads":19,"trips":1526,"billed":475509,"perRead":25027,"share":0.006746860784865037},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\ai-panel.ts","label":"src/ui/ai-panel.ts","kind":"write","tool":"Write","selfTokens":6629,"reads":9,"trips":1050,"billed":431266,"perRead":47918,"share":0.006119103454678457},{"attr":"file:D:/ide/mdreader/desktop/HostBridge.cs","label":"desktop/HostBridge.cs","kind":"read","tool":"Read","selfTokens":8240,"reads":1,"trips":94,"billed":392078,"perRead":392078,"share":0.005563085443255674},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-maas.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-maas.cjs","kind":"write","tool":"Write","selfTokens":2210,"reads":2,"trips":668,"billed":366546,"perRead":183273,"share":0.0052008132788803965},{"attr":"file:C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\D--ide-mdreader\\memory\\desktop-verification-env.md","label":"C:/Users/zhaobingxiang/.qoder-cn/projects/D--ide-mdreader/memory/desktop-verification-env.md","kind":"read","tool":"Read","selfTokens":2760,"reads":1,"trips":252,"billed":331831,"perRead":331831,"share":0.0047082505814577125},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\layout.ts","label":"src/ui/layout.ts","kind":"read","tool":"Read","selfTokens":5504,"reads":10,"trips":726,"billed":275648,"perRead":27565,"share":0.0039110932298329956},{"attr":"file:D:/ide/mdreader/src/app.ts","label":"src/app.ts","kind":"read","tool":"Read","selfTokens":15599,"reads":3,"trips":78,"billed":208468,"perRead":69489,"share":0.002957895308401997},{"attr":"file:D:\\ide\\mdreader\\src\\core\\file\\webview.ts","label":"src/core/file/webview.ts","kind":"read","tool":"Read","selfTokens":3845,"reads":5,"trips":436,"billed":184343,"perRead":36869,"share":0.0026155962266490988},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-ask.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-ask.cjs","kind":"write","tool":"Write","selfTokens":1365,"reads":1,"trips":228,"billed":155330,"perRead":155330,"share":0.002203932760203865},{"attr":"file:D:\\ide\\mdreader\\desktop\\Workfile.cs","label":"desktop/Workfile.cs","kind":"read","tool":"Read","selfTokens":2013,"reads":6,"trips":858,"billed":147817,"perRead":24636,"share":0.0020973352024874926},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-diff.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-diff.cjs","kind":"write","tool":"Write","selfTokens":990,"reads":2,"trips":590,"billed":144658,"perRead":72329,"share":0.002052514832970909},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\providers.ts","label":"src/core/ai/providers.ts","kind":"write","tool":"Write","selfTokens":2301,"reads":8,"trips":1190,"billed":137526,"perRead":17191,"share":0.0019513127496494913},{"attr":"file:D:\\ide\\mdreader\\desktop\\SecretsStore.cs","label":"desktop/SecretsStore.cs","kind":"read","tool":"Read","selfTokens":1742,"reads":4,"trips":658,"billed":132879,"perRead":33220,"share":0.0018853816737875752},{"attr":"file:D:\\ide\\mdreader\\src\\editor\\extensions\\lint.ts","label":"src/editor/extensions/lint.ts","kind":"read","tool":"Read","selfTokens":2757,"reads":1,"trips":92,"billed":128996,"perRead":128996,"share":0.0018302870671569958},{"attr":"file:D:/ide/mdreader/src/editor/extensions/lint.ts","label":"src/editor/extensions/lint.ts","kind":"read","tool":"Read","selfTokens":2755,"reads":1,"trips":92,"billed":128324,"perRead":128324,"share":0.0018207567752636608},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-lanz-e2e.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-lanz-e2e.cjs","kind":"write","tool":"Write","selfTokens":1032,"reads":1,"trips":260,"billed":128042,"perRead":128042,"share":0.0018167511480776122},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-test.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-test.cjs","kind":"write","tool":"Write","selfTokens":2513,"reads":1,"trips":92,"billed":120342,"perRead":120342,"share":0.0017074920470906434},{"attr":"file:D:/ide/mdreader/src/ui/layout.ts","label":"src/ui/layout.ts","kind":"read","tool":"Read","selfTokens":2428,"reads":1,"trips":94,"billed":115530,"perRead":115530,"share":0.0016392198369204818},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-hintscroll.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-hintscroll.cjs","kind":"write","tool":"Write","selfTokens":5870,"reads":4,"trips":172,"billed":103068,"perRead":25767,"share":0.0014624026223750374},{"attr":"file:D:\\ide\\mdreader\\src\\styles\\widgets.css","label":"src/styles/widgets.css","kind":"read","tool":"Read","selfTokens":1042,"reads":3,"trips":522,"billed":101954,"perRead":33985,"share":0.0014466020137182396},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-lanz-apply.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-lanz-apply.cjs","kind":"write","tool":"Write","selfTokens":809,"reads":1,"trips":222,"billed":85593,"perRead":85593,"share":0.0012144602013525524},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-defaults.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-defaults.cjs","kind":"write","tool":"Write","selfTokens":1882,"reads":1,"trips":94,"billed":84642,"perRead":84642,"share":0.001200961475644484},{"attr":"file:D:/ide/mdreader/src/core/file/webview.ts","label":"src/core/file/webview.ts","kind":"read","tool":"Read","selfTokens":1893,"reads":1,"trips":88,"billed":84318,"perRead":84318,"share":0.0011963689320708458},{"attr":"file:D:/ide/mdreader/src/core/settings.ts","label":"src/core/settings.ts","kind":"read","tool":"Read","selfTokens":1600,"reads":1,"trips":96,"billed":77770,"perRead":77770,"share":0.0011034548544102977},{"attr":"file:D:/ide/mdreader/src/ui/settings-modal.ts","label":"src/ui/settings-modal.ts","kind":"read","tool":"Read","selfTokens":1570,"reads":1,"trips":96,"billed":76312,"perRead":76312,"share":0.0010827650758901053},{"attr":"file:D:/ide/mdreader/src/styles/layout.css","label":"src/styles/layout.css","kind":"read","tool":"Read","selfTokens":5849,"reads":1,"trips":22,"billed":67000,"perRead":67000,"share":0.0009506434138625408},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\panels.ts","label":"src/ui/panels.ts","kind":"read","tool":"Read","selfTokens":1762,"reads":5,"trips":194,"billed":65494,"perRead":13099,"share":0.0009292742776791532},{"attr":"file:D:\\ide\\mdreader\\src\\editor\\extensions\\autocomplete.ts","label":"src/editor/extensions/autocomplete.ts","kind":"read","tool":"Read","selfTokens":1360,"reads":1,"trips":94,"billed":64957,"perRead":64957,"share":0.0009216523115224595},{"attr":"file:D:/ide/mdreader/src/editor/extensions/autocomplete.ts","label":"src/editor/extensions/autocomplete.ts","kind":"read","tool":"Read","selfTokens":1358,"reads":1,"trips":92,"billed":63254,"perRead":63254,"share":0.000897490998478422},{"attr":"file:D:/ide/mdreader/src/ui/panels.ts","label":"src/ui/panels.ts","kind":"read","tool":"Read","selfTokens":1226,"reads":1,"trips":96,"billed":59591,"perRead":59591,"share":0.0008455222821918911},{"attr":"file:D:\\ide\\mdreader\\src\\styles\\dark.css","label":"src/styles/dark.css","kind":"read","tool":"Read","selfTokens":1364,"reads":1,"trips":72,"billed":50159,"perRead":50159,"share":0.0007116921916762081},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-shell-check.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-shell-check.cjs","kind":"write","tool":"Write","selfTokens":1781,"reads":6,"trips":284,"billed":42375,"perRead":7062,"share":0.000601240162579109},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\prompts.ts","label":"src/core/ai/prompts.ts","kind":"write","tool":"Write","selfTokens":1327,"reads":1,"trips":62,"billed":41985,"perRead":41985,"share":0.0005957093671342121},{"attr":"file:D:/ide/mdreader/desktop/SettingsStore.cs","label":"desktop/SettingsStore.cs","kind":"read","tool":"Read","selfTokens":860,"reads":1,"trips":90,"billed":39182,"perRead":39182,"share":0.0005559380190952092},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\types.ts","label":"src/core/ai/types.ts","kind":"write","tool":"Write","selfTokens":1161,"reads":1,"trips":64,"billed":37924,"perRead":37924,"share":0.000538085888695052},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-maas-default.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-maas-default.cjs","kind":"write","tool":"Write","selfTokens":880,"reads":1,"trips":82,"billed":34627,"perRead":34627,"share":0.0004913099717823672},{"attr":"file:/d/ide/mdreader/src","label":"/d/ide/mdreader/src","kind":"search","tool":"Grep","selfTokens":785,"reads":1,"trips":88,"billed":34227,"perRead":34227,"share":0.0004856334160106092},{"attr":"file:D:\\ide\\mdreader\\src\\core\\ai\\host.ts","label":"src/core/ai/host.ts","kind":"write","tool":"Write","selfTokens":904,"reads":3,"trips":312,"billed":33632,"perRead":11211,"share":0.0004771940504357816},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-dbg.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-dbg.cjs","kind":"write","tool":"Write","selfTokens":847,"reads":1,"trips":80,"billed":33596,"perRead":33596,"share":0.00047668321607358707},{"attr":"file:D:/ide/mdreader/src/core/document.ts","label":"src/core/document.ts","kind":"read","tool":"Read","selfTokens":2302,"reads":1,"trips":28,"billed":33414,"perRead":33414,"share":0.0004740992203986941},{"attr":"file:D:\\ide\\mdreader\\src\\core\\snippets.ts","label":"src/core/snippets.ts","kind":"write","tool":"Write","selfTokens":1305,"reads":1,"trips":48,"billed":31989,"perRead":31989,"share":0.0004538850194881439},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-model-pick.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-model-pick.cjs","kind":"write","tool":"Write","selfTokens":2210,"reads":1,"trips":22,"billed":24628,"perRead":24628,"share":0.000349435167410879},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-maas-fallback.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-maas-fallback.cjs","kind":"write","tool":"Write","selfTokens":690,"reads":1,"trips":64,"billed":21310,"perRead":21310,"share":0.0003023602687791841},{"attr":"file:D:/ide/mdreader/src/ui/diff-view.ts","label":"src/ui/diff-view.ts","kind":"read","tool":"Read","selfTokens":1299,"reads":1,"trips":22,"billed":14880,"perRead":14880,"share":0.00021112767902332712},{"attr":"file:D:\\ide\\mdreader\\src\\editor\\create.ts","label":"src/editor/create.ts","kind":"read","tool":"Read","selfTokens":724,"reads":1,"trips":40,"billed":14794,"perRead":14794,"share":0.00020990080685299382},{"attr":"file:D:\\ide\\mdreader\\desktop\\SettingsStore.cs","label":"desktop/SettingsStore.cs","kind":"read","tool":"Read","selfTokens":238,"reads":1,"trips":122,"billed":14477,"perRead":14477,"share":0.00020541128373910043},{"attr":"file:/d/ide/mdreader/src/app.ts","label":"/d/ide/mdreader/src/app.ts","kind":"search","tool":"Grep","selfTokens":319,"reads":1,"trips":84,"billed":13285,"perRead":13285,"share":0.0001885031611661279},{"attr":"file:/d/ide/mdreader/src/core/ai/session.ts","label":"/d/ide/mdreader/src/core/ai/session.ts","kind":"search","tool":"Grep","selfTokens":349,"reads":1,"trips":76,"billed":13146,"perRead":13146,"share":0.00018651988246674625},{"attr":"file:/d/ide/mdreader/src/core/file/webview.ts","label":"/d/ide/mdreader/src/core/file/webview.ts","kind":"search","tool":"Grep","selfTokens":347,"reads":1,"trips":72,"billed":12393,"perRead":12393,"share":0.00017584402537395262},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\modal.ts","label":"src/ui/modal.ts","kind":"read","tool":"Read","selfTokens":603,"reads":1,"trips":40,"billed":12321,"perRead":12321,"share":0.00017482069963032496},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-desktop.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-desktop.cjs","kind":"write","tool":"Write","selfTokens":1166,"reads":1,"trips":20,"billed":12125,"perRead":12125,"share":0.00017203847343980248},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\maas-diff.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/maas-diff.png","kind":"read","tool":"Read","selfTokens":103,"reads":1,"trips":200,"billed":10319,"perRead":10319,"share":0.00014641507780044857},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\maas-jump.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/maas-jump.png","kind":"read","tool":"Read","selfTokens":102,"reads":1,"trips":190,"billed":9712,"perRead":9712,"share":0.00013780652809120269},{"attr":"file:D:/ide/mdreader/src/styles/widgets.css","label":"src/styles/widgets.css","kind":"read","tool":"Read","selfTokens":994,"reads":1,"trips":18,"billed":9315,"perRead":9315,"share":0.00013217244541310845},{"attr":"file:D:\\ide\\mdreader\\desktop\\MdReader.csproj","label":"desktop/MdReader.csproj","kind":"write","tool":"Edit","selfTokens":126,"reads":2,"trips":258,"billed":8415,"perRead":4208,"share":0.00011940360049584341},{"attr":"file:D:\\ide\\mdreader\\desktop\\Program.cs","label":"desktop/Program.cs","kind":"write","tool":"Edit","selfTokens":113,"reads":1,"trips":132,"billed":7390,"perRead":7390,"share":0.00010485903089963659},{"attr":"file:D:/ide/mdreader/src/styles/base.css","label":"src/styles/base.css","kind":"read","tool":"Read","selfTokens":674,"reads":1,"trips":20,"billed":7020,"perRead":7020,"share":0.00009960416130317617},{"attr":"file:D:/ide/mdreader/desktop/MdReader.csproj","label":"desktop/MdReader.csproj","kind":"read","tool":"Read","selfTokens":1097,"reads":1,"trips":12,"billed":6841,"perRead":6841,"share":0.00009706602974332804},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-panel.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-panel.png","kind":"read","tool":"Read","selfTokens":105,"reads":1,"trips":88,"billed":4813,"perRead":4813,"share":0.00006828939005928626},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-settings.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-settings.png","kind":"read","tool":"Read","selfTokens":106,"reads":1,"trips":86,"billed":4749,"perRead":4749,"share":0.00006738786318939167},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-ai-diff.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-ai-diff.png","kind":"read","tool":"Read","selfTokens":104,"reads":1,"trips":84,"billed":4552,"perRead":4552,"share":0.00006458374443674336},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\maas-default-result.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/maas-default-result.png","kind":"read","tool":"Read","selfTokens":106,"reads":1,"trips":68,"billed":3475,"perRead":3475,"share":0.000049311739245992284},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\hint-scrolled.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/hint-scrolled.png","kind":"read","tool":"Read","selfTokens":104,"reads":1,"trips":66,"billed":3406,"perRead":3406,"share":0.000048324905621495845},{"attr":"file:D:/ide/mdreader/desktop/Program.cs","label":"desktop/Program.cs","kind":"read","tool":"Read","selfTokens":437,"reads":1,"trips":10,"billed":2269,"perRead":2269,"share":0.00003219115563812598},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\mdreader-model-desktop.cjs","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/mdreader-model-desktop.cjs","kind":"write","tool":"Write","selfTokens":1097,"reads":1,"trips":4,"billed":2235,"perRead":2235,"share":0.00003171770591057672},{"attr":"file:D:\\ide\\mdreader\\src\\ui\\diff-view.ts","label":"src/ui/diff-view.ts","kind":"write","tool":"Edit","selfTokens":369,"reads":2,"trips":18,"billed":1736,"perRead":868,"share":0.000024634325187255787},{"attr":"file:D:/ide/mdreader/desktop/SecretsStore.cs","label":"desktop/SecretsStore.cs","kind":"write","tool":"Write","selfTokens":796,"reads":1,"trips":4,"billed":1650,"perRead":1650,"share":0.00002341746239527956},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\models-settings.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/models-settings.png","kind":"read","tool":"Read","selfTokens":104,"reads":1,"trips":16,"billed":845,"perRead":845,"share":0.000011989596463604695},{"attr":"file:D:/ide/mdreader/desktop/Workfile.cs","label":"desktop/Workfile.cs","kind":"write","tool":"Write","selfTokens":733,"reads":1,"trips":2,"billed":760,"perRead":760,"share":0.000010777696691247275},{"attr":"file:C:\\Users\\zhaobingxiang\\AppData\\Local\\Temp\\models-panel.png","label":"C:/Users/zhaobingxiang/AppData/Local/Temp/models-panel.png","kind":"read","tool":"Read","selfTokens":104,"reads":1,"trips":14,"billed":740,"perRead":740,"share":0.00001050100283238563},{"attr":"file:/d/ide/mdreader/src/styles/layout.css","label":"/d/ide/mdreader/src/styles/layout.css","kind":"search","tool":"Grep","selfTokens":59,"reads":1,"trips":24,"billed":684,"perRead":684,"share":0.000009712036711812707},{"attr":"file:/d/ide/mdreader/src/ui/layout.ts","label":"/d/ide/mdreader/src/ui/layout.ts","kind":"search","tool":"Grep","selfTokens":52,"reads":1,"trips":22,"billed":551,"perRead":551,"share":0.000007824002497688076},{"attr":"file:D:/ide/mdreader/desktop/AiClient.cs","label":"desktop/AiClient.cs","kind":"write","tool":"Write","selfTokens":5595,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0}],"byAttr":[{"attr":"attachment","tokens":15968439,"share":0.22657162596423294},{"attr":"system","tokens":14072010,"share":0.1996637303075011},{"attr":"tool_result|Bash","tokens":9901246,"share":0.14048595577541356},{"attr":"assistant_thinking","tokens":8474726,"share":0.1202454664414905},{"attr":"tool_result|Read","tokens":8462471,"share":0.1200715877255144},{"attr":"user_input","tokens":3607430,"share":0.051184796249219074},{"attr":"compact_summary","tokens":3049448,"share":0.043267751207538216},{"attr":"tool_use|Edit","tokens":2246912,"share":0.031880797255806656},{"attr":"tool_use|Bash","tokens":2207679,"share":0.031324119834267035},{"attr":"tool_use|Write","tokens":1370675,"share":0.019448117449525855},{"attr":"assistant_text","tokens":468979,"share":0.006654212993501415},{"attr":"tool_result|Edit","tokens":227349,"share":0.0032257927617423132},{"attr":"tool_use|Read","tokens":95706,"share":0.001357942348800309},{"attr":"tool_use|AskUserQuestion","tokens":84649,"share":0.0012010552533143252},{"attr":"tool_result|Grep","tokens":68244,"share":0.0009683003624486835},{"attr":"tool_result|Write","tokens":44119,"share":0.0006259987173690256},{"attr":"tool_result|AskUserQuestion","tokens":28468,"share":0.0004039188483231772},{"attr":"tool_result|TaskList","tokens":27783,"share":0.00039420485237715697},{"attr":"tool_use|TaskCreate","tokens":25332,"share":0.0003594240222177924},{"attr":"tool_use|Skill","tokens":14532,"share":0.000206183436903512},{"attr":"tool_use|TaskUpdate","tokens":10000,"share":0.00014188287015376113},{"attr":"tool_result|TaskCreate","tokens":7066,"share":0.00010025556311771445},{"attr":"tool_result|TaskUpdate","tokens":6666,"share":0.00009458858010250758},{"attr":"tool_use|Grep","tokens":6043,"share":0.0000857361617782534},{"attr":"tool_result|Skill","tokens":2409,"share":0.00003418028931241669},{"attr":"tool_use|TaskList","tokens":167,"share":0.0000023747280263684167}],"byRequest":[{"index":1,"time":"16:02","ratio":0.179145,"inputTokens":35829,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.572,"originalCredits":1.572,"afterCompact":false},{"index":2,"time":"16:02","ratio":0.199605,"inputTokens":39921,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":3,"time":"16:02","ratio":0.211275,"inputTokens":42255,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.144,"originalCredits":0.144,"afterCompact":false},{"index":4,"time":"16:02","ratio":0.219995,"inputTokens":43999,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":5,"time":"16:02","ratio":0.22263,"inputTokens":44526,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.078,"originalCredits":0.078,"afterCompact":false},{"index":6,"time":"16:03","ratio":0.2465,"inputTokens":49300,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":7,"time":"16:03","ratio":0.298075,"inputTokens":59615,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.532,"originalCredits":0.532,"afterCompact":false},{"index":8,"time":"16:03","ratio":0.3225,"inputTokens":64500,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.354,"originalCredits":0.354,"afterCompact":false},{"index":9,"time":"16:03","ratio":0.330535,"inputTokens":66107,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.148,"originalCredits":0.148,"afterCompact":false},{"index":10,"time":"16:03","ratio":0.34521,"inputTokens":69042,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":11,"time":"16:04","ratio":0.35161,"inputTokens":70322,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.053,"originalCredits":1.053,"afterCompact":false},{"index":12,"time":"16:05","ratio":0.379035,"inputTokens":75807,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.302,"originalCredits":0.302,"afterCompact":false},{"index":13,"time":"16:07","ratio":0.382405,"inputTokens":76481,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.139,"originalCredits":0.139,"afterCompact":false},{"index":14,"time":"16:08","ratio":0.38445,"inputTokens":76890,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.138,"originalCredits":0.138,"afterCompact":false},{"index":15,"time":"16:14","ratio":0.387285,"inputTokens":77457,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.251,"originalCredits":0.251,"afterCompact":false},{"index":16,"time":"16:15","ratio":0.39234,"inputTokens":78468,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":17,"time":"16:16","ratio":0.395635,"inputTokens":79127,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":18,"time":"16:16","ratio":0.402235,"inputTokens":80447,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":19,"time":"16:16","ratio":0.40743,"inputTokens":81486,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.189,"originalCredits":0.189,"afterCompact":false},{"index":20,"time":"16:16","ratio":0.411325,"inputTokens":82265,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.487,"originalCredits":0.487,"afterCompact":false},{"index":21,"time":"16:17","ratio":0.42276,"inputTokens":84552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.708,"originalCredits":0.708,"afterCompact":false},{"index":22,"time":"16:17","ratio":0.442925,"inputTokens":88585,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":23,"time":"16:18","ratio":0.447765,"inputTokens":89553,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.651,"originalCredits":0.651,"afterCompact":false},{"index":24,"time":"16:20","ratio":0.462965,"inputTokens":92593,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.19,"originalCredits":0.19,"afterCompact":false},{"index":25,"time":"16:20","ratio":0.466495,"inputTokens":93299,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.188,"originalCredits":0.188,"afterCompact":false},{"index":26,"time":"16:20","ratio":0.46993,"inputTokens":93986,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":27,"time":"16:22","ratio":0.474875,"inputTokens":94975,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":28,"time":"16:23","ratio":0.479215,"inputTokens":95843,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.221,"originalCredits":0.221,"afterCompact":false},{"index":29,"time":"16:23","ratio":0.484705,"inputTokens":96941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.204,"originalCredits":0.204,"afterCompact":false},{"index":30,"time":"16:23","ratio":0.49181,"inputTokens":98362,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.23,"originalCredits":0.23,"afterCompact":false},{"index":31,"time":"16:23","ratio":0.496185,"inputTokens":99237,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.439,"originalCredits":0.439,"afterCompact":false},{"index":32,"time":"16:25","ratio":0.505765,"inputTokens":101153,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":33,"time":"16:25","ratio":0.509435,"inputTokens":101887,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":34,"time":"16:25","ratio":0.5118,"inputTokens":102360,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.157,"originalCredits":0.157,"afterCompact":false},{"index":35,"time":"16:25","ratio":0.514255,"inputTokens":102851,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.248,"originalCredits":0.248,"afterCompact":false},{"index":36,"time":"16:25","ratio":0.519905,"inputTokens":103981,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":37,"time":"16:25","ratio":0.52415,"inputTokens":104830,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.249,"originalCredits":0.249,"afterCompact":false},{"index":38,"time":"16:26","ratio":0.528865,"inputTokens":105773,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.489,"originalCredits":0.489,"afterCompact":false},{"index":39,"time":"16:26","ratio":0.54879,"inputTokens":109758,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":40,"time":"16:26","ratio":0.580805,"inputTokens":116161,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.398,"originalCredits":0.398,"afterCompact":false},{"index":41,"time":"16:26","ratio":0.606625,"inputTokens":121325,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.346,"originalCredits":0.346,"afterCompact":false},{"index":42,"time":"16:26","ratio":0.640625,"inputTokens":128125,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.432,"originalCredits":0.432,"afterCompact":false},{"index":43,"time":"16:26","ratio":0.68695,"inputTokens":137390,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.619,"originalCredits":0.619,"afterCompact":false},{"index":44,"time":"16:27","ratio":0.695955,"inputTokens":139191,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":45,"time":"16:27","ratio":0.703195,"inputTokens":140639,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.294,"originalCredits":1.294,"afterCompact":false},{"index":46,"time":"16:27","ratio":0.741365,"inputTokens":148273,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.26,"originalCredits":0.26,"afterCompact":false},{"index":47,"time":"16:28","ratio":0.74406,"inputTokens":148812,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":48,"time":"16:28","ratio":0.750455,"inputTokens":150091,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.601,"originalCredits":0.601,"afterCompact":false},{"index":49,"time":"16:29","ratio":0.764015,"inputTokens":152803,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.924,"originalCredits":1.924,"afterCompact":false},{"index":50,"time":"16:29","ratio":0.814285,"inputTokens":162857,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":51,"time":"16:29","ratio":0.814655,"inputTokens":162931,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.273,"originalCredits":0.273,"afterCompact":false},{"index":52,"time":"16:29","ratio":0.8182,"inputTokens":163640,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.261,"originalCredits":0.261,"afterCompact":false},{"index":53,"time":"16:30","ratio":0.821445,"inputTokens":164289,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.1,"originalCredits":1.1,"afterCompact":false},{"index":54,"time":"16:30","ratio":0.24309,"inputTokens":48618,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.215,"originalCredits":1.215,"afterCompact":true},{"index":55,"time":"16:31","ratio":0.30606,"inputTokens":61212,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.634,"originalCredits":0.634,"afterCompact":false},{"index":56,"time":"16:31","ratio":0.313895,"inputTokens":62779,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":57,"time":"16:31","ratio":0.318035,"inputTokens":63607,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.126,"originalCredits":0.126,"afterCompact":false},{"index":58,"time":"16:31","ratio":0.31992,"inputTokens":63984,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.277,"originalCredits":0.277,"afterCompact":false},{"index":59,"time":"16:31","ratio":0.326075,"inputTokens":65215,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.112,"originalCredits":0.112,"afterCompact":false},{"index":60,"time":"16:31","ratio":0.32784,"inputTokens":65568,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.091,"originalCredits":0.091,"afterCompact":false},{"index":61,"time":"16:31","ratio":0.329645,"inputTokens":65929,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.1,"originalCredits":0.1,"afterCompact":false},{"index":62,"time":"16:32","ratio":0.342255,"inputTokens":68451,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":63,"time":"16:32","ratio":0.346275,"inputTokens":69255,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.117,"originalCredits":0.117,"afterCompact":false},{"index":64,"time":"16:32","ratio":0.34791,"inputTokens":69582,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.085,"originalCredits":0.085,"afterCompact":false},{"index":65,"time":"16:32","ratio":0.34931,"inputTokens":69862,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":66,"time":"16:32","ratio":0.3508,"inputTokens":70160,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.13,"originalCredits":0.13,"afterCompact":false},{"index":67,"time":"16:32","ratio":0.35262,"inputTokens":70524,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.12,"originalCredits":0.12,"afterCompact":false},{"index":68,"time":"16:32","ratio":0.354895,"inputTokens":70979,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.094,"originalCredits":0.094,"afterCompact":false},{"index":69,"time":"16:32","ratio":0.35562,"inputTokens":71124,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.097,"originalCredits":0.097,"afterCompact":false},{"index":70,"time":"16:32","ratio":0.357415,"inputTokens":71483,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":71,"time":"16:32","ratio":0.36062,"inputTokens":72124,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.12,"originalCredits":0.12,"afterCompact":false},{"index":72,"time":"16:33","ratio":0.36151,"inputTokens":72302,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.099,"originalCredits":0.099,"afterCompact":false},{"index":73,"time":"16:33","ratio":0.36228,"inputTokens":72456,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.092,"originalCredits":0.092,"afterCompact":false},{"index":74,"time":"16:33","ratio":0.36369,"inputTokens":72738,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.1,"originalCredits":0.1,"afterCompact":false},{"index":75,"time":"16:33","ratio":0.364645,"inputTokens":72929,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.097,"originalCredits":0.097,"afterCompact":false},{"index":76,"time":"16:33","ratio":0.366165,"inputTokens":73233,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.099,"originalCredits":0.099,"afterCompact":false},{"index":77,"time":"16:33","ratio":0.375035,"inputTokens":75007,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":78,"time":"16:33","ratio":0.398605,"inputTokens":79721,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":79,"time":"16:33","ratio":0.481665,"inputTokens":96333,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.878,"originalCredits":0.878,"afterCompact":false},{"index":80,"time":"16:33","ratio":0.50751,"inputTokens":101502,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.319,"originalCredits":0.319,"afterCompact":false},{"index":81,"time":"16:34","ratio":0.5238,"inputTokens":104760,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false},{"index":82,"time":"16:34","ratio":0.535135,"inputTokens":107027,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":83,"time":"16:34","ratio":0.53787,"inputTokens":107574,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.189,"originalCredits":0.189,"afterCompact":false},{"index":84,"time":"16:34","ratio":0.54004,"inputTokens":108008,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":85,"time":"16:34","ratio":0.55249,"inputTokens":110498,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.275,"originalCredits":0.275,"afterCompact":false},{"index":86,"time":"16:34","ratio":0.566885,"inputTokens":113377,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":87,"time":"16:34","ratio":0.56933,"inputTokens":113866,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":88,"time":"16:35","ratio":0.573845,"inputTokens":114769,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.737,"originalCredits":0.737,"afterCompact":false},{"index":89,"time":"16:35","ratio":0.593205,"inputTokens":118641,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.154,"originalCredits":0.154,"afterCompact":false},{"index":90,"time":"16:35","ratio":0.60131,"inputTokens":120262,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.193,"originalCredits":0.193,"afterCompact":false},{"index":91,"time":"16:35","ratio":0.61649,"inputTokens":123298,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.434,"originalCredits":0.434,"afterCompact":false},{"index":92,"time":"16:35","ratio":0.62222,"inputTokens":124444,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.328,"originalCredits":0.328,"afterCompact":false},{"index":93,"time":"16:35","ratio":0.62838,"inputTokens":125676,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.342,"originalCredits":0.342,"afterCompact":false},{"index":94,"time":"16:36","ratio":0.63482,"inputTokens":126964,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":95,"time":"16:36","ratio":0.6398,"inputTokens":127960,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.439,"originalCredits":0.439,"afterCompact":false},{"index":96,"time":"16:36","ratio":0.64892,"inputTokens":129784,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":97,"time":"16:36","ratio":0.65289,"inputTokens":130578,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.243,"originalCredits":0.243,"afterCompact":false},{"index":98,"time":"16:37","ratio":0.657455,"inputTokens":131491,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.212,"originalCredits":1.212,"afterCompact":false},{"index":99,"time":"16:37","ratio":0.68814,"inputTokens":137628,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.231,"originalCredits":0.231,"afterCompact":false},{"index":100,"time":"16:37","ratio":0.69107,"inputTokens":138214,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":101,"time":"16:37","ratio":0.693165,"inputTokens":138633,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":102,"time":"16:37","ratio":0.695415,"inputTokens":139083,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.512,"originalCredits":0.512,"afterCompact":false},{"index":103,"time":"16:38","ratio":0.706325,"inputTokens":141265,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":104,"time":"16:38","ratio":0.713095,"inputTokens":142619,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.184,"originalCredits":0.184,"afterCompact":false},{"index":105,"time":"16:38","ratio":0.71599,"inputTokens":143198,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":106,"time":"16:38","ratio":0.719355,"inputTokens":143871,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.551,"originalCredits":0.551,"afterCompact":false},{"index":107,"time":"16:38","ratio":0.738485,"inputTokens":147697,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":108,"time":"16:39","ratio":0.739145,"inputTokens":147829,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.355,"originalCredits":0.355,"afterCompact":false},{"index":109,"time":"16:39","ratio":0.74537,"inputTokens":149074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":110,"time":"16:39","ratio":0.74669,"inputTokens":149338,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":111,"time":"16:39","ratio":0.751475,"inputTokens":150295,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.19,"originalCredits":0.19,"afterCompact":false},{"index":112,"time":"16:39","ratio":0.75313,"inputTokens":150626,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.236,"originalCredits":0.236,"afterCompact":false},{"index":113,"time":"16:39","ratio":0.755975,"inputTokens":151195,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":114,"time":"16:39","ratio":0.75683,"inputTokens":151366,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":115,"time":"16:39","ratio":0.75849,"inputTokens":151698,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":116,"time":"16:39","ratio":0.75945,"inputTokens":151890,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":117,"time":"16:40","ratio":0.763655,"inputTokens":152731,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.693,"originalCredits":0.693,"afterCompact":false},{"index":118,"time":"16:40","ratio":0.780755,"inputTokens":156151,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.176,"originalCredits":0.176,"afterCompact":false},{"index":119,"time":"16:41","ratio":0.781795,"inputTokens":156359,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.087,"originalCredits":1.087,"afterCompact":false},{"index":120,"time":"16:41","ratio":0.808895,"inputTokens":161779,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":121,"time":"16:41","ratio":0.811725,"inputTokens":162345,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":122,"time":"16:41","ratio":0.813345,"inputTokens":162669,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.189,"originalCredits":0.189,"afterCompact":false},{"index":123,"time":"16:41","ratio":0.814475,"inputTokens":162895,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.19,"originalCredits":0.19,"afterCompact":false},{"index":124,"time":"16:41","ratio":0.82431,"inputTokens":164862,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.337,"originalCredits":0.337,"afterCompact":false},{"index":125,"time":"16:41","ratio":0.827935,"inputTokens":165587,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.211,"originalCredits":0.211,"afterCompact":false},{"index":126,"time":"16:42","ratio":0.82965,"inputTokens":165930,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.241,"originalCredits":1.241,"afterCompact":false},{"index":127,"time":"16:42","ratio":0.25089,"inputTokens":50178,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.238,"originalCredits":1.238,"afterCompact":true},{"index":128,"time":"16:43","ratio":0.252115,"inputTokens":50423,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.078,"originalCredits":0.078,"afterCompact":false},{"index":129,"time":"16:43","ratio":0.25526,"inputTokens":51052,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.101,"originalCredits":0.101,"afterCompact":false},{"index":130,"time":"16:43","ratio":0.25661,"inputTokens":51322,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.143,"originalCredits":0.143,"afterCompact":false},{"index":131,"time":"16:43","ratio":0.260285,"inputTokens":52057,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.076,"originalCredits":0.076,"afterCompact":false},{"index":132,"time":"16:43","ratio":0.264925,"inputTokens":52985,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.104,"originalCredits":0.104,"afterCompact":false},{"index":133,"time":"16:43","ratio":0.274845,"inputTokens":54969,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.155,"originalCredits":0.155,"afterCompact":false},{"index":134,"time":"16:43","ratio":0.27915,"inputTokens":55830,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.099,"originalCredits":0.099,"afterCompact":false},{"index":135,"time":"16:43","ratio":0.28421,"inputTokens":56842,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.252,"originalCredits":0.252,"afterCompact":false},{"index":136,"time":"16:43","ratio":0.29299,"inputTokens":58598,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.121,"originalCredits":0.121,"afterCompact":false},{"index":137,"time":"16:43","ratio":0.30155,"inputTokens":60310,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.241,"originalCredits":0.241,"afterCompact":false},{"index":138,"time":"16:44","ratio":0.30939,"inputTokens":61878,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.111,"originalCredits":0.111,"afterCompact":false},{"index":139,"time":"16:44","ratio":0.31368,"inputTokens":62736,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.109,"originalCredits":0.109,"afterCompact":false},{"index":140,"time":"16:44","ratio":0.31989,"inputTokens":63978,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.139,"originalCredits":0.139,"afterCompact":false},{"index":141,"time":"16:44","ratio":0.320745,"inputTokens":64149,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.08,"originalCredits":0.08,"afterCompact":false},{"index":142,"time":"16:44","ratio":0.32158,"inputTokens":64316,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.08,"originalCredits":0.08,"afterCompact":false},{"index":143,"time":"16:44","ratio":0.326155,"inputTokens":65231,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.384,"originalCredits":1.384,"afterCompact":false},{"index":144,"time":"16:44","ratio":0.36259,"inputTokens":72518,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":145,"time":"16:45","ratio":0.36441,"inputTokens":72882,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.092,"originalCredits":0.092,"afterCompact":false},{"index":146,"time":"16:45","ratio":0.365965,"inputTokens":73193,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.114,"originalCredits":0.114,"afterCompact":false},{"index":147,"time":"16:45","ratio":0.371085,"inputTokens":74217,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.118,"originalCredits":0.118,"afterCompact":false},{"index":148,"time":"16:45","ratio":0.378585,"inputTokens":75717,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":149,"time":"16:45","ratio":0.38658,"inputTokens":77316,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":150,"time":"16:45","ratio":0.395635,"inputTokens":79127,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.17,"originalCredits":0.17,"afterCompact":false},{"index":151,"time":"16:45","ratio":0.406185,"inputTokens":81237,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.174,"originalCredits":0.174,"afterCompact":false},{"index":152,"time":"16:45","ratio":0.418805,"inputTokens":83761,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":153,"time":"16:45","ratio":0.429395,"inputTokens":85879,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":154,"time":"16:45","ratio":0.439735,"inputTokens":87947,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.193,"originalCredits":0.193,"afterCompact":false},{"index":155,"time":"16:46","ratio":0.45134,"inputTokens":90268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.201,"originalCredits":0.201,"afterCompact":false},{"index":156,"time":"16:46","ratio":0.47434,"inputTokens":94868,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.307,"originalCredits":0.307,"afterCompact":false},{"index":157,"time":"16:46","ratio":0.47829,"inputTokens":95658,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.462,"originalCredits":0.462,"afterCompact":false},{"index":158,"time":"16:46","ratio":0.48865,"inputTokens":97730,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.11,"originalCredits":0.11,"afterCompact":false},{"index":159,"time":"16:46","ratio":0.49352,"inputTokens":98704,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.262,"originalCredits":0.262,"afterCompact":false},{"index":160,"time":"16:46","ratio":0.49971,"inputTokens":99942,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":161,"time":"16:46","ratio":0.50511,"inputTokens":101022,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":162,"time":"16:47","ratio":0.50732,"inputTokens":101464,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":163,"time":"16:47","ratio":0.50849,"inputTokens":101698,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.131,"originalCredits":0.131,"afterCompact":false},{"index":164,"time":"16:47","ratio":0.509545,"inputTokens":101909,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.129,"originalCredits":0.129,"afterCompact":false},{"index":165,"time":"16:47","ratio":0.51061,"inputTokens":102122,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":166,"time":"16:47","ratio":0.51303,"inputTokens":102606,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.116,"originalCredits":0.116,"afterCompact":false},{"index":167,"time":"16:47","ratio":0.51339,"inputTokens":102678,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.108,"originalCredits":0.108,"afterCompact":false},{"index":168,"time":"16:47","ratio":0.51376,"inputTokens":102752,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.47,"originalCredits":0.47,"afterCompact":false},{"index":169,"time":"16:48","ratio":0.529375,"inputTokens":105875,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.917,"originalCredits":0.917,"afterCompact":false},{"index":170,"time":"16:48","ratio":0.55124,"inputTokens":110248,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":171,"time":"16:48","ratio":0.553055,"inputTokens":110611,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":172,"time":"16:48","ratio":0.554135,"inputTokens":110827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":173,"time":"16:48","ratio":0.55545,"inputTokens":111090,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":174,"time":"16:48","ratio":0.56036,"inputTokens":112072,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.248,"originalCredits":0.248,"afterCompact":false},{"index":175,"time":"16:48","ratio":0.56444,"inputTokens":112888,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":176,"time":"16:48","ratio":0.567165,"inputTokens":113433,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":177,"time":"16:48","ratio":0.5681,"inputTokens":113620,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":178,"time":"16:49","ratio":0.569825,"inputTokens":113965,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.129,"originalCredits":0.129,"afterCompact":false},{"index":179,"time":"16:49","ratio":0.57128,"inputTokens":114256,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":180,"time":"16:49","ratio":0.572935,"inputTokens":114587,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.126,"originalCredits":0.126,"afterCompact":false},{"index":181,"time":"16:49","ratio":0.573515,"inputTokens":114703,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":182,"time":"16:49","ratio":0.579665,"inputTokens":115933,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":183,"time":"16:49","ratio":0.58094,"inputTokens":116188,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":184,"time":"16:49","ratio":0.581975,"inputTokens":116395,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.155,"originalCredits":0.155,"afterCompact":false},{"index":185,"time":"16:50","ratio":0.583475,"inputTokens":116695,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":186,"time":"16:50","ratio":0.584135,"inputTokens":116827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.128,"originalCredits":0.128,"afterCompact":false},{"index":187,"time":"16:50","ratio":0.58592,"inputTokens":117184,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.152,"originalCredits":0.152,"afterCompact":false},{"index":188,"time":"16:50","ratio":0.58796,"inputTokens":117592,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":189,"time":"16:50","ratio":0.592045,"inputTokens":118409,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.176,"originalCredits":0.176,"afterCompact":false},{"index":190,"time":"16:50","ratio":0.593405,"inputTokens":118681,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.136,"originalCredits":0.136,"afterCompact":false},{"index":191,"time":"16:50","ratio":0.5944,"inputTokens":118880,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":192,"time":"16:50","ratio":0.59602,"inputTokens":119204,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":193,"time":"16:50","ratio":0.597305,"inputTokens":119461,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.143,"originalCredits":0.143,"afterCompact":false},{"index":194,"time":"16:50","ratio":0.59839,"inputTokens":119678,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.134,"originalCredits":0.134,"afterCompact":false},{"index":195,"time":"16:50","ratio":0.59937,"inputTokens":119874,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.136,"originalCredits":0.136,"afterCompact":false},{"index":196,"time":"16:51","ratio":0.60181,"inputTokens":120362,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.142,"originalCredits":0.142,"afterCompact":false},{"index":197,"time":"16:51","ratio":0.60267,"inputTokens":120534,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.136,"originalCredits":0.136,"afterCompact":false},{"index":198,"time":"16:51","ratio":0.60433,"inputTokens":120866,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":199,"time":"16:52","ratio":0.60509,"inputTokens":121018,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.429,"originalCredits":0.429,"afterCompact":false},{"index":200,"time":"16:52","ratio":0.614075,"inputTokens":122815,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":201,"time":"16:52","ratio":0.61546,"inputTokens":123092,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":202,"time":"16:52","ratio":0.61679,"inputTokens":123358,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.201,"originalCredits":0.201,"afterCompact":false},{"index":203,"time":"16:52","ratio":0.624985,"inputTokens":124997,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":204,"time":"16:52","ratio":0.62667,"inputTokens":125334,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":205,"time":"16:52","ratio":0.62746,"inputTokens":125492,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":206,"time":"16:52","ratio":0.62898,"inputTokens":125796,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":207,"time":"16:52","ratio":0.63235,"inputTokens":126470,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":208,"time":"16:53","ratio":0.635505,"inputTokens":127101,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":209,"time":"16:53","ratio":0.642195,"inputTokens":128439,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.192,"originalCredits":0.192,"afterCompact":false},{"index":210,"time":"16:53","ratio":0.64326,"inputTokens":128652,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":211,"time":"16:54","ratio":0.651545,"inputTokens":130309,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":212,"time":"16:54","ratio":0.657095,"inputTokens":131419,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":213,"time":"16:54","ratio":0.65945,"inputTokens":131890,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":214,"time":"16:54","ratio":0.66082,"inputTokens":132164,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":215,"time":"16:54","ratio":0.66167,"inputTokens":132334,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":216,"time":"16:54","ratio":0.66873,"inputTokens":133746,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.718,"originalCredits":0.718,"afterCompact":false},{"index":217,"time":"16:54","ratio":0.68464,"inputTokens":136928,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.153,"originalCredits":0.153,"afterCompact":false},{"index":218,"time":"16:55","ratio":0.68872,"inputTokens":137744,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.184,"originalCredits":0.184,"afterCompact":false},{"index":219,"time":"16:55","ratio":0.69437,"inputTokens":138874,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":220,"time":"16:55","ratio":0.70331,"inputTokens":140662,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":221,"time":"16:55","ratio":0.709495,"inputTokens":141899,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.46,"originalCredits":0.46,"afterCompact":false},{"index":222,"time":"16:55","ratio":0.71779,"inputTokens":143558,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.172,"originalCredits":0.172,"afterCompact":false},{"index":223,"time":"16:55","ratio":0.71906,"inputTokens":143812,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.176,"originalCredits":0.176,"afterCompact":false},{"index":224,"time":"16:56","ratio":0.72044,"inputTokens":144088,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":225,"time":"16:56","ratio":0.721625,"inputTokens":144325,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.165,"originalCredits":0.165,"afterCompact":false},{"index":226,"time":"16:56","ratio":0.726295,"inputTokens":145259,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":227,"time":"16:56","ratio":0.73044,"inputTokens":146088,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.192,"originalCredits":0.192,"afterCompact":false},{"index":228,"time":"16:56","ratio":0.73331,"inputTokens":146662,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.203,"originalCredits":0.203,"afterCompact":false},{"index":229,"time":"16:56","ratio":0.73641,"inputTokens":147282,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":230,"time":"16:56","ratio":0.741195,"inputTokens":148239,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":231,"time":"16:57","ratio":0.74379,"inputTokens":148758,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":232,"time":"16:57","ratio":0.74501,"inputTokens":149002,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":233,"time":"16:57","ratio":0.74589,"inputTokens":149178,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.174,"originalCredits":0.174,"afterCompact":false},{"index":234,"time":"16:57","ratio":0.74757,"inputTokens":149514,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":235,"time":"16:58","ratio":0.750525,"inputTokens":150105,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.186,"originalCredits":0.186,"afterCompact":false},{"index":236,"time":"16:58","ratio":0.75632,"inputTokens":151264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.227,"originalCredits":0.227,"afterCompact":false},{"index":237,"time":"16:58","ratio":0.757775,"inputTokens":151555,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":238,"time":"16:58","ratio":0.76118,"inputTokens":152236,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":239,"time":"16:58","ratio":0.763925,"inputTokens":152785,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":240,"time":"16:59","ratio":0.76722,"inputTokens":153444,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.257,"originalCredits":0.257,"afterCompact":false},{"index":241,"time":"16:59","ratio":0.770535,"inputTokens":154107,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":242,"time":"16:59","ratio":0.77105,"inputTokens":154210,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":243,"time":"16:59","ratio":0.77157,"inputTokens":154314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":244,"time":"16:59","ratio":0.772095,"inputTokens":154419,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":245,"time":"16:59","ratio":0.77284,"inputTokens":154568,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":246,"time":"17:00","ratio":0.774475,"inputTokens":154895,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.165,"originalCredits":0.165,"afterCompact":false},{"index":247,"time":"17:00","ratio":0.77623,"inputTokens":155246,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":248,"time":"17:00","ratio":0.77926,"inputTokens":155852,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.235,"originalCredits":0.235,"afterCompact":false},{"index":249,"time":"17:00","ratio":0.782135,"inputTokens":156427,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":250,"time":"17:00","ratio":0.783485,"inputTokens":156697,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":251,"time":"17:00","ratio":0.78408,"inputTokens":156816,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.185,"originalCredits":0.185,"afterCompact":false},{"index":252,"time":"17:00","ratio":0.78533,"inputTokens":157066,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.409,"originalCredits":0.409,"afterCompact":false},{"index":253,"time":"17:00","ratio":0.79303,"inputTokens":158606,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":254,"time":"17:01","ratio":0.795295,"inputTokens":159059,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.459,"originalCredits":0.459,"afterCompact":false},{"index":255,"time":"17:01","ratio":0.804015,"inputTokens":160803,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.324,"originalCredits":0.324,"afterCompact":false},{"index":256,"time":"17:01","ratio":0.80919,"inputTokens":161838,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.195,"originalCredits":0.195,"afterCompact":false},{"index":257,"time":"17:01","ratio":0.811565,"inputTokens":162313,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":258,"time":"17:01","ratio":0.815805,"inputTokens":163161,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":259,"time":"17:02","ratio":0.817165,"inputTokens":163433,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.5,"originalCredits":0.5,"afterCompact":false},{"index":260,"time":"17:02","ratio":0.82954,"inputTokens":165908,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.232,"originalCredits":0.232,"afterCompact":false},{"index":261,"time":"17:02","ratio":0.831275,"inputTokens":166255,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.248,"originalCredits":0.248,"afterCompact":false},{"index":262,"time":"17:02","ratio":0.83398,"inputTokens":166796,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.208,"originalCredits":0.208,"afterCompact":false},{"index":263,"time":"17:03","ratio":0.22814,"inputTokens":45628,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.019,"originalCredits":1.019,"afterCompact":true},{"index":264,"time":"17:03","ratio":0.228775,"inputTokens":45755,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.07,"originalCredits":0.07,"afterCompact":false},{"index":265,"time":"17:03","ratio":0.22945,"inputTokens":45890,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":266,"time":"17:03","ratio":0.230795,"inputTokens":46159,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.072,"originalCredits":0.072,"afterCompact":false},{"index":267,"time":"17:04","ratio":0.232795,"inputTokens":46559,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.112,"originalCredits":0.112,"afterCompact":false},{"index":268,"time":"17:04","ratio":0.240225,"inputTokens":48045,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.122,"originalCredits":0.122,"afterCompact":false},{"index":269,"time":"17:04","ratio":0.24407,"inputTokens":48814,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.091,"originalCredits":0.091,"afterCompact":false},{"index":270,"time":"17:04","ratio":0.25793,"inputTokens":51586,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.557,"originalCredits":0.557,"afterCompact":false},{"index":271,"time":"17:04","ratio":0.269295,"inputTokens":53859,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.084,"originalCredits":0.084,"afterCompact":false},{"index":272,"time":"17:05","ratio":0.270565,"inputTokens":54113,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":273,"time":"17:05","ratio":0.273715,"inputTokens":54743,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.114,"originalCredits":0.114,"afterCompact":false},{"index":274,"time":"17:05","ratio":0.27634,"inputTokens":55268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.109,"originalCredits":0.109,"afterCompact":false},{"index":275,"time":"17:05","ratio":0.281755,"inputTokens":56351,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.219,"originalCredits":0.219,"afterCompact":false},{"index":276,"time":"17:05","ratio":0.285995,"inputTokens":57199,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.158,"originalCredits":0.158,"afterCompact":false},{"index":277,"time":"17:06","ratio":0.290635,"inputTokens":58127,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.256,"originalCredits":0.256,"afterCompact":false},{"index":278,"time":"17:06","ratio":0.296515,"inputTokens":59303,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.122,"originalCredits":0.122,"afterCompact":false},{"index":279,"time":"17:06","ratio":0.300815,"inputTokens":60163,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.121,"originalCredits":0.121,"afterCompact":false},{"index":280,"time":"17:06","ratio":0.302725,"inputTokens":60545,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.183,"originalCredits":0.183,"afterCompact":false},{"index":281,"time":"17:06","ratio":0.306345,"inputTokens":61269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":282,"time":"17:06","ratio":0.31021,"inputTokens":62042,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.116,"originalCredits":0.116,"afterCompact":false},{"index":283,"time":"17:07","ratio":0.31385,"inputTokens":62770,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.1,"originalCredits":0.1,"afterCompact":false},{"index":284,"time":"17:07","ratio":0.31678,"inputTokens":63356,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.093,"originalCredits":0.093,"afterCompact":false},{"index":285,"time":"17:07","ratio":0.318045,"inputTokens":63609,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":286,"time":"17:07","ratio":0.322125,"inputTokens":64425,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.086,"originalCredits":0.086,"afterCompact":false},{"index":287,"time":"17:10","ratio":0.32332,"inputTokens":64664,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":288,"time":"17:10","ratio":0.32704,"inputTokens":65408,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":289,"time":"17:10","ratio":0.3295,"inputTokens":65900,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.095,"originalCredits":0.095,"afterCompact":false},{"index":290,"time":"17:10","ratio":0.33037,"inputTokens":66074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.08,"originalCredits":0.08,"afterCompact":false},{"index":291,"time":"17:10","ratio":0.33394,"inputTokens":66788,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.151,"originalCredits":0.151,"afterCompact":false},{"index":292,"time":"17:11","ratio":0.344275,"inputTokens":68855,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.153,"originalCredits":0.153,"afterCompact":false},{"index":293,"time":"17:11","ratio":0.357045,"inputTokens":71409,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":294,"time":"17:11","ratio":0.361235,"inputTokens":72247,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.09,"originalCredits":0.09,"afterCompact":false},{"index":295,"time":"17:11","ratio":0.362035,"inputTokens":72407,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.093,"originalCredits":0.093,"afterCompact":false},{"index":296,"time":"17:11","ratio":0.36649,"inputTokens":73298,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.201,"originalCredits":0.201,"afterCompact":false},{"index":297,"time":"17:11","ratio":0.373395,"inputTokens":74679,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.282,"originalCredits":0.282,"afterCompact":false},{"index":298,"time":"17:11","ratio":0.379055,"inputTokens":75811,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":299,"time":"17:11","ratio":0.384215,"inputTokens":76843,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.138,"originalCredits":0.138,"afterCompact":false},{"index":300,"time":"17:12","ratio":0.38758,"inputTokens":77516,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":301,"time":"17:12","ratio":0.393855,"inputTokens":78771,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.115,"originalCredits":0.115,"afterCompact":false},{"index":302,"time":"17:12","ratio":0.396985,"inputTokens":79397,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":303,"time":"17:12","ratio":0.39821,"inputTokens":79642,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.158,"originalCredits":0.158,"afterCompact":false},{"index":304,"time":"17:12","ratio":0.400655,"inputTokens":80131,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":305,"time":"17:12","ratio":0.405075,"inputTokens":81015,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.102,"originalCredits":0.102,"afterCompact":false},{"index":306,"time":"17:12","ratio":0.40579,"inputTokens":81158,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.106,"originalCredits":0.106,"afterCompact":false},{"index":307,"time":"17:12","ratio":0.406635,"inputTokens":81327,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.106,"originalCredits":0.106,"afterCompact":false},{"index":308,"time":"17:13","ratio":0.40753,"inputTokens":81506,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.104,"originalCredits":0.104,"afterCompact":false},{"index":309,"time":"17:15","ratio":0.40897,"inputTokens":81794,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":310,"time":"17:15","ratio":0.41231,"inputTokens":82462,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":311,"time":"17:15","ratio":0.41529,"inputTokens":83058,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.109,"originalCredits":0.109,"afterCompact":false},{"index":312,"time":"17:15","ratio":0.41695,"inputTokens":83390,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.107,"originalCredits":0.107,"afterCompact":false},{"index":313,"time":"17:15","ratio":0.417665,"inputTokens":83533,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.102,"originalCredits":0.102,"afterCompact":false},{"index":314,"time":"17:15","ratio":0.41836,"inputTokens":83672,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.107,"originalCredits":0.107,"afterCompact":false},{"index":315,"time":"17:16","ratio":0.41942,"inputTokens":83884,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.105,"originalCredits":0.105,"afterCompact":false},{"index":316,"time":"17:16","ratio":0.420155,"inputTokens":84031,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.106,"originalCredits":0.106,"afterCompact":false},{"index":317,"time":"17:16","ratio":0.42345,"inputTokens":84690,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":318,"time":"17:17","ratio":0.425125,"inputTokens":85025,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.108,"originalCredits":0.108,"afterCompact":false},{"index":319,"time":"17:17","ratio":0.426005,"inputTokens":85201,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.107,"originalCredits":0.107,"afterCompact":false},{"index":320,"time":"17:17","ratio":0.42743,"inputTokens":85486,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.236,"originalCredits":0.236,"afterCompact":false},{"index":321,"time":"17:18","ratio":0.432735,"inputTokens":86547,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":322,"time":"17:18","ratio":0.43592,"inputTokens":87184,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":323,"time":"17:18","ratio":0.437045,"inputTokens":87409,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.106,"originalCredits":0.106,"afterCompact":false},{"index":324,"time":"17:18","ratio":0.439865,"inputTokens":87973,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.252,"originalCredits":0.252,"afterCompact":false},{"index":325,"time":"17:18","ratio":0.44416,"inputTokens":88832,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":326,"time":"17:18","ratio":0.445855,"inputTokens":89171,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.106,"originalCredits":0.106,"afterCompact":false},{"index":327,"time":"17:18","ratio":0.45292,"inputTokens":90584,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":328,"time":"17:19","ratio":0.45457,"inputTokens":90914,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.363,"originalCredits":0.363,"afterCompact":false},{"index":329,"time":"17:19","ratio":0.4626,"inputTokens":92520,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.118,"originalCredits":0.118,"afterCompact":false},{"index":330,"time":"17:19","ratio":0.463935,"inputTokens":92787,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.122,"originalCredits":0.122,"afterCompact":false},{"index":331,"time":"17:19","ratio":0.46482,"inputTokens":92964,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.111,"originalCredits":0.111,"afterCompact":false},{"index":332,"time":"17:19","ratio":0.46693,"inputTokens":93386,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.199,"originalCredits":0.199,"afterCompact":false},{"index":333,"time":"17:20","ratio":0.47256,"inputTokens":94512,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":334,"time":"17:20","ratio":0.47973,"inputTokens":95946,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":335,"time":"17:20","ratio":0.481895,"inputTokens":96379,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.114,"originalCredits":0.114,"afterCompact":false},{"index":336,"time":"17:20","ratio":0.485345,"inputTokens":97069,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":337,"time":"17:20","ratio":0.487385,"inputTokens":97477,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":338,"time":"17:20","ratio":0.49371,"inputTokens":98742,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":339,"time":"17:21","ratio":0.495585,"inputTokens":99117,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.132,"originalCredits":0.132,"afterCompact":false},{"index":340,"time":"17:21","ratio":0.496675,"inputTokens":99335,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":341,"time":"17:21","ratio":0.498965,"inputTokens":99793,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":342,"time":"17:22","ratio":0.50066,"inputTokens":100132,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.111,"originalCredits":0.111,"afterCompact":false},{"index":343,"time":"17:22","ratio":0.50608,"inputTokens":101216,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":344,"time":"17:22","ratio":0.51202,"inputTokens":102404,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":345,"time":"17:22","ratio":0.514785,"inputTokens":102957,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":346,"time":"17:23","ratio":0.52083,"inputTokens":104166,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":347,"time":"17:23","ratio":0.523185,"inputTokens":104637,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":348,"time":"17:23","ratio":0.529855,"inputTokens":105971,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.342,"originalCredits":0.342,"afterCompact":false},{"index":349,"time":"17:23","ratio":0.535705,"inputTokens":107141,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.242,"originalCredits":0.242,"afterCompact":false},{"index":350,"time":"17:23","ratio":0.54132,"inputTokens":108264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.213,"originalCredits":0.213,"afterCompact":false},{"index":351,"time":"17:23","ratio":0.545145,"inputTokens":109029,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.131,"originalCredits":0.131,"afterCompact":false},{"index":352,"time":"17:24","ratio":0.546045,"inputTokens":109209,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":353,"time":"17:24","ratio":0.547005,"inputTokens":109401,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.116,"originalCredits":0.116,"afterCompact":false},{"index":354,"time":"17:24","ratio":0.547365,"inputTokens":109473,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.242,"originalCredits":0.242,"afterCompact":false},{"index":355,"time":"17:25","ratio":0.55128,"inputTokens":110256,"outputTokens":null,"usageSource":"transcript-ratio","credits":3.955,"originalCredits":3.955,"afterCompact":false},{"index":356,"time":"17:25","ratio":0.552535,"inputTokens":110507,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.12,"originalCredits":0.12,"afterCompact":false},{"index":357,"time":"17:25","ratio":0.555695,"inputTokens":111139,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":358,"time":"17:25","ratio":0.559235,"inputTokens":111847,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":359,"time":"17:25","ratio":0.56098,"inputTokens":112196,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.129,"originalCredits":0.129,"afterCompact":false},{"index":360,"time":"17:26","ratio":0.5621,"inputTokens":112420,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.158,"originalCredits":0.158,"afterCompact":false},{"index":361,"time":"17:26","ratio":0.56534,"inputTokens":113068,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.183,"originalCredits":0.183,"afterCompact":false},{"index":362,"time":"17:26","ratio":0.567295,"inputTokens":113459,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":363,"time":"17:26","ratio":0.568295,"inputTokens":113659,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.162,"originalCredits":0.162,"afterCompact":false},{"index":364,"time":"17:26","ratio":0.570995,"inputTokens":114199,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":365,"time":"17:27","ratio":0.573605,"inputTokens":114721,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.144,"originalCredits":0.144,"afterCompact":false},{"index":366,"time":"17:27","ratio":0.57546,"inputTokens":115092,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":367,"time":"17:27","ratio":0.577005,"inputTokens":115401,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.208,"originalCredits":0.208,"afterCompact":false},{"index":368,"time":"17:28","ratio":0.57988,"inputTokens":115976,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":369,"time":"17:28","ratio":0.58159,"inputTokens":116318,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.134,"originalCredits":0.134,"afterCompact":false},{"index":370,"time":"17:28","ratio":0.582255,"inputTokens":116451,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":371,"time":"17:41","ratio":0.583825,"inputTokens":116765,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":372,"time":"17:41","ratio":0.59244,"inputTokens":118488,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":373,"time":"17:41","ratio":0.597525,"inputTokens":119505,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":374,"time":"17:41","ratio":0.601405,"inputTokens":120281,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.411,"originalCredits":0.411,"afterCompact":false},{"index":375,"time":"17:45","ratio":0.60939,"inputTokens":121878,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":376,"time":"17:46","ratio":0.614045,"inputTokens":122809,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":377,"time":"17:46","ratio":0.62844,"inputTokens":125688,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.247,"originalCredits":0.247,"afterCompact":false},{"index":378,"time":"17:46","ratio":0.635085,"inputTokens":127017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.18,"originalCredits":0.18,"afterCompact":false},{"index":379,"time":"17:46","ratio":0.644795,"inputTokens":128959,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":380,"time":"17:46","ratio":0.64679,"inputTokens":129358,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.143,"originalCredits":0.143,"afterCompact":false},{"index":381,"time":"17:46","ratio":0.653475,"inputTokens":130695,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.2,"originalCredits":0.2,"afterCompact":false},{"index":382,"time":"17:46","ratio":0.65737,"inputTokens":131474,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.438,"originalCredits":0.438,"afterCompact":false},{"index":383,"time":"17:47","ratio":0.66705,"inputTokens":133410,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":384,"time":"17:47","ratio":0.66991,"inputTokens":133982,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.154,"originalCredits":0.154,"afterCompact":false},{"index":385,"time":"17:47","ratio":0.67059,"inputTokens":134118,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":386,"time":"17:47","ratio":0.67128,"inputTokens":134256,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.148,"originalCredits":0.148,"afterCompact":false},{"index":387,"time":"17:47","ratio":0.671935,"inputTokens":134387,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.151,"originalCredits":0.151,"afterCompact":false},{"index":388,"time":"17:47","ratio":0.67266,"inputTokens":134532,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":389,"time":"17:47","ratio":0.67303,"inputTokens":134606,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.191,"originalCredits":0.191,"afterCompact":false},{"index":390,"time":"17:47","ratio":0.67504,"inputTokens":135008,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.184,"originalCredits":0.184,"afterCompact":false},{"index":391,"time":"17:48","ratio":0.676805,"inputTokens":135361,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":392,"time":"17:48","ratio":0.679835,"inputTokens":135967,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.154,"originalCredits":0.154,"afterCompact":false},{"index":393,"time":"17:48","ratio":0.68066,"inputTokens":136132,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":394,"time":"17:48","ratio":0.68103,"inputTokens":136206,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":395,"time":"17:48","ratio":0.682235,"inputTokens":136447,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":396,"time":"17:48","ratio":0.68307,"inputTokens":136614,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.257,"originalCredits":0.257,"afterCompact":false},{"index":397,"time":"17:48","ratio":0.686935,"inputTokens":137387,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.154,"originalCredits":0.154,"afterCompact":false},{"index":398,"time":"17:48","ratio":0.687865,"inputTokens":137573,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":399,"time":"17:49","ratio":0.69054,"inputTokens":138108,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.175,"originalCredits":0.175,"afterCompact":false},{"index":400,"time":"17:49","ratio":0.69187,"inputTokens":138374,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":401,"time":"17:49","ratio":0.6929,"inputTokens":138580,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":402,"time":"17:49","ratio":0.694955,"inputTokens":138991,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.158,"originalCredits":0.158,"afterCompact":false},{"index":403,"time":"17:49","ratio":0.6959,"inputTokens":139180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":404,"time":"17:49","ratio":0.69993,"inputTokens":139986,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.234,"originalCredits":0.234,"afterCompact":false},{"index":405,"time":"17:50","ratio":0.707035,"inputTokens":141407,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.251,"originalCredits":0.251,"afterCompact":false},{"index":406,"time":"17:50","ratio":0.709515,"inputTokens":141903,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":407,"time":"17:50","ratio":0.71298,"inputTokens":142596,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":408,"time":"17:50","ratio":0.714225,"inputTokens":142845,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.337,"originalCredits":0.337,"afterCompact":false},{"index":409,"time":"17:50","ratio":0.72799,"inputTokens":145598,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.273,"originalCredits":0.273,"afterCompact":false},{"index":410,"time":"17:50","ratio":0.730085,"inputTokens":146017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":411,"time":"17:50","ratio":0.733245,"inputTokens":146649,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":412,"time":"17:51","ratio":0.736185,"inputTokens":147237,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":413,"time":"17:51","ratio":0.744865,"inputTokens":148973,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.233,"originalCredits":0.233,"afterCompact":false},{"index":414,"time":"17:51","ratio":0.748055,"inputTokens":149611,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":415,"time":"17:51","ratio":0.748865,"inputTokens":149773,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":416,"time":"17:51","ratio":0.7526,"inputTokens":150520,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":417,"time":"17:51","ratio":0.75604,"inputTokens":151208,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":418,"time":"17:51","ratio":0.75772,"inputTokens":151544,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":419,"time":"17:52","ratio":0.76221,"inputTokens":152442,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":420,"time":"17:52","ratio":0.768535,"inputTokens":153707,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":421,"time":"17:52","ratio":0.770275,"inputTokens":154055,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":422,"time":"17:52","ratio":0.77148,"inputTokens":154296,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":423,"time":"17:52","ratio":0.773185,"inputTokens":154637,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.214,"originalCredits":0.214,"afterCompact":false},{"index":424,"time":"17:52","ratio":0.77642,"inputTokens":155284,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.176,"originalCredits":0.176,"afterCompact":false},{"index":425,"time":"17:52","ratio":0.777425,"inputTokens":155485,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.17,"originalCredits":0.17,"afterCompact":false},{"index":426,"time":"17:53","ratio":0.77915,"inputTokens":155830,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.17,"originalCredits":0.17,"afterCompact":false},{"index":427,"time":"17:53","ratio":0.78012,"inputTokens":156024,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.164,"originalCredits":0.164,"afterCompact":false},{"index":428,"time":"17:53","ratio":0.781405,"inputTokens":156281,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.172,"originalCredits":0.172,"afterCompact":false},{"index":429,"time":"17:53","ratio":0.7822,"inputTokens":156440,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":430,"time":"17:53","ratio":0.78278,"inputTokens":156556,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.325,"originalCredits":0.325,"afterCompact":false},{"index":431,"time":"17:53","ratio":0.787915,"inputTokens":157583,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.563,"originalCredits":0.563,"afterCompact":false},{"index":432,"time":"17:54","ratio":0.79992,"inputTokens":159984,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.174,"originalCredits":0.174,"afterCompact":false},{"index":433,"time":"17:54","ratio":0.800805,"inputTokens":160161,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.268,"originalCredits":0.268,"afterCompact":false},{"index":434,"time":"17:54","ratio":0.807885,"inputTokens":161577,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.197,"originalCredits":0.197,"afterCompact":false},{"index":435,"time":"17:54","ratio":0.81273,"inputTokens":162546,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":436,"time":"17:55","ratio":0.817865,"inputTokens":163573,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":437,"time":"17:55","ratio":0.819195,"inputTokens":163839,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.184,"originalCredits":0.184,"afterCompact":false},{"index":438,"time":"17:55","ratio":0.821015,"inputTokens":164203,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":439,"time":"17:56","ratio":0.82327,"inputTokens":164654,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.221,"originalCredits":0.221,"afterCompact":false},{"index":440,"time":"17:56","ratio":0.82541,"inputTokens":165082,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.372,"originalCredits":0.372,"afterCompact":false},{"index":441,"time":"17:56","ratio":0.83177,"inputTokens":166354,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":442,"time":"17:56","ratio":0.833855,"inputTokens":166771,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.194,"originalCredits":0.194,"afterCompact":false},{"index":443,"time":"17:57","ratio":0.2219,"inputTokens":44380,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.961,"originalCredits":0.961,"afterCompact":true},{"index":444,"time":"17:57","ratio":0.22259,"inputTokens":44518,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.064,"originalCredits":0.064,"afterCompact":false},{"index":445,"time":"17:57","ratio":0.223265,"inputTokens":44653,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.054,"originalCredits":0.054,"afterCompact":false},{"index":446,"time":"17:57","ratio":0.22413,"inputTokens":44826,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.056,"originalCredits":0.056,"afterCompact":false},{"index":447,"time":"17:58","ratio":0.22449,"inputTokens":44898,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.06,"originalCredits":0.06,"afterCompact":false},{"index":448,"time":"17:58","ratio":0.22485,"inputTokens":44970,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.057,"originalCredits":0.057,"afterCompact":false},{"index":449,"time":"17:58","ratio":0.22521,"inputTokens":45042,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.065,"originalCredits":0.065,"afterCompact":false},{"index":450,"time":"17:58","ratio":0.228555,"inputTokens":45711,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.125,"originalCredits":0.125,"afterCompact":false},{"index":451,"time":"17:58","ratio":0.23085,"inputTokens":46170,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.063,"originalCredits":0.063,"afterCompact":false},{"index":452,"time":"17:58","ratio":0.233025,"inputTokens":46605,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.108,"originalCredits":0.108,"afterCompact":false},{"index":453,"time":"17:58","ratio":0.234795,"inputTokens":46959,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.069,"originalCredits":0.069,"afterCompact":false},{"index":454,"time":"17:58","ratio":0.237035,"inputTokens":47407,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.081,"originalCredits":0.081,"afterCompact":false},{"index":455,"time":"17:59","ratio":0.240655,"inputTokens":48131,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.092,"originalCredits":0.092,"afterCompact":false},{"index":456,"time":"17:59","ratio":0.24235,"inputTokens":48470,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.086,"originalCredits":0.086,"afterCompact":false},{"index":457,"time":"17:59","ratio":0.24334,"inputTokens":48668,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.065,"originalCredits":0.065,"afterCompact":false},{"index":458,"time":"17:59","ratio":0.244215,"inputTokens":48843,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.071,"originalCredits":0.071,"afterCompact":false},{"index":459,"time":"18:00","ratio":0.246255,"inputTokens":49251,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.038,"originalCredits":0.038,"afterCompact":false},{"index":460,"time":"18:00","ratio":0.24677,"inputTokens":49354,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.066,"originalCredits":0.066,"afterCompact":false},{"index":461,"time":"18:53","ratio":0.249355,"inputTokens":49871,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.663,"originalCredits":0.663,"afterCompact":false},{"index":462,"time":"18:53","ratio":0.26299,"inputTokens":52598,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.11,"originalCredits":0.11,"afterCompact":false},{"index":463,"time":"18:53","ratio":0.26556,"inputTokens":53112,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.036,"originalCredits":0.036,"afterCompact":false},{"index":464,"time":"18:53","ratio":0.26943,"inputTokens":53886,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.133,"originalCredits":0.133,"afterCompact":false},{"index":465,"time":"18:54","ratio":0.278105,"inputTokens":55621,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.075,"originalCredits":0.075,"afterCompact":false},{"index":466,"time":"18:54","ratio":0.28113,"inputTokens":56226,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.069,"originalCredits":0.069,"afterCompact":false},{"index":467,"time":"18:54","ratio":0.285935,"inputTokens":57187,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.102,"originalCredits":0.102,"afterCompact":false},{"index":468,"time":"18:54","ratio":0.289635,"inputTokens":57927,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.046,"originalCredits":0.046,"afterCompact":false},{"index":469,"time":"18:54","ratio":0.292915,"inputTokens":58583,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.046,"originalCredits":0.046,"afterCompact":false},{"index":470,"time":"18:54","ratio":0.296055,"inputTokens":59211,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.103,"originalCredits":0.103,"afterCompact":false},{"index":471,"time":"18:54","ratio":0.30136,"inputTokens":60272,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.046,"originalCredits":0.046,"afterCompact":false},{"index":472,"time":"18:54","ratio":0.30218,"inputTokens":60436,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.041,"originalCredits":0.041,"afterCompact":false},{"index":473,"time":"18:55","ratio":0.30298,"inputTokens":60596,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.039,"originalCredits":0.039,"afterCompact":false},{"index":474,"time":"18:55","ratio":0.30728,"inputTokens":61456,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.058,"originalCredits":0.058,"afterCompact":false},{"index":475,"time":"18:55","ratio":0.309445,"inputTokens":61889,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.047,"originalCredits":0.047,"afterCompact":false},{"index":476,"time":"18:55","ratio":0.310345,"inputTokens":62069,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.062,"originalCredits":0.062,"afterCompact":false},{"index":477,"time":"18:55","ratio":0.312175,"inputTokens":62435,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.089,"originalCredits":0.089,"afterCompact":false},{"index":478,"time":"18:55","ratio":0.31665,"inputTokens":63330,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.044,"originalCredits":0.044,"afterCompact":false},{"index":479,"time":"18:55","ratio":0.321035,"inputTokens":64207,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.075,"originalCredits":0.075,"afterCompact":false},{"index":480,"time":"18:55","ratio":0.32385,"inputTokens":64770,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.092,"originalCredits":0.092,"afterCompact":false},{"index":481,"time":"18:56","ratio":0.32931,"inputTokens":65862,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.065,"originalCredits":0.065,"afterCompact":false},{"index":482,"time":"18:56","ratio":0.33127,"inputTokens":66254,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.063,"originalCredits":0.063,"afterCompact":false},{"index":483,"time":"18:56","ratio":0.334975,"inputTokens":66995,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.064,"originalCredits":0.064,"afterCompact":false},{"index":484,"time":"18:57","ratio":0.375045,"inputTokens":75009,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.223,"originalCredits":0.223,"afterCompact":false},{"index":485,"time":"18:57","ratio":0.37783,"inputTokens":75566,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.071,"originalCredits":0.071,"afterCompact":false},{"index":486,"time":"18:57","ratio":0.383995,"inputTokens":76799,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.074,"originalCredits":0.074,"afterCompact":false},{"index":487,"time":"18:57","ratio":0.388165,"inputTokens":77633,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.066,"originalCredits":0.066,"afterCompact":false},{"index":488,"time":"18:58","ratio":0.38943,"inputTokens":77886,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.049,"originalCredits":0.049,"afterCompact":false},{"index":489,"time":"18:58","ratio":0.39037,"inputTokens":78074,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.048,"originalCredits":0.048,"afterCompact":false},{"index":490,"time":"18:58","ratio":0.39097,"inputTokens":78194,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.067,"originalCredits":0.067,"afterCompact":false},{"index":491,"time":"18:58","ratio":0.39772,"inputTokens":79544,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.087,"originalCredits":0.087,"afterCompact":false},{"index":492,"time":"18:58","ratio":0.40217,"inputTokens":80434,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.153,"originalCredits":0.153,"afterCompact":false},{"index":493,"time":"18:58","ratio":0.40822,"inputTokens":81644,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.062,"originalCredits":0.062,"afterCompact":false},{"index":494,"time":"18:59","ratio":0.409465,"inputTokens":81893,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.051,"originalCredits":0.051,"afterCompact":false},{"index":495,"time":"18:59","ratio":0.411375,"inputTokens":82275,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.064,"originalCredits":0.064,"afterCompact":false},{"index":496,"time":"18:59","ratio":0.412595,"inputTokens":82519,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.056,"originalCredits":0.056,"afterCompact":false},{"index":497,"time":"18:59","ratio":0.427695,"inputTokens":85539,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.127,"originalCredits":0.127,"afterCompact":false},{"index":498,"time":"18:59","ratio":0.429245,"inputTokens":85849,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.065,"originalCredits":0.065,"afterCompact":false},{"index":499,"time":"18:59","ratio":0.43276,"inputTokens":86552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.075,"originalCredits":0.075,"afterCompact":false},{"index":500,"time":"18:59","ratio":0.434265,"inputTokens":86853,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.052,"originalCredits":0.052,"afterCompact":false},{"index":501,"time":"18:59","ratio":0.43549,"inputTokens":87098,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.05,"originalCredits":0.05,"afterCompact":false},{"index":502,"time":"19:00","ratio":0.43867,"inputTokens":87734,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.088,"originalCredits":0.088,"afterCompact":false},{"index":503,"time":"19:00","ratio":0.441015,"inputTokens":88203,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.054,"originalCredits":0.054,"afterCompact":false},{"index":504,"time":"19:00","ratio":0.44271,"inputTokens":88542,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.062,"originalCredits":0.062,"afterCompact":false},{"index":505,"time":"19:00","ratio":0.44922,"inputTokens":89844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.088,"originalCredits":0.088,"afterCompact":false},{"index":506,"time":"19:00","ratio":0.451165,"inputTokens":90233,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.081,"originalCredits":0.081,"afterCompact":false},{"index":507,"time":"19:01","ratio":0.453355,"inputTokens":90671,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.078,"originalCredits":0.078,"afterCompact":false},{"index":508,"time":"19:01","ratio":0.45556,"inputTokens":91112,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.067,"originalCredits":0.067,"afterCompact":false},{"index":509,"time":"19:01","ratio":0.45704,"inputTokens":91408,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.056,"originalCredits":0.056,"afterCompact":false},{"index":510,"time":"19:01","ratio":0.458625,"inputTokens":91725,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.088,"originalCredits":0.088,"afterCompact":false},{"index":511,"time":"19:02","ratio":0.461935,"inputTokens":92387,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.123,"originalCredits":0.123,"afterCompact":false},{"index":512,"time":"19:02","ratio":0.46658,"inputTokens":93316,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.055,"originalCredits":0.055,"afterCompact":false},{"index":513,"time":"19:02","ratio":0.467395,"inputTokens":93479,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.055,"originalCredits":0.055,"afterCompact":false},{"index":514,"time":"19:03","ratio":0.46877,"inputTokens":93754,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.087,"originalCredits":0.087,"afterCompact":false},{"index":515,"time":"19:03","ratio":0.477115,"inputTokens":95423,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.085,"originalCredits":0.085,"afterCompact":false},{"index":516,"time":"19:03","ratio":0.48053,"inputTokens":96106,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.063,"originalCredits":0.063,"afterCompact":false},{"index":517,"time":"19:03","ratio":0.48318,"inputTokens":96636,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.072,"originalCredits":0.072,"afterCompact":false},{"index":518,"time":"19:03","ratio":0.484265,"inputTokens":96853,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.057,"originalCredits":0.057,"afterCompact":false},{"index":519,"time":"19:04","ratio":0.48657,"inputTokens":97314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.085,"originalCredits":0.085,"afterCompact":false},{"index":520,"time":"19:04","ratio":0.48873,"inputTokens":97746,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.054,"originalCredits":0.054,"afterCompact":false},{"index":521,"time":"19:04","ratio":0.489615,"inputTokens":97923,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.069,"originalCredits":0.069,"afterCompact":false},{"index":522,"time":"19:04","ratio":0.490805,"inputTokens":98161,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.061,"originalCredits":0.061,"afterCompact":false},{"index":523,"time":"19:04","ratio":0.49165,"inputTokens":98330,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.062,"originalCredits":0.062,"afterCompact":false},{"index":524,"time":"19:05","ratio":0.492995,"inputTokens":98599,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.073,"originalCredits":0.073,"afterCompact":false},{"index":525,"time":"19:05","ratio":0.49581,"inputTokens":99162,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.091,"originalCredits":0.091,"afterCompact":false},{"index":526,"time":"21:33","ratio":0.49521,"inputTokens":99042,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.957,"originalCredits":2.957,"afterCompact":false},{"index":527,"time":"21:33","ratio":0.512985,"inputTokens":102597,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":528,"time":"21:33","ratio":0.5155,"inputTokens":103100,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":529,"time":"21:33","ratio":0.51857,"inputTokens":103714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":530,"time":"21:34","ratio":0.525155,"inputTokens":105031,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.284,"originalCredits":0.284,"afterCompact":false},{"index":531,"time":"21:34","ratio":0.53159,"inputTokens":106318,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":532,"time":"21:34","ratio":0.536995,"inputTokens":107399,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":533,"time":"21:35","ratio":0.5436,"inputTokens":108720,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.365,"originalCredits":0.365,"afterCompact":false},{"index":534,"time":"21:35","ratio":0.555585,"inputTokens":111117,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":535,"time":"21:35","ratio":0.55653,"inputTokens":111306,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.266,"originalCredits":0.266,"afterCompact":false},{"index":536,"time":"21:35","ratio":0.55785,"inputTokens":111570,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":537,"time":"21:36","ratio":0.560355,"inputTokens":112071,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":538,"time":"21:36","ratio":0.56228,"inputTokens":112456,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":539,"time":"21:36","ratio":0.56551,"inputTokens":113102,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":540,"time":"21:37","ratio":0.569335,"inputTokens":113867,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":541,"time":"21:37","ratio":0.570825,"inputTokens":114165,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":542,"time":"21:37","ratio":0.57323,"inputTokens":114646,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.286,"originalCredits":0.286,"afterCompact":false},{"index":543,"time":"21:37","ratio":0.574985,"inputTokens":114997,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":544,"time":"21:37","ratio":0.57736,"inputTokens":115472,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":545,"time":"21:38","ratio":0.58061,"inputTokens":116122,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.284,"originalCredits":0.284,"afterCompact":false},{"index":546,"time":"21:38","ratio":0.581585,"inputTokens":116317,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":547,"time":"21:38","ratio":0.583885,"inputTokens":116777,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.282,"originalCredits":0.282,"afterCompact":false},{"index":548,"time":"21:38","ratio":0.58498,"inputTokens":116996,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":549,"time":"21:38","ratio":0.59028,"inputTokens":118056,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":550,"time":"21:39","ratio":0.59292,"inputTokens":118584,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":551,"time":"21:39","ratio":0.594455,"inputTokens":118891,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":552,"time":"21:39","ratio":0.59875,"inputTokens":119750,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":553,"time":"21:39","ratio":0.599925,"inputTokens":119985,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.281,"originalCredits":0.281,"afterCompact":false},{"index":554,"time":"21:39","ratio":0.602035,"inputTokens":120407,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.301,"originalCredits":0.301,"afterCompact":false},{"index":555,"time":"21:39","ratio":0.605445,"inputTokens":121089,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.3,"originalCredits":0.3,"afterCompact":false},{"index":556,"time":"21:40","ratio":0.60677,"inputTokens":121354,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.304,"originalCredits":0.304,"afterCompact":false},{"index":557,"time":"21:40","ratio":0.609265,"inputTokens":121853,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":558,"time":"21:40","ratio":0.61044,"inputTokens":122088,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.288,"originalCredits":0.288,"afterCompact":false},{"index":559,"time":"21:40","ratio":0.611485,"inputTokens":122297,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.287,"originalCredits":0.287,"afterCompact":false},{"index":560,"time":"21:41","ratio":0.612475,"inputTokens":122495,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.29,"originalCredits":0.29,"afterCompact":false},{"index":561,"time":"21:41","ratio":0.61369,"inputTokens":122738,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.286,"originalCredits":0.286,"afterCompact":false},{"index":562,"time":"21:41","ratio":0.61756,"inputTokens":123512,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.329,"originalCredits":0.329,"afterCompact":false},{"index":563,"time":"21:41","ratio":0.620645,"inputTokens":124129,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":564,"time":"21:41","ratio":0.62229,"inputTokens":124458,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.291,"originalCredits":0.291,"afterCompact":false},{"index":565,"time":"21:42","ratio":0.62547,"inputTokens":125094,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.303,"originalCredits":0.303,"afterCompact":false},{"index":566,"time":"21:42","ratio":0.626395,"inputTokens":125279,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.296,"originalCredits":0.296,"afterCompact":false},{"index":567,"time":"21:42","ratio":0.62766,"inputTokens":125532,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.311,"originalCredits":0.311,"afterCompact":false},{"index":568,"time":"21:42","ratio":0.62995,"inputTokens":125990,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.302,"originalCredits":0.302,"afterCompact":false},{"index":569,"time":"21:43","ratio":0.631035,"inputTokens":126207,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.299,"originalCredits":0.299,"afterCompact":false},{"index":570,"time":"21:43","ratio":0.63228,"inputTokens":126456,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.297,"originalCredits":0.297,"afterCompact":false},{"index":571,"time":"21:43","ratio":0.63358,"inputTokens":126716,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.297,"originalCredits":0.297,"afterCompact":false},{"index":572,"time":"21:43","ratio":0.635855,"inputTokens":127171,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":573,"time":"21:44","ratio":0.63943,"inputTokens":127886,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":574,"time":"21:44","ratio":0.640355,"inputTokens":128071,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.299,"originalCredits":0.299,"afterCompact":false},{"index":575,"time":"21:45","ratio":0.6474,"inputTokens":129480,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.509,"originalCredits":0.509,"afterCompact":false},{"index":576,"time":"21:46","ratio":0.663125,"inputTokens":132625,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":577,"time":"21:47","ratio":0.664765,"inputTokens":132953,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.315,"originalCredits":0.315,"afterCompact":false},{"index":578,"time":"21:47","ratio":0.666175,"inputTokens":133235,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":579,"time":"21:48","ratio":0.669705,"inputTokens":133941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.405,"originalCredits":0.405,"afterCompact":false},{"index":580,"time":"21:49","ratio":0.67905,"inputTokens":135810,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":581,"time":"21:49","ratio":0.68285,"inputTokens":136570,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":582,"time":"21:50","ratio":0.688415,"inputTokens":137683,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.345,"originalCredits":0.345,"afterCompact":false},{"index":583,"time":"21:50","ratio":0.6894,"inputTokens":137880,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.319,"originalCredits":0.319,"afterCompact":false},{"index":584,"time":"21:51","ratio":0.69265,"inputTokens":138530,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.388,"originalCredits":0.388,"afterCompact":false},{"index":585,"time":"21:52","ratio":0.6985,"inputTokens":139700,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.353,"originalCredits":0.353,"afterCompact":false},{"index":586,"time":"21:53","ratio":0.69995,"inputTokens":139990,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.332,"originalCredits":0.332,"afterCompact":false},{"index":587,"time":"21:54","ratio":0.7012,"inputTokens":140240,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.325,"originalCredits":0.325,"afterCompact":false},{"index":588,"time":"21:54","ratio":0.70301,"inputTokens":140602,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.335,"originalCredits":0.335,"afterCompact":false},{"index":589,"time":"21:54","ratio":0.71401,"inputTokens":142802,"outputTokens":null,"usageSource":"transcript-ratio","credits":3.42,"originalCredits":3.42,"afterCompact":false},{"index":590,"time":"21:55","ratio":0.71715,"inputTokens":143430,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.383,"originalCredits":0.383,"afterCompact":false},{"index":591,"time":"21:55","ratio":0.72143,"inputTokens":144286,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.355,"originalCredits":0.355,"afterCompact":false},{"index":592,"time":"21:56","ratio":0.72381,"inputTokens":144762,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":593,"time":"21:57","ratio":0.72938,"inputTokens":145876,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":594,"time":"21:57","ratio":0.731265,"inputTokens":146253,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false},{"index":595,"time":"21:57","ratio":0.733025,"inputTokens":146605,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.346,"originalCredits":0.346,"afterCompact":false},{"index":596,"time":"21:57","ratio":0.734025,"inputTokens":146805,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.338,"originalCredits":0.338,"afterCompact":false},{"index":597,"time":"21:58","ratio":0.734995,"inputTokens":146999,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":598,"time":"21:58","ratio":0.73643,"inputTokens":147286,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.348,"originalCredits":0.348,"afterCompact":false},{"index":599,"time":"21:59","ratio":0.737865,"inputTokens":147573,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.395,"originalCredits":0.395,"afterCompact":false},{"index":600,"time":"22:00","ratio":0.75309,"inputTokens":150618,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.412,"originalCredits":0.412,"afterCompact":false},{"index":601,"time":"22:00","ratio":0.755445,"inputTokens":151089,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.353,"originalCredits":0.353,"afterCompact":false},{"index":602,"time":"22:00","ratio":0.75783,"inputTokens":151566,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.359,"originalCredits":0.359,"afterCompact":false},{"index":603,"time":"22:00","ratio":0.760565,"inputTokens":152113,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.36,"originalCredits":0.36,"afterCompact":false},{"index":604,"time":"22:01","ratio":0.76141,"inputTokens":152282,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.349,"originalCredits":0.349,"afterCompact":false},{"index":605,"time":"22:01","ratio":0.763655,"inputTokens":152731,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":606,"time":"22:01","ratio":0.772545,"inputTokens":154509,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":607,"time":"22:01","ratio":0.774025,"inputTokens":154805,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":608,"time":"22:01","ratio":0.776855,"inputTokens":155371,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.44,"originalCredits":0.44,"afterCompact":false},{"index":609,"time":"22:02","ratio":0.78513,"inputTokens":157026,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.41,"originalCredits":0.41,"afterCompact":false},{"index":610,"time":"22:02","ratio":0.789445,"inputTokens":157889,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.413,"originalCredits":0.413,"afterCompact":false},{"index":611,"time":"22:02","ratio":0.79376,"inputTokens":158752,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.4,"originalCredits":0.4,"afterCompact":false},{"index":612,"time":"22:02","ratio":0.79607,"inputTokens":159214,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":613,"time":"22:03","ratio":0.79924,"inputTokens":159848,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.378,"originalCredits":0.378,"afterCompact":false},{"index":614,"time":"22:03","ratio":0.799975,"inputTokens":159995,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.371,"originalCredits":0.371,"afterCompact":false},{"index":615,"time":"22:03","ratio":0.801115,"inputTokens":160223,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.373,"originalCredits":0.373,"afterCompact":false},{"index":616,"time":"22:03","ratio":0.80218,"inputTokens":160436,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.494,"originalCredits":0.494,"afterCompact":false},{"index":617,"time":"22:04","ratio":0.813465,"inputTokens":162693,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.429,"originalCredits":0.429,"afterCompact":false},{"index":618,"time":"22:04","ratio":0.81434,"inputTokens":162868,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.373,"originalCredits":0.373,"afterCompact":false},{"index":619,"time":"22:04","ratio":0.81755,"inputTokens":163510,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":620,"time":"22:05","ratio":0.822985,"inputTokens":164597,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.404,"originalCredits":0.404,"afterCompact":false},{"index":621,"time":"22:05","ratio":0.824805,"inputTokens":164961,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.382,"originalCredits":0.382,"afterCompact":false},{"index":622,"time":"22:06","ratio":0.826035,"inputTokens":165207,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":623,"time":"22:08","ratio":0.20627,"inputTokens":41254,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.575,"originalCredits":0.575,"afterCompact":true},{"index":624,"time":"22:08","ratio":0.20689,"inputTokens":41378,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.101,"originalCredits":0.101,"afterCompact":false},{"index":625,"time":"22:09","ratio":0.20776,"inputTokens":41552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.101,"originalCredits":0.101,"afterCompact":false},{"index":626,"time":"22:09","ratio":0.219245,"inputTokens":43849,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":627,"time":"22:09","ratio":0.225315,"inputTokens":45063,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.139,"originalCredits":0.139,"afterCompact":false},{"index":628,"time":"22:09","ratio":0.231085,"inputTokens":46217,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.142,"originalCredits":0.142,"afterCompact":false},{"index":629,"time":"22:09","ratio":0.23405,"inputTokens":46810,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.133,"originalCredits":0.133,"afterCompact":false},{"index":630,"time":"22:10","ratio":0.235245,"inputTokens":47049,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.169,"originalCredits":0.169,"afterCompact":false},{"index":631,"time":"22:10","ratio":0.24039,"inputTokens":48078,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.145,"originalCredits":0.145,"afterCompact":false},{"index":632,"time":"22:10","ratio":0.24321,"inputTokens":48642,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.137,"originalCredits":0.137,"afterCompact":false},{"index":633,"time":"22:10","ratio":0.24778,"inputTokens":49556,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":634,"time":"22:11","ratio":0.255465,"inputTokens":51093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.179,"originalCredits":0.179,"afterCompact":false},{"index":635,"time":"22:11","ratio":0.259775,"inputTokens":51955,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.157,"originalCredits":0.157,"afterCompact":false},{"index":636,"time":"22:11","ratio":0.26168,"inputTokens":52336,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":637,"time":"22:11","ratio":0.26457,"inputTokens":52914,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":638,"time":"22:11","ratio":0.270505,"inputTokens":54101,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.94,"originalCredits":0.94,"afterCompact":false},{"index":639,"time":"22:11","ratio":0.27203,"inputTokens":54406,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":640,"time":"22:12","ratio":0.27276,"inputTokens":54552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.135,"originalCredits":0.135,"afterCompact":false},{"index":641,"time":"22:12","ratio":0.27442,"inputTokens":54884,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":642,"time":"22:13","ratio":0.275635,"inputTokens":55127,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":643,"time":"22:13","ratio":0.281885,"inputTokens":56377,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.168,"originalCredits":0.168,"afterCompact":false},{"index":644,"time":"22:13","ratio":0.283115,"inputTokens":56623,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":645,"time":"22:13","ratio":0.28396,"inputTokens":56792,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":646,"time":"22:13","ratio":0.284935,"inputTokens":56987,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.148,"originalCredits":0.148,"afterCompact":false},{"index":647,"time":"22:14","ratio":0.28657,"inputTokens":57314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":648,"time":"22:14","ratio":0.289775,"inputTokens":57955,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.153,"originalCredits":0.153,"afterCompact":false},{"index":649,"time":"22:14","ratio":0.29069,"inputTokens":58138,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.147,"originalCredits":0.147,"afterCompact":false},{"index":650,"time":"22:14","ratio":0.292105,"inputTokens":58421,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":651,"time":"22:14","ratio":0.29322,"inputTokens":58644,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":652,"time":"22:15","ratio":0.29549,"inputTokens":59098,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.151,"originalCredits":0.151,"afterCompact":false},{"index":653,"time":"22:15","ratio":0.29823,"inputTokens":59646,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.166,"originalCredits":0.166,"afterCompact":false},{"index":654,"time":"22:15","ratio":0.30016,"inputTokens":60032,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.15,"originalCredits":0.15,"afterCompact":false},{"index":655,"time":"22:15","ratio":0.300995,"inputTokens":60199,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":656,"time":"22:16","ratio":0.30195,"inputTokens":60390,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.146,"originalCredits":0.146,"afterCompact":false},{"index":657,"time":"22:16","ratio":0.302665,"inputTokens":60533,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.157,"originalCredits":0.157,"afterCompact":false},{"index":658,"time":"22:16","ratio":0.30434,"inputTokens":60868,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.156,"originalCredits":0.156,"afterCompact":false},{"index":659,"time":"22:16","ratio":0.305565,"inputTokens":61113,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.149,"originalCredits":0.149,"afterCompact":false},{"index":660,"time":"22:16","ratio":0.3064,"inputTokens":61280,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.172,"originalCredits":0.172,"afterCompact":false},{"index":661,"time":"22:20","ratio":0.30965,"inputTokens":61930,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.171,"originalCredits":1.171,"afterCompact":false},{"index":662,"time":"22:20","ratio":0.31406,"inputTokens":62812,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.178,"originalCredits":0.178,"afterCompact":false},{"index":663,"time":"22:20","ratio":0.3171,"inputTokens":63420,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.17,"originalCredits":0.17,"afterCompact":false},{"index":664,"time":"22:21","ratio":0.321125,"inputTokens":64225,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.171,"originalCredits":0.171,"afterCompact":false},{"index":665,"time":"22:21","ratio":0.322,"inputTokens":64400,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.157,"originalCredits":0.157,"afterCompact":false},{"index":666,"time":"22:21","ratio":0.32287,"inputTokens":64574,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.155,"originalCredits":0.155,"afterCompact":false},{"index":667,"time":"22:21","ratio":0.324215,"inputTokens":64843,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":668,"time":"22:22","ratio":0.32526,"inputTokens":65052,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.159,"originalCredits":0.159,"afterCompact":false},{"index":669,"time":"22:22","ratio":0.32631,"inputTokens":65262,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.172,"originalCredits":0.172,"afterCompact":false},{"index":670,"time":"22:22","ratio":0.32852,"inputTokens":65704,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false}],"identity":{"sumAttributed":70478549,"billedInputTokens":70478549,"absDiff":0,"ok":true},"pluginVersion":"2.7.4","selfCmd":"\"C:\\Users\\zhaobingxiang\\.qoder-cn\\plugins\\cache\\qoder-marketplace\\qoder-credits-inspector\\2.7.4\\bin\\credits-inspector.cmd\" cli","linkHealth":{"matched":0,"requests":670,"coverage":0,"usageSource":"transcript-ratio","breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":670},"logRecords":0,"lastRecordAt":null,"recentRequests":0,"proxyErrors":null,"clientAbort":null,"clientAbortMaxMs":null,"upstreamRejected":null,"aborted":null,"truncated":null,"noUsage":null,"slowestMs":null,"supersededFailure":null},"subagents":{"scanned":false,"dir":null,"probedPaths":["C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\D--ide-mdreader\\a5e077de-b700-412e-9340-8b9e9078b10b\\subagents","C:\\Users\\zhaobingxiang\\.qoder-cn\\projects\\a5e077de-b700-412e-9340-8b9e9078b10b\\subagents"],"reason":"no-dir","count":0,"items":[],"totals":{"roundTrips":0,"billedInputTokens":0,"credits":0,"originalCredits":0},"combined":{"roundTrips":670,"billedInputTokens":70478549,"credits":163.456,"originalCredits":163.456}},"manual":null,"artifacts":{"report":"report.json","canvas":"在设置中增加模型的配置，用户的书写提示中的内容可__a5e077de.canvas.tsx"}} as unknown as Report;

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
