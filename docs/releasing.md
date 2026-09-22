# macOS 签名、公证与发布

悬浮岛基于 TO-DO Panel 做本地改写。当前 GitHub 下载入口仍指向上游原版；本地 `1.5.1` 尚未公开发布。任何打包或发布操作都必须先获得用户明确确认。

macOS 对外分发建议使用 **Developer ID Application 证书签名 + Hardened Runtime + 安全时间戳 + Apple 公证 + 票据装订**。Electron 的[代码签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)和 Apple 的[公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)解释了这套流程；项目通过 [`@electron/notarize`](https://github.com/electron/notarize) 调用 `notarytool`、等待结果并装订票据。

## 两种构建用途

`npm run build` 保留本机测试路径。没有配置证书时会使用 ad-hoc 签名；它适合本机验证，不能为朋友提供稳定的开发者身份或公证结果，系统更新应用后也可能要求重新授予隐私权限。

`npm run build:distribution` 是对外分发路径。它要求明确指定 Developer ID Application 证书和钥匙串中的 Apple 公证配置，缺少任一项都会停止，不会降级到 ad-hoc 签名。

无论采用哪种签名，辅助功能、屏幕录制、麦克风和摄像头都由 macOS 按用户与功能分别授权。签名和公证不会绕过这些权限。

## 准备 Developer ID 与公证凭据

1. 加入 Apple Developer Program，在钥匙串中安装带私钥的 **Developer ID Application** 证书。
2. 查找可用证书及其 40 位 SHA-1 指纹：

   ```bash
   security find-identity -v -p codesigning
   ```

3. 用 Apple 的 `notarytool` 把凭据保存到当前 Mac 的钥匙串。下面的名称可自行修改，后续环境变量需使用同一个名称：

   ```bash
   xcrun notarytool store-credentials "FuDao Notary" \
     --apple-id "你的 Apple ID" \
     --team-id "你的 Team ID" \
     --password "App 专用密码"
   ```

钥匙串配置保存凭据，项目只接收配置名称。证书私钥、App 专用密码、API Key、Apple ID 和 Team ID 都不得写入源码、`.env`、构建日志或 Release。

## 生成可分发 DMG

获得本次打包授权后，在项目根目录执行：

```bash
npm ci
npm test
export FUDAO_SIGNING_IDENTITY='替换为 Developer ID Application 证书的40位SHA1指纹'
export FUDAO_NOTARY_KEYCHAIN_PROFILE='FuDao Notary'
npm run build:distribution
```

分发构建会依次完成：

1. 校验 Electron helper 布局并生成本机系统状态辅助程序。
2. 从内部动态库、Framework、helper 到主应用逐层使用指定证书签名。
3. 为可执行文件启用 Hardened Runtime 与最小权限 entitlements；Developer ID 签名使用 Apple 安全时间戳。
4. 将 `悬浮岛.app` 提交 Apple 公证，等待通过，并把公证票据装订到应用。
5. 运行 `stapler validate` 验证票据，再生成 Apple Silicon DMG。

产物为 `dist.noindex/FuDao-1.5.1-arm64.dmg`，应用名为 `悬浮岛.app`。`.noindex` 后缀避免构建目录中的应用被 Spotlight 当成第二份已安装应用。

## 分发前验证

从最终 DMG 拖出一份全新的 `悬浮岛.app`，不要只验证构建目录。至少检查：

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/悬浮岛.app"
codesign -dv --verbose=4 "/Applications/悬浮岛.app"
xcrun stapler validate "/Applications/悬浮岛.app"
spctl --assess --type execute --verbose=4 "/Applications/悬浮岛.app"
shasum -a 256 "dist.noindex/FuDao-1.5.1-arm64.dmg"
```

`codesign -dv` 应显示 Developer ID Application 证书和 TeamIdentifier；`stapler validate` 应确认票据有效；`spctl` 应接受应用。随后从真实安装路径验证折叠悬浮岛、悬停任务预览、工作台、Codex 额度与任务、完成提醒、番茄钟、设置、音量与亮度按键接管。首次使用受保护功能时仍要按 macOS 提示授权。

Codex 生命周期 Hook 指向安装包内脚本：

```text
/Applications/悬浮岛.app/Contents/Resources/app/scripts/fudao-codex-hook.js
```

每位用户第一次启用、脚本或路径发生变化时，都要在 Codex 的正常审核入口检查命令与路径并信任；安装程序不会自动授予这项信任。从「浮岛」换装「悬浮岛」时，需同步更新原 Hook 与 notify 的应用路径，避免仍指向旧应用；保留原脚本文件名且不重复添加连接。旧版的核验记录见[连接说明](codex-lifecycle-setup/README.md)。

## 交给朋友安装

同时发送 DMG 和 SHA-256 值。朋友先核对校验值，再打开 DMG，把 `悬浮岛.app` 拖入「应用程序」并启动。已正确签名、公证和装订的版本应能通过 Gatekeeper；首次使用辅助功能、屏幕录制、麦克风、摄像头或 Codex Hook 时，仍按系统或 Codex 的提示逐项确认。

如果只能发送 ad-hoc、未公证的测试包，应明确标记为测试版。朋友首次打开时可能需要到「系统设置 → 隐私与安全性」选择「仍要打开」；该步骤只处理 Gatekeeper，不能替代隐私权限授权。

## GitHub Release

推送前必须确认工作区干净、测试通过，并同步核对 `package.json`、`package-lock.json`、`CHANGELOG.md`、README 本地版本与网站下载入口。当前下载按钮仍从上游 `xiaopu-ai/TO-DO-Panel` 的 `releases/latest` 解析；正式发布悬浮岛前，要先切换到获授权的发布仓库并验证 Pages 与 Release 指向相同的 DMG。

标签必须与 `package.json` 的版本一致：

```bash
version=$(node -p "require('./package.json').version")
git tag "v${version}"
git push origin main
git push origin "v${version}"
```

只有在 GitHub Actions 已安全配置 Developer ID 证书、对应私钥和 Apple 公证凭据，并且工作流实际使用正式分发路径后，才能把 CI 生成的 DMG 称为已签名、公证的正式安装包。Release 应同时包含 DMG 与 SHA-256 文件；任一签名、公证、票据、校验或安装版验收失败，都应停止发布。

应用显示名使用「悬浮岛」，macOS 工作台菜单使用 `CFBundleName = 工作台`；`app.setName('TO-DO Panel')` 与 `Dynamic Panel` 数据目录保留原身份，以延续已有数据与安全存储。macOS 第一个菜单标题由系统应用名称决定，不能仅通过菜单的 label 修改，见 [Electron 应用菜单说明](https://www.electronjs.org/docs/latest/tutorial/application-menu)。Electron 原生启动阶段按 `CFBundleName` 寻找 helper，因此构建钩子必须在签名前统一 helper 目录、可执行文件名和 `CFBundleExecutable`；当前目标名称为 `工作台 Helper` 及其 Renderer / GPU / Plugin 变体。安全存储沿用主进程启动时的内部名称，见 [Electron 44 初始化实现](https://github.com/electron/electron/blob/v44.0.0/shell/browser/electron_browser_main_parts.cc#L510-L551)。
