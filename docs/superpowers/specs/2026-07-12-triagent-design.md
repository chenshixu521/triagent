# TriAgent 产品设计

日期：2026-07-12  
状态：已通过独立规格审查，等待用户最终复核

## 1. 产品概述

TriAgent 是一个面向 Windows 终端的多 AI 编程协作编排器。用户在同一个全屏 TUI 中启动并管理 Codex CLI、Claude Code 和 Grok CLI，由用户为每个任务动态指定主控、实现者和审查者。

默认协作流程为：

1. 主控分析需求并生成实施计划。
2. 根据任务设置，等待用户确认计划或自动继续。
3. 实现者修改项目文件并执行验证。
4. 审查者根据需求、计划和任务专属 diff 独立审查。
5. 主控综合实际文件、验证结果和审查意见完成最终验收。
6. 验收失败时，将具体问题退回原实现者返工。
7. 最多自动返工 3 轮，超过后暂停并等待用户处理。

## 2. 目标

- 在一个终端界面中统一管理三个外部 AI CLI。
- 允许用户为每个任务手动指定主控、实现者和审查者。
- 自动完成规划、实现、独立审查、最终验收和返工闭环。
- 实时显示各 Agent 的输出、当前阶段、文件变化和审查轮次。
- 支持暂停、继续、终止及运行期间追加要求。
- 支持 Git 仓库和普通目录。
- 使用 SQLite 保存任务、日志、会话、审查和恢复信息。
- 首版优先支持 Windows 10/11 与 PowerShell，并为跨平台适配保留接口。

## 3. 非目标

首版不负责：

- 安装 Codex、Claude Code 或 Grok CLI。
- 完成三个 CLI 的登录和凭据管理。
- 保存 API Key、Token、密码或外部 AI 登录凭据。
- 自动执行 git commit、reset、checkout、clean 或向远程仓库推送。
- 提供操作系统级的绝对文件系统隔离。
- 可靠判定任务运行期间每一次文件写入究竟来自 Agent、用户、IDE 还是其他进程。
- 关闭 TUI 后继续在后台运行任务。
- 同时让两个实现者并行修改同一项目。
- 自动决定三个 AI 的角色分配。

## 4. 用户已确认的产品决策

| 项目 | 决策 |
| --- | --- |
| 界面 | 同一终端中的全屏 TUI |
| 角色 | 每个任务由用户手动选择主控、实现者、审查者 |
| 默认流程 | 主控规划 -> 实现者编码 -> 审查者独立审查 -> 主控验收 |
| 技术栈 | TypeScript + Node.js |
| 数据存储 | 本地 SQLite |
| 权限 | 对经过 Adapter 能力验证的项目内操作自动批准；整体属于 best-effort 项目护栏，不是安全沙箱 |
| 项目类型 | Git 仓库和普通目录均支持，普通目录显示风险提示 |
| 启动方式 | 全局安装后运行 `triagent` |
| 计划确认 | 创建任务时可选，默认需要确认 |
| 自动返工 | 最多 3 轮 |
| 人工介入 | 支持暂停、继续、终止和追加要求 |
| 平台 | 首版 Windows 10/11 + PowerShell，预留跨平台接口 |
| 资源限制 | 默认总任务运行预算 60 分钟；最大外部调用次数和单次调用超时分别配置 |
| 安装认证 | 仅检测，不负责安装或登录 |
| 隔离强度 | 工具级项目目录约束，不使用 Docker |

## 5. 总体架构

采用 TUI 主进程加独立 Agent Worker：

```text
TriAgent TUI 主进程
├── Workflow Engine
├── SQLite Repository
├── Project Guard / File Tracker
├── Codex Worker  -> Codex CLI
├── Claude Worker -> Claude CLI
└── Grok Worker   -> Grok CLI
```

TUI 主进程负责界面、状态机、持久化和用户操作。每个外部 AI 由独立 Worker 管理，防止单个 CLI 的异常输出、崩溃或超时导致整个应用退出。

Worker 可以是 Node.js Worker Thread 或独立 Node.js 子进程。实施阶段优先选择独立 Node.js 子进程，因为它能提供更明确的故障和生命周期隔离。

