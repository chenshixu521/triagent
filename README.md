# TriAgent 编排器

面向 Windows 的终端编排工具：通过受监管的工作流，协调三个协作编码代理（规划 / 实施 / 审查角色）。持久状态存放在项目树之外；每一次真实代理进程都由原生 Windows Job Object 辅助程序监管。

这是带有明确护栏与限额的 **尽力而为（best-effort）** 编排。它 **不** 承诺完美沙箱、辅助程序代码签名、完美安全隔离，也不保证能完全抵御恶意或已被攻破的 CLI。

## 前置条件

| 要求 | 说明 |
| --- | --- |
| **Windows x64** | 打包的原生辅助程序主要支持平台。 |
| **Node.js ≥ 24** | 与 `engines.node` 及 `@types/node` 24 一致。在 Windows 上请使用 `npm.cmd`。 |
| **.NET 10 SDK** | 仅在从源码 **构建** 原生 ProcessHost 时需要（`net10.0`）。请从 [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download) 安装。构建脚本 **不会** 自动下载 SDK 或工具链。 |
| **PowerShell** | `build:native` 使用（`scripts/build-native.ps1`）。 |
| **各代理 CLI** | 厂商 CLI 需已由你安装并 **登录 / 完成认证**。TriAgent **不** 存储凭据、API token 或登录 cookie。 |

## 安装（全局，推荐从打包 tarball）

```powershell
npm.cmd run build
npm.cmd pack --ignore-scripts
npm.cmd install -g .\triagent-orchestrator-0.1.0.tgz
triagent --help
```

打包 tarball 体积较大（约 70–100+ MB），因为内含 **自包含** 的 win-x64 ProcessHost 辅助程序，这是预期行为。

本地开发：

```powershell
npm.cmd install
npm.cmd run build
node dist/cli.js --help
```

### 构建脚本

| 脚本 | 行为 |
| --- | --- |
| `npm.cmd run build:native` | 将 ProcessHost 全新发布到唯一暂存目录，校验 PE x64，再原子提升到稳定发布路径。若新 exe 缺失则失败（绝不静默复用陈旧预构建产物）。 |
| `npm.cmd run build:trust` | 计算辅助程序 SHA-256 / 长度 / PE machine，并写入 `src/process/generated-native-helper-trust.ts`（仅确定性常量）。 |
| `npm.cmd run build:node` | 用 tsup 打包 CLI（`dist/cli.js` + source map），嵌入信任常量，并将运行时 SQLite migrations 复制到 `dist/migrations/`。 |
| `npm.cmd run build:copy-native` | 带锁的安全复制到 `dist/native/win-x64/`，备份交换式原子替换；对照嵌入信任常量校验。 |
| `npm.cmd run build` | 在进程间锁下编排：native → trust → node → copy。 |
| `npm.cmd run prepack` | 带锁执行 `test` → `typecheck` → `build`。打包 e2e 时可设 `TRIAGENT_SKIP_PREPACK=1` 或使用 `npm pack --ignore-scripts`，避免 prepack 递归。 |
| `npm.cmd run typecheck` | `tsc --noEmit`。 |
| `npm.cmd test` | Vitest。 |

### 发布白名单（`files`）

仅打包以下路径：

- `dist/cli.js`（以及预期的 `dist/cli.js.map`）
- `dist/migrations/*.sql`
- `dist/native/win-x64/triagent-process-host.exe`
- `dist/native/win-x64/checksum-metadata.json`
- `dist/native/win-x64/triagent-process-host.sha256`
- `schemas/`
- `README.md`

排除：`src/`、测试、docs/plans、worktrees、日志、数据库、快照、设置、token、env 文件、tarball、原生源码/构建中间产物，以及 `dist/native` 下所有临时 `.tmp` / `.bak` / 点文件。

### 辅助程序信任与失败关闭校验

运行时发现 **仅** 解析包内相对路径：

`dist/native/win-x64/triagent-process-host.exe`

在启用真实运行前会校验：

- 打开 / stat / 哈希前后均在包路径内；
- 普通文件，**不是** reparse/symlink；
- `nlink === 1`（拒绝硬链接异常）；
- SHA-256 与字节长度必须匹配编译进 `dist/cli.js` 的 **嵌入** 信任常量（旁路元数据本身不是信任锚；同时替换 exe+metadata 会失败）；
- PE machine 必须恰好为 `0x8664`（win-x64）— 架构未定义则拒绝。

辅助程序缺失或不匹配时 **失败关闭**，禁用真实运行并给出诊断。TriAgent 绝不在 `PATH`、cwd、项目树或临时目录中搜索替代辅助程序。生产 API **不** 接受任意辅助程序路径覆盖（CLI/设置/环境变量均不可指定）。测试仅可通过显式、仅测试用的工厂注入假辅助程序，且无法由不可信输入选择。

