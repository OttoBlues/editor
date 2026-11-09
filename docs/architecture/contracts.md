# 数据与状态契约 v0.5

状态：**待实施设计**。延续内核权威状态、独立视图/选区、智能编辑上下文和有界工具往返，新增唯一模型激活与有序插件路由状态；插件页面、模型和工具不成为第二个文档仓库。接口见 [Kernel API](kernel-api.md)，扩展点见 [插件协议](plugin-system.md)，页面契约见 [文档视图](document-views.md)，执行流程见 [模型与工具](model-tools.md)。

## 1. 身份与所有权

| 对象 | 签发/拥有者 | 生命周期 |
| --- | --- | --- |
| kernelInstanceId | 内核启动实例 | 重启改变，旧票据/租约不可复用 |
| sessionId | 内核，会话绑定用户主体 | 与网页连接分离，显式关闭或宿主关闭内核才结束 |
| connectionId / clientId | 经认证的宿主连接 | 断线可变；resume 不能仅靠猜 sessionId |
| pluginId / contributionId | manifest；内核注册 | 安装/启停管理，调用绑定 pluginGeneration |
| workspaceId / resourceId | 内核结合资源插件签发 | 只能定位已授权资源，不接受任意路径代替 |
| documentId | 内核 | 一份独立缓冲区；关闭后重新打开是新 ID |
| viewId | 内核绑定、宿主挂载 | 每个插件页面实例一个；绑定文档/插件代次/连接，关闭不删除文档 |
| selectionId | 内核校验后签发 | 文档快照中的临时范围，受主体/视图限制；不等于聚焦或授权 |
| writerId / leaseId | 可信输入端身份 / 内核租约 | 页面对应 viewId；无 UI 客户端或宿主业务命令另绑定，始终同文档单写 |
| tabId / paneId | 宿主 UI | 纯视图标识，不作文件/编辑授权 |
| snapshotId / proposalId / planId / runId | 内核 | 会话隔离、不可猜测、按引用和限额保留 |
| executionId / candidateId | 内核 | 一个 run 中目标文档的执行 / 工具暂存候选，终态后不能复用来改新版本 |
| toolId / toolCallId | 插件贡献 / 模型插件规范化 | 工具 ID 带命名空间；调用 ID 在执行内唯一，不构成权限 |

所有 ID 为 opaque 值，不等于权限。内核校验 session/主体/资源归属；插件拿不到跨会话 ID 的解析权。多个内核实例互不共享凭据、授权或文档句柄。

### 1.1 唯一模型激活与插件路由状态

```ts
interface ActiveModelState {
  activeModelProfileId: string | null; // 同一内核实例至多一个，模拟器也计入
  activationRevision: number;
}
interface FileRoutingPolicy {
  routingRevision: number;
  defaultPluginOrder: string[];       // 文件类型/视图插件 ID，越前越优先
  perFileTypeOrders: Record<string, string[]>; // 同一集合的按类型完整排列
}
```

两者由内核持有，作用于该实例全部宿主连接与会话；权限范围不因共享选择而扩大。零插件时激活槽为 null，顺序为空。modelProfileId 指向具体模型配置及接入贡献，不等于 pluginId；可保存多份配置，仅一个能进入执行。registryRevision 另外记录已安装/启用贡献及代次变化。

激活切换用 expectedActivationRevision 校验，活动 run 或尚未释放的本地模型调用阻止切换/清空；成功后旧计划失效，已有提案保留来源。插件故障可强制撤销槽并拒绝迟到结果，新激活须待旧调用在本地释放或隔离。模型详情及凭据按主体授权过滤，不能借全局槽读取另一会话内容。

顺序更新用 expectedRoutingRevision 原子替换，不允许重复、遗漏或未知插件。新增文件插件追加末尾并递增水位，停用保留位置；移除删条目，升级保留次序。fileTypeKey 取规范化扩展名，无扩展名以空键表示；类型内容仍由插件识别。解析记录含两个路由水位、匹配链、选中贡献和选中原因，绑定后不随调序自动更换。

## 2. 文档基础模型