首个可用版本同时只运行一个活动任务。历史任务可以有多个，但任何 canonical project root 及其父子重叠路径只能持有一个活动锁。

## 6. 核心模块

```text
src/
├── cli/                 # triagent 命令入口和参数
├── tui/                 # Ink/React 终端界面
│   ├── screens/
│   ├── components/
│   └── keyboard/
├── workflow/            # 任务状态机、返工循环、人工确认
├── agents/
│   ├── codex-adapter.ts
│   ├── claude-adapter.ts
│   ├── grok-adapter.ts
│   └── agent-adapter.ts
├── process/             # 子进程、流式输出、超时和终止
├── protocol/            # 提示词和结构化结果协议
├── project/             # 项目检测、路径约束和环境检查
├── tracking/            # 文件监听、快照和 diff
├── persistence/         # SQLite、日志和任务恢复
└── review/              # 审查结果、验收和返工请求
```

建议技术：

- TUI：Ink + React。
- SQLite：Node.js 24 内置 `node:sqlite`。
- 进程管理：Node.js `child_process.spawn`。
- 文件监听：Chokidar。
- 状态管理：项目内部实现的强类型状态机。
- 原始日志：JSONL。

第三方库的具体版本和 API 必须在实施前查询当前官方文档并锁定。

## 7. 工作流状态机

核心状态包括：

- `draft`
- `checking_environment`
- `planning`
- `awaiting_plan_approval`
- `implementing`
- `reviewing`
- `master_validation`
- `rework_requested`
- `paused_after_run`
- `interrupting`
- `interrupted_needs_inspection`
- `cleanup_failed`
- `awaiting_user`
- `completed`
- `cancelled`
- `failed`

关键转换表：

| 当前状态 | 事件/条件 | 副作用 | 下一状态 |
| --- | --- | --- | --- |
| `draft` | 用户启动任务 | 写入启动 intent 并尝试获取项目锁 | `checking_environment` |
| `checking_environment` | CLI、权限和项目检查通过 | 建立需求版本与任务基线 | `planning` |
| `checking_environment` | 检查失败 | 保存诊断 | `awaiting_user` |
| `planning` | 计划生成且要求确认 | 保存计划版本 | `awaiting_plan_approval` |
| `planning` | 计划生成且无需确认 | 建立实现 attempt 基线 | `implementing` |
| `awaiting_plan_approval` | 用户批准 | 建立实现 attempt 基线 | `implementing` |
| `awaiting_plan_approval` | 用户要求修改 | 增加需求版本，废弃旧计划 | `planning` |
| `awaiting_plan_approval` | 用户取消 | 释放项目锁 | `cancelled` |
| `implementing` | 实现调用成功且文件状态一致 | 固化 attempt 结果和 diff | `reviewing` |
| `implementing` | 进程失败或超时 | 保存现场并重扫任务窗口变化 | `interrupted_needs_inspection` |
| `reviewing` | 只读审查完成且审查基线未变化 | 保存审查报告 | `master_validation` |
| `reviewing` | 审查期间检测到写入或基线变化 | 作废本轮审查 | `awaiting_user` |
| `master_validation` | 验收通过 | 固化最终证据并释放锁 | `completed` |
| `master_validation` | 验收不通过且返工次数未达上限 | 保存具体返工请求 | `rework_requested` |
| `master_validation` | 验收不通过且已达上限 | 保存未解决问题 | `awaiting_user` |
| `rework_requested` | 返工上下文已持久化 | 建立新 attempt 基线 | `implementing` |
| 任意可运行状态 | 用户选择“本次执行结束后暂停” | 设置 `pause_after_attempt`；当前 attempt 结果持久化后保存其正常后继状态 | 当前 attempt 结束后进入 `paused_after_run` |
| `paused_after_run` | 用户继续 | 读取 `resume_target_state` | 正常后继状态 |
| 任意执行中状态 | 用户要求中断 | 写入停止 intent，启动协作式停止 | `interrupting` |
| `interrupting` | 进程树确认结束且 stop intent 为中断 | 重扫文件并保存现场 | `interrupted_needs_inspection` |
| `interrupting` | 进程树确认结束且 stop intent 为取消 | 重扫文件、固化取消记录并释放锁 | `cancelled` |
| `interrupting` | 进程树无法确认结束 | 保留项目锁并阻止退出 | `cleanup_failed` |
| `interrupted_needs_inspection` | 用户确认继续 | 建立新 attempt，不重放未确认副作用 | 对应执行状态 |

