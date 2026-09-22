# code 工具连接与验收

首次打开进入「code列表」，没有默认工具。只有确认选择成功后才检测该工具；搜索、取消与未选工具不会被探测。选择页、工作台、速览和折叠岛共用同一选择。

## 当前能力（2026-09-16）

“已实现接入”表示已有协议适配和隔离测试，**不表示每款客户端、每个版本均已实机验证**。软件已安装或进程存在不能代替任务状态。

| 工具 | 接入与默认配置 | 使用条件 |
| --- | --- | --- |
| Codex | 只读 App Server 额度；官方 Hook + notify 任务 | 每台新电脑独立配置、审核；见[任务连接](codex-lifecycle-setup/README.md) |
| Claude Code | `~/.claude/settings.json`，嵌套 Hook | 启用 Hook，新开任务 |
| Kimi Code | `~/.kimi-code/config.toml`，`[[hooks]]` | 新版 Kimi Code CLI；普通 Kimi 聊天客户端不算 CLI |
| Gemini CLI | `~/.gemini/settings.json` | 启用 Hook，重开会话 |
| Qwen Code | `~/.qwen/settings.json` | 启用 Hook，重开会话 |
| WorkBuddy | `~/.workbuddy/settings.json`，支持 JSONC | 重启 WorkBuddy，按提示启用后开始新任务 |
| QoderWork | `~/.qoderwork/settings.json` | 重启 QoderWork；与 Qoder CLI 配置不同 |
| Cursor | `~/.cursor/hooks.json`，version 1、直接 command 数组 | 本机 Agent 任务；不含云端 Agent |
| ZCode | `~/.zcode/cli/config.json`，`hooks.enabled` / `hooks.events` | 新开会话 |
| OpenCode | `~/.config/opencode/plugins/xuanfudao.js` | 重启加载插件，接收 session 事件 |
| MiMo Code | `~/.config/mimocode/hooks/xuanfudao.ts` | 支持文件 Hook 的版本；新建会话 |
| 豆包工作 | **未接入** | 尚未确认可靠的外部任务事件接口；内部工具日志不足以判断整项任务结束 |
| TraeWork | **未接入** | TraeCode IDE 的 Hook 接口不能冒充 TraeWork / SOLO 完整接入 |
| DeepSeek Harness | **未接入自动配置** | 官方桥接插件须挂载到实际启动的 preset，创建全局文件不会自动生效 |

## 连接步骤

1. 选择并确认使用的工具，查看安装检测结果。
2. 点击「连接任务监测」。先验证悬浮岛自带运行时，再备份合并配置；不改账号、模型、凭据或权限决策。
3. 按客户端正常审核流程启用 Hook，重启客户端，开始新任务。
4. 「等待验证」表示只有配置；「已收到事件」表示真实客户端事件已到达，并显示最近时间。仍需观察任务开始和结束，确认完整链路。
5. 应用路径变化后，点击「修复连接」更新自己的旧命令，再按工具提示审核；不累积重复 Hook。

仍等待验证时，检查客户端版本、是否已重启/新开会话、Hook 是否被禁用、是否采用自定义配置目录。不要关闭安全策略来绕过审核。Codex 额度连通不等于任务连通；新电脑不能复用开发者的 Hook 信任。

## 可迁移性与状态边界

- 路径在目标电脑生成。支持 `CLAUDE_CONFIG_DIR`、`WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR`、`XDG_CONFIG_HOME`、`MIMOCODE_HOME`；环境变量须被悬浮岛进程继承，仅存在于终端 profile 的自定义值不能自动猜测。
- GUI 启动会查找 nvm/fnm、Homebrew、`.local/bin`、`.bun/bin`、`.opencode/bin`、`.mimocode/bin` 等目录，不执行 shell profile 或未选工具。
- 命令 Hook 使用应用自带 Electron 的 Node 模式，无须收件人另装 Node。插件使用客户端运行时。配置损坏、格式不兼容、被策略禁用或运行时失效均保留原配置并报错。
- 每次切换使用新的选择身份；旧工具迟到事件不写入，新选择不复用旧回执。切回时无法确认的旧任务显示未知，不因宿主进程仍在而猜成运行。
- 已收到开始事件的短任务即使在两次轮询之间结束也能提醒；重复完成不重复提醒。长任务不按静默时间过期，进程 PID/启动时间不匹配时转未知。
- 只存会话 ID、项目名、目录哈希、时间、状态与来源进程身份，不保存提示词、回复、transcript 路径或凭据。子代理不触发主任务完成。
- 个人选择和事件位于 `userData/ai-tools.json` 与 `userData/ai-code-events/<工具 ID>/`，不进入发行包。没有可靠订阅额度来源的工具始终显示 `—`。

## 验证范围与发布限制

`tests/ai-code-connectors.test.js` 为十款接入建立独立 HOME，执行实际生成的 Hook 命令，覆盖回执、生命周期、切换、应用移动、中文/空格/引号路径、JSONC/TOML 保留、禁用策略和插件父子会话。输入为协议样本，不调用第三方模型，**不能代替客户端实机验收**。

`tests/ai-code-status.test.js` 覆盖短任务、提醒保留/释放与重试；`tests/ai-tools.electron.js` 验证真实 Electron 界面的选择、连接入口、跨窗口同步。

对外发布前，仍需在独立 macOS 用户环境中逐款实际发起、结束、中断任务并来回切换。三款未接入工具及未实测版本是发布限制，不能声称“全部工具已验证可用”。

## 官方依据

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Kimi Code Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [Gemini CLI](https://geminicli.com/docs/hooks/reference/)、[Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)
- [WorkBuddy 插件](https://www.codebuddy.cn/docs/workbuddy/Plugins)、[CodeBuddy Hooks](https://www.codebuddy.cn/docs/cli/hooks)、[QoderWork Hooks](https://docs.qoder.com/qoderwork/hooks)
- [Cursor Hooks](https://cursor.com/docs/hooks)、[ZCode Hooks](https://zcode.z.ai/en/docs/hooks)、[OpenCode 插件](https://opencode.ai/docs/plugins/)
- [MiMo 官方源码](https://github.com/XiaomiMiMo/MiMo-Code)、[DeepSeek Harness Hooks](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/hooks)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced)
