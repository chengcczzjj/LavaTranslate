# macOS 适配与调试（Apple Silicon）

状态：2026-10-22，已在 Windows 完成首轮源码适配；尚未在 Mac 上运行或生成经过验证的 `.app` / `.dmg`。本轮目标是苹果芯片 Mac（arm64）。保留同一套 Windows、安卓和 Mac 源码，版本号仍为 1.4.1。

## 三个平台的关系

| 平台 | 源码与系统实现 | 独立安装包 |
| --- | --- | --- |
| Windows | Electron 桌面代码 `src/main` / `src/renderer`，Win32 系统接口 | `.exe` |
| Mac（M 系列） | 共用 Electron 桌面代码，`src/main/macos.ts` 提供 Mac 系统接口 | `.app` / `.dmg` |
| 安卓 | `android/` Kotlin 工程、`src/mobile/` 界面，复用核心翻译逻辑 | `.apk` |

Mac 是能独立安装、独立运行的软件，不依赖 Windows 或安卓客户端。开发时使用同一个 Git 仓库，桌面翻译界面与业务逻辑共用，系统权限、窗口与打包按平台区分，不另复制一套容易失去同步的桌面代码。

## 从 Git 获取

在 M 系列 Mac 上首次获取：

```bash
git clone https://github.com/chengcczzjj/LavaTranslate.git
cd LavaTranslate
```

已经有该仓库时，在干净的项目目录运行 `git pull --ff-only origin main`。Git 不包含 OCR 模型或 node_modules，首次拉取后按下面的顺序安装依赖并下载模型。

## Windows 可以做哪些工作

可以修改界面、翻译逻辑、平台分支、权限引导与打包配置，并运行 TypeScript 检查、坐标测试和前端构建。实际 macOS 截屏、系统权限、原生模块、窗口焦点与安装包必须在 Mac 验证。

