# Progress

## 2026-07-15（收尾：合入 main + Task 12 全绿）

- 将 `.worktrees/triagent-implementation` 全部源码/测试/文档同步到主仓根目录。
- **Task 12 GREEN**：`D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168`
  - `passed: true`，`exitCode: 0`，`workflowState: completed`，0 rework
  - Claude plan → Grok isolated implement → Codex approve → Claude master approve → promote
  - `postApplyVerified: true`；canonical `triagent-smoke.txt` 内容正确；`activeLocks: []`
- 收尾修复：`inspectionRoot`（review/master 看 candidate 而非空 canonical）；Codex 自定义 provider 省略 `--output-schema`；rework rebind workspace `attempt_id`；smoke 放宽预算。

## 2026-07-15（Task 12 真实三 AI — 部分通过，Codex 上游阻塞）【历史】

- 生产接线修复：`implementationWorkspacesDirectory` 注入 ProductionTaskRuntime；Grok adapter 映射 `isolatedWorkspace`；migration 008 允许 `agent_sessions.mode=workspace_write`；Grok 0.2.x `text/end` 流合成 structured result。
- 真实验收 harness：`D:\tmp\triagent-isolated-grok-e2e-smoke.mjs`（工作树 `dist/cli.js` + `TRIAGENT_REAL_AI_TESTS=1`）。
- **已实证（多轮）**：
  - Claude master planning completed
  - Grok isolated implementer：候选区写出 `triagent-smoke.txt` 正确内容；canonical 项目仍仅 README
  - finalize change-set + review-bundle；workspace `under_review` + changeSetHash
- **当时未完成（后已修复并全绿）**：Codex reviewer 曾因上游 `502` / structured-output 路径失败；master 误看 canonical 导致 rework。
- 早期证据：`D:\tmp\triagent-isolated-grok-e2e-1784085863189-5632`。

## 2026-07-15（Task 9 真提升 + Task 10 retention + Task 11 pack 断言）

- **Task 9 GREEN**：`WorkspacePromotionService` 真调 `PatchApplier`；promotion-scoped attempt baseline（含 add 的 missing 条目）；post-apply path/kind/hash 等价；空 change-set 无写提升；全局漂移 / 锁 / 哈希篡改 / 目标碰撞阻断。
- change-set 去掉 git mode 行，并与 `applyHunks` 换行语义对齐（否则 modify/delete 基线不匹配）。
- Orchestrator `PromoteCandidateWorkspace` 接线真提升；workspace 绑定 implementer attempt；fake adapter 下 ready→…→approved 可推进。
- **Task 10 GREEN**：`decideWorkspaceRecovery` 覆盖各状态；`housekeepImplementationWorkspaces` 24h 清理 promoted/expired abandoned，永不删 `recovery_required`/`promoting`；audited cancel 后才可清理；startup-reconcile 启动 housekeep。
- **Task 11**：package-install 清单增加 `007_implementation_workspaces.sql`。
- 验证：typecheck 0；定向 103/103（workspace + isolated-grok + happy-path + engine + startup-reconcile + coordinator）。
- **未完成**：Task 12 真实三 AI（需 `TRIAGENT_REAL_AI_TESTS=1`）。

## 2026-07-15（Task 8 审查 / rework / 候选校验）

- `buildImmutableReviewBundleFromCandidateChangeSet` + `classifyCandidateReviewResult`（approve/rework/reject，拒绝歧义）。
- 新增工作流事件 `REVIEW_REWORK_REQUESTED`：Codex rework → PersistReworkRequest → 再实施。
- Finalize 冻结 change-set 与 review-bundle sidecar；审查/主控期间候选 manifest hash 变化则 invalidate/fail。
- Rework 复用同一候选目录，签发新 single-use authorization（`reused: true`）。
- 验证：read-only-review 22/22；isolated-grok-workflow 3/3；happy-path 4/4；engine 56/56；typecheck 0。

## 2026-07-15（Task 7 工作流路由）

- 新增 effects：`PrepareImplementationWorkspace`、`FinalizeCandidateChangeSet`、`PromoteCandidateWorkspace`。
- `effectsForNewAttempt(implementing)`：CreateAttemptBaseline → Prepare → StartImplementation。
- `IMPLEMENTATION_COMPLETED`：Finalize → reviewing effects。
- `MASTER_APPROVED`：Promote → ReleaseProjectLock。
- Orchestrator：Grok implementer 才真正 materialize/finalize/promote；非 Grok 跳过并带 attemptId。
- StartImplementation 对 Grok 注入 `executionScope=isolated_implementation` 与候选 prompt（不含原项目写路径）。
- 拒绝 adapter 角色静默替换（role assignment vs adapter.kind）。
- 验证：
  - workflow-engine 56/56
  - isolated-grok-workflow 2/2
  - happy-path 4/4
  - typecheck 0

## 2026-07-15（Task 4–6 + Task 9 核心推进）

- 用户要求继续完成剩余隔离 Grok 实施；工作树仍为 `.worktrees/triagent-implementation`。
- **Task 4 GREEN**：`ExecutionScope`、`workspace_write` 权限配置；`SafeAgentLaunchCoordinator` 支持 isolated prepare（peek）+ authorize（atomic consume）；Grok live_project 仍 disabled。coordinator 测试 7/7。
- **Task 5 GREEN**：`buildGrokCommand` isolated profile — candidate `--cwd`、`--permission-mode auto`、允许 Read/Glob/Grep/Edit/Write、拒绝 Bash/Shell 等；无 always-approve。grok-command 41/41。
- **Task 6 GREEN**：`workspace-change-set.ts` v1 — add/modify/delete、稳定 hash、拒绝 binary/绝对路径/大小写碰撞/受保护路径。3/3。
- **Task 9 部分 GREEN**：`WorkspacePromotionService` 全局 manifest 漂移与锁不匹配阻断，且不调用 PatchApplier。1/1。完整 PatchApplier 提升路径与 post-hash 等价仍待加深。
- **未完成**：Task 7 工作流 effects/路由、Task 8 review/rework、Task 10 recovery、Task 11 全量 pack、Task 12 真实三 AI。
- `npm.cmd run typecheck` 退出 0；定向相关套件合计 58+ 通过（含 materialization）。

## 2026-07-15（Task 2 复测 + Task 3 materialization）

- 从 `HANDOFF_PLAN.md` 恢复；真实工作树仍为 `.worktrees/triagent-implementation` / `feature/triagent-implementation`。未执行 git commit/reset/checkout/clean。
- Task 2 复测全部退出 0：
  - `npm.cmd run typecheck` → 0
  - `implementation-workspace-service.test.ts` → 2/2 passed
  - `keyboard.test.tsx` + workspace → 18/18 passed
  - workspace + `package-install.test.ts` → 3/3 passed（含 e2e pack 约 24s）
