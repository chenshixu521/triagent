# Findings

## 2026-07-15 Task 12 真实验收（最终全绿）

- Production runtime 曾未注入 `implementationWorkspacesDirectory`，Grok implementer 在 prepare 时必炸。
- Grok adapter `#commandInput` 未把 `executionRoot`/`workspaceAuthorizationId`/`sourceManifestHash` 映射为 `isolatedWorkspace`，导致 `workspace_write requires isolatedWorkspace authorization ref`。
- `agent_sessions.mode` CHECK 不含 `workspace_write` → migration 008 重建表。
- Grok 0.2.101 流格式是 `text`/`thought`/`end`（无 Claude 式 `result`/`structured_output`）；isolated implementer 需在 EndTurn 合成 AgentResult（candidate 文件系统权威）。
- Grok 在候选区成功写入 `triagent-smoke.txt`；canonical 在 promote 前保持仅 README。
- Codex 自定义 provider 在带 `--output-schema` 时易 502；plain exec 可用 → 对 custom provider 省略 schema，freeform 解析 AgentResult。
- **Master 误拒根因**：review/master 的 cwd 仍是 canonical（promote 前无 smoke 文件）。修复：`AgentRequest.inspectionRoot` + Claude/Codex adapter 使用 candidate 作为 cwd/tool scope；专用 isolated validation prompt。
- Rework 后 workspace auth 仍绑旧 attempt → reissue 时更新 `attempt_id`。
- 最终成功证据：`D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168`（completed + promoted + postApplyVerified）。

## 2026-07-15 Task 9–11 实施要点

- PatchApplier 拒绝 `new file mode` / `deleted file mode` 行；change-set 不得输出 mode 元数据。
- `applyHunks` 会去掉 trailing newline 产生的 phantom empty line；modify/delete 的 unified diff 必须用同一 split 语义，否则 “baseline content mismatch for deleted line”。
- 新文件 add：`applyHunks` 从空原文开始且不自动补尾换行；候选以 LF 结尾时需在 diff 中保留末尾空 `+` 行才能字节一致。
- 提升用的 attempt baseline 必须覆盖 change-set 全部路径：modify/delete 为现有文件，add 为 `missing: true`。
- workspace 行绑定的是 implementer attempt；master 完成时的 `PromoteCandidateWorkspace.attemptId` 是主控 attempt，不能拿来做 workspace 身份校验。
- housekeep 不可复用 incomplete-prepare 的“删整个 task 父目录”逻辑，否则会误删同 task 下 sibling workspace（含 `recovery_required`）。
- `sourceManifestHash` 在 materialize 路径是 baseline.checksum；漂移比较应使用 `expectedCanonicalFiles` vs `currentCanonicalFiles` 的内容指纹，而不是把 baseline.checksum 当内容 hash。

## 2026-07-14 真实闭环续跑决策

- `RestartRecoveryService.cancelAfterInspection()` 会对任何 `lastAttempt.status=pending` 返回 `recovery blocked: the prior attempt has no durable process identity`。第一次真实任务虽未启动模型，却留有一个 role=null/pending 的预启动 attempt；需先用只读数据库证据区分“保留但从未启动”与“未知进程”，不能直接放宽安全门禁。
- 真实 smoke 的下一组合固定为 Claude(master)、Codex(implementer)、Grok(reviewer)。这是工作流能力约束，不是模型偏好：当前 coordinator 会拒绝非 `auto_allowed` 的 Claude implementer patch_mode，而动态验证后的 Codex implementer 具备 project-write。
- 第一次隔离任务没有模型输出或项目写入，必须先用类型化 `RECOVERY_CANCEL` 收口；不得直接修改 SQLite 或删除锁记录。

- 2026-07-14 新故障初步假设：已取消任务仍合法保留 `projects(root_path='D:\\triagent')`；新任务创建路径若每次生成新 projectId 并无条件 `INSERT projects`，就会稳定触发 `UNIQUE(projects.root_path)`。正确语义应是复用同一 canonical root 的现有 project，而不是删除历史项目记录。
- 源码与现场数据库已验证假设：schema 明确 `projects.root_path UNIQUE`，现场仍有合法项目行 `project-959... / D:\\triagent`；`TaskRepository.createProject()` 使用普通 INSERT，且 `TaskOrchestrator` 存在 task creation 时调用 `createProject()` 的路径。下一步读取完整事务边界和现有任务流测试。
- 完整数据流确认：`TaskSessionController.CREATE_TASK -> production runtime -> TaskOrchestrator.initialize()`；initialize 无条件 `createProject({fresh projectId, same canonical root})`，随后 task FK 使用 fresh ID。修复不能只是 `INSERT OR IGNORE`，否则 task 会引用不存在的新 ID；repository 必须原子返回该 root 对应的实际 project ID，orchestrator 再用返回值创建 task。
- `TaskRepository.createProject()` 当前返回 void；最佳最小接口是用单条 `INSERT ... ON CONFLICT(root_path) DO UPDATE ... RETURNING id` 原子返回实际 ID。需要两层测试：repository 复用 ID，以及 orchestrator 第二个 task 的 FK 确实使用返回的旧 ID。