`resume_target_state` 保存当前 attempt 已完成并持久化之后的正常后继状态。例如实现已完成时暂停，继续后进入 `reviewing`，不得再次进入 `implementing`。

异常和人工操作转换：

| 场景/操作 | 处理 | 下一状态 |
| --- | --- | --- |
| 项目锁获取失败 | 显示冲突任务和 canonical path | `awaiting_user` |
| planning、reviewing 或 master 调用失败 | 保存 attempt、日志和可用重试动作 | `awaiting_user` |
| `A` 批准计划 | 仅在 `awaiting_plan_approval` 有效 | `implementing` |
| `R` 手动返工 | 仅在已有可审查结果且无活动进程时有效，增加返工计数 | `rework_requested` |
| `Q` 取消且无活动进程 | 释放项目锁 | `cancelled` |
| `Q` 取消且存在活动进程 | 写入取消 intent 并清理进程树 | `interrupting`；清理完成后 `cancelled` |
| `interrupted_needs_inspection` 选择继续 | 用户确认现场后建立新 attempt | 对应执行状态 |
| `interrupted_needs_inspection` 选择仅查看 | 保留锁和现场，不启动副作用 | `awaiting_user` |
| `interrupted_needs_inspection` 选择终止 | 无活动进程后释放锁 | `cancelled` |
| `awaiting_user` 解决环境/能力问题 | 重新执行健康检查 | `checking_environment` |
| `awaiting_user` 解决文件现场问题 | 建立新基线或取消任务，必须由用户选择 | 对应安全状态或 `cancelled` |
| `cleanup_failed` | 重新尝试清理并确认全部后代退出 | 成功后 `interrupted_needs_inspection`，失败则保持原状态 |

`awaiting_user` 必须记录原因和允许的恢复动作。所有终态禁止继续转换，除非用户显式创建派生任务。实现阶段不得自行猜测未在表中定义的转换。

应用重启时不能只恢复最后一个状态值，而要执行 reconcile：检查最后一个 pending action、run attempt、进程身份、文件基线和外部对话会话，再决定安全的恢复状态。

## 8. Agent 角色

### 8.1 主控

- 理解用户需求。
- 生成结构化计划和验收标准。
- 将计划传递给实现者。
- 接收实现结果、任务专属 diff 和审查意见。
- 亲自完成最终验收。
- 决定通过、返工或暂停等待用户。

### 8.2 实现者

- 只在指定项目范围内修改文件。
- 遵循主控计划和项目规范。
- 不主动提交代码。
- 执行与任务相关的测试、lint 或构建。
- 返回修改文件、执行命令、验证结果和遗留风险。

### 8.3 审查者

- 不参与本轮实现。
- 根据原始需求、确认后的计划、验收标准和任务专属 diff 独立审查。
- 输出具体文件位置、问题原因、严重程度、预期行为和验证建议。
- 不修改项目文件，除非用户在未来版本中明确启用该模式。

## 9. Agent Adapter 与执行模型

统一接口示意：

```ts
interface AgentAdapter {
  readonly kind: 'codex' | 'claude' | 'grok';
  checkAvailability(): Promise<AgentHealth>;
  discoverCapabilities(): Promise<AgentCapabilities>;
  start(request: AgentRequest): Promise<ExecutionHandle>;
  resume(conversationId: string, request: AgentRequest): Promise<ExecutionHandle>;
  parseEvent(line: string): AgentEvent | null;
}
```

必须区分三个对象：

- `ConversationSession`：外部 AI 的可恢复对话，包含 `conversationId` 和能力信息。
- `RunAttempt`：一次本地进程调用，包含 `attemptId`、PID、进程启动时间、角色、需求版本、基线 ID、开始/结束时间和退出原因。
- `ExecutionHandle`：提供 `events()`、`sendMessage()`、`requestStop()`、`forceKillTree()` 和 `wait()`。