```ts
interface PluginBinding {
  pluginId: string;
  pluginVersion: string;
  contributionId: string;
  pluginGeneration: number;
  configRevision: number;
}

type DocumentSource =
  | { kind: 'resource'; workspaceId: string; resourceId: string; sourceBinding: PluginBinding }
  | { kind: 'import'; importId: string }
  | { kind: 'memory' };

interface DocumentState {
  documentId: string;
  sessionId: string;
  model: 'text/v1';
  source: DocumentSource;
  typeBinding: PluginBinding | null; // 纯内存文档可不绑定类型插件
  fileTypeKey: string | null;        // 打开/导入时的路由键，纯内存文档可为空
  displayName: string;
  content: string;                  // 规范化 LF 的有效 Unicode
  version: number;                  // 每次内容事务递增，undo 也不回退
  scopeRevision: number;            // 目标权限/聚焦变化
  savedSnapshotId: string | null;
  resourceRevision: string | null;
  formatMetadata: unknown;          // 受类型插件 schema 约束，内核保管
  access: { editable: boolean; reason: string | null };
}

interface TextSnapshot {
  snapshotId: string;
  documentId: string;
  version: number;
  content: string;
  contentHash: string;
  typeBinding: PluginBinding | null;
}

interface ViewBinding {
  viewId: string;
  documentId: string;
  connectionId: string;
  viewBinding: PluginBinding;  // 与 DocumentState.typeBinding 独立
  runtimeKind: 'web-module/v1';
  modeId: string;
  allowedActions: string[];   // 内核推导，不信任页面自报
}
```

以上类型中的附加类型由 contracts/schema 定义，属于设计草图，不是可运行的 TS 实现。资源源版本是 opaque token；本地源建议对原始字节做摘要，包含 BOM/换行。contentHash 对规范化 LF 正文的 UTF-8 字节计算 SHA-256，不能替代资源重读。

格式插件负责 UTF-8/BOM/换行编解码；文本插件的 metadata 包含 encoding、bom、newline。混合换行只读，非法 Unicode、孤立代理项、NUL 拒绝；字节和正文上限由内核再检查。纯内存 text/v1 文档只提供基础文本事务，不因文件名结尾 .md/.txt 自动拥有对应类型。

同资源可打开多个独立 documentId，保留 Demo 语义；同一生成计划包含相同 resourceId 的多个目标缓冲区则返回 DUPLICATE_RESOURCE_TARGET。导入的同名文件独立、无资源保存权限。引用恢复产生新文档，不继承旧关注/聚焦/提案。

一个文档可有多个 ViewBinding，共享权威正文；不把 viewId 放进文件身份、脏状态或格式元数据。typeBinding 决定格式，viewBinding 决定页面；换视图不重新解码、不换保存编码器，也不因展示方式改变 scopeRevision。视图故障只撤销对应绑定，除非同包的无界面能力也故障。

## 3. 输入同步和写入租约

```ts
interface TextChange { start: number; end: number; insert: string; }
interface TextTransaction {
  documentId: string;
  leaseId: string;
  expectedVersion: number;
  clientTransactionId: string;
  intent: 'user-input';
  changes: TextChange[];
  undoGroupId?: string;
}
```

范围是 expectedVersion 正文中的 UTF-16 半开区间 `[start,end)`，允许 start=end 插入；必须有界、互不重叠、不切断代理对。相同位置的重复插入拒绝或先由 SDK 合并成一个 change，不能依赖不稳定排序。内核从后向前应用，返回新版本、变更映射和事件游标。

内核以文档为单位串行提交。SDK 可先在 UI 显示乐观输入，但同文档只有一个在途事务；后续队列基于乐观投影保存，收到确认后按返回映射重建并使用新版本发送。拒绝时暂停该文档队列，保留临时输入并显示差异，不能把旧全文覆盖到新版本。

写入租约由内核绑定主体/连接和 writerId，所有改变内容的命令包括 apply、undo、redo 和可能隐式应用的 save/prepare 都核对租约；普通读视图无写权限。同宿主多个视图也不共用 writerId；页面写入与 viewId 绑定，宿主全局操作通过该拥有者的输入协调器及租约执行。租约需要续期，失联过期后保留文档，旧 lease 不能重用；重新取得租约并重同步后才可处理保留输入。首期不自动抢占活跃租约，不做多人合并。

没有活跃输入拥有者时，获准的宿主保存/应用/撤销可申请短期 host-command 租约，完成后释放，不赋予阅读视图输入权限。有活跃拥有者则先协调，不能抢占；文档自身只读时内容修改仍拒绝。页面只读模式与文档访问权限分别判断，避免阅读模式阻断正常的宿主业务操作。

IME 组合文本暂留界面，结束时形成事务；保存/生成/关闭须等待组合结束和队列确认。SDK 本地未确认内容不属于内核已保存草稿，导航时需提示；突发断页可能丢失未提交队列，此限制必须可见。需跨刷新恢复这部分输入时单独设计本地恢复存储，不能偷偷把正文存进偏好。

