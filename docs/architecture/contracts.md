# 数据与协议契约草案

状态：**待实施的 v1 设计，不是现有 API 文档**。关联 [架构总览](README.md) 与 [迁移计划](implementation-plan.md)。字段采用 TypeScript 风格表达，实施时须配套运行时 schema 与测试；类型声明不能校验浏览器或模型输入。

## 1. 标识、正文和版本

所有 ID 均为 opaque 字符串，按本地会话隔离。内核签发 workspaceId、fileId、planId、runId；浏览器生成文档、标签和上下文项 ID。ID 不能替代认证、工作区授权或文件权限检查。

```ts
type DocumentSource =
  | { kind: 'workspace'; workspaceId: string; fileId: string }
  | { kind: 'import'; importId: string };

interface TextFormat {
  encoding: 'utf8';
  bom: boolean;
  newline: 'LF' | 'CRLF' | 'CR' | 'none' | 'mixed';
}

interface DocumentBuffer {
  documentId: string;
  source: DocumentSource;
  displayName: string;
  fileType: 'markdown' | 'text';
  content: string;                 // 内部统一 LF
  bufferVersion: number;           // 非负安全整数，编辑/撤销/应用后递增
  savedContent: string;            // 最后成功保存或导出时捕获的正文
  diskRevision: string | null;     // 导入文档必须为 null
  format: TextFormat;
  editable: boolean;
  readOnlyReason: string | null;
}

interface TextSnapshot {
  snapshotId: string;
  documentId: string;
  bufferVersion: number;
  content: string;
  snapshotHash: string;            // SHA-256(UTF-8 编码的规范化正文)
}

interface SourceRange {
  rangeId: string;
  start: number;                   // 包含，UTF-16 code unit 索引
  end: number;                     // 不包含
  original: string;                // snapshot.content.slice(start, end)
}
```

source 不能由显示名称推导；同名导入文件永远不对应磁盘文件。内核首次读取时签发 fileId 并记录工作区与路径；替换保存后的同一路径可继续使用该 ID，但每次操作重新验证。删除、移动或来源失效返回错误，不自动追踪到其他路径。规范化路径和平台文件身份共同检查别名；首期拒绝不能可靠识别或隔离的链接及多重链接文件。

正文必须是有效 Unicode，禁止孤立代理项和 NUL。所有偏移使用 JavaScript 字符串的 UTF-16 单位，不能与 UTF-8 字节、Unicode code point 或展示行号混用，边界不能切断代理对。行号只作展示。

diskRevision 对原始字节计算 SHA-256，包含 BOM 和实际换行，不能与 snapshotHash 互换。撤销后即使正文相同，bufferVersion 也不回退，已有聚焦和提案保守失效，避免旧异步结果重新生效。这比 Demo 仅比较全文快照更严格，应记录为可见行为变更。

保存状态分为三个维度：`dirty = content !== savedContent`、I/O 状态 `idle | saving | failed`、磁盘状态 `unknown | matching | externally-changed | missing`。提案状态单独记录，不把已应用等同于已保存。

保存捕获正文、bufferVersion、diskRevision，同一文档只允许一个保存请求在途。成功后更新该次正文的 savedContent 和新 diskRevision；期间继续输入则 dirty 仍为 true。失败不改保存基线。导出仅记录下载已发起，不能宣称浏览器已经写入用户磁盘。

## 2. 引用、关注与聚焦

| 对象 | 关键字段 | 生命周期和校验 |
| --- | --- | --- |
| ReferenceSnapshot | referenceId、展示名、来源提示、独立正文/摘要、创建时间 | 不可变，关闭来源继续存在；更新须重建；来源提示不授予文件访问权 |
| Attention | documentId、scopeRevision | 只允许可编辑且支持 attention 的文档；移除令待确认提案失效，重新加入不恢复旧提案 |
| FocusGroup | focusId、documentId、role、snapshotId、ranges、instruction、scopeRevision | 一条说明对应多个精确范围；编辑/移除目标聚焦推进 scopeRevision |
| TabView | tabId、documentId?、paneId、模式、选区与滚动 | 空标签无文档；移动/隐藏只改视图；关闭文档清理关联授权 |

