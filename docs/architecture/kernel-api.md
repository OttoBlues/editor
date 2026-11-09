# Kernel API v1 草案

状态：**设计中，尚未实现**。依据 [架构总览](README.md)。这是宿主调用内核的统一业务契约；HTTP、IPC 和进程内调用只是传输适配。数据细节见 [数据契约](contracts.md)，插件侧接口见 [插件协议](plugin-system.md)。

## 1. 内核入口与身份

```ts
interface Kernel {
  execute(request: KernelRequest, caller: CallerContext): Promise<KernelResponse>;
  subscribe(input: Subscription, caller: CallerContext): AsyncIterable<KernelEvent>;
  dispose(input: ShutdownRequest, caller: CallerContext): Promise<ShutdownResult>;
}

interface KernelRequest {
  apiVersion: '1';
  requestId: string;
  sessionId: string;
  method: string;
  params: unknown;
  idempotencyKey?: string;
}

type KernelResponse =
  | { requestId: string; ok: true; result: unknown; eventCursor: string }
  | { requestId: string; ok: false; error: KernelError };

interface KernelError {
  code: string;
  messageKey: string;
  retryable: boolean;
  details: Record<string, unknown>;
}
```

这是本项目的命令封装，不声称兼容某个既有 RPC 协议。每个 method 必须有注册的输入、输出、错误和副作用 schema，未知方法/字段拒绝。禁止批量写操作在没有明确事务语义时混在一个请求。字节制品通过 artifactId 和受限二进制通道传递，不把任意函数、对象句柄或可执行字符串放入 DTO。

CallerContext 由可信传输适配器根据连接身份注入，包含 connectionId、principalId、角色和授权集合，**不取自请求参数**。角色为 host-admin、interactive-client、plugin-service；插件不能调用宿主授权/确认方法。sessionId 也是隔离边界，必须核对所属主体。进程内调用仍使用绑定到主体的 façade，不把原始 execute 和管理员上下文交给插件。

`kernel.describe` 和 `sessions.create/resume` 是建会话例外，使用连接认证上下文、无需已有 sessionId；其独立 request schema 明确省略该字段。dispose 为宿主管理入口，不能由普通 UI 或插件直接调用；有脏文档时须返回清单并由宿主显式处理。

## 2. 方法目录

Q 表示查询，C 表示变更命令，J 表示创建异步任务。所有业务变更只在内核执行；权限、版本前置条件、能力检查是方法自身的规则，各宿主不得另做一套。