- 2026-07-14 当前故障根因已复核：数据库健康且无存活 TriAgent 进程；同任务项目锁租约已过期。首次失败来自 Windows ProcessHost 对裸 `codex`/`claude` 调用 `CreateProcessW`，无法执行 npm `.cmd` shim；重启后恢复逻辑先判 owner mismatch，才把陈旧锁误报成其他实例。
- 本阶段修复边界：受支持的 Windows npm shim 只解析到官方包内原生 `.exe`，不经过 shell；环境检查失败释放本任务锁，重试前重新获取；无 run attempt 的恢复任务提供审计化取消/清锁路径；仍禁止抢占可验证的活锁。
- `reconciler.validateLock()` 当前确实先比较 owner、后判断租约时间，所以“旧 owner + 已过期租约”稳定落入 `project_lock_owner_mismatch`；`blockedDecision()` 统一暴露 `inspect,cancel`，没有根据是否存在 attempt 调整。
- 原生 ProcessHost 把传入 command 直接拼进 `CreateProcessW` 命令行且 `lpApplicationName=null`；这能启动 `.exe`，但 Windows 不会执行 npm 的 `.cmd` shim，和数据库中的 `CreateProcessW failed` 完全一致。
- `CommandProbe` 和真实 Agent 启动都通过 `ProcessSupervisorPort.start({ executable, ... })` 进入同一个 ProcessHost，因此解析器放在 Supervisor 启动边界可以同时修复环境检查与实际执行；但仍需核对健康证据/兼容缓存的 launcher identity，避免其继续绑定未解析 shim。
- `CompatibilityResolver` 的 `resolveExecutableIdentity()` 当前按 PATH/PATHEXT 直接对命中的 `.cmd` 做 realpath/hash，未知版本缓存因此会绑定 npm shim，而 ProcessSupervisor 将来若启动包内 `.exe` 就会身份分叉。新解析器必须被这两个边界共同复用：缓存哈希最终原生文件，Supervisor 也启动同一路径。
- 工作流已存在 `ReleaseProjectLock` effect 及 Recovery 的审计化 `project_lock_reconciliations` + 条件删除实现，可复用而不需要直接 SQL 修库；缺陷集中在 `ENVIRONMENT_FAILED` 未发释放 effect、retry 未先 Acquire，以及 recovery public 方法在入口强制要求 episode attempt。
- `startup-reconcile.allowedActionsFor()` 目前只要 baseline 不完整就硬编码 `inspect,cancel`，并且 `autoResume` 仅认可 feed-forward/retry；因此“无 attempt + 锁已正常释放 + awaiting_user”即使 reconciler 判定安全，也仍会被送入 Recovery。需要把这种 pre-attempt idle 状态识别为无需恢复，而不是伪造 baseline。
- `composeApplication()` 实际按 `reconcileReport.incompleteTaskCount > 0` 直接选择 Recovery，并未使用 `autoResume` 过滤；所以正确修复点是让 `runStartupReconcile()` 不把安全的 pre-attempt awaiting-user idle task 放进 recovery items，而不只是调整按钮。
- `cancelAfterInspection()` 除了入口强制 `#requireEpisodeAttemptId()` 外，`#processExitBlock()` 也把 `lastAttempt===undefined` 当成不安全；对于从未启动过进程的任务，这恰好相反。取消路径可安全允许 no-attempt，但审计 payload 必须记录 `recoveryEpisodeKey=pre-attempt` 且不写伪造的 `episodeAttemptId`。
- RecoveryScreen、StatusBar 与键盘处理仍硬编码 I/C/X 三个动作；即使启动报告只允许 cancel，页面仍显示 inspect/continue，且按键仍会派发后再由 AppContext 拒绝。应把 `allowedNextActions` 放入 TuiSnapshot，并由渲染和键盘入口共同过滤。
- 最终现场验证：全局 bundle 与本地 build 哈希一致；实际解析 Codex/Claude 到官方包内 native `.exe`，Grok 保持原生 `.exe`；默认数据库旧任务已 cancelled、activeLocks=[]、release reconciliation=1；全局默认数据库 smoke 启动为 `new_task/draft`，不再进入 Recovery。