所有事件、消息、命令证据、文件变化和审查结果都关联 `attemptId`，不能只关联外部会话 ID。停止操作针对 `RunAttempt`，恢复操作针对 `ConversationSession`。

`AgentCapabilities` 用来表达 CLI 差异，例如：

- 是否支持固定会话 ID。
- 是否支持恢复会话。
- 是否支持流式 JSON。
- 是否支持运行中输入。
- 是否支持原生 sandbox 或权限规则。
- 是否支持成本、轮次或时间限制。

运行中消息具有递增序号和 `queued / delivered / acknowledged / applied / failed` 状态。只有 Adapter 明确验证支持实时输入时才向当前执行发送；否则默认排队到当前 attempt 完成后的下一个安全点。不能为了发送普通追加要求而默认终止当前进程。

只有 Adapter 明确支持“可恢复中断”时，才允许终止后恢复同一对话。不支持恢复时必须启动新对话，并注入经过持久化的完整上下文。追加要求若改变需求、计划或验收标准，则增加 `requirement_version`，返回 `planning`，并使旧审查结果失效。

每个 Adapter 都必须维护经过测试的兼容矩阵：CLI 版本、版本检测命令、无副作用认证检查、流式格式、会话恢复、实时输入、权限模式和限制参数。能力探测失败时禁用对应功能，不能乐观假设支持。

## 10. 提示词和结构化协议

每次调用应包含：

- 用户原始需求。
- 当前 Agent 角色。
- 已确认计划和验收标准。
- 项目绝对路径。
- 允许和禁止的操作范围。
- 项目规范摘要。
- 当前返工轮次。
- 上一轮结果或审查意见。
- 必须返回的结构化结果格式。

标准化结果示意：

```json
{
  "status": "completed",
  "summary": "完成了什么",
  "changedFiles": ["src/example.ts"],
  "commandsRun": ["npm test"],
  "verification": {
    "passed": true,
    "details": "全部测试通过"
  },
  "issues": [],
  "nextAction": "review"
}
```

原始流式输出始终保存，结构化结果仅用于自动化决策。结构化结果解析失败时，工作流不得猜测成功，而应尝试一次格式修复请求；仍失败则进入 `awaiting_user` 或由主控基于原始输出重新判断。

Agent 自报不是事实来源：

- `changedFiles` 由任务基线计算。
- 命令和退出码由进程监督器记录。
- 验证结果必须引用真实命令、退出码、时间和日志位置。
- 缺少可验证证据时，主控不得直接判定通过。

UI 渲染外部输出前必须过滤危险 ANSI/OSC 控制序列、限制单行长度和输出速率。原始日志和安全显示文本分离保存。

## 11. TUI 设计

主运行页面：

```text
┌ TriAgent ─ Task #18 ─ RUNNING ─ 00:12:46 ─ Retry 1/3 ┐
│ Project: D:\codex\project\demo                        │
│ Roles: Master=Codex  Implementer=Claude  Reviewer=Grok│
├──────────────┬─────────────────────────────────────────┤
│ 工作流       │ 当前 Agent 实时输出                    │
│ ✓ 环境检查   │ Claude: 正在修改 src/server.ts         │
│ ✓ 生成计划   │ Claude: 执行 npm test                  │
│ ✓ 用户确认   │ Claude: 发现 1 个测试失败              │
│ ● 实现代码   │ ...                                     │
│ ○ 独立审查   │                                         │
│ ○ 最终验收   │                                         │
├──────────────┴─────────────────────────────────────────┤
│ Changed: 4 files │ +128 -31 │ Commands: 6 │ Errors: 0 │
├────────────────────────────────────────────────────────┤
│ [P]暂停 [M]追加消息 [D]查看Diff [L]全部日志 [Q]终止   │
└────────────────────────────────────────────────────────┘
```

页面包括：

- 项目选择。
- 新建任务和角色选择。
- 计划确认。
- 任务运行。
- Diff 浏览。
- 审查结果。
- 历史任务和恢复。
- 设置与健康检查。

主要快捷键：

- `P`：暂停或继续。
- `M`：追加消息。
- `D`：查看 diff。
- `Tab`：切换 Agent 日志。
- `R`：手动要求返工。
- `A`：批准当前阶段。
- `Q`：终止任务并二次确认。
- `Ctrl+C`：第一次打开暂停/中断菜单，第二次只打开终止确认，不直接退出。