| 方法 | 类别 | 输入与结果要点 |
| --- | --- | --- |
| kernel.describe | Q | API 版本、支持的数据模型、有效限额、插件 SDK 范围、宿主能力 |
| sessions.create / resume / snapshot | C/Q | 新建或恢复会话、返回状态投影和事件游标；恢复凭证与连接身份绑定 |
| sessions.close.prepare / commit | C | 返回脏文档/活动任务清单及票据，再确认保存或丢弃；关闭不隐式持久化 |
| plugins.list / describe | Q | 已安装包、启用状态、版本、权限和贡献清单 |
| plugins.install / enable | C/J | 仅 host-admin；包引用来自可信宿主加载器，缺权限先返回确认要求 |
| plugins.disable.prepare / commit、plugins.upgrade.prepare / commit、plugins.remove.prepare / commit | C/J | 列出占用和影响，绑定确认后执行生命周期变更 |
| capabilities.list / resolve | Q | 有效贡献及指定操作的候选；多个匹配时要求显式选择 |
| workspaces.attach / detach | C | host-admin 提交 Host Ports 签发的资源授权凭证，返回工作区；不接受任意绝对路径 |
| workspaces.list / resources.list | Q | 已授权资源源、目录游标、资源 ID 与元数据；不自动读取全部正文 |
| documents.create | C | 显式创建内存 text/v1 文档；零插件可用，不识别文件扩展名 |
| documents.open | C | resourceId、选择的 document-type contribution、复用或新开缓冲区意图 |
| documents.import | C | 宿主已提交的 artifactId、文件元数据、选择的类型贡献；不获得覆盖原文件权限 |
| documents.get / snapshot | Q | 返回权威文档及版本或指定不可变快照，按会话/文档授权 |
| documents.write.acquire / renew / release | C | 取得/续期/释放写入租约；不得无提示抢占另一个活跃写入者 |
| documents.detach.prepare / commit | C | 保留正文，转为无类型绑定内存文档，撤销原格式保存能力 |
| documents.transact | C | leaseId、expectedVersion、变更列表、输入意图、事务 ID，返回新版本/变更映射 |
| documents.undo / redo | C | 内核历史事务、当前租约及版本；改变内容仍递增版本 |
| documents.blocks / preview | Q | snapshotId、类型贡献、分页参数；返回经校验的范围或 PreviewTree/v1 |
| documents.save | J | documentId、expectedVersion、saveId；内核编码并向原资源源保存，返回 operationId |
| documents.export | J | 指定快照和编码能力，生成有界制品，不默认覆盖导入来源 |
| documents.close.prepare / commit | C | 版本绑定的关闭计划；有 pending/dirty/活动保存时不得静默关闭 |
| context.references.add / remove / list | C/Q | 从内核快照生成独立只读引用；来源关闭不删除引用 |
| context.attention.add / remove / list | C/Q | 关注必须可编辑、支持该能力；移除撤销相关应用资格 |
| context.focus.create / update / remove / list | C/Q | 快照、多个精确范围、共同说明；角色由内核派生 |
| models.list / configure / remove | Q/C | 已启用模型插件的配置 schema、实例配置和版本；不含密钥 |
| credentials.set / clear / status | C/Q | 只设置/清理/查询存在状态，无读取密钥 API；绑定模型实例及端点 |
| plans.prepare / get / cancel | C/Q | 从内核已有上下文建立最终发送清单；prepare 不联网 |
| runs.start / get / cancel | J/Q/C | 执行经确认的冻结计划，返回 runId；取消是终止意图 |
| proposals.list / get / compare | Q | 完整 before/after、状态、范围与差异数据 |
| proposals.apply / discard | C | expectedVersion、scopeRevision、proposalId；应用只进缓冲区 |
| operations.get / cancel | Q/C | 查询保存/导出/生命周期任务；进入资源提交点后可拒绝取消 |
| commands.list / prepare / execute | Q/C/J | 命名空间插件命令，由内核解析、校验权限并审查输出 |
| settings.describe / get / update | Q/C | 内核策略和插件配置 schema；语言/窗口几何等 UI 偏好留宿主 |
| artifacts.upload / read / release | C/Q | 按会话限额传递导入/导出字节，校验长度、摘要、TTL |
| effects.get / complete | Q/C | 宿主完成下载/对话框等效果后回报状态，不等于业务审批授权 |

除显式列出的 host-admin 方法外，互动业务方法必须检验 interactive-client 的会话、文档/资源权限；plugin-service 只持 Plugin SDK 中单次操作的窄权限，不因方法存在而可调用。资源写入只能从 documents.save 或经审查的内核写入流程进入。

plugins.enable 遇到未授予的权限时返回权限清单和 confirmationId；host-admin 经用户授权后携票据重试，不能用 interactive-client 自报权限替代。API 线上主版本为 1，kernel.describe 另返回完整契约语义版本和特性集合；插件 manifest 的兼容范围针对完整版本，同主版本只能作向后兼容增加。

## 3. 变更、版本、幂等

内核串行处理同文档命令，避免 check 与 apply 分成两个可穿插操作。每个 C/J 方法在目录里声明是否需要 idempotencyKey；凡会改内容、创建任务、确认授权或改变插件生命周期的命令必须提供。查询不需要。

去重键范围为 kernelInstanceId + principalId + sessionId + method + idempotencyKey，记录请求语义摘要和结果；**先查去重记录，再校验旧 expectedVersion**，否则丢失响应后的合法重试会被当作旧版本错误。相同键不同参数返回 IDEMPOTENCY_MISMATCH。记录过期时返回明确状态，客户端查询当前结果，不能假定命令没有发生。

返回事件游标是已提交变更的水位。响应和事件可先后到达，SDK 按事务 ID/版本去重，不重复应用同一变更。失败不得悄悄执行部分正文变更；跨文档操作逐文档报告，不承诺分布式或跨文件事务。

## 4. 确认是内核协议的一部分