- 当前实现工作树：`D:\codex\project\agent_help\.worktrees\triagent-implementation`，分支 `feature/triagent-implementation`。
- 工作树大部分内容未跟踪，因此不以 `git diff` 作为变更完整性依据。
- 上一轮集中回归：67 个测试文件通过、1 个跳过；795 个测试通过、6 个跳过；剩 2 文件/3 测试失败。
- 授权失败的初步根因：测试用固定签发/过期时间，Adapter 消费授权时使用真实 `Date.now()`。
- 已用窄测试稳定复现：8 项中 2 项失败，均由 `CodexAdapter.#consumeLaunchAuthorization` 报固定授权已过期；其余 6 项通过。
- `CodexAdapterOptions` 没有时钟注入，生产消费逻辑故意使用仓储默认真实时钟；最小修复是让这两个“有效授权”测试生成相对当前时间的有效窗口，不修改生产 TTL 或授权验证。
- 启动 reconcile 失败的初步根因：完整并发套件下 5 秒用例超时；需单测确认。
- `startup-reconcile.test.ts` 单独运行通过：1 文件、11 测试全部通过；总耗时 12.75 秒，其中测试执行 10.40 秒。由此排除稳定的生产逻辑失败，支持“完整套件并发负载下个别默认 5 秒测试超时”的判断。
- verbose 单测显示最后一项 `reports missing/incomplete/wrong-task baselines...` 用时 4542 ms，距离默认 5000 ms 仅约 458 ms；它创建并验证三套数据库/应用组合，是完整并发负载下越界的具体用例。
- 仓库已有多处针对文件系统/集成测试使用 `}, 15_000);`；本轮只给该用例相同的 15 秒上限，不修改生产 reconcile 或清理逻辑。
- 沙箱外完整离线回归通过：69 文件通过、1 跳过；798 测试通过、6 跳过，共 804 项。
- 受限沙箱内曾出现 25 项 ACL/CIM/Job Object/全局安装“拒绝访问”失败；同一命令沙箱外全绿，判定为执行权限环境差异，未据此修改生产逻辑。
- `typecheck` 与首次 `build` 均成功；随后外层 `npm pack --dry-run --json` 的 prepack 完整测试中，package-install e2e 因 tarball 不存在失败。
- 打包失败根因：npm 将外层 dry-run 作为 `npm_config_dry_run` 传入生命周期；`run-prepack.mjs` 又原样传给内部 `npm test`，而 package-install e2e 的嵌套 `npm pack` 因继承 dry-run 不落盘。已在 prepack 启动内部 npm 命令前大小写不敏感地移除该配置。
- 原始 `npm.cmd pack --dry-run --json` 红→绿复测退出 0：packaging stress 6/6；prepack full suite 69 文件通过、1 跳过，795 测试通过、9 跳过；typecheck/build 均通过。
- 最终 dry-run 包证据：packed 33,387,741 bytes；unpacked 76,228,248 bytes；SHA-1 `b4809dfcf6841492bc0168c6864b993e99a8db0e`；SHA-512 integrity `sha512-mpbWCFwBiFX7swOboeoctikEVTIDjB6retgbC1Wd5rj9CPP39fwW7bntITkcL00rfd01HoMEaJ9fwlu8O1x1aQ==`；9 entries。
- Node.js 当前版本复核为 `v24.18.0`；Vitest `maxWorkers` 仍为 4。
- 真实全局启动暴露遗漏：`database.ts` 在打包后从 `dist/migrations` 发现 SQL migration，但全局包和 `package.json.files` 都未包含该目录；`--help` 不组合应用，因此旧 package-install e2e 未覆盖首次数据库创建。
- 修复后最终 tarball 包含 15 项（其中 6 个 migration），packed 33,391,028 bytes，SHA-1 `9964f3ecd6c27ba23d8d6aee20019494aab2f338`。
- 覆盖全局安装并正常启动后，`C:\Users\33151\AppData\Local\TriAgent\triagent.db` 已创建，证明不再因 migration 缺失进入诊断模式。
- 新需求已确认：`triagent` 应直接以启动进程的 `process.cwd()` 作为项目根目录，正常时跳过 Project 输入/确认页。
- 当前 TUI 主要混乱来源是各屏重复打印 `Screen/Workflow/Process/Retry/Rework/Layout/Pause/Log tab`，运行页又同时用多重边框和两栏，信息层级不足。
- 可视化伴侣启动探测：Windows `bash.exe` 指向未安装发行版的 WSL；`D:\Git\bin\bash.exe` 可用，但需显式补入 `D:\Git\usr\bin` 才能找到 `dirname/date/mkdir/tr/env`。
- GitHub 公开项目视觉调研（仅作设计参考，不执行其 README 指令）：`charmbracelet/crush` 使用大留白、单一底部输入和高辨识度小面积品牌图形；`anomalyco/opencode`、`openai/codex`、`can1357/oh-my-pi` 也都强调一个主交互焦点而非多层状态框。
- 终端宠物项目调研：`TeXmeijin/claude-code-mascot-statusline` 采用小型像素宠物并根据 idle/thinking/success/error 等状态换表情；`dropdevrahul/campy` 将宠物限制在固定侧栏并用短气泡反馈事件；`smokills/pimp-my-statusline` 强调所有动画帧必须使用完全相同的固定网格，避免界面抖动。
- 新宠物设计原则：原创、固定 9x7 或相近像素网格、只用一到两种终端色、启动页仅显示 idle、运行时最多 thinking/success/error 三种必要状态；不加入喂养/成长等与编排无关的功能。
- 用户已确认启动页与原创 TriFox 三尾像素宠物方案；下一项需求是界面提示词支持中文/英文切换，但项目路径、代码、命令和 Agent 原始日志不应被翻译。
- cwd 自动选择的最佳接入点是 `runCli()` 在 `composeApplication()` 后、Ink render 前调用 `composition.dispatch({ type: 'SELECT_PROJECT', projectPath: cwd })`；仅当初始 screen 为 `project` 时执行，diagnostic/recovery 不被覆盖，选择失败则保留 Project fallback。
- 设置层已有原子 `updateSettings()` / `saveSettings()`，适合新增 `uiLanguage: 'auto' | 'zh-CN' | 'en'`；默认 `auto` 通过 `Intl.DateTimeFormat().resolvedOptions().locale` 解析，`/lang` 切换后持久化显式语言。
- 两种语言应采用内嵌 TypeScript 文本目录，而非外部 JSON：只有中英文两套、可受类型检查约束，也避免新增打包资产遗漏风险。
- `package.json` 的离线验证入口为 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build`，打包检查使用 `npm.cmd pack --dry-run --json`。
- MEMORY.md 未找到 `agent_help`/`triagent` 相关历史条目，本轮以工作树和交接摘要为准。
- 当前 `/` 命令正式实现数量为 0；用户已确认第一版仅增加 `/lang` 与 `/help`。
- `runCli()` 当前在 `composeApplication()` 后立即进入 render，尚未把 `process.cwd()` 派发为项目；CLI 已提供可注入 compose/render 测试缝，适合为 cwd 自动选择补单元测试。
- `AppSettings` 当前没有 UI 语言字段，设置校验采用严格 `KNOWN_KEYS` 白名单并支持缺省键向后兼容；新增 `uiLanguage` 需要同步接口、默认值、白名单、校验和冻结结果。
- `TaskSessionController` 的 `SELECT_PROJECT` 成功后已经返回 `screen: 'new_task'`，失败则返回 rejected，因此 CLI 启动时仅需在初始 `project` 屏派发 cwd；失败会自然保留路径修正页，recovery/diagnostic 不应派发。
- Slash Command 最小边界可保持清晰：独立纯函数 parser 只识别 `/help` 与 `/lang`；`/help` 作为本地 `help` modal，Esc 关闭；`/lang` 通过新的类型化 intent 交给 AppContext 调用现有 `updateSettings()` 持久化，再把解析后的语言写回 snapshot。
- `GlobalModal` 已是全屏共享覆盖层，适合新增帮助内容；现有 run-screen 测试依赖将被移除的重复状态文字，需要按新信息层级重写断言而不是保留旧噪声。
- `useKeyboard` 的任务 Enter 分支是 Slash parser 的唯一入口；用单个 `OPEN_HELP`/`SET_UI_LANGUAGE` intent 同时清空命令草稿，可避免异步键盘队列中再派发一个清空动作。
- AppContext 的 `updateSettings()` 已能原子保存任意合法新增字段；语言 intent 只需在 controller 中捕获异常并在成功后更新 `snapshotState.uiLanguage`，失败时不修改 snapshot。
- TUI 去噪后仍保留领域原始值：workflow state、task id、项目路径、Diff、命令和 Agent 日志不翻译；仅标题、说明、空状态、快捷键和操作提示切换语言。
- 完整离线回归：73 文件通过、1 文件跳过；826 测试通过、6 测试跳过。typecheck 与沙箱外 build 均退出 0。
- 标准 prepack 沙箱外只剩 1 个环境门禁失败：本机 `grok --version` 为 `0.2.101`，现有测试精确要求 `0.2.93`；这直接证明精确版本锁定会被用户正常升级打断。
- 已验证包清单包含 15 项，packed 33,403,768 bytes，unpacked 76,301,610 bytes，SHA-1 `aee302260319e3a9a77d2bfcaffe6225eabf7d63`，integrity `sha512-4ujZ8BjIkYDY8gMVXmMuXQc/UvlCknVeJYMdRJhajZtJ1shsvByqx0B/RsTIzR2FkHo1Ap1GejTcXcHijZUOxg==`。
- 覆盖全局安装后，从 `D:\tmp` 运行已安装 bundle 的无真实 AI smoke：首屏 `new_task`，projectPath=`D:\tmp`，初始语言 `zh-CN`，切换为 `en` 后重启仍为 `en`；`triagent --help` 退出 0。
- 用户新增需求：CLI 升级后应自动检测实际版本；推荐兼容范围 + 无副作用能力探测 + 本机签名兼容缓存，而不是遇到未知版本无条件放行或自动修改代码。
- 用户回复“继续”，视为批准上述安全方案；不使用未知版本无条件放行，也不让程序自动改写自身命令模板。
- 初步源码证据：`compatibility-matrix.ts` 只登记 Codex `0.144.1`、Claude `2.1.206`、Grok `0.2.93` 的精确记录，未知版本返回 disabled；三个 command builder 还会再次检查精确版本，因此只改健康测试或版本测试不能解决真实启动门禁。
- `CommandProbe` 已具备本需求需要的安全执行边界：结构化 argv、禁止 shell、临时/指定 cwd、超时、输出上限、脱敏，以及 ProcessSupervisor/Job Object 清理；无需引入新的进程执行通道。
- 三个 health checker 各自维护 `*_SUPPORTED_VERSIONS` 精确数组，并在版本未知时返回 `unsupported_version`；能力探测应插入“解析版本之后、判定 unsupported 之前”。
- 现有 `HealthEvidenceRepository` 绑定 task/attempt 且 readiness 单次消费，适合启动门禁证据，不适合作为跨任务的本机版本兼容缓存；需要独立、不可由项目控制的 app-data 缓存记录。
- 当前环境未暴露 `rg` 命令；源码检索必须使用 PowerShell 定向遍历，避免从仓库根递归进入 `node_modules`。
- 工作树内没有额外 `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`；本轮继续遵守用户明确边界和根目录规划文件。
- `AppPaths` 当前只暴露 database/logs/snapshots/native diagnostics/settings；兼容缓存应新增根目录下专用文件（例如 `cli-compatibility-cache.json`），不能放项目目录，也不应复用 settings 或任务证据库。
- 三个 health checker 都在完成版本与 auth/inspect 的无模型调用后，才用固定数组判断 `unsupported_version`；因此动态 resolver 可在这一位置接管 record 解析，同时保留现有 missing/timeout/malformed/auth 错误优先级。
- Grok 的 inspect 只能证明 JSON 命令可执行，仍必须保持 `auth=unknown` 和 `requiresReadinessProbe=true`；动态兼容不能把它提升为已登录、read-only 或 project-write。
- 三个 command builder 已经先校验 record/key/platform 和各自实际所需 capability bits，随后又额外硬编码固定版本；删除固定版本分支后，现有 capability 校验可继续 fail-closed，不需要让 builder 猜测版本参数。
- 动态 record 必须注册到 `lookupCompatibility()` 可见的进程内 registry：`SafeAgentLaunchCoordinator`、`WorkerStartGateVerifier` 和 Adapter launch 都会按 immutable key 再查一次，单纯把 record 放在启动健康报告里会在后续门禁丢失。
- `runProductionCapabilityProbes()` 是最合适的缓存装配点，但 Adapter 的后续 health 调用没有 resolver；因此 health checker 应先查统一 registry，只有启动探测在 miss 时注入 resolver，成功后注册，后续调用即可复用。
- 最终设计将缓存内容限制为 probe receipt，而不是完整 capability record；缓存命中时由当前代码的保守基线重新构造 record，可防止缓存字段直接提升权限。动态版本范围采用基线（含）到下一主版本（不含），并拒绝 prerelease。
- 最终标准 prepack 在真实 Windows 权限环境通过，直接证明常规打包流程不再因本机 Grok 0.2.101 与旧 0.2.93 精确断言而失败；受限沙箱中的 npm cache/CIM/ACL/Job Object 失败仍属于已知环境差异。
- 本轮遵守用户“不调用 Grok”边界，因此没有让已安装 Grok 0.2.101 执行实时 help probe；动态探测逻辑由 fixture/manifest/cache 测试覆盖，常规测试也不再依赖本机 Grok。
- 2026-07-14 启动页返工的唯一视觉基准为工作树内 `.superpowers/brainstorm/triagent-tui-20260714/pet-polish-v4.html`；不再把后续概括性文字当作可自由发挥的设计输入。
- 返工范围只包含启动页布局与 TriFox 画面：金色品牌、完整外框和大留白、右上宠物、全宽 Project 信息、大输入区、底部快捷键/角色；cwd 自动选择、双语、`/help`、`/lang` 及工作流逻辑保持不变。
- 当前有效代码工作树仍为 `.worktrees/triagent-implementation` 的 `feature/triagent-implementation`；项目根仅保存持久规划文件。
- 已完整对比 `pet-polish-v4.html` 与当前实现：确认稿是“品牌左上 + TriFox 绝对位于右上 + Project 独占全宽一行 + 164px 级大输入区 + 底部 roles/footer”的纵向信息架构；当前 `StartScreen.tsx` 则把 TriFox 作为横向布局首项放在左侧，并把其余内容全部挤到右侧。
- 当前实现把确认稿的金色 `#d6a756` 视觉语义改成 Ink `cyan`，输入区仅有标题和一行草稿，没有确认稿所要求的大留白、底部左右快捷键和完整外层终端框架。
- 当前 `TriFox.tsx` 是 24×7 普通 ASCII 线条狐狸，三条尾巴仅由最后一行 `~  ~~  ~~~` 暗示；确认稿是明确的块状像素狐狸、三条独立尾巴、固定区域并带 `TRIFOX · IDLE` 标签。
- 当前 `start-screen.test.tsx` 只断言标题、路径、提示词、`~~~` 和任意顶边框字符，没有断言品牌/宠物的左右位置、yellow 主题、外框高度、Project 全宽、大输入区高度或底部信息层级，因此未能阻止设计漂移。
- 已用 `ink-testing-library` 输出当前 120 列真实 frame：狐狸确实位于左侧，Project 与输入框从第 29 列开始，输入框只有 3 行高，证明偏差可稳定复现。
- 为避免再次自由绘制，TriFox 将直接从确认稿 SVG 的 168×128 矩形像素结构降采样为固定终端网格；32×9 采样能够保留耳朵、脸、躯干、三段尾巴和三枚 Agent 领灯，并可再加一行固定状态标签。
- 启动页红灯测试按预期得到 4 failed / 1 passed：旧界面没有完整外框，品牌仍为 cyan，60 列布局溢出，TriFox 仍为 24×7 ASCII。
- 新实现使用 32×10 固定像素网格、金色 `#d6a756`、完整外框、右上 TriFox、全宽 Project、宽屏 9 行/窄屏 6 行任务框以及底部角色/快捷键层级。
- 100 列真实 frame 与 `ink-testing-library` 的 100 列 stdout 对齐后外框完整；60×24 中文 frame 为 23 行、最大终端宽度 59，未横向溢出。
- 首次全 TUI 回归暴露启动页缩写键复用了 RunScreen 的 `Implementer/Reviewer` 标签；已拆分为启动页专用 `Implement/Review` 键，运行页原文保持不变。
- 标准 prepack 已完成 packaging stress 6/6、完整套件 839 passed / 9 skipped 和 typecheck；仅在 tsup 清理旧 `dist/native/win-x64/triagent-process-host.sha256` 时遇到 Windows `EBUSY`，尚无证据表明与启动页代码有关。
- EBUSY 文件为普通 Archive、ACL 可修改/删除；进程命令行检查只发现 Codex 与 MCP Node 进程，没有 TriAgent 构建进程。一次定向 `npm.cmd run build` 重试退出 0，支持瞬时 Windows 文件占用判断。
- 最终 tarball 15 项，33,420,440 bytes，SHA-1 `58777f2642a8598c360a5ec24dfbb59ba61a1609`；全局安装后本地/全局 CLI SHA-256 同为 `FBE8DD5767F5AA94E9C462B6451CC3B9FECF356FC1B613C7B8292168BC44E9CD`。
- 全局安装包无 AI smoke：从 `D:\tmp` 启动得到 `screen=new_task`、`projectPath=D:\tmp`、`uiLanguage=zh-CN`、`processRunning=false`，正常关闭且 exitCode=0。
- 任务 `task-cc890b03-3528-4503-84c1-d35f177358d8` 的默认数据库 `quick_check=ok`；当前机器没有任何 TriAgent 进程，因此 Recovery 的“different application instance”不是活并发实例。
- 活跃锁 `315ebc51-eb67-4a2f-87f5-c5ff61f06495` 属于同一任务/项目 `D:\triagent`，owner instance 为旧启动实例，租约在 `2026-07-14T09:29:47.610Z` 已过期，且没有 run attempt/baseline，属于需安全回收的陈旧锁。
- 任务数据库真实 `awaitingReason` 是 `master adapter unavailable: start_failed: CreateProcessW failed`；环境检查结果显示 Claude(master) 与 Codex(reviewer) 启动失败，Grok(implementer) 0.2.101 可用。Recovery 锁冲突是重启后的二次症状。
- `acquire-project-lock` 与 `environment-check` 两个 pending action 均已 completed；工作流已从 checking_environment 经 ENVIRONMENT_FAILED 转为 awaiting_user，但锁仍保持 active，导致新应用 instance 无法继续同一任务。
- 重复项目根路径的安全修复必须同时解决两层身份：持久化层通过 `root_path` upsert 返回数据库中的实际 `projects.id`，工作流层再把这个 ID 写入新 task。仅忽略冲突或仅重试 INSERT 都会留下 fresh project ID 与持久化行不一致的问题。
- `project lock release has no master attempt evidence identity` 不是用户没有确认，而是证据身份模型与新增释放时机冲突：过去 ReleaseProjectLock 主要发生在 master validation 后，代码把 attempt ID 当作必需；现在 `ENVIRONMENT_FAILED` 会在任何 master run 之前释放锁，而 `ENVIRONMENT_FAILED` 事件又不携带 environment-check attemptId，导致 release action 被准备成无 `reservedAttemptId` 并在实际释放前失败。
- 用户现场包含两个串联故障：第一故障是升级后的 Claude `2.1.209` 与 Codex `0.144.4` 未通过动态兼容探测，导致环境检查合法转入 awaiting_user；第二故障是该 pre-attempt 失败路径丢失 environment-check attempt identity，使锁释放抛错并遮蔽第一故障。确认键本身已生效，任务和转换记录都已持久化。
- 动态版本范围没有排斥现场版本；manifest 要求 Codex `exec --help`/`exec resume --help` 与 Claude `--help` 保留当前命令模板使用的固定 token。下一步诊断应区分 auth 未被识别、help 命令退出失败、超时及 token 漂移，不能把所有情况概括成“版本太新”。
- Claude `2.1.209` 未被接纳的确定根因是 auth parser 不支持 CLI 当前 JSON 输出中的 camelCase `loggedIn: true`；由于 resolver 只在 auth=authenticated 时执行，兼容 help 探测完全没机会运行。
- Codex `0.144.4` 未被接纳的确定根因是 approval flag 已成为真正的全局选项：top-level help 仍提供 `-a/--ask-for-approval`，但 `exec --help` 不再列出或接受它。TriAgent 的 resume builder 已前置全局参数，fresh start builder 却仍生成 `codex exec ... -a never`；probe manifest 也在错误的 `exec --help` 层寻找长 flag。应同时修正 probe 层级和 fresh 命令参数顺序。
- 修复后的全局安装包已用三个现场 CLI 做无模型端到端健康探测，三者均生成对应版本的动态兼容 receipt；这证明当前安装、登录解析、可执行身份、help contract 与缓存写入链路全部贯通。真正任务仍只会在用户确认后由 TriAgent 自动调度。
- 动态兼容链路仍有一处安全门禁断层：SafeAgentLaunchCoordinator 持有并验证了 runtime CompatibilityRecord，却没有把它传给 ProjectGuard；ProjectGuard 只能看版本字符串并回退到旧精确集合，导致任何动态升级版本在真正 Agent 启动前必然 disabled。修复必须显式传递 verified record 并核对 key/platform/capabilities，不能仅按版本范围放行。
# 2026-07-15 — Grok implementer boundary