- Task 3 按 TDD 完成：
  - 扩展 `tests/integration/workspace/implementation-workspace-service.test.ts` 覆盖 materialization 用例
  - 新增 `src/workspace/implementation-workspace-service.ts`
  - 扩展 `implementation-workspace-types.ts`（Materialize 输入/输出与 candidate manifest）
  - 最终 `implementation-workspace-service.test.ts` → **7/7 passed**；`typecheck` → 0
- 未开始 Task 4（scope/authorization 路由）；未调用真实模型；未改默认数据库。
- 根目录 `HANDOFF_PLAN.md` / `task_plan.md` / `progress.md` / `findings.md` 已同步到 Task 4 起点。

## 2026-07-15（持久化基础检查点交接）

- 从中断摘要恢复并核对真实状态：代码仍在 `.worktrees/triagent-implementation`、分支 `feature/triagent-implementation`；根目录仅承载持久计划文件，所有源码目前仍为未跟踪文件，禁止 Git 清理/提交边界保持不变。
- 本轮范围按用户要求收窄：只复现并完成 `ImplementationWorkspaceRepository` 检查点，运行定向类型检查/测试；转绿后停止 Task 3 及后续实现，并在根目录生成 `HANDOFF_PLAN.md`。
- 恢复审计先后误判 `AppPaths` 和 migration 所在目录；没有修改代码。通过列出 `src` 后确认真实路径分别为 `src/config/app-paths.ts` 与 `src/persistence/migrations/007_implementation_workspaces.sql`。

## 2026-07-15（Grok 实施角色真实复现）

- 任务 1 完成：默认角色测试先 RED（收到旧 Codex/Claude/Grok），仅重排 `ROLE_ASSIGNMENT_ORDER` 后新断言通过；同步角色循环测试的显式起点/顺序，最终 `keyboard.test.tsx` 16/16 GREEN。
- 执行前完整离线基线通过：76 文件通过/1 跳过，865 项通过/6 跳过，退出 0。任务 1 已先加入默认角色红灯测试，尚未修改生产默认值。
- 计划首轮审查返回 Issues Found。逐项对照后，TDD 顺序、PatchApplier 原子回滚、全局漂移、恢复保留、角色边界和安装/真实验收已在计划中；采纳有效遗漏并补充 ignored/generated 保留、nested repo fail-closed、secret/protected path、project-local TriAgent state 排除、no silent adapter fallback，以及无额外模型调用的负向安装验收。
- 修订后的隔离实施规格第二轮独立审查已 Approved。已按 writing-plans 将工作拆为 12 个 TDD 任务：默认角色、持久化、baseline materialization、scope/authorization、Grok profile、candidate change-set、workflow routing、review/rework/master validation、PatchApplier promotion、recovery、离线/打包安装、真实三 Agent 验收。
- 独立规格审查首轮返回 Issues Found；已补齐 baseline 复制权威、链接/硬链接/二进制策略、workspace change-set v1、全项目 manifest 漂移阻断、Codex approve/rework/reject 机器结果、格式修复/超时处理、24 小时清理、single-use 授权，以及 Grok 禁用 Shell/子进程的工具档案。首次大补丁因上下文锚点不匹配未落盘，随后按实际文档锚点重新应用。
- 用户批准隔离实施工作区方案并要求直接实施。完整设计已固化：候选工作区位于 app-root；Grok 只写候选副本；Codex 审查不可变 diff；Claude 在候选上做 master validation；最终由现有 PatchApplier 在原项目漂移复查后提升。
- 用户否决精确版本绑定的 Grok 写入证明，要求升级后不需要人工重新授权。新增推荐设计：Grok 只获得一次性隔离实现工作区，不接触原项目路径；TriAgent 从实际文件变化生成并验证 diff，Codex 审查后再通过受控 PatchApplier 提升到原项目。
- 用户明确指定固定角色：Claude 规划（master）、Grok 实施（implementer）、Codex 审查（reviewer），并授权在隔离目录执行真实任务。
- 已通过全局安装包的 `runCli()` 启动入口在唯一 `D:\tmp` app-root 派发固定文本文件任务。Claude master 真实 attempt 已 `completed`；工作流在 Grok 启动前转为 `interrupted_needs_inspection`，错误为 `ProjectGuard start is not auto-allowed (disabled): neither direct-write nor read-only patch mode can be proven; adapter disabled for implementer`；Grok 没有 run attempt，Codex 未进入 review。
- 当前安装 bundle 与工作树 `dist/cli.js` SHA-256 一致。根因不是已观测到的连接失败：Grok 0.2.101 动态 help receipt 仍继承保守 baseline，`readOnly=false`、`projectWrite=false`、`writeModes=[]`；Grok command builder 还强制 `--cwd` 为 immutable review bundle，拒绝 live project root。
- 现有 opt-in Grok enforcement proof 只证明 `permission-mode plan + tool deny` 能拒绝写入，且仅提升到 `read-only` / `writeModes=['read-only']`；它不能让 Grok 实施写入项目。下一步先获得用户对直接写入隔离证明 vs 补丁中介方案的设计批准，再按 TDD 实现。

## 2026-07-14（真实闭环续跑）