role 从文档可编辑能力派生：可编辑为 target、只读为 reference，不能任意填值绕过校验。target 聚焦只在文档已关注时生效；不自动关注。只读参考聚焦不需要关注。

聚焦须满足：

1. 说明 trim 后非空且不超过 2,000 个 UTF-16 单位，至少一个范围。
2. `0 <= start < end <= snapshot.content.length` 且原文相等；组内及同文档目标组间不重叠。
3. 校验文档身份、bufferVersion、完整正文摘要和切片；只比较选区文本不足以证明原位置有效。
4. 非连续范围不得转成从最小 start 到最大 end 的整体范围，区间原文和空白逐字保留。
5. 过期后保留创建时正文和说明供查看，不自动套到当前文本；重新选择确认生成新记录。
6. 结构分块按序拼接须恢复全文及空白；空文件无虚假聚焦范围。

全局 contextRevision 使未提交的发送计划失效。逐文档 scopeRevision 用于应用校验：关闭、移除/重新关注、修改目标聚焦或编辑权限时递增；无关文档变化不必使已完成提案失效。修改请求或引用不改变已有提案，它们保留生成时的来源记录。

## 3. 发送计划与模型任务

```ts
interface ApprovedRange extends SourceRange {
  focusId: string | null;           // null 表示整文档授权范围
  instruction: string;
}

interface PlanTarget {
  documentId: string;
  source: DocumentSource;
  snapshotId: string;
  snapshotHash: string;
  bufferVersion: number;
  scopeRevision: number;
  ranges: ApprovedRange[];
}

interface SendItem {
  itemId: string;
  purpose: 'target' | 'reference' | 'surrounding-context';
  sourceId: string;
  text: string;
  instruction: string | null;
}

interface PreparedPlan {
  protocolVersion: 1;
  planId: string;
  planHash: string;
  contextRevision: number;
  providerConfigRevision: number;
  modelProfileId: string;
  destination: { origin: string; modelId: string };
  prompt: string;
  targets: PlanTarget[];
  sendItems: SendItem[];
  inputBytes: number;
  estimatedTokens: number | null;
  expiresAt: string;
}
```

内核保留计划关联的不可变全文快照用于本地验证。Provider 只接收 sendItems、请求和匿名目标/范围 ID，不得访问未选全文、绝对路径、文件权限或快照仓库。无目标聚焦时整文档形成一个授权范围；空文档使用唯一的 `[0, 0)` 整文档范围，该例外不适用于聚焦组。

prepare 会把选中的文档快照交给**本机内核内存**，包括浏览器导入文件，接入时须展示此变化。外部发送清单只含 sendItems 与请求，不含本地校验所用的其余全文。前端先选内容，prepare 后显示最终清单，再 execute；prepare 不调用外部服务。

planHash 由内核对稳定序列化的计划语义计算，覆盖正文、范围、说明、端点与模型配置版本。确认只提交 planId、返回的 hash 和幂等键，内核执行自己保存的计划，不信任客户端重传的已批准范围。计划归属当前会话，过期或修改后不能继续使用。

prepare 时内核自行计算快照摘要和范围原文，校验大小、类型及重叠。workspace 来源须解析已签发 fileId 并验证当前授权和可编辑能力，不能相信客户端的 editable；允许正文包含未保存编辑，因此不要求它等于磁盘正文。import 来源只能作为临时内存文本，不能转换成磁盘权限。浏览器的关注与范围表示这次用户请求的应用级意图，不构成对恶意本地客户端的独立安全隔离。