- Existing reusable primitives support the approved design: task/attempt baselines and `DiffService` already describe source-to-current changes; `ReviewBundle` already carries a fixed unified diff and evidence; `PatchApplier` already revalidates patch paths and source text, stages all files, performs atomic replacements, and rolls back partial commits. The missing boundary is a durable candidate workspace and routing each workflow stage to the correct execution root.
- Real isolated workflow with `master=claude`, `implementer=grok`, `reviewer=codex` reached a completed Claude planning attempt, then stopped before Grok launch with `ProjectGuard ... neither direct-write nor read-only patch mode can be proven`.
- `compatibility-matrix.ts` deliberately assigns Grok `readOnly=false`, `projectWrite=false`, and `writeModes=[]`; dynamic help receipts re-key the conservative baseline and do not elevate capabilities.
- `grok-enforcement-proof.ts` supports only a proof that plan mode denies writes and elevates the exact version/platform to `read-only`; `grok-command.ts` then still routes `--cwd` only to an immutable review bundle and rejects the live project root. A Grok implementer therefore requires a new, separately proven direct-write profile or a new patch-broker protocol.

## 2026-07-15 - Repository checkpoint recovery

- The current code checkout remains `.worktrees/triagent-implementation` on `feature/triagent-implementation`; the repository root contains only persistent planning files for this effort.
- The user requested a hard stop after the persistence repository checkpoint is green. Task 3 (baseline materialization) must remain unimplemented in this session and becomes the next AI's starting point.
- `AppPaths` is defined in `src/config/app-paths.ts`, while migration 007 is under `src/persistence/migrations`; earlier assumed `src/core` and `src/db` paths do not exist.