- 第三次失败任务的启动恢复快照证明 PID 57780 已持久化 completed/failed 且当前不存在，但 reconcile 仍因“project lock lease is stale or cannot be verified”及 non-Git baseline 的 `manifest git metadata must be an object` 只开放 cancel、又阻止 cancel。为保持真实需求验收独立且不直接改库，下一轮使用全新 app-root、同一干净项目根目录。
- 新 app-root 的 Claude 已通过 schema/tool 参数并到达本地 CLI 运行校验；2.1.209 明确要求 `-p --output-format stream-json` 同时传 `--verbose`。将把该真实模板依赖加入 command builder 和 dynamic help probe contract，先验收红灯再重跑。
- `--verbose` 命令与 probe-contract 回归已 GREEN（2 文件 43/43）。下一次真实 smoke 改用第三个全新 app-root，旧隔离数据库继续保留为诊断证据、不会直接删除或修补。
- 第三 app-root 的 Claude master 已真实完成 planning attempt（PID 46276、退出 0），但其结构化结果准确说明“read-only 无法创建文件”并返回 failed/await_user。根因是通用阶段提示词没有区分 master 的规划职责；新红灯要求 planning prompt 明确只产出方案、不得改文件、requirements 清楚时返回 completed/implement。
- 新的 stage prompt 契约已 RED→GREEN：planning 明确“只规划、不修改文件、completed/implement”，其余 implementation/review/master_validation 也写入各自预期 nextAction；prompt 单测与完整 happy-path 回归共 5/5 通过。下一次真实 smoke 使用第四个 app-root。
- 第四 app-root 已真实通过 Claude planning 并转入 Codex implementation；Codex 会话启动后出现连续 5 次 `stream disconnected before completion`，最后以外部传输错误退出，未输出/写入任何项目文件。该失败不改代码，改用第五个独立 app-root 安全重试同一需求。
- Recovery 安全回归已完成 RED→GREEN：目标文件 8/8 通过；只有与同 attempt 绑定的 disabled ProjectGuard 决策、匹配失败原因、failed agent-run、never-auto-replay 且无 log_index 进程证据时，pending attempt 才允许取消。
- 第二次真实 smoke 在模型启动前失败：全局 bundle 内 Claude schema 默认路径按源文件层级 `../../../schemas` 计算，错误落到 npm prefix 根目录；已开始为“dist/cli.js 所属 package.json -> schemas”补打包布局红灯。
- 第三次真实 smoke 已启动 Claude master 进程，但 CLI 在请求前本地拒绝：未知 deny tool `MultiEdit`，且其 JSON Schema 校验器未加载 Draft 2020-12 meta-schema；项目仍只有 README。下一轮红灯要求仅发送 help 已证明的 deny 工具，并在 Claude 专用 schema 内容中移除 `$schema` 声明而保留业务约束。
- 对第三次任务执行类型化 cancel 时仍被恢复安全门禁挡住；持久证据显示 Claude PID 57780 已 completed/failed 且当前进程列表不存在该 PID。新增只读 recovery snapshot 脚本用于读取启动 reconcile 的精确阻塞原因，不直接改数据库。
- 真实 smoke 驱动已改为 Claude=master、Codex=implementer、Grok=reviewer，固定文件需求和验收条件不变。
- 第一次类型化 `RECOVERY_CANCEL` 返回 snapshot 且生命周期安全退出，但任务仍为 `awaiting_user`；没有直接重试同一命令，开始读取 recovery operation 的阻塞证据。
- 首次只读数据库诊断在受限进程无法打开文件，非沙箱只读重跑可打开；随后发现诊断 SQL 错把 attempt identity 当成 `pending_actions` 独立列，实际身份位于 JSON payload/result，已修正脚本后继续。
- 新 recovery 回归首次运行在 fixture 校验处失败：`awaiting_user` 含 continue 时缺少安全 `resumeTargetState`；这是测试构造错误，不是目标行为红灯，已补与现场一致的 `planning` 后重跑。
- 已从持久计划恢复第 14 阶段；有效代码工作树仍为 `.worktrees/triagent-implementation`，不使用子代理、不执行 Git 清理或提交。
- 第一次隔离任务在任何模型 stage 启动前被旧 ProjectGuard 门禁拦截；动态 CompatibilityRecord 传播修复及定向回归已完成。
- 下一次角色调整为 Claude=master、Codex=implementer、Grok=reviewer：Codex implementer 可使用已验证的 project-write 自动模式，避免 Claude implementer 的 patch_mode 需要人工批准。
- 先通过已安装 AppContext 的类型化 Recovery cancel 清理失败任务及锁，再重跑同一固定文件需求。

## 2026-07-14（真实三 Agent 简单需求验收）

- 动态 ProjectGuard 红灯确认：SafeAgentLaunchCoordinator 新增 2 个现场版本用例均失败，Codex `0.144.4` implementer 和 Claude `2.1.209` master 都被旧精确表拒绝。
- 已显式把 coordinator 已验证的 CompatibilityRecord 传入 ProjectGuard，并在 guard 内重新核对 verified、cli/version/platform 及完整 capabilities；仅继承保守 record 的 readOnly/projectWrite 权限，Grok 未证明权限仍不放行。
- 定向回归 4/4 通过，typecheck 退出 0。下一步覆盖全局安装、类型化取消第一次隔离失败任务，并用更安全可自动运行的角色组合重新做真实闭环。
- 第一次真实闭环退出 2，未调用任何模型 stage：任务在 planning 启动前被 ProjectGuard 拦截，原因是 Codex `0.144.4` 动态兼容 record 未被旧精确版本权限表认可；项目仍只有 README.md，目标文件未创建。
- 数据库证据：workflow awaiting_user/version 4，唯一 run_attempt 仍 pending/role=null，reviews=[]；因此不是 Agent 输出失败，而是 launch coordinator -> ProjectGuard 的 capability record 传播缺口。
- 根因已定位：SafeAgentLaunchCoordinator 已查到 verified dynamic `CompatibilityRecord` 并核对 discovered capabilities，但调用 `evaluateAdapterStart()` 时只传 adapter/version/capabilities；permission profile 再次依赖硬编码 `codex@0.144.1`、`claude@2.1.206` 集合，丢失动态验证事实。
- 用户明确要求测试能否完成一个简单需求，授权真实调用三个 AI；将使用全新 D:\tmp 隔离项目和独立 app-root，不触碰正式项目或默认数据库。
- 固定角色：Codex=master、Claude=implementer、Grok=reviewer；需求仅创建 `triagent-smoke.txt`，内容固定为 `TriAgent real smoke completed.`，禁止修改其他文件。
- 验收必须同时满足：workflow=completed、目标文件内容正确、三个角色均有真实 attempt/review 证据、active locks=0；仅健康检查或部分角色成功不算完成。


## 2026-07-14（pre-attempt 锁释放证据诊断）