切换插件视图/模式以及应用/撤销同样经过输入协调；prepareToLeave 回报 ready 后还需宿主验证队列和版本。切视图时先确认旧输入、新视图只读就绪，再交接租约；失败保留旧视图，不能以重挂载覆盖草稿。普通人工编辑不要求 Attention；自动命令/模型候选仍使用提案规则，不能伪装成 user-input。

undo/redo 由内核历史处理，编辑器禁用与其冲突的第二套权威历史；UI 可对尚未发出的临时队列做局部撤销，发出后用内核事务。内核可按受控 undoGroupId 合并连续人工输入，但不得跨提案应用或保存检查点吞并历史。

## 4. 保存与关闭

脏状态由当前内容与最后保存快照比较，版本递增不直接等于 dirty。保存捕获确认版本/快照，后续人工输入可继续，成功仅推进那次快照的保存基线；新输入仍 dirty。一个文档一个保存任务，内核对相同资源按 canonical identity 串行写。

创建、打开和导入时都建立初始基线快照；另以 source.kind 表示是否存在外部资源，不能用基线存在推导“已写入磁盘”。无改动的导入仍可导出，有改动的 memory/import 关闭时仍需处理脏状态。

保存：权限/插件代次检查 → 类型插件 encode → 内核大小/编码校验 → 资源插件 writeConditional → 平台端口再次校验授权/当前资源版本 → 临时写入与提交 → 返回新资源版本。类型/资源插件只能在本次授权调用内工作。失败保留内容和旧基线，禁止自动 force-save。

本地源仍需处理符号链接/junction/硬链接与路径别名、Windows 特殊路径、文件删除/替换、临时文件清理和权限变化。普通文件系统的重读加替换不能承诺防住所有同权限外部进程竞态；平台必须报告 conditional-write 的实际保证和限制，不宣称严格原子 CAS。

saveId 幂等先于旧版本校验，响应未知时先查询 operation 或复用同键；内核重启后去重记录不可假定存在，重新读资源比较。提交已开始不能简单 cancel 成功，须等待实际结果或标记 unknown 并核实。

close.prepare 返回 dirty/pending/任务状态和版本绑定票据；commit 时再次检查。关闭视图不关闭内核文档，显式关闭最后文档清理关注/聚焦并令提案过期，引用快照可保留。会话有未保存数据时内核不得仅因客户端断线自动销毁。宿主关进程仍是持久化前的硬边界。

views.close 只撤销对应通道、租约、订阅和临时 selection，不删除已创建的引用、关注或聚焦；documents.close.commit 成功后通知全部视图卸载。视图重连生成新绑定，旧页面的迟到调用拒绝。

导出返回 artifact，宿主下载只是 accepted，不等于已落盘，不推进原资源的保存基线；可单独记录 lastExportedSnapshotId。

## 5. 上下文与精确范围

- ReferenceSnapshot：添加时从内核文档版本生成不可变副本，来源关闭仍保留；更新须重建。
- Attention：绑定 documentId，只允许可编辑且具备能力的文档；移除后撤销应用资格，再加入不恢复旧提案。
- FocusGroup：focusId、documentId、snapshotId、version、role、ranges、instruction、scopeRevision。role 从内核能力派生，可编辑为 target、只读为 reference，不让 UI 自授权限。

临时 ValidatedSelection 是 snapshotId/version 上的精确源范围，不是上述持久上下文。selections.create 检查文档归属、范围、非重叠和 Unicode 边界，内核从快照提取原文；context.focus.create/update 接收 selectionId + instruction，或无 UI 客户端直接提交同等数据走同一校验。创建时仍核对当前版本与能力。

视图中的图形块/字段须映射到精确 text/v1 范围；显示标签、DOM 位置和渲染文本不构成源索引。过期或关闭视图后 selection 不能继续作为新修改聚焦的输入。FocusGroup 建立后持有自己的快照/范围，删除临时选区不影响它。局部高亮不自动增加 Attention；已有聚焦卡片的 reveal 只是定位，过期内容显示快照详情。

聚焦说明 trim 后非空且限 2,000 UTF-16 单位；每范围包含 rangeId、start、end、original，满足 `0 <= start < end <= content.length`。组内及同文档目标组间不重叠，原文切片一致，整文档版本/摘要有效。非连续范围间原文和空白逐字保留。过期后显示旧快照，不自动套新位置。空文档无虚假 focus。

