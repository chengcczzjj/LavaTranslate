# LavaTranslate 开发文档

> 面向用户的说明见仓库首页的 [README](../README.md) / [中文 README](../README.zh-CN.md)。

按下快捷键，框选屏幕上任意区域：本地 OCR 找出每一行文字的位置，大模型看着截图纠错、合并段落并翻译，译文按**原来的位置、字号、颜色、粗细、对齐方式**直接覆盖在原文上。

看懂对方的消息后，可以直接用自己的语言写回复：**回复助手**会参照屏幕上的对话语气实时译成对方的语言，并附上回译让你确认意思，`Enter` 复制即可去发送。

## 使用

| 操作 | 说明 |
| --- | --- |
| `Alt + Q`（可改） | 进入截图模式 |
| 拖动 / 单击 | 框选区域 / 选中鼠标下的窗口 |
| 拖动选区、拖动手柄 | 移动、调整选区，松开后自动重新翻译 |
| `Space`（按住） | 查看原文 |
| `Tab` | 切换「原位覆盖 / 并排对照」 |
| 单击某段译文 | 复制这一段 |
| `Ctrl C` / `Alt C` | 复制全部译文 / 原文 |
| `Ctrl Shift C` / `Ctrl S` | 复制 / 保存翻译后的截图 |
| `F3` | 钉在桌面（可拖动、滚轮缩放、双击关闭） |
| `Enter` 或双击选区 | 复制译文并退出 |
| `R` | 打开 / 聚焦回复框 |
| 右键 / `Esc` | 重新框选 / 退出 |

工具条上可以切换目标语言（会记住）、显示方式、回复、重新翻译、打开设置。

### 回复助手

- 模型判断截图是聊天、私信、评论或邮件时，翻译完成后自动在工具条旁弹出回复框（设置 → 翻译 里可关闭；任何时候按 `R` 都能打开）；
- 用自己的语言输入，停顿约半秒就开始流式翻译；默认译成截图里识别出的语言，可手动改；语气可选「跟随语境 / 正式 / 随意」；
- 译文下方附**回译**（再翻回你的语言），不懂对方语言也能确认意思没走样；
- `Enter` 复制并关闭（还没翻完会等翻完再复制）、`Ctrl Enter` 只复制、`Shift Enter` 换行、单击译文复制；`↑ / ↓` 翻看发过的回复；
- 输入框为空时，`Space` / `Enter` / `Tab` 等截图快捷键照常可用；有内容时 `Esc` 先收起回复框（保留草稿），空白时直接退出。

## 翻译服务

服务商目录在 `src/shared/providers.ts`：每家的接口地址、获取 Key 的网页与步骤、推荐模型、优先用哪种接口（Responses / Chat Completions），
以及在 Chat Completions 里关掉「思考」的参数（DeepSeek / 智谱 / 豆包：`thinking: {type: "disabled"}`，通义：`enable_thinking: false`；
其余用 `reasoning_effort` 从 none 逐档尝试）。设置按服务商分别保存 `providers[id] = { key, baseUrl, model }`，Key 用 safeStorage 加密
（密文绑定数据目录的 Local State，不能跨目录复制）；旧版的 `engine / openaiKey / apiKey` 在 `settings.load()` 里自动转换。

- 全部走 `openai` SDK（Claude 用 Anthropic 的 OpenAI 兼容接口 `https://api.anthropic.com/v1`，模型列表用原生 `/v1/models`）：先用 Responses API，服务商没有该接口（404）时改用 Chat Completions 并记住；
  模型不能看图时只发 OCR 文本；Key 无效（401，Gemini 是 400）统一提示「API Key 无效」。
