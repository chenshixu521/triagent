# TriAgent CLI 动态版本兼容设计

日期：2026-07-14  
状态：用户已批准直接实现  

## 1. 目标

TriAgent 在每次启动时读取 Codex、Claude 和 Grok 的实际版本。已内置验证的精确版本继续直接使用；遇到符合兼容范围但尚未登记的新版本时，TriAgent 只运行无模型调用、无项目写入的帮助/检查命令来验证当前命令模板依赖的参数。探测通过后生成仅对该 CLI、版本、平台和本机可执行文件有效的运行时兼容记录，并写入本机 app-data 缓存。

这解决用户正常升级 CLI 后被精确版本字符串阻断的问题，同时保持未知版本默认禁用。

## 2. 非目标

- 不调用 Codex、Claude、Grok 模型，不发送 prompt，不消耗额度。
- 不自动安装、升级或降级任何供应商 CLI。
- 不修改 TriAgent 自身代码、命令模板或猜测新参数。
- 不因版本号更大就无条件放行。
- 不把帮助文本中的参数存在性等同于 Grok 的 live-project 权限隔离证明。
- 不提升现有未证明权限：Claude `projectWrite=false`；Grok `readOnly=false`、`projectWrite=false`、`nativePermissionRules=false`、`writeModes=[]`。

## 3. 兼容判定

内置 matrix 仍是信任锚。动态版本必须同时满足：

1. 版本是严格的三段数字稳定版本，不接受 prerelease/build 变体作为动态版本。
2. 版本不低于当前内置基线。
3. 版本低于下一主版本：Codex `>=0.144.1 <1.0.0`、Claude `>=2.1.206 <3.0.0`、Grok `>=0.2.93 <1.0.0`。
4. 当前 CLI 的声明式 probe manifest 全部通过。
5. 生成的 record 通过现有 `assertCompatibilityRecordInvariants()`。

超出范围、版本降级、预发布版本、探测超时、非零退出、输出缺少必需参数或缓存不可信时全部 fail closed，health 状态保持 `unsupported_version` 或原有更具体错误。

## 4. 无副作用能力探测

探测复用现有 `CommandProbe`，保持结构化 argv、`shell=false`、临时 cwd、5 秒超时、输出上限、脱敏和 ProcessSupervisor/Job Object 清理。manifest 只允许固定的帮助命令：

- Codex：`exec --help` 与 `exec resume --help`，验证 builder 使用的 JSONL、schema、sandbox、approval、non-Git 和 resume 参数。
- Claude：`--help`，验证 print/safe-mode/stream-json/text/session/resume/schema/permission/tools/add-dir 参数。
- Grok：`--help` 与 `inspect --help`，验证 cwd、prompt-file、streaming-json、session/resume、permission/tools/max-turns 和 inspect JSON 参数。

输出只做大小写不敏感的固定 token 匹配。缺少任何 builder 当前会发出的参数就不生成 record。manifest 本身做稳定序列化并计算 SHA-256；代码升级改变探测契约时旧缓存自动失效。

## 5. 能力生成与运行时 registry

动态 record 不从帮助文本自由推导布尔权限，也不从缓存加载任意 capabilities。它只从当前代码内置的同 CLI 基线 record 克隆，再替换目标版本和追加探测说明。这样动态能力最多等于当前保守基线，不能通过编辑缓存提升权限。

探测或缓存命中后，record 注册到 `compatibility-matrix.ts` 的进程内 runtime registry。`lookupCompatibility()` 统一查询静态 matrix 和 runtime registry，因此 Adapter、`SafeAgentLaunchCoordinator`、`WorkerStartGateVerifier` 与 command builder 后续按 immutable key 重查时都能获得同一个 record。

静态 key 不允许被 runtime record 覆盖；runtime record 注册前必须冻结并验证 invariants。

## 6. 本机兼容缓存

`AppPaths` 新增 `%LOCALAPPDATA%\TriAgent\cli-compatibility-cache.json`（测试仍使用 app-root override）。缓存只保存“探测收据”，不保存可提升权限的 record：

- schema version；
- CLI 名、版本、平台；
- 配置的 executable 字符串；
- PATH/绝对路径解析后的 canonical launcher 路径、文件大小、mtime 和 SHA-256；
- probe-contract hash；
- verified/expires 时间。

默认 TTL 为 7 天。以下任一情况都会失效并重新探测：过期、CLI/version/platform 不同、launcher 路径或内容身份变化、manifest hash 变化、结构损坏、字段越界。缓存文件限制大小和 entry 数；读取损坏时忽略，只有新探测成功后才以临时文件加原子 rename 重写。缓存位于 app-data，绝不写入用户项目。

同一进程内三个并行 health probe 共享一个 resolver；缓存更新通过 promise 队列串行化，避免相互覆盖。

## 7. 启动数据流

1. `composeApplication()` 解析 `AppPaths`。
2. `runProductionCapabilityProbes()` 创建共享 `CompatibilityResolver`。
3. 每个 health checker 完成现有 version 与 auth/inspect 检查。
4. health checker 先查统一 matrix；miss 时调用 resolver。
5. resolver 依次尝试：静态 record、有效缓存、声明式帮助探测。
6. 成功 record 注册到 runtime registry；health 返回 `available + compatibility`。
7. 后续 task runtime 的 Adapter health 不需要再次注入 resolver，因为 registry 已包含本次启动验证的 record。

使用 `--skip-health-probes` 时不会为未知版本创建动态 record；未知版本继续禁用。

## 8. Command builder 调整

三个 builder 删除“版本必须等于旧常量”的重复分支，但继续强制：

- record 已 verified；
- record key 与请求 key 完全一致；
- cliName 与 runtime platform 一致；
- 当前操作所需 jsonl/schema/readOnly/resume/fixedSession/nonGit/projectWrite/maxTurns 等 capability bit 已验证；
- 原有 prompt、sandbox、bundle、schema、budget、guard 和 authorization 限制不变。

因此 builder 不根据版本猜参数，只消费 resolver 已验证且与当前模板匹配的 record。

## 9. 测试与验收

按 TDD 覆盖：

1. 版本范围、降级/major/prerelease 拒绝。
2. probe 成功、缺 flag、非零退出、超时。
3. cache 命中、过期、损坏、identity mismatch、contract mismatch、原子重写。
4. unknown 新版本通过 resolver 后 health 可用；无 resolver 仍 unsupported。
5. runtime registry 可被 launch coordinator/worker gate 重查。
6. 三个 builder 接受 key 匹配且 capability 完整的新版本 record，仍拒绝 capability 缺失。
7. 删除默认测试中对本机 `grok --version` 的精确断言，所有常规测试保持离线和环境无关。
8. 最终运行窄测试、完整离线测试、typecheck、build、标准 prepack，并覆盖全局安装；不运行真实 AI 测试。

## 10. 交付边界

本轮不使用子代理、不调用 Grok、不运行真实 AI 或额度测试、不执行 Git commit/reset/checkout/clean。规格和计划按用户要求由当前代理直接检查一次后实现。