确认由内核 prepare 生成 `{confirmationId, operation, resourceVersions, summary, expiresAt}`，绑定发起主体、会话、精确内容和操作。宿主展示 summary，用户操作后携票据 commit/start；内核再次核对版本与授权。票据一次使用，重复请求由幂等层返回原结果。不能提交客户端自造的 approved 布尔值。

发送模型、丢弃脏文档、影响文档的插件禁用/升级等操作使用这一模式。非敏感可逆命令按已确认策略执行，不对每个按键弹确认。修改计划、端点、插件代次或来源版本使旧票据失效。

插件只能返回建议操作/状态，不能获取用户确认票据。可信互动宿主代表用户传达操作，内核不能靠票据证明真实人点击过按钮；这是应用信任边界，不宣称可以防住已被攻陷的宿主。

## 5. 输入与隐式应用

输入端提交基于最近确认版本的 text/v1 变更，按文档顺序发送，IME 组合期间可暂存在 UI。保存/生成/关闭必须先结束或等待组合输入并排空队列；不能忽略暂存文本继续操作。具体事务形状见 contracts.md。

在 accept-on-next-action 模式下，存在 pending 时，内核接收 `documents.transact` 的 user-input 意图：先验证旧提案，再映射用户原始编辑位置，分别提交“应用提案”和“人工输入”两个可撤销事务；外部观察者只看到一致的最终批次。映射含糊或跨越改写范围无法安全确定时，返回 INPUT_REBASE_REQUIRED，不改任一内容，宿主保留输入供处理。

保存以及新生成前的隐式应用也由内核执行，显式记录接受原因；应用通过而后续磁盘保存失败时保留已应用的脏缓冲区并报告保存失败。不可将两个阶段描述成原子磁盘事务。只看差异或切换视图不会发送 user-input 意图。

## 6. 事件与状态恢复

```ts
interface KernelEvent {
  kernelInstanceId: string;
  sessionId: string;
  seq: number;
  eventId: string;
  causeRequestId?: string;
  type: string;
  entityId?: string;
  entityVersion?: number;
  payload: unknown;
}
```

事件覆盖 session、plugin、capability、document、context、proposal、run、operation 和 host-effect。领域事件由内核生成；插件只能返回原始进度/结果，不能自行宣告 document.changed 或 proposal.applied。预览/流式正文也受原会话访问控制。

状态快照携带同一提交水位 seq，订阅从该游标继续，避免“先读快照再订阅”丢事件。有限 replay；游标过期返回 EVENT_GAP，SDK 重新取得快照后恢复投影，**不因此重发修改或模型请求**。新 kernelInstanceId 表示内核重启，旧 ID、票据、租约全部失效。

慢订阅者有有界队列；不能无限占内存或拖慢文档命令。超限后断开该订阅并要求重同步。取消后的迟到结果按任务终态丢弃。UI 失联和用户关闭会话是不同事件，前者不删除文档。

## 7. 传输与宿主效果

| 适配器 | 映射方式 | 必须保留的语义 |
| --- | --- | --- |
| 进程内 | SDK 调绑定主体的 façade | schema、授权、版本、幂等，与远程相同 |
| HTTP | POST /kernel/v1/commands；GET /kernel/v1/events；制品单独有界上传/下载 | 同源令牌、Host/Origin、请求限额、事件游标；token 不进 URL |
| IPC | 命令/响应/事件消息 | 主体和通道绑定、版本握手、断线和重复消息 |
| 嵌入消息桥 | 握手后绑定的 MessagePort 或宿主 RPC | 校验来源/源窗口与消息结构，不使用任意目标广播凭据 |

HTTP 认证在路由前完成：未认证 401/403，传输过大 413；通过传输层的命令使用统一 KernelResponse，包括业务失败，SDK 只按 error.code 判断。旧 Demo API 仅在迁移兼容层转换到同一 Kernel API，不再独立写业务。

导入或内存文档的“保存副本”调用 documents.export；若该动作需要按兼容策略接受旧提案，export 命令带 user-save 意图并由内核先校验/应用后捕获快照；单纯导出指定历史 snapshotId 不触发应用。无类型编码能力时不能声称生成原文件格式，只能经 documents.get 取回内存正文。

