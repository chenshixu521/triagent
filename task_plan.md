# TriAgent 收尾计划

## 目标

在不运行真实 AI/Grok、不使用子代理、不执行 Git 清理或提交的前提下，修复剩余离线测试并完成一次集中验证与验收记录更新。

## 阶段

1. **已完成** — 修复 `launch-authorization.test.ts` 的固定时间失效问题，只调整测试时钟或测试数据，不放宽生产授权 TTL。
2. **已完成** — 单独复现 `startup-reconcile.test.ts`；仅在确认属于完整套件并发超时后调整测试超时，不改生产逻辑。
3. **已完成** — 集中运行完整离线测试、typecheck、build、pack dry-run。
4. **已完成** — 用本轮实际输出更新 `docs/verification/acceptance-checklist.md`，明确真实 AI/Grok/真实闭环未运行。
5. **已完成** — 修复全局安装包缺少 `dist/migrations/*.sql` 导致首次启动进入诊断模式；回归、重装并重新打开界面。
6. **已完成** — 完成“启动命令所在目录自动成为项目根目录”、精简启动页、TriFox、中英文 UI、`/lang` 与 `/help` 的设计确认并写入规格。
7. **已完成** — 已按 TDD 完成语言设置、cwd 自动选择、`/help`、`/lang`、新启动页、TriFox 和其余 UI 本地化。
8. **已完成** — 完整离线测试、typecheck、build、包清单、全局覆盖安装和无真实 AI smoke 已完成；标准 prepack 唯一阻塞为本机 Grok `0.2.101` 与旧精确版本门禁 `0.2.93` 不匹配，未放宽该无关安全门禁。
9. **已完成** — “CLI 新版本自动检测 + 无副作用能力探测 + 本机兼容缓存”已按 TDD 实现；完整离线测试、标准 prepack、打包、全局覆盖安装和无真实 AI smoke 全部通过。
10. **已完成** — 以 `.superpowers/brainstorm/triagent-tui-20260714/pet-polish-v4.html` 为唯一视觉验收基准，已按 TDD 重新实现并全局安装启动页：完整外框与留白、左上金色品牌、右上固定网格三尾 TriFox、全宽 Project 行、大尺寸任务输入区、输入框底部快捷键，以及底部角色/次要操作；cwd、`/help`、`/lang` 和窄终端降级行为保持通过。
11. **已完成** — 已按 TDD 修复新任务环境检查后的 Recovery 锁故障：Windows Agent CLI npm shim 安全解析到包内 native `.exe`；环境失败释放锁、重试重新获取；pre-attempt 启动恢复不再误入 Recovery；陈旧锁可通过审计化 cancel 清理；Recovery 只显示/派发合法动作。完整测试、typecheck、build、pack、全局安装和默认数据库无 AI smoke 均通过，现场旧任务已取消且活锁为 0。
12. **已完成** — 已按 TDD 修复同一路径再次创建任务时 `UNIQUE constraint failed: projects.root_path`：持久化层原子复用已有 canonical project ID，工作流用实际返回 ID 创建 task；完整离线验证、打包、全局覆盖安装及默认数据库无 AI smoke 均通过。
13. **已完成** — 已按 TDD 修复确认任务后的三项串联故障：Claude JSON auth 解析、Codex 0.144.4 全局 approval 参数/探测层级、pre-attempt 环境失败锁释放身份传播；完成完整离线验证、全局覆盖安装、三 CLI 无模型实机健康探测及默认数据库恢复清理。
14. **已完成** — 用户明确批准真实 AI 端到端验收：在隔离非 Git 目录中让 Claude(master)、Codex(implementer)、Grok(reviewer)完成“只创建一个固定内容文本文件”的简单需求，核对工作流终态、文件内容、三角色 attempt/review 证据与锁清理。
15. **已完成** — Task 1–12 全部完成。Task 12 全绿证据：`D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168`（promote + smoke 文件 + 零锁）。源码已从工作树合入主仓 `main`。
16. **已完成** — 收尾：更新 HANDOFF/progress/findings/acceptance-checklist；主仓可直接 `npm run build` 与 harness 复跑。

## 边界

- 不使用子代理。
- 不调用 Grok。
- 本阶段例外：用户已明确批准仅调用三个 CLI 的 version/auth/inspect/help 健康探测；仍禁止向 Grok 或其他 CLI 发送任务提示词、执行模型推理。
- 不运行真实 AI 或额度测试；除非用户再次明确批准并设置 `TRIAGENT_REAL_AI_TESTS=1`。
- 第 14 阶段例外：用户已明确批准本次隔离项目真实三 AI 任务；仅该 smoke 进程设置 `TRIAGENT_REAL_AI_TESTS=1`，不会持久化到设置。
- 第 15 阶段例外：用户已明确授权为上述固定角色组合做隔离实证和真实端到端验收；任何 Grok 写入能力必须绑定精确 CLI 版本/平台和可审计的隔离证据，不能以 `--always-approve` 或全局绕过门禁实现。
- 不执行 commit、reset、checkout、clean。
- 尽量只修改测试与验收文档；生产代码仅在证据证明必要时修改。

## 已知错误

