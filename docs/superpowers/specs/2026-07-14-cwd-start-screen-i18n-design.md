# TriAgent 启动体验与双语命令设计

日期：2026-07-14  
状态：用户已批准直接进入实现  

## 1. 目标

本次改动把 TriAgent 的首次交互收敛为一个清晰入口：用户在哪个目录运行 `triagent`，该目录就自动成为项目根目录；正常启动直接显示任务输入页，不再要求重复输入路径。同时重做启动页的信息层级，加入固定尺寸的原创三尾像素宠物 TriFox，并让 UI 提示可在中文和 English 之间切换。

首版 Slash Commands 仅包含：

- `/help`：显示操作说明和当前可用命令，Esc 关闭。
- `/lang`：在中文与 English 之间切换，并持久化选择。

## 2. 非目标

- 不翻译项目路径、代码、命令、Diff 或 Agent 原始日志。
- 不新增更多 Slash Commands、命令自动补全或命令历史。
- 不改变 Agent 编排、权限、恢复模式、数据库诊断或生命周期退出规则。
- 不加入宠物成长、喂养、复杂动画等与编排无关的功能。
- 不调用真实 AI、Grok 或消耗外部模型额度。

## 3. 启动目录行为

`runCli()` 在应用组合完成且进入 Ink render 之前读取 `process.cwd()`。只有初始 snapshot 的 screen 为 `project` 时，才派发一次类型化 `SELECT_PROJECT` intent。

- 选择成功：沿用现有 `TaskSessionController`，进入 `new_task` 屏并显示规范化项目路径。
- 目录无效或不可用：控制器返回 rejected，仍停留在 `project` 屏，用户可编辑路径并重试。
- 初始状态为 `recovery` 或数据库 diagnostic：不派发自动项目选择，避免覆盖恢复证据或触发被禁止的副作用。

为保证测试不依赖测试进程的真实目录，`RunCliDependencies` 增加可注入的 `cwd()`。

## 4. Slash Command 架构

新增独立、无副作用的 Slash Command parser。parser 接收裁剪后的任务输入和当前 UI 语言，只返回类型化结果：

- `/help` -> 打开帮助 modal。
- `/lang` -> 计算目标语言并派发语言更新 intent。
- 未知 `/...` -> 返回可本地化的错误，不创建任务。
- 普通文本 -> 保持现有 `CREATE_TASK` 流程。

解析逻辑不直接写设置、不操作 React 状态，也不嵌入键盘 hook 的字符串分支。`useKeyboard` 只负责在 Enter 时将 parser 结果转换为 intent。

`/help` 是纯 UI 行为，通过共享 `GlobalModal` 渲染；`/lang` 是持久状态变更，通过控制器交给 AppContext 调用现有原子 `updateSettings()` / `saveSettings()` 路径。

## 5. 语言设置与文本目录

`AppSettings` 新增：

```ts
uiLanguage: 'auto' | 'zh-CN' | 'en'
```

默认值为 `auto`。旧设置文件缺少该字段时自动补默认值，保持向后兼容；非法值仍按现有 fail-closed 校验拒绝。

首次启动时，`auto` 根据系统 locale 解析：以 `zh` 开头使用中文，否则使用 English。用户执行 `/lang` 后持久化明确值 `zh-CN` 或 `en`，下次启动沿用。

新增内嵌 TypeScript 文本目录，键名受类型检查约束。UI 组件通过 snapshot 中已经解析后的语言选择文本。路径、代码、命令、Diff 和 Agent 日志始终原样显示。

## 6. 启动页与 TriFox

`new_task` 屏必须以已由用户确认的
`.superpowers/brainstorm/triagent-tui-20260714/pet-polish-v4.html`
为唯一视觉基准。后续概括性文字不得覆盖其中的明确位置、颜色和层级约束。

- 整个启动页位于一个完整圆角终端外框内，保留明显的内边距和纵向留白。
- `TRIAGENT` 使用金色强调色 `#d6a756`，位于左上；副标题在其下方。
- 宽终端的 TriFox 固定在右上，不能作为左侧栏挤压 Project 与输入区；窄终端才纵向堆叠。
- Project 标签与项目路径独占完整一行区域，并与左上品牌左边缘对齐。
- 任务输入区横跨可用宽度，宽终端至少 9 行高；标题、输入内容和底部快捷键具有清晰留白。
- 输入框底部左侧显示 Enter 启动，右侧显示 Ctrl+P 计划确认及当前状态。
- 角色分配位于输入框下方；Tab、`/help`、`/lang`、Ctrl+C 等次要操作位于最底部。
- 移除启动页重复的 Screen、Workflow、Process、Retry、Layout、Pause、Log tab 等调试式状态行。

TriFox 直接从确认稿 SVG 的矩形像素结构转换为固定 32×10 终端网格，保留三条独立尾巴和三枚 Agent 领灯；不得替换为普通斜杠 ASCII 狐狸。`idle`、`thinking`、`success`、`error` 四个状态使用完全相同的行数与列宽。终端无法原样表达网页阴影与 SVG，但位置、金色主题、完整外框、大输入区和像素结构必须忠实保留。60×24 窄终端采用纵向布局且不得横向溢出。

## 7. 帮助界面

`/help` 打开全局 modal，按当前语言显示：

- Enter、Backspace、Tab、Ctrl+P、Ctrl+C、Esc 的核心操作。
- `/help` 和 `/lang` 两个命令。
- 说明 `/lang` 会保存语言选择。
- 提示路径、代码、Diff 和 Agent 日志不会翻译。

帮助 modal 不触发控制器副作用；Esc 使用现有 `DISMISS_MODAL` 路径关闭。

## 8. 错误处理

- cwd 选择失败：保留 Project fallback，并显示控制器返回的具体错误。
- `/lang` 持久化失败：保持原语言并显示错误，不伪装成功。
- 未知 Slash Command：显示“未知命令，可使用 /help”，不创建任务。
- diagnostic/recovery：不执行 cwd 自动选择；现有只读限制保持不变。
- 翻译键遗漏：类型检查失败，不在运行时静默显示 `undefined`。

## 9. 测试策略

按 TDD 分批实现：

1. CLI 单元测试覆盖正常 cwd 自动选择、无效 cwd fallback、recovery/diagnostic 不覆盖。
2. 设置测试覆盖 `uiLanguage` 默认值、旧文件兼容、非法值拒绝、保存/重载。
3. parser 单元测试覆盖 `/help`、`/lang`、大小写/空白、未知命令和普通任务文本。
4. store/controller 测试覆盖 help modal 和语言更新成功/失败。
5. Ink 渲染测试覆盖完整外框、宽屏品牌左上/TriFox 右上、Project 左对齐、大输入区高度、底部快捷键、金色主题、32×10 三尾像素 TriFox、60×24 窄终端、中英文帮助 modal 和无重复状态噪声。
6. 最后运行相关窄测试、完整 `npm test`、`npm run typecheck`、`npm run build` 和打包检查。

## 10. 交付边界

本轮不使用子代理、不调用 Grok、不运行真实 AI 测试、不执行 Git commit/reset/checkout/clean。完成验证后再覆盖全局安装，并从非项目目录实际启动检查 cwd 行为与界面。