多个目标默认使用各自独立的 Provider 输入，共用显式参考；其他关注文件不自动作为参考发送给当前目标。所有子请求归入同一 runId，默认串行执行，全部完成并校验后才发布整组提案。一个失败则整体任务失败，不发布部分可应用结果；重试可能再次计费，须显示已完成调用状态。

### 并发与失效

- 同文档至多属于一个活动任务；按排好序的 ID 一次性预留全部目标，冲突即拒绝，避免交叉占用。不同文档任务受全局并发限制。
- 发起前按审查策略处理旧 pending，再冻结文档和上下文，不能混用冻结前后快照。
- 内容/范围变更使相关活动任务过期并请求取消。内核不能直接观察浏览器内存，故应用必须再验版本；取消消息丢失也不能使迟到结果覆盖新内容。
- 只接受本 session/run 的单调事件序号。流式文字只是进度，最终结构结果通过完整校验前不能应用。
- 取消通过 AbortSignal 传至 Provider；无法保证撤销服务已收内容或已产生费用，取消后不发布提案。
- 断线不自动重建任务或重发模型请求；查询已有 runId 恢复显示。内核重启则返回任务丢失，保留浏览器草稿。

任务状态：`prepared → running → validating → completed`，运行/校验阶段可转 `failed | cancelled | expired`。终态不回到 running，重试建新计划。completed 仅指候选有效，不代表应用或保存。

## 4. 模型候选与逐文档提案

```ts
interface ModelCandidate {
  message: string;
  edits: Array<{ documentId: string; rangeId: string; replacement: string }>;
}

interface ChangeProposal {
  proposalId: string;
  runId: string;
  documentId: string;
  source: DocumentSource;
  baseBufferVersion: number;
  baseSnapshotHash: string;
  baseScopeRevision: number;
  before: string;
  after: string;
  edits: Array<{ rangeId: string; start: number; end: number; replacement: string }>;
  status: 'pending' | 'applied' | 'discarded' | 'expired';
  reasonCode: string | null;
}
```

Provider 只做协议转换，共同校验器拒绝未知 documentId/rangeId、重复范围、未知结构字段、非法文本和超限输出。replacement 里的文字即使像命令也只是文档内容，不执行。start/end 从本机计划取，不能由模型提供权威偏移。未返回的范围视为不改，空 replacement 明确表示删除已授权范围。

按原位置从后向前替换，构造完整 after，内部正文的范围外内容逐字保持，编码交给保存适配器。合并多个范围可通过首范围写合并文本、其余所选范围给空串表达，不能删除中间未选内容。before 等于 after 则只记未改动，不建 pending。

不支持结构化输出的服务可要求严格 JSON 并解析，但仍经共同校验；解析失败只记失败/普通回复，不从 Markdown 猜路径或运行工具。首个真实协议和服务商待选，不宣称一个兼容协议覆盖所有服务。

应用同时校验：来源/文档身份一致，仍打开、可编辑且受关注，没有保存操作在途，scopeRevision、bufferVersion 一致，before 与当前正文相同。通过单个同步编辑事务更新缓冲区、版本与提案状态；撤销内容不能使旧提案恢复 pending。

| 动作 | accept-on-next-action（兼容默认） | explicit-only（后续可选） |
| --- | --- | --- |
| 点击应用/放弃 | 当前文档校验后处理 | 相同 |
| 实际输入/粘贴/Tab | 单独事务应用有效提案，再输入 | 提示先选择应用/放弃，保留输入意图 |
| 保存 | 先应用，再捕获正文保存 | 提示先处理提案 |
| 再次生成该文档修改 | 先处理旧提案，再快照 | 提示先处理提案 |
| 切换标签/查看对比/改请求 | 不应用 | 不应用 |

校验失败则 expired，保留快照；暂时 saving 只拒绝本次操作，结束后重新检查。多个文档始终分别校验和报告，不隐藏部分失败。

## 5. 本地 API 草案