- 用户批准三个 CLI 全部检测后，新隔离 app-root 实机 smoke 退出 0：adapter capability stage `probes=3` 且 ok；兼容缓存包含 `claude@2.1.209`、`codex@0.144.4`、`grok@0.2.101`。
- 实机 smoke 明确记录 adapterStarted=false、workerStarted=false、projectLockAcquired=false；只执行 version/auth/inspect/help，没有发送任务提示词或调用模型。
- 全局默认数据库 smoke 再次退出 0：screen=new_task、workflowState=draft、projectPath=`D:\triagent`，不再进入 Recovery。
- 本地与全局 `dist/cli.js` SHA-256 同为 `5C6C5153ECF41FD98FF328F60F04A51D3DEA249BD3A52F243EC3D044209F8D57`。
- 第 13 阶段完成；当前三个 CLI 可由 TriAgent 自动检测和调度，现场失败任务已取消且无活跃锁。
- 首次安装包健康 smoke 在执行中被用户中断；随后非沙箱 CIM 复核未发现匹配的 Node/ProcessHost 残留。
- 用户明确要求三个 AI CLI 都检测；隔离设置已恢复 `grok`，下一次将让全局 TriAgent 对 Codex/Claude/Grok 执行完整无模型健康探测。
- 已用新安装 bundle 的类型化 `RECOVERY_CANCEL` 安全收口现场任务：Recovery 只允许 cancel，dispatch 成功，任务 awaiting_user -> cancelled，生命周期 exitAllowed=true。
- 默认数据库只读复核 quick_check=ok，最新任务 status=cancelled、workflowVersion=4、locks=[]；没有直接 SQL 修改或删除历史 action。
- 最后将用隔离 app-root 把 Grok 路径指向不存在文件，仅让新安装包执行 Codex/Claude 的 version/auth/help 无模型探测，并以兼容缓存 receipt 验证这两个现场版本已被接纳。
- 集中验证通过：typecheck 退出 0；完整离线套件 75 文件通过/1 跳过、857 项通过/6 跳过；build 退出 0。
- 已从该新鲜构建生成 15 项 tarball，SHA-1 `d0045ca90180f7d047a1192617219eb383e36e6c`，并成功覆盖全局安装（changed 42 packages）。
- 现场数据库仍保留本次失败任务与未释放锁，下一步只通过已安装 AppContext 的类型化 Recovery cancel 收口，不直接写 SQL；随后做无模型版本/能力验证。
- 四组目标回归最终 GREEN：health、compatibility resolver、Codex command、workflow crash recovery 共 4 文件、89/89 通过。
- 最小生产修改完成：Claude auth parser 支持严格 boolean `loggedIn` JSON；Codex top-level help 验证 approval flag且 fresh start 前置 `-a never`；无 event attempt 的 action-result 转换继承真实 `consumedAction.attemptId`。
- 首次 GREEN 回跑已有 88/89 通过；唯一失败不是生产逻辑，而是新测试漏写既有的 `master adapter unavailable:` 角色前缀。Promise 已正常 resolve，说明原锁释放异常消失；已只修正测试期望后重跑。
- Codex 参数位置实测进一步闭环：`codex exec -a never --help` 在 0.144.4 退出 2（unexpected `-a`），而 `codex -a never exec --help` 退出 0。resume builder 已使用全局参数前置，只有 fresh start builder 仍把 `-a never` 放在 `exec` 后。
- 因此 Codex 修复需要两部分：manifest 从 top-level `codex --help` 验证 approval flag，并让 fresh start 与 resume 一致，把全局 `-a never` 放在 `exec` 前；不能只删除 probe token，否则会放行一个实际启动必失败的命令模板。
- TDD 修复面已收窄为三条红灯：Claude JSON auth true/false 解析；Codex 新版 help 不含已移除且生产未使用的 `--ask-for-approval` 时仍可通过；环境失败后 release action 继承已完成 environment-check 的 attempt ID 并真实释放锁。
- 工作流最小实现候选不是伪造 master attempt，而是让 `#applyEvent()` 在事件自身无 attemptId 时继承 `consumedAction.attemptId`；这样 ReleaseProjectLock 的审计身份来自真实环境检查 action。
- 无模型实机命令诊断完成：Claude version/auth/help 均退出 0，help contract 所需 token 全部存在；但 `claude auth status` 现在输出 JSON `{"loggedIn": true, ...}`，现有 parser 只识别带空格的 `logged in`/`authenticated` 文本，因此错误归类为 auth error，resolver 根本没有执行。
- Codex version/login/help 均退出 0；`codex exec --help` 唯一缺失旧 manifest token `--ask-for-approval`。源码全局搜索确认生产 command builder 已不再使用该 flag，只有 probe manifest 仍要求它，因此这是过期探测合同造成的误拒绝。
- 动态兼容 resolver 的范围本身允许 Claude `2.1.209`（<3.0.0）和 Codex `0.144.4`（<1.0.0）；拒绝只能来自可执行文件身份、auth 前置条件、help probe 退出/超时或缺少 manifest token。
- 健康检查只有在 auth 被解析为 `authenticated` 时才调用 resolver；resolver 失败的详细原因只存在启动 capability report，任务运行时 Adapter 最终只留下 `unsupported <cli> version`。当前诊断需直接执行两个 CLI 的无模型 version/auth/help 命令来确定具体分支。
- 默认数据库只读现场确认：最新任务 `task-e3895e42-21ca-41bc-9816-c8435f7587e6` 已成功创建并从 draft -> checking_environment -> awaiting_user；数据库 quick_check=ok。
- 原始环境失败为 Claude master `2.1.209` unsupported；同轮 Codex reviewer `0.144.4` 也 unsupported，Grok `0.2.101` available。environment-check action 已 completed，并持有 attempt `882c0622-...`；随后 release action payload 的 attemptId 却为 null，action 被标记 failed，锁仍未释放。
- 兼容缓存当前只有 Grok `0.2.101` 的成功 receipt，没有 Claude/Codex 条目；说明自动探测没有接纳这两个更新版本。任务 JSONL 未包含相关诊断行，下一步从 capability probe 实现与 help contract 定位拒绝原因。
- 用户现场确认任务后收到 `project lock release has no master attempt evidence identity`；本轮只读诊断，不调用 AI、不改数据库。
- 精确错误来自 `TaskOrchestrator.#releaseProjectLock()`：任何 ReleaseProjectLock 若没有 `prepared.reservedAttemptId` 就先把 action 标记 failed，再抛错。
- 环境检查不可用路径调用 `ENVIRONMENT_FAILED` 时，事件本身没有 attemptId；工作流新加入的 pre-attempt ReleaseProjectLock 因此没有继承 environment-check 的保留 attempt identity。单独的 `consumedAction.attemptId` 只写消费审计，不参与 effect 身份准备。


## 2026-07-14（重复项目路径任务创建修复）

