# TO-DO Panel

一个常驻 macOS 屏幕顶部的本地工作台。默认折叠为 200px 物理刘海加左右状态侧翼，悬停显示任务预览，点击从顶部展开，包含**首页 / 待办 / 笔记 / 链接 / 录制 / 密钥**等页面；剪贴板默认关闭、可从菜单栏「显示功能」启用；还可接收 Codex / Claude Code / GPT 的本机完成事件并关联当前窗口。

项目为单一 Electron 架构：折叠态、展开工作区、任务完成提醒与 Hover + Space 唤出都在 Electron 主进程和渲染层内实现，`npm start` 是唯一运行路径。

> **文档准绳**：产品行为以 [README.md](README.md) 为唯一事实来源。本文与 README 冲突时以 README 为准。

## 技术栈

- 桌面端：Electron 44 + 原生 HTML/CSS/JavaScript，无渲染层构建步骤
- 官网：React 19 + Vinext + 原生 CSS，位于 `website/`
- 数据：LocalStorage + `userData/clipboard-images/` + `userData/recordings/`，无后端和云同步
- 包管理器：npm
- Node：桌面端使用 Node 18+；官网要求 Node 22.13.0+

## 命令

- 桌面开发：`npm install && npm start`
- 桌面检查：`npm test`
- 桌面打包：`npm run build`（只在用户明确确认后执行）
- 官网开发：`cd website && npm install && npm run dev`
- 官网检查：`cd website && npm run lint && npm run build`

## 目录结构

```text
.
├── main.js                 # Electron 主进程：窗口、定位、菜单栏、剪贴板、媒体与通知服务
├── main-services.js        # 可单测的纯领域服务（无 Electron 依赖）
├── preload.js              # contextBridge 安全桥接
├── renderer/               # 桌面界面与交互（index.html / styles.css / app.js / workspace.js / notification.*）
├── build/                  # DMG 打包钩子、entitlements 与应用图标
├── scripts/                # Codex 与 Claude Code 的通知转发脚本
├── tests/                  # Node 单元测试
├── docs/                   # 设计说明、ADR 与验收图
├── website/                # 官网 React/Vinext 源码
└── package.json
```

## 当前产品约束

- 折叠态：中央 200px 刘海安全区，左右各 28px 侧翼，总宽 256px；高度等于当前屏幕菜单栏高度，下方两角 17px。共用 07 号角标布局：额度白色、系统字体 400 字重、自然字宽，主读数上限 11.5px，100% 等四字符上限 9.5px；左侧内收 3px 并在剩余空间居中。额度右上角 8px / 55% 白色显示同窗口真实重置天数（向上取整，只显示数字），未知为 —。右翼为所选工具 16px 白色品牌图标，运行时自下向上渐层每 2.4 秒连续循环，右上角 9px 项目数；按目录哈希去重、无目录按会话区分，完成弹窗完全收回后才减去对应任务。空闲显示 11px 度数形 °；两侧角标基准 top=4px，右翼另下移 0.5px，° 再下移 1.5px 做视觉居中，未知为 —，需处理仍为静态感叹号；24px 菜单栏按高度缩放内容，不改变岛体。
- 任务预览：折叠态悬停 400ms 展开为 256×56px，移开 250ms 收回；点击、回车或空格直接打开完整工作台
- 展开态：各页整窗尺寸统一为 B 档 `1040 × 480`（含菜单栏安全区与导航）；内容高度为 `480 − 菜单栏安全区 − 76`，窄屏与矮屏保留 24px 安全距
- 待办：2 × 2 布局，一次回车新增，颜色为红 / 橙 / 绿 / 蓝。内部存储键仍是 `P0`–`P3`（`notch-todo-data` 结构不可变更），但界面显示名默认「课程 / 自媒体&写作 / Vibe coding / 日常」且用户可改名（存 `notch-todo-category-names-v1`）；截止时间默认当天 23:30，到期前一小时提醒
- 剪贴板：默认关闭（`DEFAULT_FEATURES.clip = false`），可在菜单栏「显示功能」中启用。历史记录由主进程轮询采集，不再占用任何全局快捷键（见 `clipboardServicePolicy`）
- 链接：只允许公开 http/https；主进程抓取标题时必须阻止本机、内网与不安全重定向
- 录制：音频写入 `userData/recordings/`，转写与元数据保存在 LocalStorage；可选百炼 Qwen3-ASR 实时转写，API Key 必须经 `safeStorage` 加密或环境变量读取
- 镜子：首页中间列使用 1:1 方形；只有主动点击才开启，离开首页或收起时立即释放摄像头 track
- 当前窗口：通过 macOS 辅助功能枚举和聚焦，使用系统应用图标；同应用多窗口编号；隐藏项保存在 LocalStorage；聚焦 IPC 只接受最近扫描缓存中的窗口 ID
- 笔记：首页随笔记保存后进入独立笔记页，可搜索、重命名、编辑和删除
- 动效：窗口边界变更不使用系统动画；视觉动效由渲染层完成，并支持 `prefers-reduced-motion`
- AI 工具：入口「code列表」位于速览与工作台的「项目抽屉」后，跳转到工作台内选择，保持单选。首次启动必须先进入该选择页；候选项需用户确认使用，保存成功后只检测所选工具，取消/搜索不得探测。`userData/ai-tools.json` 版本 2 存 selected/confirmed；版本 1 多选迁移为重新确认，不能默认启动 Codex。主进程由 `ai-code-runtime.js` 统一选择、暂停和校验异步结果；源码与旧安装版的 `.codex-priority`/`.codex-recent` 必须整块隔离，不能靠漏项的 CSS 隐藏。Codex 提供真实额度/任务；Claude Code、Kimi Code、Gemini CLI、Qwen Code 的 Hook 仅在用户点「连接任务监测」后备份合并配置，并保持工具本身的审核流程。新增 MiMo Code（官方命令 mimo），当前仅安装检测与官网入口、监测未接入。其他工具未接入监测必须明确标注且显示空状态，不能复用 Codex 数据。所有图标打包在本地，个人选择和事件不得打包。
- Codex 任务：生命周期 Hook 区分运行、等待权限、等待输入、完成、失败和中断；已确认的长任务不按静默时间过期，详情按「需处理 / 运行中 / 最近完成」展示且最多八项。`userData/codex-activities/` 保存最少的真实事件与显示元数据，Hook 在应用关闭期间也更新；重启恢复必须校验原进程 PID 和启动时间，关闭期间完成的回合不补弹提醒。普通退出保留缓存，切换工具清除；不保存正文、完整路径或凭据，不能打包缓存。
- 通知：独立无焦点窗口使用 04 号「双段胶囊」：顶部保留 256px 折叠岛，菜单栏安全区下方 16px 显示 254×54px 任务胶囊、8px 透明间隔和 54×54px 完成圆点；含阴影整窗 348px 宽、高为安全区加 86px。系统字体 13px / 400 主标题，11px 来源与状态，本地工具图标；长标题省略且完整名称保留在悬浮与无障碍信息。自动跟随应用「柔焦玻璃 / 纯黑」，当前弹窗即时更新但不重播动画或重置计时；两个玻璃区分别裁切，切纯黑、隐藏、尺寸变化即清理。420ms 展开后停留 3 秒，约 300ms 收起，按 eventId 完全隐藏后才释放完成计数。GPT、待办截止、番茄钟阶段结束与合并提示共用双段布局；截止提醒使用时钟。电源／充电／拔电源、20%／10% 低电量、耳机／蓝牙音频／扬声器切换共用 `renderer/island-popup.css` 的 04 号双段胶囊与 `renderer/popup-appearance.js` 的主题材质逻辑，保留电量、设备名和完整细节，420ms 展开后固定停留 3 秒并收起；常驻活动在收起后恢复。音量与亮度继续由 macOS 处理；录音与倒计时常驻紧凑状态保留。HTTP 只监听 `127.0.0.1:43821` 的 `/notify/<source>`，来源白名单 `codex` / `claude` / `gpt`；由现有脚本转发，子代理结束与云端会话不弹提醒。