## 2026-07-15 - Task 3 baseline materialization

- `ImplementationWorkspaceService.materializeFromBaseline` materializes under `implementation-workspaces/<task>/<attempt>/project` using exclusive file creates (`wx`), never hard links (`nlink === 1`).
- Authoritative source set is the task baseline, not live `.gitignore`. Always-excluded segments (`.git`, `.worktrees`, `node_modules`, caches, `.triagent*`) and secret basenames (`.env*`, `id_rsa`, `*.pem`/`*.key`, credential-shaped names) are omitted and recorded as protected paths even if a baseline incorrectly lists them.
- Baseline-included generated files (e.g. `generated.out`) are preserved when present in the baseline; build-output ignore reasons alone do not strip them during materialization.
- Nested repository markers (any non-root `.git` file/dir/symlink under an ancestor of a baseline path) fail with `nested_repository_unsupported` and leave no ready root.
- Symlink/reparse baseline entries fail with `unsupported_entry` (in-root) or reparse path-escape (external/absolute/`..` targets).
- Content-excluded files (blobHash null, hash present) are re-read from the canonical project and require exact content-hash match before copy; drift and missing blobs cannot become `ready`, and incomplete roots are deleted while the row is abandoned.
- Candidate manifest hash is content-identity only (files + protectedPaths + source baseline identity), so identical source content yields the same hash across attempts; workspace root path remains deterministically derived from app-root + task + attempt.
- Protected path set is process-memory keyed by workspaceId for now (`assertCandidatePathWritable`); durable protected-path persistence can be added when promotion/review tasks need restart-safe enforcement.

