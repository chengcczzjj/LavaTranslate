# macOS 适配与调试（Apple Silicon）

Apple Silicon（M 系列，arm64）版本目前以源码预览形式提供。2026-10-22 已在 Mac 真机上构建并打开 `.app`，检查了本地 CPU OCR 和设置界面。完整翻译流程、多显示器和混合缩放仍待真机验收。GitHub Releases 暂未提供 Mac 安装包。

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

导出的源码包位于 `dist/LavaTranslate-Mac-Source-<版本号>.zip`，版本号取自当前源码的 `package.json`。包内带上本地已有的 OCR 模型，排除了 Windows 的依赖、构建产物、本机配置、Git 历史和安卓原生工程。

## 在 Mac 上运行

直接克隆仓库，或把导出的 ZIP 复制到 Mac 并解压。在包含 `package.json` 的目录打开终端：

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
2. 默认快捷键为 `Option + Space`；连按两次进入输入翻译。也可从菜单栏图标选择「截图翻译」。
3. 第一次截图时，在「系统设置 → 隐私与安全 → 录屏与系统录音」（旧系统可能名为「屏幕录制」）允许应用。若系统提示重新打开，使用 `Command + Q` 完全退出并重新启动。
4. 按住空格穿透到原应用时，另需「输入监控」权限；普通截屏翻译不需要此权限。代码只读取空格按下状态，不记录文字输入。

Mac 界面支持 `Command+C` 复制译文、`Command+Shift+C` 复制译图、`Command+S` 保存、`Command+R` 重译、`Command+T` 钉图；按住 `Option` 看原文。原有 Ctrl 快捷键仍可使用。F3 可能被系统占用，钉图可使用 Command+T。

「通用」中可直接打开录屏、输入监控、登录项和键盘的系统设置页面，并查看当前权限状态。关闭设置窗口后应用仍在菜单栏运行；点击菜单栏图标选择「设置」，或按 `Command + ,` 重新打开。

Mac 版按本地保存方式处理 API Key：明文写入 Electron 的 `userData/settings.json`，文件权限限制为 `0600`（仅当前 macOS 用户可读写），界面只显示打码内容，不再访问钥匙串。请勿分享配置文件；同一登录用户下的进程仍可能读取该文件。Windows 的 safeStorage 加密行为保持不变。

旧版 `enc:` 加密内容在重新填写前原样保留，修改其他设置不会清空它，也不会触发验证。它无法绕过钥匙串解密；请从服务商后台复制或新建 API Key，在「翻译服务」重新填写一次，之后重新启动也不需要钥匙串密码。应用不会还原或删除 macOS 钥匙串。

## 在 Mac 生成本地调试安装包

```bash
# 只生成 .app，适合优先调试
npm run pack:mac
open dist/mac-arm64/LavaTranslate.app

# 生成 .dmg 与 .zip
npm run dist:mac
```

本地打包会在 `dist/` 生成 `LavaTranslate-Mac-<版本号>-arm64.dmg` 和同名 `.zip`。先退出开发模式，再启动打包版，避免单实例锁或快捷键冲突。将应用放进 Applications 后再授予权限，后续尽量保持安装路径不变。

