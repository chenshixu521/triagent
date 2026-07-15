# 命名与身份说明

本仓库是 **TriAgent**（npm 包名 `triagent-orchestrator`）的公开源码主页。

| 场景 | 名称 / 路径 |
| --- | --- |
| npm 包名 | `triagent-orchestrator` |
| 命令行入口 | `triagent` |
| GitHub 仓库 | `https://github.com/chenshixu521/triagent.git` |
| 本地历史开发目录 | `agent_help` |
| 隔离实施工作树（历史） | `.worktrees/triagent-implementation` |

## 默认角色（隔离 Grok 实施路径）

| 角色 | 适配器 |
| --- | --- |
| master / 规划 / 主控终检 | Claude |
| implementer（实施） | Grok（仅可写候选工作区） |
| reviewer（审查） | Codex |
| 提升到正式项目时的唯一写入方 | PatchApplier |

## 安装（推荐：先打包再全局安装）

```powershell
npm pack --ignore-scripts
npm install -g .\triagent-orchestrator-0.1.0.tgz --ignore-scripts
triagent --help
```

若希望安装结果是精简发布布局，请不要直接对完整 git 检出目录执行 `npm install -g .`；应优先使用 `npm pack` 生成 tarball 后再安装。

## 数据目录

- 持久数据默认在 `%LOCALAPPDATA%\TriAgent`
- 不会写进项目工作目录（cwd）
- 不存储 API 密钥或凭证