## 代码规范

- 主进程文件 camelCase，常量大写下划线
- 渲染逻辑放在 `renderer/`，与主进程隔离
- IPC 必须通过 `preload.js` 的 contextBridge 暴露
- 项目抽屉经 `project-drawer.js` 与 `project-drawer-electron.js` 读取顶层文件元数据，分类保存到 `userData/project-drawer.json`。归类只改元数据，不能移动或删除用户文件；打开文件只接受当前目录缓存内的文件 ID，并重新校验文件身份。
- 视觉取值集中在 CSS 自定义属性中

## 本机安装版更新

- 本机单层玻璃应用图标使用 macOS 自定义图标标记。增量更新若因签名暂时清理 `com.apple.FinderInfo` / `Icon\r`，必须在签名完成后执行 `swift scripts/restore-local-app-icon.swift build/to-do-panel-icon.png /Applications/悬浮岛.app` 恢复，再检查实际图标；不能把清理标记当成最终状态，否则系统会再次显示套框图标。此步骤仅用于本机安装维护，不用于发行包。

## GitHub 推送与发布联动

- 任何产品更新推送到 GitHub 前，必须联动检查版本号、`CHANGELOG.md`、README 当前稳定版本与下载入口、GitHub Pages 下载按钮。
- 正式发布必须保证 `package.json` 与 `package-lock.json` 版本一致，推送匹配的 `v*.*.*` 标签，并在 GitHub Actions 完成后验证 Release 的 DMG / SHA-256 资产与 Pages 实际下载指向。
- 官网下载按钮应始终从 GitHub `releases/latest` 动态解析当前版本的 `arm64.dmg`，不得留下过期的固定版本链接。

## NEVER

- NEVER 在渲染进程直接 `require('electron')`
- NEVER 让窗口可被拖出刘海位置；显示与模式切换必须贴顶居中
- NEVER 让摄像头常驻；离开首页或收起时立即释放 track
- NEVER 在用户未主动点击时启动麦克风；结束录音或退出应用时必须释放音频 track
- NEVER 把剪贴板图片 dataURL 存入 LocalStorage
- NEVER 提交 `node_modules` 或 `dist`
- NEVER 在没有用户确认时打包或发布桌面应用

## 压缩指令

执行 `/compact` 时必须保留：

- 当前窗口行为与样式细节
- LocalStorage 数据结构
- 已知 macOS、多屏、菜单栏与摄像头适配问题

窗口尺寸：设置页外观下方提供 两档：适合 16 寸或 15.3 寸（原始 1240 宽）/ 适合 14 寸或 13 寸（1040 宽，默认），速览与工作台同步、贴顶居中；只改变宽度，工作台整窗高 480，速览内容高 270 加菜单栏安全区。选择保存在 userData/window-size-settings.json，重启恢复。