窄终端降级为单面板，通过 `Tab` 切换工作流、日志、Diff 和审查结果。

## 12. 权限与项目隔离

首版采用 best-effort 工具级项目护栏，不宣称为操作系统安全边界，也不保证恶意或失控的子进程绝对无法写到项目外。

- 所有 CLI 从 canonical project root 启动。
- 启动前解析大小写、长路径、UNC、符号链接、junction 和其他 reparse point 风险。
- Codex、Claude、Grok 只在兼容矩阵确认对应版本具有所需权限能力时启用自动模式。
- 实现者使用 project-write 权限配置。
- 审查者和主控验收使用独立的 read-only 权限配置，不复用实现者配置。
- 审查开始前固定所审查的基线哈希；审查后重新计算，任何写入都会使本轮审查失败。
- 需要产生缓存或构建产物的验证由编排器在受控副本或明确的验证阶段运行，不交给只读审查角色直接写工作区。
- 项目内直接文件编辑及 allowlist 中的验证命令可以自动批准。
- 任意 PowerShell、依赖安装、带生命周期脚本的包管理命令或 Adapter 无法证明范围的操作，不因“项目内自动批准”而获得安全保证；能力不足时阻止或降级为人工确认。
- 提示词继续明确禁止目录外操作，但提示词不是安全机制。
- TUI 显示 `Isolation: Best-effort Project Guardrails` 和当前 Adapter 能力降级。

若用户需要安全意义上的绝对隔离，应在后续版本提供 Docker 执行器。

## 13. 文件追踪、快照与项目锁

Agent 直接在用户选择的项目目录中工作。系统只能证明“相对于任务基线的任务窗口变化”，不能仅凭文件事件可靠证明具体写入者。活动 attempt 期间的所有变化统一归入任务窗口，无法区分 Agent、用户、IDE 或其他进程。运行期间应提示用户不要并发编辑。

首版使用单活动任务锁。项目根路径 canonicalize 后，对同一路径以及父子重叠路径加锁；异常退出时通过 SQLite 租约和 reconcile 决定恢复或释放。

任务开始前建立总基线，每次实现或返工前建立独立 attempt 基线：

### Git 项目

- 记录当前分支、HEAD 和工作区状态。
- 识别任务开始前已有的已跟踪和未跟踪修改。
- 保存文件哈希和恢复任务专属 diff 所需的原始内容。
- 能排除任务开始前已有修改，但任务运行期间的并发写入只能标记为“来源不确定”。

### 普通目录

- 对项目文件创建内容快照和哈希。
- 默认排除 `.git`、`node_modules`、缓存、构建产物和可配置的大文件。
- 显示缺少 Git 保护的风险提示。

文件监听器只负责实时 UI。最终变更集使用 `HEAD / 任务前快照 / attempt 前快照 / 当前内容` 进行比较，不能仅依赖文件事件。系统只在“没有活动 attempt”或“attempt 结束且审查基线已经固定”之后检测新的文件变化；此类变化会使当前结果失效并进入 `awaiting_user`。活动 attempt 期间不尝试判断写入来源。

快照 manifest 包含文件路径、类型、大小、哈希、完成标记和排除原因。未写入完成标记的快照无效。重命名和二进制文件以内容哈希和元数据处理；reparse point 默认不跟随。排除目录至少记录元数据变化，并明确区分“不展示内容”“不保存内容”和“完全不追踪”。

快照和数据库保存在：

```text
%LOCALAPPDATA%\TriAgent\
├── triagent.db
├── logs\
└── snapshots\
```

首版不自动回滚。异常退出后恢复任务时，先重新计算当前文件状态，再让用户选择继续、仅查看或终止任务。

## 14. SQLite 数据模型

