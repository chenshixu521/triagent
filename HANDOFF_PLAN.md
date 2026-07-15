# TriAgent 后续实施交接计划

## 1. 最终目标

Claude master / Grok 隔离 implementer / Codex reviewer → PatchApplier 提升。

## 2. 工作树与主仓

- 实施工作树：`D:\codex\project\agent_help\.worktrees\triagent-implementation`（历史实施环境）
- **源码已合入主仓根目录** `D:\codex\project\agent_help`（`main`）
- 新开发默认在主仓进行；工作树可保留作对照，不再作为唯一真相源

## 3. 状态

| Task | 状态 |
|------|------|
| 1–11 离线隔离实施 | **完成** |
| 12 真实三 AI e2e | **完成** |

## 4. Task 12 验收证据

成功跑：`D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168`

- `passed: true`，`exitCode: 0`，`workflowState: completed`
- Claude plan → Grok isolated implement → Codex review **approved** → Claude master **approved** → **promote**
- `postApplyVerified: true`，canonical 出现 `triagent-smoke.txt`
- 内容：`TriAgent isolated Grok smoke completed.`
- workspace `promoted`，`activeLocks: []`，0 rework
- harness：`D:\tmp\triagent-isolated-grok-e2e-smoke.mjs`

## 5. 关键修复（Task 12 收尾）

- Codex custom provider：省略 `--output-schema` 时避免 502；freeform 解析 AgentResult
- rework 时 reissue workspace authorization 并更新 `attempt_id`
- master/review 增加 `inspectionRoot`：cwd/`--add-dir`/`-C` 指向 **candidate**，避免误看未 promote 的 canonical
- smoke 放宽预算（180 min 总 / 45 min 每 attempt / 50 calls）

## 6. 复跑

```powershell
Set-Location 'D:\codex\project\agent_help'
npm.cmd run build
$env:TRIAGENT_REAL_AI_TESTS = '1'
node D:\tmp\triagent-isolated-grok-e2e-smoke.mjs
```

期望：`workflowState=completed`，canonical 有 `triagent-smoke.txt`，workspace `promoted`，`activeLocks=[]`。

## 7. 边界（仍有效）

- 不抬高 Grok live projectWrite
- 不 `--always-approve`
- Claude/Codex 上游偶发 502 属于外部服务，不绕过隔离安全门禁