- 最小自审完成：`#projectId` 现在只作为首次插入候选 ID，持久化返回的 canonical ID 是 task 外键的唯一来源；未发现额外调用点或身份分叉。
- 非沙箱全局复核通过：`triagent.ps1/.cmd` 均存在，`triagent --help` 退出 0；本地与全局 `dist/cli.js` SHA-256 同为 `A7D802F1FA1183B9AAC1398433DF4F41714F8E330B8ABB77401478E624D12E00`。
- 第 12 阶段完成；没有删除旧项目/任务，没有调用 Grok 或任何真实 AI，也没有使用子代理。
- 全局默认数据库无 AI smoke 退出 0：`D:\triagent` 的 fresh 请求 ID 被解析回既有 `project-9592445f-4f5e-4aed-afda-7ad696fb77ac`，匹配项目行仍为 1，启动页为 `new_task`，生命周期正常退出。
- 随后的命令定位/哈希组合检查因当前 PowerShell PATH 不含 npm 全局目录而在 `Get-Command triagent` 处提前中止；这不是产品启动失败，将显式补 PATH 后重跑同一只读检查。
- 集中验证进展：typecheck 退出 0；完整离线套件 75 文件通过/1 跳过、855 项通过/6 跳过；build 退出 0；pack dry-run 的 prepack 852 项通过/9 跳过且打包清单 15 项。
- 已生成实际 tarball，SHA-1 `aceb2600760b57aeb63f6ace900a0fd788ad94d2` 与 dry-run 完全一致，并成功覆盖全局安装（changed 42 packages）。
- 最终现场 smoke 将通过全局 bundle、`--skip-health-probes` 和 `--skip-process-host` 对默认数据库派发一次 `CREATE_TASK`；该路径不会启动 Agent CLI，重点确认不再返回 projects.root_path 唯一约束，并用类型化 cancel 收口任务。
- 红灯复跑确认：2 个目标文件共 40 项，新增的 2 项均因 `UNIQUE constraint failed: projects.root_path` 失败，其余 38 项通过。
- 最小修复已实现：`createProject()` 使用单条 `ON CONFLICT(root_path) DO UPDATE ... RETURNING id` 原子解析持久化 project ID；`TaskOrchestrator.initialize()` 用该返回值创建 task，避免 fresh ID 破坏外键语义。
- 目标回归已转绿：2 个测试文件、40 项全部通过。
- 本次续作已重新核对有效工作树、计划与新增回归：`TaskRepository.createProject()` 仍为无返回值普通 INSERT，`TaskOrchestrator.initialize()` 仍把 fresh project ID 写入 task；两个测试已准确覆盖“同 canonical root 复用首个 project ID”。
- 收到现场错误 `task creation failed: UNIQUE constraint failed: projects.root_path`。
- 已选择系统化调试 + TDD；将先核对默认数据库项目行与 `CREATE_TASK` 数据流，再补重复路径红灯，不删除旧项目或历史任务。
- 只读数据库 quick_check=ok，旧项目记录按设计仍存在；唯一约束不是数据库损坏。源码检索已锁定 `TaskRepository.createProject()` 普通 INSERT 与 `TaskOrchestrator` 创建调用。
- 根因已闭环：新 runtime 每次生成 fresh projectId，但同 canonical root 已存在；简单忽略 INSERT 会破坏 task FK。下一步红灯将创建两个不同 task/project ID、同一个 projectRoot，并要求第二个 task 复用首个 project ID。
- 已确认 `#projectId` 仅在 initialize 的 project/task 两处使用，修改面很小；事务 helper 为 BEGIN IMMEDIATE，但单条 SQLite upsert+RETURNING 可直接保证 root 复用原子性。

## 2026-07-14（Recovery 锁故障修复续作）

- 已恢复第 11 阶段上下文，确认有效工作树为 `.worktrees/triagent-implementation`，未覆盖现有未跟踪实现。
- 已选择 `systematic-debugging`、`test-driven-development` 与 `verification-before-completion`；下一步读取定向源码和既有测试，先创建红灯回归。
- 已确定最小设计：安全解析 Windows Agent CLI 原生入口、修正环境失败锁生命周期、补齐无 attempt 恢复操作；不删数据库、不调用真实 AI、不使用子代理。
- 已核对 `reconciler.ts` 与原生 `Program.cs`：锁判断顺序和裸命令启动路径均与现场证据吻合；继续定位命令进入 ProcessHost 前的统一解析边界以及恢复服务测试缝。
- 已缩小进程链路到 `agents/health/command-probe.ts`、`process/process-supervisor.ts` 与 `process/process-host-client.ts`；下一轮读取这些接口的启动请求和 launcher identity 绑定位置，再决定解析器接入点。
- 已确认环境探测与真实运行共享 `ProcessSupervisor.start`，且生产端没有 direct-spawn/shell fallback；解析器可保持 Job Object 与无 shell 安全边界。正在核对缓存身份字段和请求透传位置。
- 已确认兼容缓存目前会哈希 PATH 命中的 `.cmd`。实现时将让缓存身份解析与 Supervisor 共用同一安全解析函数，确保探测、缓存和实际运行绑定同一个原生可执行文件。
- 已定位恢复链路的可复用安全机制：取消操作本来就会记录锁 reconciliation 并条件删除；下一步以现有单元/集成测试为基座补红灯，不新增无审计 SQL 通道。
- Windows CLI identity 红灯已确认：新测试 4/4 按预期失败；Codex/Claude 都解析到 `.cmd`，项目伪造 shim 和缺失原生目标也被错误接受。失败精确覆盖待修行为，不是测试装配错误。
- 已新增共享 Windows Agent CLI 解析器，并让兼容缓存 identity 使用最终 native 文件；4/4 定向测试转绿。下一轮验证 ProcessSupervisor 是否真正把同一路径传给 ProcessHost。
- ProcessSupervisor 透传红灯按预期收到 `codex` 而非 native 路径；接入共享解析器后，CLI identity + Supervisor 两文件共 11/11 通过。ProcessHost 现在收到包内 `.exe`，无 shell。
- 锁生命周期红灯确认两项缺失 effect：环境失败未 Release、重试未 Acquire。最小状态机修改后 `workflow-engine.test.ts` 56/56 通过。
- 已定位下一组恢复红灯：组合“过期租约 + 旧 owner”必须优先报 stale；“无 attempt + 无 lock + awaiting_user”必须留在正常等待界面；旧锁场景只暴露可执行的 cancel。
- 已确认 Recovery 选择依据是 report item 数量；将同时补决策级与启动报告级测试，避免只修文案/按钮却仍然进入 Recovery。
- 恢复决策与启动组合红灯 3/3 按预期失败；修正租约优先级、pre-attempt 缺锁/缺 baseline 语义、按钮来源及安全 idle 过滤后，两文件 35/35 通过。
- 正在补最后一条 Recovery 服务红灯：no-attempt awaiting-user 任务可原子取消、写 reconciliation、条件删除旧锁，并以 `pre-attempt` episode key 做幂等，不伪造 run attempt。
- no-attempt Recovery 服务红灯按预期报“no prior attempt”；实现可选 attempt 审计与 pre-attempt 幂等后，`restart-recovery-service.test.ts` 6/6 通过。现在收口 UI 合法动作显示/按键过滤。
- UI 现状已确认：RecoveryScreen、StatusBar 和 useKeyboard 均硬编码 I/C/X。下一轮先补“仅 cancel 时不显示/不派发 inspect/continue”的组件与键盘红灯。
- Recovery 合法动作红灯已确认：组件仍显示两组 I/C/X，键盘也仍派发禁止的 inspect；2 项均按预期失败。开始把 allowed actions 纳入 TuiSnapshot，并统一驱动显示与键盘。
- 已将 allowed actions 写入冻结的 TuiSnapshot，RecoveryScreen 动态渲染，StatusBar 仅保留 Ctrl+C，键盘按允许集合过滤；组件/键盘两文件 20/20 通过。
- 首次集中 typecheck 发现 3 个纯类型问题：awaiting action 过滤谓词过宽 2 处、测试 union spread 1 处；已收窄为 continue/cancel 并改用显式 present-lock fixture，未改变运行行为。
- 重新集中验证通过：typecheck 退出 0；8 个相关测试文件、128 个测试全部通过。进入完整离线套件与 build/pack 阶段。
- 完整离线套件通过：75 个测试文件通过、1 个跳过；853 项通过、6 项跳过，共 859 项；未运行真实 AI。
- build 退出 0；native helper 为 73,525,322 bytes，SHA-256 `82f5c98216959e30517c58ccd79f5b06dd8958bd5db41708aa48c4454abe6ec4`。
- 标准 `npm pack --dry-run --json` 退出 0：packaging stress 6/6，prepack 全套 850 passed / 9 skipped，typecheck/build 通过；包清单 15 项，size=33,426,324 bytes，SHA-1 `95c7273957979d1baaaa1168e9e41575bb42eb89`。
- 全局覆盖安装完成；本地与全局 `dist/cli.js` SHA-256 同为 `A4F08A9699C8990ADBA9E5B0E87F283F42D30EEEDA860B1356B1ECFA090D831F`。
- 无执行路径核对通过：Codex -> 包内 `codex.exe`，Claude -> 包内 `claude.exe`，Grok 保持 `C:\Users\33151\.grok\bin\grok.exe`；未调用任何 Agent CLI。
- 当前数据库再次只读确认 quick_check=ok、无 TriAgent 活进程、旧任务/陈旧锁仍原样存在；下一步使用 AppContext 的 `RECOVERY_CANCEL` 类型化路径处理。
- 首次一次性恢复脚本在执行前被 tsx CJS 转换拒绝（top-level await），数据库未打开、未发生副作用；已改为显式 async main 后重试。
- 类型化 `RECOVERY_CANCEL` 成功：启动时只允许 cancel，dispatch 返回 snapshot，任务从 awaiting_user -> cancelled。
- 只读数据库复核：quick_check=ok、activeLocks=[]、recovery operator completed、`project_lock_reconciliations` 有且仅有 1 条 release，审计使用 `recoveryEpisodeKey=pre-attempt` 且无伪造 attempt ID。
- 全局已安装 bundle 的隔离 app-root smoke 退出 0：screen=new_task、cwd=`D:\tmp`、语言 zh-CN、ProcessHost 未启动。
- 全局已安装 bundle 对默认数据库的无 AI smoke 退出 0：screen=new_task、workflowState=draft、projectPath=`D:\triagent`，原始 Recovery 症状未复现。
- 第 11 阶段完成；未删除/替换数据库，未抢占活锁，未调用 Grok 或运行真实 AI。