内核不直接弹窗、访问 clipboard 或点击下载。它返回/发布结构化 host-effect，宿主完成并用 effects.complete 反馈 accepted/completed/failed/unknown；浏览器只能确认下载已发起时报告 accepted，不能标记磁盘保存完成。文件源的真实保存由 Resource.write.commit 端口返回最终版本，不经过 UI 假确认。

## 8. 首期错误与降级

首期必须定义：METHOD_NOT_FOUND、API_VERSION_UNSUPPORTED、SESSION_INVALID、PERMISSION_DENIED、CAPABILITY_UNAVAILABLE、CAPABILITY_AMBIGUOUS、PLUGIN_VERSION_UNSUPPORTED、PLUGIN_BUSY、PLUGIN_FAULTED、PLUGIN_CHANGED、DOCUMENT_VERSION_CONFLICT、WRITE_LEASE_REQUIRED、INPUT_REBASE_REQUIRED、STALE_FOCUS、STALE_PROPOSAL、RESOURCE_CONFLICT、DUPLICATE_RESOURCE_TARGET、CONFIRMATION_REQUIRED、CONFIRMATION_EXPIRED、IDEMPOTENCY_MISMATCH、EVENT_GAP、LIMIT_EXCEEDED、INVALID_PLUGIN_OUTPUT、INVALID_MODEL_OUTPUT、UNSUPPORTED_EXECUTION_MODE。

messageKey 给宿主本地化，details 只放白名单 ID、版本、限制，不含原文、凭据、绝对路径或未过滤外部错误。无插件/缺平台端口是一等状态，不能用隐式实现填补。

## 9. Host Ports 最小契约

Host Ports 是内核调用宿主机制的方向，与宿主调用 Kernel API 相反；插件只拿本次调用的缩小版代理。原始平台端口只在启动装配阶段注入，不暴露给网页或插件。接口不传 Node FileHandle、DOM File、绝对路径等宿主对象；用 bytes、opaque 句柄和 schema 定义的数据。

| 端口 | 方法草案 | 返回与权限边界 |
| --- | --- | --- |
| Runtime | clock.now、ids.random、digest.sha256、scheduler.schedule/cancel | 无正文持久化；计时器可注入虚拟时间测试，摘要算法/编码固定 |
| Resource | grant.validate、entries.list、bytes.read、write.prepare/commit/abort、revision.get；watch 可选 | Host 授权凭证由可信选择器/启动配置签发，限主体/根/操作；commit 只接受内核签发且绑定资源版本与字节摘要的一次写票据 |
| Network | request.execute/abort | 只执行已批准配置的端点/方法/限额，绑定计划与操作；解析地址/重定向复核 |
| Credential | put、delete、has、authenticatedRequest | 无返回密钥的 get；鉴权注入绑定确定端点与模型实例，不跨站转发 |
| PluginLoader | inspect、load、unload | inspect 不执行代码；返回包摘要/manifest；load 仅启用阶段通过执行策略调用 |
| PluginExecutionHost | activate、invoke、cancel、deactivate | 受控进度/结果消息，代次和截止时间；trusted-code 不保证抢占或隔离 |
| Persistence（可选） | read、writeAtomic、remove | 首期仅获准的非敏感配置；正文恢复需另启用和定义 schema |

资源插件负责将自己的资源标识映射到被批准的端口操作，内核统一审批并签发写票据；类型插件 encode 的返回值不会自行拥有写权限。无法提供上述某端口的宿主如实声明缺失；依赖该端口的插件不能启用，不能无提示改用宿主全局 API。

内部 operation cancellation 不承诺停止已开始的不可逆资源提交；端口返回 committed/rejected/unknown 等可验证结果，内核决定 UI 状态。平台能力与信任模式是 kernel.describe 的一部分，移植时必须测它们的实际语义。

## 10. 接口完成标准

所有目录方法有 schema、权限声明、错误集合和一致性测试；零插件启动、类型/来源/模型分开装配、无 DOM 完整工作流均通过。至少在网页和一个极简嵌入测试宿主中用同一 SDK 验证打开、编辑、聚焦、模拟、应用、撤销、保存与冲突，第二宿主不能包含重复业务逻辑。