当前项目包含 node-screenshots、koffi、ONNX Runtime 原生依赖。macOS 签名只能在 macOS 完成；本项目的 Mac 打包命令因此明确要求在 Mac 运行。也可以日后使用远程 Mac 或 macOS CI 构建机。[electron-builder 跨平台构建说明](https://www.electron.build/v26/docs/features/multi-platform-build/)

## 带到 Mac

Windows 项目目录运行：

```powershell
npm run export:mac
```

生成 `dist/LavaTranslate-Mac-Source-1.4.1.zip`。它是源码包，包含当前已下载的 OCR 模型，不是安装程序；不含 Windows 的 node_modules、构建结果、安卓签名、本机配置和 Git 历史。导出包不包含安卓原生工程，完整的三端仓库仍保留在 Windows 项目目录中。

把 ZIP 复制到 Mac 并解压。在项目根目录（包含 package.json 的目录）打开终端：

```bash
# 安装 Node.js 22.18 或更高版本的 Apple Silicon/arm64 版本后，先确认架构
node -p "process.platform + '/' + process.arch"
# 应显示 darwin/arm64

npm ci
npm run models
npm run typecheck
npm run check:platform
npm run dev
```

`npm run models` 在模型齐全时直接跳过下载。不要从 Windows 复制 node_modules；两套系统需要不同的原生库。安装包工具需要 Xcode Command Line Tools 时，运行 `xcode-select --install` 并完成系统提示。开发模式加载的是 Electron，权限列表中可能显示 Electron 或启动它的终端；以系统实际显示的项目为准。

## 第一次使用

1. 打开设置，重新配置自己的翻译服务。Windows 的加密凭据不能直接搬到 Mac。
2. 默认快捷键为 `Command + Shift + 2`；连按两次进入输入翻译。也可从菜单栏图标选择「截图翻译」。
3. 第一次截图时，在「系统设置 → 隐私与安全性 → 屏幕录制」（部分系统版本名为「屏幕与系统音频录制」）允许应用。完全退出并重新启动后再试。
4. 按住空格穿透到原应用时，另需「输入监控」权限；普通截屏翻译不需要此权限。代码只读取空格按下状态，不记录文字输入。

Mac 界面支持 `Command+C` 复制译文、`Command+Shift+C` 复制译图、`Command+S` 保存、`Command+R` 重译、`Command+T` 钉图；按住 `Option` 看原文。原有 Ctrl 快捷键仍可使用。F3 可能被系统占用，钉图可使用 Command+T。

## 在 Mac 生成本地调试安装包

```bash
# 只生成 .app，适合优先调试
npm run pack:mac
open dist/mac-arm64/LavaTranslate.app

# 生成 .dmg 与 .zip
npm run dist:mac
```

安装包名称：`LavaTranslate-Mac-1.4.1-arm64.dmg` / `.zip`，位于 `dist/`。先退出开发模式，再启动打包版，避免单实例锁或快捷键冲突。将应用放进 Applications 后再授予权限，后续尽量保持安装路径不变。

这个入口使用 ad-hoc 本地签名、不公证、不上传发布，不需要 Apple Developer 证书。它适合本人调试，不能当作已完成 Apple 公证的正式发行版。公开分发前需使用 Developer ID 签名、公证并完成真机验收。[electron-builder macOS 打包说明](https://www.electron.build/v26/docs/mac/)

Mac 预览版暂时关闭应用内自动更新，设置页会显示需手动安装新版本；待准备好签名的 Mac Release 和 latest-mac.yml 后再启用。Windows、安卓现有更新逻辑不变。

## 真机验收

- 权限拒绝后能正常返回，再次授权并重启后可以截到其他应用。
- Retina 内置屏、外接屏以及混合缩放下，选区、窗口吸附、译文和鼠标位置一致。
- 在普通桌面、其他应用的全屏空间和多桌面中，截图窗口可见且可以输入。
- 框选 → 本地 OCR → 翻译 → 原位覆盖完整走通；Mac 当前用 CPU OCR，尚未优化 CoreML。
- Command 快捷键、回复输入框的复制粘贴、Option 看原文、图片保存与钉图正常。
- 空格按住时可操作下层应用，松开后重新截图并恢复焦点；权限被撤销时不会卡在透明遮罩中。
- 关闭设置窗口后菜单栏仍可用，点击 Dock 图标能重新打开设置，退出时快捷键释放。
- 重启后设置保存正常，Keychain 加密凭据可以读取；开机启动开关实际生效。
- 打包后的 .app 完成同样检查，确认 OCR 原生库随包带齐。

发生问题时保留：macOS 版本、芯片型号、屏幕分辨率/缩放比例、复现步骤，以及 `npm run dev` 的终端错误。打包版日志通常位于 `~/Library/Application Support/LavaTranslate/error.log`，开发模式目录名称可能不同。分享日志前检查是否包含自己的服务地址等信息。

## 本轮实现

- `src/main/macos.ts`：录屏/输入监控权限提示、CoreGraphics 空格状态、跨桌面覆盖窗口。
- `src/main/capture.ts` / `capture-geometry.ts`：避免 Mac 调用 Windows 专用坐标 API，按屏幕 ID 匹配显示器，将点坐标转换为实际截图像素。
- `src/main/index.ts`：平台窗口行为、Mac 应用菜单、菜单栏入口、Dock 激活、Command 快捷键与设置标题栏。
- `src/main/ocr.ts`：Windows 保留 DirectML，Mac 使用 CPU。
- `package.json` / `scripts/build-mac.mjs`：Mac arm64 打包入口，分别过滤 Windows / macOS 原生库。
- `scripts/platform.test.mjs` / `mac-regression.test.mjs`：Windows、Retina、混合缩放、权限拒绝 / 首次申请、截图取消与旧请求返回、Command 快捷键和平台原生库打包回归测试。

本轮复查修复了首次录屏权限报告为 denied 时未发起系统申请，以及取消截图后旧的异步结果重新弹出窗口的问题；同时修正 Mac 设置页的系统名称与快捷键提示。

Windows 上已通过类型检查、17 项平台回归测试、桌面构建及安卓共用网页构建；原生系统边界在回归测试中使用模拟对象，这些检查不能替代上述 Mac 真机验收。