旧 `/api/files` 和 `/api/file` 兼容期保留，新接口位于 `/api/v1`。生产同源，所有 API 和事件流校验会话、Host 和 Origin；schema 拒绝未知字段，同时限制原始请求体和解码后的正文。

| 方法和路径 | 输入要点 | 返回或行为 |
| --- | --- | --- |
| GET /api/v1/session | 会话令牌 | 会话代号、协议、有效限制、模拟/真实能力 |
| GET /api/v1/workspaces | 无路径参数 | 本地启动入口已授权根的可读标签 |
| GET /api/v1/workspaces/:id/entries | 签发的目录 ID、cursor | 分页子项和 fileId，不递归读正文 |
| GET /api/v1/files/:fileId | 授权文件 ID | 正文、格式、editable、diskRevision |
| PUT /api/v1/files/:fileId | content、expectedDiskRevision、saveId | 新 revision；旧版本 409 |
| GET /api/v1/models | 无 | 非敏感配置、能力、credentialConfigured |
| POST /api/v1/models | 显示名、端点、协议类型、modelId | 校验并保存，不自动联网 |
| PATCH /api/v1/models/:id | 非敏感字段 | 新 configRevision，旧计划失效 |
| PUT /api/v1/models/:id/credential | 密钥、session/secure-store 模式 | 仅返回设置状态，禁止请求体日志 |
| DELETE /api/v1/models/:id/credential | 当前会话 | 清理凭据、使未执行计划失效并请求取消相关活动任务 |
| POST /api/v1/plans | 所选快照、关注、聚焦、引用、请求、模型 ID | PreparedPlan，只在本机准备 |
| DELETE /api/v1/plans/:id | 本会话计划 | 取消未执行计划并释放无引用快照 |
| POST /api/v1/runs | planId、planHash、idempotencyKey | 202 + runId，同键同负载返回同任务 |
| GET /api/v1/runs/:id | 本会话任务 | 状态、最后 seq、终态结果/错误 |
| GET /api/v1/runs/:id/events | runId、可选 afterSeq | text/event-stream，单调序号进度 |
| DELETE /api/v1/runs/:id | 本会话任务 | 幂等取消；已 completed 返回终态 |

应用/放弃是浏览器命令，不增加文件写入接口。测试模型连接必须是独立显式操作，接口在首个 Provider 定义后补充，不在填写端点时自动联网。

事件流用 fetch 读取，以便携带 X-Editor-Token 请求头，不将 token 放入 URL。事件为 run.started、text.delta、run.validating、run.completed、run.failed、run.cancelled、run.expired；每条含 runId、seq、type、payload。后端保留有界 replay，afterSeq 太旧返回 EVENT_GAP，前端 GET 任务快照，不重发模型调用。

execute 之前重新检查 providerConfigRevision；任何模型端点、模型标识或凭据变更均推进该版本，使未执行计划失效。已在途请求不能追回发送内容；删除凭据会尽力中止这些请求。创建 run 的幂等检查必须在消费计划之前：同键同负载返回既有任务，同键不同负载返回 IDEMPOTENCY_MISMATCH；同计划换键重发也返回原任务，不重复调用服务。

saveId 按会话+文件去重：同 ID 同正文摘要/expectedDiskRevision 返回原响应，负载不同返回 409。断线后先重试同 saveId 或读取磁盘比较，不能把未知响应视为未保存。幂等记录仅当前内核会话有效，重启后不保证恢复。

### 错误契约

错误对象含 code、messageKey、requestId、retryable 和白名单 details。前端按 messageKey 本地化，不再匹配中文错误句子。details 不含正文、密钥、绝对路径、完整 Provider 响应或调用栈。