构建/复制使用进程间锁，使并发的 `build` / `copy-native` / pack 串行化，成功后不留下 tmp/bak/lock 残留。

本包 **不** 对辅助程序提供 Authenticode / 代码签名保证。

## CLI 用法

```text
triagent [options]

  --help                 显示帮助并退出（不启动应用）
  --diagnostic           以数据库诊断 / 恢复导向模式打开
  --app-root <path>      覆盖持久应用数据根（测试用；绝对路径）
  --skip-health-probes   启动时跳过适配器能力/健康探测
  --skip-process-host    不启动原生 ProcessHost 辅助程序
```

帮助模式不会组装应用、不会打开项目数据库，也不会启动适配器、worker 或原生辅助程序。

### 退出与进程策略

- CLI **永不** 从终端会话脱离（detach）。
- 处理器返回可测试的退出码并设置 `process.exitCode`；在 Job Object / worker 可能仍存活时，**不会** 用提前 `process.exit` 绕过清理。
- 关闭采用失败关闭：在清理被授权完成前，退出会被阻塞。

## 认证与代理 CLI

TriAgent 驱动 **已有的** 厂商 CLI。真实运行前请先完成各厂商自己的登录 / 认证流程。TriAgent 不收集、不持久化 API 密钥、OAuth token 或会话 cookie，也不会在发布包中嵌入机器相关的绝对路径。

### CLI 升级兼容性

启动时 TriAgent 会读取已安装的 Codex、Claude、Grok 版本。内置基线版本使用静态兼容矩阵。同一支持主版本内的更新版本，仅在固定、无模型参与的 `--help` / `inspect --help` 探测确认当前命令模板用到的每个 flag 均可用后，才会被接受。缺失 flag、超时、非零退出、预发布版本、降级以及下一主版本仍保持禁用。

成功探测回执会缓存 7 天，路径为 `%LOCALAPPDATA%\TriAgent\cli-compatibility-cache.json`（或测试用的 `--app-root`）。回执绑定 CLI/版本/平台、启动器路径与 SHA-256，以及探测契约哈希；过期或身份/契约任一变化会强制重新探测。缓存不含能力布尔值、凭据或提示词。TriAgent 不会自动改写自身或臆造替代 flag。`--skip-health-probes` 也会跳过动态版本发现，因此该次启动中未知版本仍失败关闭。

## 护栏与限额（尽力而为）

- 项目路径策略与补丁校验尽量阻止路径逃逸、任意 shell 与依赖安装 — **尽力而为**，不是对抗恶意代理二进制的安全边界。
- 运行时与调用预算会持久化，并在重启后继续强制执行。
- 在适配器遵守配置时，审查 / 主控角色相对项目写入视为只读。
- 实施方返工有上限（含产品层 **3 次返工** 限制）。
- 真实运行由 Windows Job Object 监管进程树；清理用 PID + 启动时间身份校验。
- SQLite 损坏时进入 **诊断** 模式：禁用副作用。

**不要** 把 TriAgent 当作完美的多租户沙箱，或 OS 级隔离的替代品。

## Git 与非 Git 项目

- **Git 项目**：基线使用只读 git 检查。脏工作区会保留；基线模块不会 reset、checkout、clean、commit 或 push。
- **非 Git 项目**：使用文件基线与快照；会谨慎记录 reparse/symlink 元数据，在强制处外部逃逸失败关闭。

## 工作流能力

- 三个协作代理之间的动态角色选择。
- 审查与返工循环，带结构化结果与主控终检。
- 启动时崩溃恢复 / 对账。
- 设置存放在持久应用根下（不在项目内）。仅运行时的覆盖不会作为凭据自动持久化。

## 持久数据位置

在 Windows 上，持久数据默认位于 `%LOCALAPPDATA%\TriAgent`（SQLite、JSONL 日志、快照、原生辅助程序诊断、设置）。**绝不是** 项目 cwd。仅测试可用 `--app-root` / `TRIAGENT_APP_ROOT`（绝对路径）覆盖。

## 测试

```powershell
npm.cmd test
npm.cmd run typecheck
```

### 真实 AI 测试（可选开启，默认关闭）

```powershell
$env:TRIAGENT_REAL_AI_TESTS = '1'
npm.cmd test -- tests/e2e/real-cli-smoke.test.ts
```

未设置 `TRIAGENT_REAL_AI_TESTS=1` 时，测试套件不得发起在线 AI 调用。

## 许可证

私有包（`"private": true`），除非之后另行添加许可证文件。