- Gemini 的模型列表用原生接口 `/v1beta/models` 获取（OpenAI 兼容接口未必提供）。
- 价格来自 [models.dev](https://models.dev)，3 天刷新一次，离线时用安装包内置的快照。
- 不提供「Claude 账号」登录：Anthropic 不允许第三方软件使用 claude.ai 登录或订阅额度（见 Agent SDK 文档）。
- **识别 Key**（`credentials.ts` 的 `detectProvider`）：先按格式（`providers.ts` 里各家的 `keyPattern`），sk- 开头格式相同的几家并发请求 `/models`，通过的就是；都不行界面上让用户选。
- **ChatGPT 登录**（`src/main/chatgpt.ts`）：OpenAI 给开源软件的「使用 ChatGPT 会员额度」——动态注册（首次 `client_id=dynamic_agent_client`，回调带回 `oaiapp_…`）、PKCE、本机回调 `http://127.0.0.1:<端口>/callback`、每台设备固定的 `ext_agent_host_id`（`settings.installId`）；
  ID Token 用 `https://auth.openai.com/.well-known/jwks.json` 校验签名、iss、aud、exp、nonce，并要求授予 `chatgpt.tokens.use.direct`；令牌加密存在 `providers.chatgpt.key`，调用前快过期就刷新；
  请求必须 `store:false`、`stream:true`，不能带 `max_output_tokens` 等参数（见 preview limitations）。
- **思考对排版的影响**：同一批真实网页开 / 关思考对比，分块、语言、是否对话一致；关思考后模型常把照抄的原文漏标 keep，现由 `BlockParser` 在译文与原文相同时自动保留原图。

## 自动更新

安装版每 4 小时检查一次 GitHub Releases（`chengcczzjj/LavaTranslate`），在后台按块差量下载，下载完成后托盘与设置里出现「重启并更新」，不点也会在下次退出时安装。
发布新版本：`npm run release -- patch|minor|major|current`（需要 `gh auth login`），会升版本号、打包，并用 `gh release create` 上传安装包、blockmap 和 `latest.yml`，发布说明取 `docs/releases/v<版本>.md`。图标：`python scripts/make-icons.py` 一次生成桌面（exe、托盘、设置页）与安卓（自适应图标、单色图标、通知栏图标）的全部图标，图形定义在 `scripts/icons/lava.py`（黑底上一滴朱红到琥珀的发光熔岩，≤32px 用去掉文字的简化版），用 Electron 渲染 SVG。

改名说明：旧名「Lens 截图翻译」的配置会在首次启动时从 `%APPDATA%\Lens 截图翻译` 迁移到 `%APPDATA%\LavaTranslate`。

## 实现

```
快捷键 ──► 截屏 (node-screenshots, DXGI, ~80ms 双屏)
         └► 每个显示器一个预创建的遮罩窗口，透明度 0 → 画好帧 → 1（~150ms 可见）
框选 ──► PP-OCRv6 检测 + 识别（onnxruntime + DirectML GPU，~100–200ms）
         └► 模型（截图 + 每行坐标与 OCR 文字）流式返回 JSON：纠错、分段、语言识别、是否对话、翻译
              └► 每收到一块立刻渲染（见下）
```

**排版还原**（`src/renderer/src/lib/colors.ts`、`fit.ts`、`components/TranslationLayer.tsx`）

- 每行原文是一个"槽位"，多行译文按顺序流入这些槽位：绕图排列的段落、首行缩进、居中段落都保持原形状；
- OCR 记录每个字符的横坐标（CTC 时间步），补丁只盖住文字本身——被认成字符的图标（▲ ☆ &lt;&gt;）、没被识别的图标、列表序号都保留可见；
- 字号由笔画实际高度 + 文本里有无上伸/下伸字母推算（比 OCR 框高可靠得多）；
- 文字色逐通道取极值分位数，抵消 ClearType 次像素彩边；行内夹彩色链接时分段取色、以正文为准；
- 粗细用"每个笔画像素横纵连续段较短者"的中位数，方块字横笔不会被误判为粗体；
- 扫描两侧空白：译文更长时先占用空白再缩小字号；两侧空白相等判为居中、右侧贴边判为右对齐；
- 所有补丁画在下层、所有文字画在上层，相邻行的补丁不会遮住文字。

排版回归测试（测试素材在本地 `.scratch/`，未纳入仓库）：`.scratch/pages` 里是真实网页截图，`.scratch/fixtures/*.jsonl` 是按提示词写的模型输出，
`LENS_REVIEW=1 LENS_AUTOTEST_ROOT=. npx electron .` 回放并截图，`python .scratch/compare.py` 生成原图/译图对照。

- **OCR**：PaddleOCR PP-OCRv6 small（50 种语言）。识别模型的输出在图里追加了 `ArgMax`（`scripts/patch-rec.py`），GPU 直接给出逐帧最佳字符，避免回传 N×T×18710 的概率矩阵。OCR 认不出的文字（如韩文）保留位置，由能看图的模型补全。
- **网络**：模型请求都走 Electron `net.fetch`（系统代理、HTTP/2），截图界面一打开就预连接当前服务的地址。
- 界面：Electron + React + Motion；Windows 11 Mica 设置窗口，跟随系统深浅色。

## 开发

```bash
npm install
npm run models   # 下载 OCR 模型（需要 python + onnx 才能打 ArgMax 补丁，否则用原始模型）
npm run dev      # 开发模式
npm run dist     # 打包 NSIS 安装程序到 dist/
```

自测（离屏渲染，不打扰屏幕，使用独立的数据目录）：`LENS_AUTOTEST=1 LENS_MOCK=1 npx electron .`，截图输出到 `.scratch/shots/`；
包括聊天截图 + 回复框、模型价格列表（本地假服务）、设置各页。

真实引擎（独立数据目录，Key 不写盘）：
- 某家服务：`LENS_ENGINE_TEST=1 LENS_PROVIDER=<服务商> LENS_PROVIDER_KEY=<Key> LENS_OPENAI_MODEL=<模型> npx electron .`
- 本机 Codex / CC Switch 的中转：`LENS_ENGINE_TEST=1 LENS_OPENAI_SOURCE=ccs:<供应商名> LENS_OPENAI_MODEL=<模型> npx electron .`
- 可加 `LENS_ENGINE_IMAGE=chat.png`（换测试图）、`LENS_REPLY_TEST="要回复的话"`（同时测回复助手）、
  `LENS_OPENAI_EFFORT=default`（不关思考，对照用）、`LENS_OPENAI_FAKE=1`（本地假服务，检查接口回退）。
- 旧格式设置迁移：`LENS_AUTOTEST=1 LENS_MOCK=1 LENS_AUTOTEST_SEED=<旧 settings.json> npx electron .`
- 识别 Key：`LENS_DETECT_TEST=<Key1,Key2…> npx electron .`（只打印识别结果，不打印 Key）

## 安卓版（开发中）

与桌面版在同一个仓库：翻译引擎、提示词、流式解析、服务商目录、排版还原、回复助手两端共用，安卓只写系统相关的部分。

```
src/core/        两端共用、与平台无关：translator（提示词、JSONL 解析、接口回退）、detect（识别 Key）、prices、lang
                 网络由宿主注入（platform.ts）：桌面用 Electron net.fetch，安卓用原生 OkHttp 代发
src/mobile/      手机版网页：overlay.html（全屏翻译）、settings.html（设置），vite.mobile.config.ts 构建到 out/mobile
android/         Kotlin 原生壳（Gradle）：
  FloatService     前台服务：悬浮球、全屏翻译窗口、截屏 → OCR → 交给网页
  BubbleView       原生悬浮球（贴边、拖动、单击翻译、长按输入翻译）
  OverlayHost      全屏覆盖窗口 + 常驻 WebView；平时不挂到屏幕上，用时先透明挂上、网页画好截图再显示
  capture/         截屏：ProjectionCapturer（系统截屏授权）、A11yCapturer（无障碍免授权，Android 11+）
  ocr/PaddleOcr    ocr.ts 的逐行移植（同一套 PP-OCRv6 模型，ONNX Runtime CPU 后端）
  web/Bridge       原生 ↔ 网页消息通道（WebMessageListener）；截图像素走 /frame/<id> 直接取，不走消息
  web/NetBridge    网页的模型请求由 OkHttp 代发并流式回传（WebView 里直接请求会被跨域拦截）
```

- **截屏**：系统截屏授权在 Android 14 起每个会话都要用户同意一次，Android 15 QPR1 起锁屏会结束会话、状态栏有共享标识；
  会话期间虚拟显示器平时不接画面（`setSurface(null)`），截屏时才接上取一帧。无障碍模式开一次一直有效，但开启步骤多（侧载应用还要先「允许受限制的设置」）。
- **识别范围**：去掉顶部状态栏；底部不去（Android 15 起应用都画到导航条下面）。
- **OCR 性能**：检测图最长边 1280（手机截图字大，够用）；首次推理前预热。XNNPACK 后端在 ORT 1.30 会崩溃，NNAPI 已弃用，只用 CPU。
  模拟器（x86_64，4 线程）上 20 行聊天截图检测约 270 ms、识别约 600 ms；真机待测。
- **界面**：翻译时原生悬浮球藏起，由网页里一模一样的球接替（单击展开菜单、按住看原文、拖动换边）；回复助手复用桌面组件（`window.lens` 由 `replyHost.ts` 在网页内实现）。

编译环境：JDK 17+、Android SDK（platform 37、build-tools 37），在 `android/local.properties` 写 `sdk.dir`。先 `npm install`、`npm run models`。

```bash
cd android
./gradlew assembleDebug     # 调试版（arm64 + x86_64 一个包），会先自动 npm run build:mobile
./gradlew assembleRelease   # 正式版：按架构分包，手机装 app-arm64-v8a-release.apk
```

- **正式签名**：`android/keystore.properties`（不进仓库）写 `storeFile / storePassword / keyAlias / keyPassword`，指向仓库外的密钥文件。
  应用内更新要求每个版本签名相同，**密钥和密码丢了就再也发不了能覆盖安装的更新**，务必备份。没有这个文件时正式版退回调试签名（只能自己装）。
- **应用内更新**（`update/Updater.kt`）：读 `https://github.com/<owner>/<repo>/releases/latest/download/latest-android.json`
  （版本号、versionCode、APK 地址、大小、SHA-256、更新说明），有新版本就下载（断点续传、校验 SHA-256），交给系统安装器。
  打开应用、悬浮球开着时每天自动检查；Wi-Fi 下自动下载好并发通知，流量下只提示。第一次要允许「安装未知应用」并确认一次；
  装过一次之后应用就是自己的安装来源，之后的更新不再弹确认（`UPDATE_PACKAGES_WITHOUT_USER_ACTION`，Android 12+）。
  装好后自动恢复悬浮球、回到设置页（`ReplacedReceiver`）。
- **发版**：`npm run release` 同时打安卓正式包，把 `LavaTranslate-Android-<版本>.apk` 和 `latest-android.json` 一起传到同一个 Release
  （需要 `JAVA_HOME`、`android/local.properties`、`android/keystore.properties`；`LAVA_SKIP_ANDROID=1` 只发桌面版）。
  安卓的 versionCode = 主版本×10000 + 次版本×100 + 修订号，与 package.json 的版本号一一对应。
- 测试升级：`./gradlew assembleDebug -PlavaVersion=x.y.z` 打一个「更新的」包；调试版可在设置里写 `updateManifest` 指向本机的测试清单。

- 仓库路径含中文：`android/gradle.properties` 里 `android.overridePathCheck=true`（AGP 默认拒绝非 ASCII 路径，实测可以编译）。
- 调试版带一个演示页 `DemoActivity`（`adb shell am start -n com.lavatranslate.app/.DemoActivity -d <网址>`），可以在模拟器里翻译任意网页，不用装别的应用。
- 网页调试：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 后用 Chrome DevTools 协议连接（调试版开启了 WebView 调试）；
  翻译界面里 `window.__lava` 是当前的识别、翻译结果，控制台有 `[lava] ocr / done` 的耗时。

## 说明

- 软件不内置任何 Key，用户填自己的。
- 只有框选的区域（以及你写的回复）会发送给你配置的服务；OCR 在本地完成，不保存任何会话记录。