| HTTP | 示例错误码 | 用户动作 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 修正输入/重建计划 |
| 401 / 403 | SESSION_INVALID / WORKSPACE_DENIED | 重开启动地址/检查本地授权 |
| 404 / 410 | FILE_MISSING / PLAN_EXPIRED、RUN_GONE | 保留草稿，重新准备 |
| 409 | DISK_CONFLICT、STALE_SNAPSHOT、TARGET_BUSY、EVENT_GAP、DUPLICATE_FILE_TARGET、IDEMPOTENCY_MISMATCH | 比较版本、处理任务或读取终态 |
| 413 / 415 / 422 | LIMIT_EXCEEDED / UNSUPPORTED_TYPE / INVALID_TEXT | 缩小内容或只读查看 |
| 429 | LOCAL_CAPACITY | 等待本地任务完成 |
| 502 / 504 | PROVIDER_FAILURE、INVALID_MODEL_OUTPUT / PROVIDER_TIMEOUT | 查看脱敏原因，自行决定重试 |

已创建任务的失败由终态报告，GET 状态返回 200；创建前失败用 HTTP 状态。retryable 是建议，不授权自动重发模型请求。

## 6. 限额与内存回收

以下是**建议初值，尚未压测或实现**，M4 前须用虚构夹具验证，不是已交付性能指标。

| 限制 | 初值 | 处理 |
| --- | --- | --- |
| 单文件原始/保存字节 | 延续 2 MiB | 读写边界均校验 |
| 单目标生成前后正文 | 延续 40,000 UTF-16 单位且不超过 400 行 | 前后均校验，不截断 |
| 单次目标数 / 全局活动任务 | 8 / 2 | 同文档活动任务上限 1 |
| 计划快照正文总量 | 去重后 4 MiB UTF-8 | 聚焦和引用复用 snapshotId |
| 原始 JSON 请求体 | 32 MiB | 容纳转义膨胀，解码后仍校验 |
| 单次 Provider 输入/输出 | 输入正文 1 MiB、结果 1 MiB；另受 token 预算限制 | 有 tokenizer 时估算；未知窗口必须配置上限 |
| 准备计划有效期 | 5 分钟 | 执行前检查，过期回收 |
| 单任务总时间 | 120 秒 | 超时停止后续调用 |
| 事件 replay / 终态缓存 | 每任务 1 MiB / 15 分钟 | gap 后查终态，过期释放 |
| 内核会话内容缓存 | 64 MiB | 回收无引用/过期数据，活动对象超额则拒绝新任务 |
| 浏览器提案和引用快照 | 64 MiB | 不删除脏缓冲区或 pending，提示用户清理后继续 |

同一计划不要重复持有 ranges.original 与全文的大对象副本，可在传输/展示时派生。配额须覆盖快照、after、候选和事件，默认不持久化正文。

## 7. 内置类型与 Provider 端口

文件类型纯模块提供 matches(metadata)、capabilities、blocks(snapshot, cursor)；web 预览适配器处理安全 DOM。分块返回可验证的原文索引，不能先格式化再报偏移。未声明的能力均为 false。

Provider 端口接收已批准输入、内核提供的凭据解析能力、AbortSignal 和限额，返回有界异步事件及最终 ModelCandidate。模拟 Provider 标记 isSimulation，不联网；真实 Provider 运行于内核，不装载任意外部代码。流式、结构化结果、token 估算分别声明，不支持时明确报错。

## 8. 契约必测案例

- 同名不同来源、同磁盘文件多缓冲区、保存中输入、保存响应丢失。
- emoji/代理对、BOM、各种换行、尾空白、纯空白、空文档整文档替换、混合换行只读。
- 非连续合并保留中间原文，过期/重叠/伪造范围、伪造角色、未关注、移除后重新关注。
- 全局请求与聚焦目标选择、只读聚焦参考优先、其他关注文件不自动成为参考。
- 半成品流、未知 rangeId、重复 edits、越权目标、超限、取消后迟到、断线和 gap。
- 显式/隐式应用、IME/粘贴、切换标签不应用、来源关闭、撤销后版本不回退。
- 路径和链接逃逸、端点重定向/DNS 地址改变、凭据不可读回、错误日志不含正文。