## 2026-07-15 - Tasks 4–6 / 9 architecture notes

- `ExecutionScope` is orthogonal to CompatibilityRecord live `projectWrite`. Isolated Grok gets `workspace_write` only with validated single-use workspace authorization; the matrix record is never elevated to live projectWrite.
- Launch flow: prepare peeks authorization (ready/unexpired/identity match) without consume; authorizeAfterBudget atomically consumes and transitions workspace `ready -> running`. Root confusion rules: `projectRoot` stays canonical, `executionRoot` is candidate, they must differ.
- Grok readiness evidence is recorded at prepare after health/capability match so WorkerStartGate can authorize Grok without a separate readiness channel for isolated launches.
- Isolated Grok argv: `--cwd <candidate>`, `--permission-mode auto`, tools Read/Glob/Grep/Edit/Write, deny Bash/Shell/Web/Task/MCP-like names; never `--always-approve` / `--sandbox` / prompt-in-argv.
- Change-set v1 hash = stable JSON of identity+entries + unifiedDiff; renames are delete+add; promotion requires full canonical manifest hash equality to source (unrelated path drift blocks).
- Remaining integration risk: TaskOrchestrator still builds live-project AgentRequests; Task 7 must inject materialize + isolated request fields + finalize change-set + promote effects before real/fake full workflow can pass.