版本变化使聚焦保守过期，即使 undo 后全文相同也不恢复授权。结构块由类型插件提供，内核验证有界、顺序、精确原文和全文覆盖；预览/分页不能改变索引语义。

全局 contextRevision 使待执行计划失效；逐文档 scopeRevision 在关注、权限、目标聚焦、类型绑定变化时递增。无关文档变更不必令已完成提案失效；只改请求或引用不改变已有提案，其依据仍是生成时快照。

## 6. 智能编辑上下文与执行计划

context.snapshot 按请求和现有引用/关注/聚焦生成 EditingContext 投影，包含版本水位、目标范围、说明和明确参考；不要求模型插件，不联网、不隐式应用 pending、不授权工具。首期上下文仍以 text/v1 快照和精确范围表达。

plans.prepare 输入含 expectedActivationRevision、请求、上下文选择 ID、候选 toolIds 白名单和 expected context/version 水位，内核从唯一激活槽读取模型，在输入协调及既有策略处理后读取自己的快照；不接受任意替代模型，也不让客户端上传 before 全文、editable 或自报批准范围。无激活模型时先返回 MODEL_NOT_ACTIVE，不触发 pending 隐式应用。通过发送确认的投影成为 ApprovedEditingContext。模型插件和工具仅获各自执行批准的内容，不能访问全库。

PreparedPlan 包含 planId、hash、目标 document/version/scope、rangeIds、快照引用、实际发送文本/说明、唯一激活的 modelProfileId/activationRevision/目的服务配置版本、所选工具 ID/schema 摘要/effect/readRequirement、各工具读/提案范围、使用到的插件绑定、总步骤/调用/字节预算和过期时间。confirmationId 绑定这些内容及工具结果可回传模型的数据流；相关正文/范围/工具/模型激活或配置/实际依赖插件代次变化都要重建。单纯切换页面或调序不改变已有绑定和冻结工具目录，prepare 不联网。

全局请求存在则选全部关注目标，有聚焦只改聚焦范围；只有聚焦说明则跳过无聚焦文档。只读聚焦作为参考并优先于显式引用快照；关注文档不会自动成为其他目标的参考。界面显示实际发送/未采用的内容。无聚焦整文档目标允许唯一 `[0,0)` 空文档插入范围。

一个 run 按目标文档建立独立 executionId，共用明确参考，默认串行；每个执行可有 model step → tool calls → model step 的多轮循环。内核只分派规范消息，真实模型通信/工具格式转换在模型插件，工具实现位于 tool/v1 贡献。一个执行的工具不能读取另一个目标的正文；要读全文须在计划中明确批准，不能由片段处理偷偷升级。

ToolCallRecord 记录 runId/executionId/toolCallId、工具 binding、参数摘要、状态、预算使用及结果引用。状态为 queued/running/completed/failed/cancelled；相同调用键不同参数拒绝，同请求去重，同一 run 的累计时限/预算不随 step 重置。结果对话记录属于内核任务数据，供后续 step 使用，不默认落日志或持久存储。

effect=propose 的工具结果只暂存 ToolCandidate，包含 candidateId、调用来源、baseVersion/baseScopeRevision、精确 edits 和内容摘要。它不是 pending 提案，不改正文、历史或 dirty。模型 complete 显式选择本执行 candidateIds，可另提供直接 edits；内核合并校验，重复/重叠范围拒绝，未选候选丢弃。所有候选都基于计划快照，前一步不会变成新的文档版本。

同 run 所有目标最终结果通过再发布提案，一个失败不发布部分可应用结果。不同文档任务可并行但有限额，同文档只一个活动任务。内核直接观察文档变化并取消/过期相关 run；权限撤销后不再向插件交正文结果，迟到结果不发布，不用 UI 通知作为唯一防线。

状态为 prepared → running → validating → completed，另有 failed/cancelled/expired 终态；running 中的 model/tools 是步骤阶段。流式文本只作进度，每 step 必须以 tool-calls 或 complete 唯一终结，完整最终候选通过才可审查。用户重试建新计划；不因断线自动重调可能计费的服务。

## 7. 提案、差异、应用

模型 complete 包含 message、选用的 candidateIds 和直接 `{documentId,rangeId,replacement}` 数组，内核将它们归并为同一种候选结构。候选 ID 必须属于本 execution 的已验证暂存结果。内核取计划中的 start/end，拒绝未知目标/范围、重复替换、超限、非法文本和未知结构字段；replacement 内像命令的内容也只是文档文字，不执行。