## 2026-07-13

- 恢复交接上下文并核对工作树、README、package scripts。
- 选择 `systematic-debugging` 追踪剩余失败，修复时遵循 TDD；完成前使用一次集中验证。
- 下一步：读取 CodexAdapter 授权消费路径和失败测试完整上下文，运行窄测试复现。
- 窄测试复现结果：`launch-authorization.test.ts` 为 2 failed / 6 passed，错误均为固定到 13:00 的授权在真实当前时间下过期。
- 已将两个应当成功消费授权的测试改为使用相对当前时间的 1 小时有效窗口；生产代码未改。
- 授权窄回归通过：1 个测试文件、8 个测试全部通过。
- `startup-reconcile.test.ts` 单独运行通过：11/11，总耗时 12.75 秒；下一步用 verbose 输出确认最慢用例并只提高对应测试超时。
- verbose 复测确认最后一项耗时 4542 ms；已按仓库既有模式仅为该用例设置 15 秒超时。
- 两处修改合并窄回归通过：2 文件、19 测试全部通过。
- 沙箱外完整离线测试通过：69 passed / 1 skipped files；798 passed / 6 skipped tests。
- typecheck 与 build 成功；pack dry-run 的 prepack 暴露 `npm_config_dry_run` 继承问题，导致嵌套 e2e pack 不生成 tarball。
- 已在 `scripts/run-prepack.mjs` 中清除仅属于外层生命周期的 dry-run 配置；下一步先用带该环境变量的 package e2e 做窄回归，再重跑 pack dry-run。
- 原始 `npm.cmd pack --dry-run --json` 已转绿，完整 prepack、typecheck、build 和 9 项包清单全部成功。
- 已用本轮实际测试计数、耗时、包大小、SHA-1 与 integrity 更新验收清单；真实 Codex/Claude/Grok smoke 与真实闭环仍明确标记为 NOT RUN。
- 全局 `triagent` 实际打开后进入诊断模式；已确认不是用户项目或数据库损坏，而是安装包漏带 migration SQL。
- 已先补打包回归断言：构建产物必须完整复制 migration，tarball 必须包含全部 6 个 SQL；下一步运行红灯测试。
- 红灯确认：packaging-security 9 项中 2 项按预期失败，分别为 package allowlist 缺项与 `dist/migrations` 不存在。
- 已在 tsup 成功钩子中复制受限命名的 migration SQL，并将 `dist/migrations/*.sql` 加入打包白名单。
- 完整 build、typecheck、packaging-security 与 package-install e2e 通过（2 文件、10 测试）。
- 已覆盖全局安装、关闭旧诊断窗口并重新打开 TriAgent；首次数据库成功创建。

## 2026-07-14