- `projects`：项目路径、类型和最近使用时间。
- `tasks`：需求、角色、状态、确认模式、超时和返工上限。
- `agent_sessions`：Agent、角色、会话 ID、进程状态和退出码。
- `run_attempts`：每次本地执行的 PID、启动时间、Job 标识、需求版本、基线和退出原因。
- `pending_actions`：副作用 intent、执行状态、幂等键和结果。
- `events`：标准化事件。
- `log_index`：JSONL 原始日志的文件、offset、sequence 和校验信息。
- `workflow_transitions`：状态转换及原因。
- `reviews`：审查意见、结论和轮次。
- `file_baselines`：文件哈希和快照位置。
- `file_changes`：新增、修改、删除和 diff。
- `user_messages`：运行期间追加的要求、序号和投递状态。
- `requirement_versions`：需求、计划和验收标准版本。
- `project_locks`：canonical path、租约、持有任务和 heartbeat。
- `settings`：CLI 路径和默认参数。

SQLite 启用 WAL、schema migration 和单写者策略。任何外部副作用遵循“先事务写入 intent -> 执行 -> 事务写入 result”。启动时 reconcile 未完成 action，不能直接重放非幂等操作。

JSONL 是原始日志唯一事实源，SQLite 只保存索引和校验信息，避免双重事实源。

敏感信息不得主动写入数据库。日志在写盘前和显示前分别执行 best-effort 脱敏，提供保留期、清理和导出警告；不得宣传为完整防泄漏能力。

## 15. 暂停、停止和恢复

Windows 不提供对任意进程通用且可靠的 `SIGSTOP/SIGCONT` 等价能力，因此首版区分：

- `Pause after current run`：当前 CLI 仍在运行并可能继续修改文件，但完成后不启动下一阶段。
- `Interrupt current run`：请求当前执行停止，结束后必须检查文件现场，再决定是否恢复。

TUI 必须持续显示外部进程是否仍在运行，不能把 `Pause after current run` 表现成已经停止工作。

Windows 进程监督器要求：

- 每次外部执行进入独立 Windows Job Object，并启用 kill-on-close；若实施验证发现 Node.js 生态无法可靠提供该能力，则该问题阻断“可靠强制终止”验收。
- 先使用 Adapter 特定的协作式停止，等待固定宽限时间，再终止整个 Job。
- 终止后验证所有后代进程已经退出。
- 强制终止后重扫文件，进入 `interrupted_needs_inspection`，不得自动继续。
- PID 必须和进程启动时间、Job 标识共同核对，避免 PID 复用导致误杀。

关闭 TUI 时，如果仍有任务运行，必须要求用户选择：

- 返回任务。
- 中断当前进程、确认进程树清理并保存恢复状态。
- 取消整个任务。

首版禁止 detach 或静默遗留后台进程。第二次 `Ctrl+C` 只能打开终止确认，不能绕过清理。只有 Job Object 中全部后代进程确认结束后才能关闭 TUI；清理失败则保持 `cleanup_failed` 并阻止退出。取消整个任务也必须先完成相同的进程树清理，再进入 `cancelled`。

## 16. 错误处理

- CLI 缺失、未登录或版本能力不足：阻止相关角色启动，显示版本、检查结果和被禁用的功能。
- 外部进程崩溃：先保存退出码、重扫文件并 reconcile 当前 attempt。只有 Adapter 明确支持恢复、没有未确认的非幂等副作用且现场一致时，才允许尝试一次会话恢复；否则进入 `interrupted_needs_inspection` 或 `awaiting_user`。
- 流式 JSON 解析失败：保留原始行并降级显示，不导致 TUI 崩溃。
- 结构化结果缺失：请求一次格式修复，失败后暂停等待处理。
- 超时：先尝试正常终止，再强制终止进程树。
- 文件冲突或基线异常：停止自动流程，不覆盖用户文件。
- SQLite 写入失败：停止启动新阶段，避免运行状态无法恢复。
- 返工超过 3 轮：进入 `awaiting_user`，展示全部未解决问题。
- 启动恢复：逐项 reconcile pending action、run attempt、进程身份、项目锁、快照 manifest 和消息投递状态。
- 数据库损坏：只读打开可用记录并提供诊断，不继续自动执行外部副作用。

## 17. 测试策略

### 单元测试

- 状态转换和非法转换。
- 返工计数与上限。
- 路径规范化和项目边界校验。
- Windows 大小写、中文、空格、长路径、UNC、junction、symlink 和 reparse point。
- CLI 事件解析。
- 结构化结果解析和格式修复。
- 日志脱敏。