| 错误 | 尝试次数 | 当前判断 |
| --- | ---: | --- |
| 两个授权 Adapter 测试报告 authorization expired | 1 | 已修复；窄回归 8/8 通过 |
| startup reconcile 在完整套件中 5 秒超时并伴随 EPERM 清理失败 | 1 | 最慢项单独 4542 ms；已仅为该项采用仓库既有的 15 秒测试上限 |
| `npm pack --dry-run` 的 prepack 内 package e2e 不生成 tarball | 1 | 已在 prepack 子进程环境清除外层 dry-run；原始 pack dry-run 命令退出 0 |
| 全局安装首次启动进入数据库诊断模式 | 1 | 已补齐 6 个 migration、10/10 打包回归通过、覆盖安装并成功创建数据库 |
| 可视化伴侣服务器启动失败 | 2 | 系统 WSL 未安装；Git Bash 首次调用未继承 coreutils PATH，下一次显式加入 `D:\Git\usr\bin` |
| build 在受限沙箱读取 NuGet.Config 被拒绝 | 1 | 沙箱外重跑成功；native helper 与 CLI build 均完成 |
| pack prepack 在受限沙箱出现 ACL/CIM/Job Object 拒绝访问 | 1 | 沙箱外重跑后权限类失败全部消失 |
| 标准 prepack 检测到 Grok 0.2.101，不匹配锁定的 0.2.93 | 1 | 不为 UI 任务放宽 Adapter 门禁；使用已验证 build 加 `--ignore-scripts` 生成本地安装包，并列入下一阶段兼容设计 |
| 启动页实现偏离已确认的 `pet-polish-v4.html` | 1 | 根因已定位为参考稿未进入精确布局测试；本阶段将先补失败测试，再重写 StartScreen/TriFox |
| 当前 PowerShell 会话找不到 `rg` | 1 | 改用定向 `Get-ChildItem` / `Select-String`，并避免递归扫描 `node_modules` |
| 集中 prepack 的 build 清理旧 `triagent-process-host.sha256` 时 EBUSY | 1 | 文件属性/ACL 正常且无 TriAgent 构建进程占用；一次定向 build 重试成功，未重复全套测试 |
| 新任务确认后 Recovery 报 project lock owned by different application instance | 1 | 已修复并部署；现场根因是 Codex/Claude npm shim 无法被 CreateProcessW 直接执行，加上环境失败未释放锁。旧任务已审计化取消，activeLocks=[] |
| Windows CLI identity 回归 4/4 红灯 | 1 | 预期失败：当前缓存绑定 `.cmd`，且未拒绝项目 shim/缺失 native target；开始实现安全解析器 |
| Recovery UI 多文件补丁上下文不匹配 | 1 | 已拆成较小 apply_patch 分步应用，未重复原命令，随后定向测试通过 |
| 集中 typecheck 报 3 个类型错误 | 1 | 已收窄 awaiting action 类型谓词并修正测试 union fixture；后续 typecheck 与 prepack 均退出 0 |
| 一次性恢复脚本 top-level await 转换失败 | 1 | 发生在执行前，数据库未变；已改为 async main，下一次运行使用不同脚本内容 |
| 同一路径新建任务触发 projects.root_path 唯一约束 | 1 | 已修复：upsert 返回持久化 ID，orchestrator 用返回值创建 task；未删除任何旧 project/task |
| 最终命令定位检查找不到 `triagent` | 2 | 受限验证进程无法枚举 npm 全局目录；非沙箱只读复核确认 `triagent.ps1/.cmd` 存在且 `triagent --help` 正常 |
| 确认任务时报 project lock release has no master attempt evidence identity | 1 | 已修复：ReleaseProjectLock 继承真实 environment-check consumedAction attempt ID；现场旧任务已类型化取消，active locks=[] |
| 三 CLI 安装包健康 smoke 被用户中断 | 1 | 中断后已用 CIM 只读复核，无残留 Node/ProcessHost；用户随后明确要求三个 CLI 全部检测，改为重新运行完整健康探测 |
| 受限沙箱查询 Win32_Process 被拒绝 | 1 | 非沙箱只读复核成功且无匹配残留进程 |
| 固定角色 Claude 规划 / Grok 实施 / Codex 审查在真实任务中失败 | 1 | Claude master 已完成；Grok 尚未启动即被 ProjectGuard 以 `neither direct-write nor read-only patch mode can be proven` 禁用，Codex 审查未到达；不是已观测到的网络连接失败 |
| 隔离 Grok 实施规格首轮审查发现规划歧义 | 1 | 首次补丁因上下文锚点不匹配未写入；随后按实际标题拆分补丁，补齐快照/链接/二进制策略、持久变更集 schema、全局漂移规则、Codex 结构化结论、保留策略及禁止 Shell/子进程的实施档案 |
| 隔离 Grok 实施计划首轮审查返回 Issues Found | 1 | TDD、提升、恢复、角色边界和端到端要求已在任务 1-12 中存在；采纳有效缺口并新增 ignored/generated、nested repo、secret/protected path、project-local TriAgent state 与 no-fallback 规则 |
| 恢复审计误判 `AppPaths`/migration 源码目录 | 2 | 未修改代码；先列出 `src` 顶层并定向搜索，确认实际位于 `src/config` 与 `src/persistence/migrations`，后续不再沿用错误路径 |
| repository 未终止字符串导致 typecheck 失败 | 1 | 已改为 `resolve(value).replaceAll('/', '\\')`；本轮复测 typecheck 与 workspace 集成测试均退出 0 |
