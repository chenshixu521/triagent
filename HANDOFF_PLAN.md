# TriAgent 后续实施交接计划

## 1. 最终目标

Claude master / Grok 隔离 implementer / Codex reviewer → PatchApplier 提升。

## 2. 工作树与主仓

- 实施工作树：`D:\codex\project\agent_help\.worktrees\triagent-implementation`（历史实施环境）
- **源码已合入主仓根目录** `D:\codex\project\agent_help`（`main`）
- 新开发默认在主仓进行；工作树可保留作对照，不再作为唯一真相源
- 当前 HEAD（文档更新时）：`608c993`（与 `origin/main` 同步）

## 3. 状态

| 项 | 状态 |
|------|------|
| Task 1–11 离线隔离实施 | **完成** |
| Task 12 真实三 AI e2e | **完成**（2026-07-15 首绿 + 2026-07-16 回归绿） |
| 同任务继续 / 进程清理 / 工作区复用 | **完成**（离线单测；真机专项可选） |
| 全角色续聊策略 + master 终检误续修复 | **完成** |
| 运行中上下文入队 | **完成**（`realTimeInput` 仍为 false） |
| agent-fail → awaiting_user 同会话 [C] | **完成**（`608c993`） |

## 4. Task 12 验收证据

### 最新成功跑（2026-07-16，推荐引用）

`D:\tmp\triagent-isolated-grok-e2e-1784163252628-47016`

- 任务：`task-0076e40b-e3ea-41fb-a97d-d9ca9d029e20`
- `passed: true`，`exitCode: 0`，`workflowState: completed`
- CLI：`D:\codex\project\agent_help\dist\cli.js`
- Claude plan → Grok isolated implement → Codex review **approved** → Claude master **approved** → **promote**
- `postApplyVerified: true`，canonical 出现 `triagent-smoke.txt`
- 内容：`TriAgent isolated Grok smoke completed.`
- workspace `promoted`，`activeLocks: []`，0 rework
- attempts：master / implementer / reviewer / master（终检）均 `completed`

### 首绿（2026-07-15）

`D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168` — 同上验收矩阵。

Harness：`D:\tmp\triagent-isolated-grok-e2e-smoke.mjs`  
详细清单：`docs/verification/acceptance-checklist.md`

## 5. 关键修复（Task 12 及之后）

### Task 12 收尾

- Codex custom provider：省略 `--output-schema` 时避免 502；freeform 解析 AgentResult
- rework 时 reissue workspace authorization 并更新 `attempt_id`
- master/review 增加 `inspectionRoot`：cwd/`--add-dir`/`-C` 指向 **candidate**
- smoke 放宽预算（180 min 总 / 45 min 每 attempt / 50 calls）

### 操作者上下文 / 同任务继续（main `797a2e6`…`608c993`）

- 同任务 `[C]` continue（不重建 taskId）
- BeginProcessCleanup + interrupt
- 中断后隔离 Grok 工作区复用
- CREATE_TASK / APPROVE 异步后台驱动；smoke 轮询终态
- 全角色 conversation resume；**master/reviewer 仅 interrupted 或 active 才 resume**（避免终检误续规划 session，`e9a1b1b`）
- 运行中 `[M]` 上下文：live / handle_queued / next_stage
- agent-fail 进入 `awaiting_user` 时 UI 暴露 continue/cancel；同会话 `[C]` 走 `continueAfterOperatorHold`（`608c993`）
- smoke 可对 `awaiting_user` 自动 `RECOVERY_CONTINUE`（应对 Claude 502 暂存）

## 6. 复跑

```powershell
Set-Location 'D:\codex\project\agent_help'
npm.cmd run build
$env:TRIAGENT_REAL_AI_TESTS = '1'
node D:\tmp\triagent-isolated-grok-e2e-smoke.mjs
```

期望：`workflowState=completed`，canonical 有 `triagent-smoke.txt`，workspace `promoted`，`activeLocks=[]`，summary `passed: true`。

说明：PowerShell 若用 `2>&1 | Tee-Object`，stderr 进度行可能被当成 NativeCommandError 使进程 exit 1；以 `summary.json` 的 `passed`/`exitCode` 为准。

## 7. 可选后续（非阻塞）

- 真机专项：中断 → `[C]` 同任务续跑 + 工作区复用
- 真机专项：运行中 `[M]` 注入上下文
- 真·实时 mid-turn 输入（需 CLI `realTimeInput` 验证，当前全 false）
- 将 smoke harness 迁入仓库 `scripts/`
- 完整离线 `npm test` 信心回归

## 8. 边界（仍有效）

- 不抬高 Grok live projectWrite
- 不 `--always-approve`
- Claude/Codex 上游偶发 502 属于外部服务，不绕过隔离安全门禁