- 开始设计 cwd 自动项目选择与 Claude Code 风格精简 TUI，遵守不使用子代理、不提交 Git。
- 已阅读 CLI/TUI 入口和主要组件，确认自动目录应在 CLI 组合后直接派发项目选择，而非仅预填表单。
- 可视化伴侣服务器前两次启动分别因 WSL 未安装、Git Bash coreutils PATH 缺失而失败；下一步使用显式 Git Bash PATH。
- 已绕过不可用的 shell 包装，直接启动底层本地可视化服务器；用户确认了“当前目录 + 单一大输入框”的启动页方向。
- 用户认为初版 ASCII 宠物不够美观；已检索 GitHub 上 Crush、OpenCode、Codex、Oh My Pi 及多个 Claude Code 宠物项目，准备改为固定网格的原创像素宠物。
- 用户确认采用 GitHub 调研后重画的 TriFox 固定像素宠物和单输入框启动页；开始确认中英文切换规则。
- 用户选择语言方案 A：首次跟随 Windows 语言，`/lang` 在中文/English 间切换并记住选择。
- 已确认 cwd 自动选择、语言设置持久化和 TUI 状态传播的代码接入点，准备提交完整设计供批准。
- 用户确认首版 Slash Commands 为 `/lang` 与 `/help`，并明确要求开始实现计划。
- 已恢复规划文件、核对工作树与 package scripts，并开始映射 CLI、设置、TUI 状态和测试入口；继续遵守不使用子代理、不调用 Grok、不提交 Git。
- 已确认 cwd 成功选择会由现有控制器转到 `new_task`，失败会停留在 Project fallback；已确定 `/help` 使用共享 modal、`/lang` 使用持久化类型化 intent 的实现边界。
- 已写入批准后的设计规格 `docs/superpowers/specs/2026-07-14-cwd-start-screen-i18n-design.md`；根据用户约束跳过子代理审查与 Git 提交，开始生成实现计划。
- 已生成实现计划 `docs/superpowers/plans/2026-07-14-cwd-start-screen-i18n.md`，拆分为语言设置、cwd、Slash Commands、StartScreen/TriFox、其余 UI 本地化和最终安装验证六个 TDD 任务。
- Task 1 RED：新设置/i18n 窄测试按预期失败（6 个断言失败，i18n 模块不存在），证明旧实现没有 `uiLanguage`、不接受该键且没有文本目录。
- Task 1 GREEN：`tests/unit/config/settings.test.ts` 与 `tests/unit/tui/i18n.test.ts` 共 9/9 通过；`npm.cmd run typecheck` 退出 0。已支持 `auto | zh-CN | en`、旧设置缺省兼容和类型安全中英文文本目录。
- Task 2 RED：`application-lifecycle.test.ts` 新增 3 个 cwd 场景；正常选择与无效目录 fallback 两项按预期失败，recovery 保护项已通过，证明旧 `runCli()` 未使用启动目录。
- Task 2 GREEN：`application-lifecycle.test.ts` 14/14 通过。`runCli()` 只在初始 Project 屏选择注入/真实 cwd；无效路径保留可编辑 Project fallback 与错误；recovery/diagnostic 不读取 cwd。
- Task 3 parser RED：`slash-commands.test.ts` 因模块不存在按预期失败，确认当前没有 Slash Command parser。
- Task 3 command-flow RED：keyboard/AppContext 窄回归出现预期 5 项失败；旧实现把 `/help`、`/lang`、未知命令都当任务，AppContext 对语言 intent 仅返回 accepted 且不保存。
- 实现时一次大补丁因上下文定位不匹配失败；已拆分为 i18n、store/keyboard/modal、AppContext 三个小补丁，避免重复同一失败方式。
- Task 3 GREEN：parser、keyboard、AppContext 三个窄套件 31/31 通过，typecheck 退出 0。`/help` 打开可 Esc 关闭的 modal；`/lang` 原子持久化并在失败时保持旧语言；未知命令不再创建任务。
- Task 4 RED：`start-screen.test.tsx` 因 TriFox/StartScreen 尚不存在按预期失败。
- Task 4 GREEN：StartScreen/TriFox 与 keyboard 共 18/18 通过，typecheck 退出 0。启动页现为当前路径、单一圆角任务框、精简提示和固定 24x7 的四状态原创三尾 TriFox；旧 NewTaskScreen 已移除。
- Task 5 RED：更新后的 run/recovery 规格测试出现预期 6 项失败，旧界面仍输出 Screen/Workflow/Layout/Retry/Log tab 重复行且没有中文标签。
- Task 5 GREEN：全部 `tests/unit/tui` 7 文件、54/54 通过，typecheck 退出 0。运行、恢复、Project fallback、Diff、健康、历史、计划确认、审查、设置及全局 modal 均接入双语 UI；StatusBar 只保留重要状态、退出阻塞和当前合法快捷键。
- Task 6 完整回归：73 passed / 1 skipped files；826 passed / 6 skipped tests。typecheck 通过；build 首次仅因沙箱读取 NuGet.Config 被拒，沙箱外重跑成功。
- 标准 prepack 沙箱外达到 822 passed / 9 skipped，仅 `grok --version` 由锁定的 0.2.93 变为本机 0.2.101 导致 1 项失败；未修改无关 Adapter 兼容门禁。
- 使用已验证 build 执行 `npm pack --ignore-scripts`：15 entries，33,403,768 bytes，SHA-1 `aee302260319e3a9a77d2bfcaffe6225eabf7d63`；已覆盖全局安装。
- 已安装 bundle 无真实 AI smoke 通过：从 `D:\tmp` 启动自动选择 `D:\tmp`，首屏 `new_task`；语言 `zh-CN -> en` 后重启仍为 `en`；全局 `triagent --help` 退出 0。
- 用户批准继续实现 CLI 新版本自动兼容层；已恢复规划文件并开始系统化追踪 compatibility matrix、health probe、command builder 与启动授权之间的数据流。
- 已确认根因是四层精确门禁叠加：health supported array、exact compatibility matrix、command builder 常量检查、测试内实际 CLI 精确版本断言；安全修复必须让“经探测生成的 record”贯穿这些层，而不是只改版本字符串。
- 本轮恢复确认实现仍位于 `.worktrees/triagent-implementation` 的 `feature/triagent-implementation`；根目录规划文件继续作为持久进度记录。当前 PowerShell 会话没有 `rg`，后续改用定向 `Get-ChildItem`/`Select-String`，并排除 `node_modules`/`dist`。
- 已完整读取 compatibility matrix、AppPaths 以及三个 health checker；确认动态 resolver 应介入现有 health 流程，并新增独立 app-data 缓存路径，不能改变 Grok 的 auth/read-only/project-write 安全结论。
- 已读取三个 command builder、Adapter、SafeAgentLaunchCoordinator 和 WorkerStartGateVerifier 的关键路径；确认需把动态 record 注册到统一 lookup registry，并只移除 builder 的精确版本常量门禁，保留 key/platform/capability 校验。
- 一次代码检索工具脚本误把 PowerShell 语句写进 JavaScript，立即改为正确的 `shell_command` 调用，未修改项目文件。
- 已写入用户批准的动态兼容规格 `docs/superpowers/specs/2026-07-14-cli-version-compatibility-design.md` 和内联 TDD 计划 `docs/superpowers/plans/2026-07-14-cli-version-compatibility.md`；按用户边界跳过子代理审查与 Git 提交，开始 Task 1 RED。
- Task 1 RED 已确认：新 `compatibility-resolver.test.ts` 因 `compatibility-probe-manifests` 模块不存在而按预期失败（1 file failed / 0 tests），证明动态 resolver/cache 尚未实现。
- Task 1 GREEN：实现严格版本范围、声明式 help-only manifest、contract hash、保守基线 record 克隆、统一 runtime registry、launcher identity、7 天 TTL probe receipt 和原子缓存；新测试 11/11 通过，typecheck 退出 0。
- Task 2 RED 已确认：health 新版本仍返回 `unsupported_version`，`AppPaths.cliCompatibilityCachePath` 与 capability-probe factory 输入均为 undefined；两套窄测试共 3 项按预期失败、46 项通过。
- Task 2 GREEN：三个 health checker 改为 matrix/resolver 判定，启动探测共享一个 app-data resolver/cache；AppPaths 新增专用缓存路径。health + startup 两套测试 49/49 通过，typecheck 退出 0。
- Task 3 RED：三个 builder 的动态版本 record 均被旧精确版本常量拒绝；同时发现 Grok command 测试还会真实执行本机 `grok --help`，一并改为环境无关 manifest 断言。
- Task 3 GREEN：删除三个 builder 的重复精确版本比较，保留 key/platform/capability/permission 门禁；移除常规测试中的真实 Grok CLI 调用。3 个 command 文件 86/86 通过，核心 6 文件 146/146 通过，typecheck 退出 0。
- Task 4 完整离线回归首次通过：74 files passed / 1 skipped；841 tests passed / 6 skipped，共 847 项；没有执行真实 AI 任务。已在 README 补充 CLI 升级探测、7 天缓存、失效条件和 fail-closed 边界。
- typecheck 与 build 均退出 0；ProcessHost SHA-256 为 `82f5c98216959e30517c58ccd79f5b06dd8958bd5db41708aa48c4454abe6ec4`，CLI bundle 898.36 KB。
- 标准 prepack 首次在受限沙箱因 npm cache、CIM、ACL、Job Object 权限产生 25 项环境失败；同一命令沙箱外重跑通过：packaging stress 6/6，完整 prepack 74 files passed / 1 skipped，838 tests passed / 9 skipped，随后 typecheck/build 均成功。旧 Grok 0.2.101 精确版本失败已消失。
- 最终 tarball 写入 `D:\tmp\triagent-orchestrator-0.1.0.tgz`：15 entries，33,418,057 bytes，unpacked 76,371,323 bytes，SHA-1 `525e4ec062a964553c49a0f974eea98a5a595d80`；已 `npm install -g` 覆盖全局安装。
- 全局安装 smoke 通过：`triagent --help` 退出 0；从 `D:\tmp` 导入已安装 bundle，使用 `--skip-health-probes --skip-process-host` 和注入 render 后返回 completed/0，首屏 `new_task`、projectPath=`D:\tmp`、兼容缓存路径为 app-root 下 `cli-compatibility-cache.json`。没有调用任何 AI 或 Grok。
- 已用本轮测试计数、prepack、包哈希、动态兼容边界和安装 smoke 更新 `docs/verification/acceptance-checklist.md`。
- 收到用户要求“直接重做一遍，不要再发挥”；已锁定 `pet-polish-v4.html` 为唯一启动页验收基准，不重新提案、不使用子代理。
- 恢复审计确认有效工作树/分支不变；下一步先读取确认稿、当前 StartScreen/TriFox 和测试，写出能够证明布局偏差的红灯测试。
- 当前 PowerShell 会话的 `rg` 不在 PATH；一次检索失败后已切换为定向 PowerShell 搜索，未修改项目代码。
- 第一次更新规划文件的补丁因 `findings.md` 上下文少了一个空格而未应用；已修正上下文后重试，避免重复同一失败输入。
- 已完整读取确认稿、当前 StartScreen、TriFox 与启动页测试。偏差由实现布局和测试缺口共同造成，不是旧全局安装或终端字体问题。
- TDD 下一步：增强 `start-screen.test.tsx`，分别约束宽屏布局、固定网格三尾像素狐狸与窄屏纵向降级；先运行并确认按预期红灯，再改生产代码。
- 已打印当前 120 列真实 frame，稳定复现“左侧线条狐狸 + 右侧三行小输入框”的错误布局。
- SVG 降采样分析前两次 `node -e` 因 PowerShell/native argv 引号处理失败，第三次改用 base64 data-URL module 后成功；不会把这些临时分析脚本写入项目。
- StartScreen 红灯测试确认：1 文件中 4 项按预期失败、帮助 modal 1 项通过；失败分别锁定外框/布局、金色主题、窄屏溢出和 TriFox 网格。
- 完成 StartScreen、TriFox 与启动页 i18n 重写后，启动页 5/5 通过，typecheck 首轮退出 0。
- 打印真实 frame：100 列宽屏已呈现完整外框、左上品牌、右上像素 TriFox、Project 全宽区和 9 行输入框；60×24 中文为 23 行、最大宽度 59。
- 首次 `tests/unit/tui` 为 2 failed / 53 passed：一个是运行页标签被意外缩写，另一个是键盘测试仍断言旧启动页等号布局。拆分启动页专用文案键并更新行为断言后，7 文件、55/55 通过。
- 集中 `npm.cmd run prepack`：packaging stress 6/6、完整离线套件 839 passed / 9 skipped、typecheck 均通过；build 在 tsup unlink 旧 SHA-256 文件时因 `EBUSY` 退出 1。下一步只诊断文件占用并重跑 build，不重复已通过的全套测试。
- 检查 EBUSY 目标文件属性/ACL/哈希及 Node 进程命令行，未发现 TriAgent 构建占用；一次定向 `npm.cmd run build` 重试成功，CLI bundle 903.87 KB。
- `npm.cmd pack --ignore-scripts --json` 成功：15 entries，33,420,440 packed bytes，SHA-1 `58777f2642a8598c360a5ec24dfbb59ba61a1609`；已覆盖全局安装。
- 本地与全局 `dist/cli.js` SHA-256 完全一致，`triagent --help` 退出 0；安装包级无 AI smoke 从 `D:\tmp` 进入 `new_task`、自动选择 `D:\tmp`、语言 `zh-CN`、ProcessHost 未启动并正常退出。
- 第 10 阶段完成；未使用子代理、未调用 Grok/真实 AI、未执行 Git commit/reset/checkout/clean。
- 用户实际创建任务 `task-cc890b03-3528-4503-84c1-d35f177358d8` 后立即进入 Recovery：状态 `awaiting_user`，原因是项目锁被判定为另一应用实例持有，当前允许 inspect/cancel。
- 开始系统化检查默认 app-data 数据库、锁 owner/lease、应用实例 identity 和存活进程；不会删除 `triagent.db`，也不会在未确认陈旧前强制释放锁。
- 一次源码搜索命令错误地在 PowerShell 中引用了 JavaScript 局部变量 `$worktree`，导致 Join-Path 空值；已改用明确工作树路径后成功，未修改项目。
- 只读进程检查确认没有 TriAgent 活进程；只读 SQLite 诊断确认数据库健康、锁属于同一任务且已过期，原始失败是 Codex/Claude `CreateProcessW failed`。
- 下一步追踪环境失败后的锁释放/重启 reconcile 与 Windows CLI launcher 数据流，分别建立最小红灯测试；当前数据库不做手工 SQL 删除。
