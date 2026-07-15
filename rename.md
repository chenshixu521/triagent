# Rename / identity notes

This repository is the public home of **TriAgent** (`triagent-orchestrator`).

| Context | Name / path |
| --- | --- |
| npm package | `triagent-orchestrator` |
| CLI binary | `triagent` |
| GitHub repository | `https://github.com/chenshixu521/triagent.git` |
| Local development checkout (historical) | `agent_help` |
| Isolated implementation worktree (historical) | `.worktrees/triagent-implementation` |

## Role defaults (isolated Grok path)

| Role | Adapter |
| --- | --- |
| master / planning / master validation | Claude |
| implementer | Grok (candidate workspace only) |
| reviewer | Codex |
| Canonical writer on promote | PatchApplier |

## Install (from a release tarball or local pack)

```powershell
npm pack --ignore-scripts
npm install -g .\triagent-orchestrator-0.1.0.tgz --ignore-scripts
triagent --help
```

Do not install with `npm install -g .` from a full git checkout if you want a slim package layout; prefer `npm pack` first.