这个入口使用 ad-hoc 本地签名、不公证、不上传发布，不需要 Apple Developer 证书。它适合本人调试，不能当作已完成 Apple 公证的正式发行版。公开分发前需使用 Developer ID 签名、公证并完成真机验收。[electron-builder macOS 打包说明](https://www.electron.build/v26/docs/mac/)

Mac 预览版暂时关闭应用内自动更新，设置页会显示需手动安装新版本；待准备好签名的 Mac Release 和 latest-mac.yml 后再启用。Windows、安卓现有更新逻辑不变。

## OCR 速度与竖排验收（2026-11-04）

CPU 检测现在限制内容约 150 万像素、含留白的最长边 1600 像素；小图不再为检测额外放大。识别阶段仍从原始截图裁字，框坐标仍返回原图物理像素。CPU 启动不再等待两次模拟推理；Windows DirectML 保留原有分辨率和预热。

使用同一张漫画选区的 2478×2268 版本，在 Windows x64 强制走与 Mac 相同的 ONNX CPU 分支，连续三次对照：检测由 1556–1890 ms 降至 389–420 ms，含竖排识别的总耗时由 1600–1939 ms 降至 653–830 ms。此数据不是 Apple Silicon 真机成绩，也不含网络翻译耗时。大幅缩小检测图可能影响极小文字，Mac 验收需覆盖 Retina 全屏小字与局部选区。

在 Mac 可运行以下本地检查，不调用翻译服务、不申请录屏权限：

```bash
npm run check:mac
# 也可以测用户自己的截图，打印初始化和三轮 det/rec 耗时
npm run check:mac -- /absolute/path/to/screenshot.png
```

竖排必须区分以下几类（参照 [W3C 竖排文字指南](https://www.w3.org/International/articles/vertical-text/)）：

| 类型 | 方向 | 当前处理 |
| --- | --- | --- |
| 中文（简繁）、日文、韩文直立竖排 | 字从上到下，列从右到左 | 按字形拆分重组后识别；同一气泡的多列译文从右向左流转，字号按列宽计算；中日韩译文保留竖排。当前本地字典不含韩文字母/音节，韩文原文依赖视觉模型校正 |
| 英文等书脊、表头、招牌的整行旋转 | 可从上到下或从下到上 | 同时评估两个旋转方向，译文按整行旋转排版 |
| 传统蒙古文、满文 | 字从上到下，列从左到右 | 已告知视觉翻译模型正确列序；现有本地 OCR 字典及目标语言列表不保证这些文字，不能视为完整原生支持 |
| 艺术字逐字堆叠、混合横竖排 | 依实际设计 | 逐框保留方向，低置信度交给视觉模型校正；不保证任意艺术字识别 |

竖排日文等直立竖排原文译成横排语言时，译文整行顺时针旋转 90°，多列从右往左排列。此规则覆盖当前所有非中日韩目标语言：英语、法语、德语、西班牙语、俄语、葡萄牙语、意大利语、越南语、泰语、阿拉伯语及语言地区变体。阿拉伯语保留行内从右往左的阅读和连写方向。中日韩译文保留直立竖排；原本横排的原文译后仍横排；原本整行旋转的文字保留检测到的 90°/270° 方向。

列数根据译文实际字体宽度和安全区域计算，保持可读字号，在能容纳全文的列数内均衡列长，避免末列仅剩很短的尾词。普通单词（包括德语长复合词）优先完整换列，先缩小字号；到最小字号仍放不下的超长单词才按完整字素应急断开。泰语按词典词边界换列。多段共享同一字号，短段未使用的列会留给其他长段落；极长文本才在最小字号下省略。

先从截图像素识别同一气泡的连续背景和安全文字区域，利用原字列两侧空白。即使模型把同一气泡拆成几段返回，也统一字号和位置，保留各段的悬停/复制标识；等该气泡的各段到齐后一起排版，其他气泡仍可先显示。气泡描边、插图和相邻文字会限制扩展范围，无法确认背景边界时保守回到原文字区域，横排语言译文仍保持整行旋转。过长译文有最小字号和省略显示，完整内容仍可通过悬停或复制读取。低置信度、空白或竖排 OCR 不再直接判为“已是目标语言”，避免丢失假名后只剩汉字导致跳过翻译。

原漫画案例修正后可识别出“金木犀ね”“もうすっかり秋だし”等主要内容，长音、竖排省略号仍可能需要视觉模型校正。`npm run check:layout` 覆盖多列、不等高、检测框重叠、韩文、旋转方向、超长文本、10 种横排目标语言的气泡曲线边界、多段乱序返回、完整单词、德语复合词、泰语词边界、阿拉伯语行内方向、长短段列数分配及真实 DOM 裁切检查，以及五档缩放；同时用真实设置组件检查 Windows/Mac 自定义快捷键保存后首页提示同步、保存失败时提示不变。Mac 真机完整捕获流程仍需验收。

## 真机验收

- 权限拒绝后能正常返回，再次授权并重启后可以截到其他应用。
- Retina 内置屏、外接屏以及混合缩放下，选区、窗口吸附、译文和鼠标位置一致。
- 在普通桌面、其他应用的全屏空间和多桌面中，截图窗口可见且可以输入。
- 框选 → 本地 OCR → 翻译 → 原位覆盖完整走通；Mac 当前用 CPU OCR，尚未优化 CoreML。
- Command 快捷键、回复输入框的复制粘贴、Option 看原文、图片保存与钉图正常。
- 空格按住时可操作下层应用，松开后重新截图并恢复焦点；权限被撤销时不会卡在透明遮罩中。
- 关闭设置窗口后菜单栏仍可用，点击 Dock 图标能重新打开设置，退出时快捷键释放。
- 重启后设置保存正常，本地保存的 Key 可以读取且不会出现钥匙串验证；开机启动开关实际生效。
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

在 Windows 上运行 `npm run check:platform` 可以复查权限、显示器坐标、快捷键和凭据保存等行为。测试用模拟对象覆盖系统接口，实际录屏、窗口交互和多屏显示仍需按上方清单在 Mac 上验收。