### 集成测试

- 使用可控的假 Codex、Claude、Grok CLI。
- 模拟成功、失败、超时、崩溃、无效 JSON 和会话恢复。
- 验证工作流不会在失败时错误进入完成状态。
- 模拟每个“intent 已写/副作用已执行/result 未写”的崩溃窗口并验证 reconcile。

### 文件系统测试

- 干净 Git 仓库。
- 带有用户原始修改的脏工作区。
- 普通目录。
- 新增、修改、删除、重命名和快速连续写入。
- 异常退出后的 diff 重建。
- 用户或 IDE 在任务期间并发修改文件。

### TUI 测试

- 键盘操作。
- 计划批准和拒绝。
- 窄终端降级。
- 日志切换。
- 暂停、终止和恢复提示。
- ANSI/OSC 清理、超长行和高输出速率。

### Windows 实机验证

- PowerShell 中通过 `triagent` 启动。
- 检查三个真实 CLI。
- 完成一次规划、实现、审查、返工和最终通过的完整闭环。

## 18. 首版验收标准

1. 给定受支持的 Node.js 和已安装的包，执行全局安装后，运行 `triagent` 能在 PowerShell 中打开 TUI，退出码为 0。
2. 给定受支持或不受支持的 CLI 版本，健康检查能在超时内返回版本、认证状态、能力矩阵和明确的启用/禁用结论。
3. 给定 Git 仓库或普通目录，项目选择能 canonicalize 路径；重叠项目存在活动锁时拒绝启动第二个任务。
4. 创建任务时必须选择三个互不重复的角色，并把角色和需求版本持久化。
5. 计划需要确认时，批准进入实现，修改要求返回重新规划，拒绝进入取消状态。
6. 给定成功的假实现 CLI，系统记录 run attempt、真实退出码、任务窗口 diff 和结构化结果，再进入审查。
7. 审查者和主控验收使用只读配置；审查期间任何工作区写入都会使该轮审查失败。
8. 主控只有在文件、命令退出码和审查证据齐全时才能判定通过。
9. “最多 3 轮返工”指初始实现之后最多额外执行 3 次返工 attempt，第 4 次返工请求进入 `awaiting_user`。
10. 默认总运行预算为 60 分钟；用户等待和 `paused_after_run` 时间不计入运行预算；单次调用超时独立配置。
11. 不支持实时输入的 Adapter 会把追加消息排队到安全点，不会为普通消息强制终止当前执行。
12. 强制中断后只有在整个进程树确认结束、文件现场重扫完成后，才能进入人工检查状态。
13. 在预设崩溃窗口重启应用时，reconcile 不会重复执行未确认的非幂等副作用。
14. 任务开始前的脏工作区修改保留在基线中；活动 attempt 期间的变化统一视为任务窗口变化，不宣称能识别写入者；attempt 结束并固定审查基线后的新变化会停止自动审查。
15. 工具级护栏能力不足时必须禁用自动模式或要求人工确认，界面不得显示“安全沙箱”或绝对目录隔离保证。
16. 软件不为自身清理而自动执行 commit、reset、checkout、clean，也不自动删除任务基线中已有文件；实现计划明确要求的项目文件删除必须作为可见 diff 展示。

## 19. 分阶段交付

为了让风险可验证，完整首版按以下顺序交付：

1. 核心状态机、SQLite 恢复协议、单活动项目锁、Git 基线和三个假 CLI Adapter。
2. 三个真实 CLI 的版本/认证/能力探测及非交互单次调用；不启用运行中中断恢复。
3. 只读审查、主控验收、自动返工和证据链。
4. 普通目录快照、来源不明并发变化检测和恢复 UI。
5. 仅对能力验证通过的 CLI 启用实时输入或可恢复中断。

每个阶段必须独立通过测试后才能进入下一阶段。完整产品目标不变，但高级能力不会在未验证 CLI 契约前被默认开启。

## 20. 后续版本候选项

- Gemini、Aider 等新 Adapter。
- Docker 硬隔离执行器。
- 后台常驻服务和重新连接 TUI。
- 多实现者并行方案比较。
- 远程任务和 Web 控制台。
- 可配置工作流模板。