未返回范围视为不改；空 replacement 删除该已授权范围。倒序替换构造 after，范围外原文不变；非连续合并可在首范围写合并文本、其余所选范围写空串，不能删除中间未选内容。before=after 不建 pending。

ChangeProposal 由内核生成，含 proposalId、runId、executionId、documentId、baseVersion、baseScopeRevision、before/after 快照、edits、使用的模型/工具插件绑定和候选来源、status/reason。每文档最多一个 pending，状态为 pending/applied/discarded/expired。

proposals.apply 校验租约、身份、文档仍打开可编辑且关注、版本/范围版本、before 一致、保存状态及依赖能力有效，再执行内核事务。compare 返回完整行级左右差异和位置映射，宿主不重写比较逻辑。应用不保存，撤销生成新版本，不复活旧提案。

accept-on-next-action 是内核策略：实际输入、save 或新生成前处理旧 pending；切换视图、查看比较、改请求不触发。隐式应用和人工输入的两步事务需用安全位置映射，含糊则整体拒绝并保留输入；详见 kernel-api.md。explicit-only 可后续提供，不暗改 Demo 默认。

## 8. 插件绑定与缓存

文档、视图、分块、预览、计划、工具调用/候选、提案都记录实际使用的 binding/generation。类型/资源/模型/工具绑定属于相应业务依赖；纯视图绑定不是模型计划或提案的必备依赖，换页面不自动使其失效。同包整体升级改变了业务依赖时仍按原规则过期。插件失效使相关派生能力不可用、冻结操作，不能把同名新版的输出当旧结果。停用/升级按占用处理，非正文派生数据可重新计算，但不能悄悄重新 decode 草稿。

正文在内核，故插件崩溃不丢文档。Host SDK 的投影不是第二个源；事件重连采用 snapshot+cursor，一旦 gap 重取，不用客户端旧正文恢复覆盖内核。错误信息和事件正文受同会话访问控制。

## 9. 限额与隐私

首期建议初值，须在实施时验证，不是已交付性能指标：单文件 2 MiB；单目标模拟前后 40,000 UTF-16 单位/400 行；聚焦结构每页 200 块；计划去重快照 4 MiB；单计划 8 目标、全局 2 活动 run；准备计划 5 分钟、执行总时限 120 秒；事件 replay 每会话 1 MiB；内核正文/历史/提案缓存建议 64 MiB。模型 token、输出、插件 CPU/时间及预览树还需单独限额。

限额必须统计正文、undo、引用、before/after、计划、插件结果和事件，不只算 HTTP 字节。共享不可变快照按引用计数回收；脏缓冲区、pending 和已承诺历史不得静默删除，达到限额拒绝新操作并提示用户处理。会话持有脏文档时不可因缓存 TTL 删除。

偏好和插件非敏感配置可存本地，正文/会话历史默认内存；可选持久恢复另设开关、格式迁移、保留期和清理。凭据用宿主安全存储或会话内存，无明文回退。默认日志仅 ID/计数/耗时/错误，正文、提示词、路径、凭据不得落日志。

工具描述/schema、参数、结果、候选和 transcript 同样计入总内存与发送预算；步骤数、调用数、结果字节和执行时限必须有界，不能靠拆成多轮绕过限制。未选候选按终态回收，已发布提案保留自身 before/after 和来源，不依赖工具处理器继续存活。

## 10. 契约验收

无 DOM 客户端与网页/嵌入宿主完成同一事务序列；覆盖乱序/重复响应、丢失响应、event gap、租约过期、IME、保存中输入、插件故障/升级、同名导入、同资源双缓冲区、undo 后版本、非连续聚焦、旧模型结果、取消、资源冲突与内存限额。新增视图/选区越权、同连接多视图单写、切换失败与队列排空、关闭视图不删除上下文、视图绑定不误使业务计划过期的验收。当前 Demo 的测试基线只是迁移依据，不是这些新契约已实现的证据。

模型/工具另测无模型上下文查询、已批准片段边界、多目标执行隔离、schema/effect 校验、候选暂存/选择/冲突、去重、预算、native/emulated/none 能力不匹配及取消/升级失效。模拟器测试和真实服务连接验收分别报告。

激活/路由另测实例内唯一模型、跨客户端并发 set/start、旧激活水位、活动任务切换拒绝、多插件同时启用、泛化与精确处理顺序、停用后继、错误不静默降级、并发调序、既有文档/提案不被重绑，以及同包多贡献仍需唯一选择。
