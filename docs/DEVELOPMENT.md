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
| `Alt`（按住） | 遮罩透明、鼠标穿透，可以操作下面的软件；松开后重新截图，选区里画面变了就重译同一块（主进程用 koffi 读全局按键状态，见 `src/main/winapi.ts`） |
| `Space`（按住） | 查看原文 |
| `Tab` | 切换「原位覆盖 / 并排对照」 |
| 单击某段译文 | 复制这一段 |
| `Ctrl C` / `Alt C` | 复制全部译文 / 原文 |
| `Ctrl Shift C` / `Ctrl S` | 复制 / 保存翻译后的截图 |
| `F3` | 钉在桌面（可拖动、滚轮缩放、双击关闭） |
| `Enter` 或双击选区 | 复制译文并退出 |
| `R` | 打开 / 聚焦回复框 |
| 右键 / `Esc` | 退出 |

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
包括聊天截图 + 回复框、按住 Alt 回来后保留 / 重译选区、模型价格列表（本地假服务）、设置各页。

按住 Alt 穿透（真窗口，屏幕会闪几秒）：`LENS_PASSTEST=1 npx electron .`——模拟按下 Alt、另开一个窗口抢焦点、松开 Alt，
逐步打印遮罩的透明度、是否穿透、焦点是否抢回。

真实引擎（独立数据目录，Key 不写盘）：
- 某家服务：`LENS_ENGINE_TEST=1 LENS_PROVIDER=<服务商> LENS_PROVIDER_KEY=<Key> LENS_OPENAI_MODEL=<模型> npx electron .`
- 本机 Codex / CC Switch 的中转：`LENS_ENGINE_TEST=1 LENS_OPENAI_SOURCE=ccs:<供应商名> LENS_OPENAI_MODEL=<模型> npx electron .`
- 可加 `LENS_ENGINE_IMAGE=chat.png`（换测试图）、`LENS_REPLY_TEST="要回复的话"`（同时测回复助手）、
  `LENS_OPENAI_EFFORT=default`（不关思考，对照用）、`LENS_OPENAI_FAKE=1`（本地假服务，检查接口回退）。
- 旧格式设置迁移：`LENS_AUTOTEST=1 LENS_MOCK=1 LENS_AUTOTEST_SEED=<旧 settings.json> npx electron .`
- 识别 Key：`LENS_DETECT_TEST=<Key1,Key2…> npx electron .`（只打印识别结果，不打印 Key）
- ChatGPT 登录刷新与设置保存：`LENS_SIGNIN_TEST=1 npx electron .`（令牌接口在应用内换成假响应，不需要真账号；
  检查并发刷新只发一次、临时故障与登录失效的区分、刷新期间重新登录、设置文件原子写入与损坏另存）

## 安卓版（开发中）

与桌面版在同一个仓库：翻译引擎、提示词、流式解析、服务商目录、排版还原、回复助手两端共用，安卓只写系统相关的部分。

```
src/core/        两端共用、与平台无关：translator（提示词、JSONL 解析、接口回退）、detect（识别 Key）、prices、lang
                 网络由宿主注入（platform.ts）：桌面用 Electron net.fetch，安卓用原生 OkHttp 代发
src/mobile/      手机版网页：overlay.html（全屏翻译）、settings.html（设置），vite.mobile.config.ts 构建到 out/mobile
android/         Kotlin 原生壳（Gradle）：
  capture/LavaAccessibilityService
                   无障碍模式（推荐，Android 11+）的服务：界面全在 LiveHost；接系统无障碍按钮 / 音量键快捷方式、界面事件；
                   没有前台服务、通知，不需要悬浮窗权限
  LiveHost         无障碍模式的界面与状态：顶部毛玻璃横条 → 整屏翻译（穿透的冻结截图 + 小胶囊）→ 手指一碰让开、停下自动重译 → 回复；读屏、释放、锁屏
  capture/NodeText 从无障碍节点读屏幕文字：逐行、带每个字的位置（EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY），被上层窗口盖住的不读
  ui/Glass, Views  毛玻璃横条（无障碍图层上的透明主题 Dialog + 背景模糊、可上下拖动）、小胶囊（普通无障碍图层窗口、贴边，`FLAG_WATCH_OUTSIDE_TOUCH`）；原生，点图标立刻出现
  LaunchActivity   点图标：就绪时直接弹面板、否则打开设置页（SettingsActivity）；桌面图标的组件名仍是 .MainActivity（别名）
  ScreenHost       截屏授权模式的翻译界面宿主：悬浮球、全屏冻结截图、截屏 → OCR → 交给网页，空闲释放
  FloatService     截屏授权模式（备用）：前台服务 + 悬浮窗 + 系统截屏授权（ProjectionCapturer）
  BubbleView       原生悬浮球（截屏授权模式；贴边、拖动、单击翻译、长按打开菜单）
  OverlayHost      全屏覆盖窗口 + WebView：用时才创建；三种状态：透明不接触摸（等网页画好、译文让开、按住对比）、
                   穿透（无障碍模式的译文：看得见，触摸、返回键、焦点都留给下面的应用）、可交互（冻结截图、回复框、出错提示）；
                   之间只改窗口参数，不重新加窗口
  TranslateTileService / QuickReplyTileService
                   下拉快捷开关「翻译屏幕」「快捷回复」：无障碍模式由服务自己收起通知栏（全局操作），否则经由透明中转页
  ocr/PaddleOcr    ocr.ts 的逐行移植（同一套 PP-OCRv6 模型，ONNX Runtime CPU 后端）
  web/Bridge       原生 ↔ 网页消息通道（WebMessageListener）；截图像素走 /frame/<id> 直接取，不走消息
  web/NetBridge    网页的模型请求由 OkHttp 代发并流式回传（WebView 里直接请求会被跨域拦截）
```

- **两种模式**（`captureMode`）：无障碍模式开一次一直有效，开机由系统拉起；系统截屏授权在 Android 14 起每个会话都要用户同意一次，
  Android 15 QPR1 起锁屏会结束会话，授权期间状态栏的共享计时每秒刷新一次（静止画面上每分钟多合成约 60 帧，屏幕降不到最低刷新率），
  所以关掉翻译 5 分钟后主动结束会话。会话期间虚拟显示器平时不接画面（`setSurface(null)`），截屏时才接上取一帧。
- **无障碍按钮**：服务带 `flagRequestAccessibilityButton` 时，Android 12+ 的无障碍页面只有「快捷方式」开关（打开它就是开启服务，
  默认选无障碍按钮）；点按钮、音量键快捷方式都走 `AccessibilityButtonCallback.onClicked`。全面屏手势下的悬浮按钮
  `isAccessibilityButtonAvailable` 总是 false，所以用可读的 `accessibility_button_targets` / `accessibility_shortcut_target_service` 判断有没有指给本应用。
  无障碍模式里按钮的作用是打开 / 收起面板，翻译中按一下退出。
  侧载应用开启无障碍要先解除「受限制的设置」（vivo 是「风险受限 → 解除限制」，同时解除悬浮窗权限的限制）。
  调研过「默认数字助理」入口：Android 17 实测第三方助理拿不到截图和屏幕文字，vivo 上也藏起了该设置，不可用。
- **整屏翻译**（`LiveHost`）：和截屏授权模式一样是冻结截图 + 译文（v1.3.6 只画译文块、不画截图的实时方案，在读不到逐字位置的
  应用上排版严重错乱，已放弃），但译文窗口是穿透的（`FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE`，无障碍图层是受信任的窗口，
  不受 Android 12 的「不可信触摸」拦截）：触摸、返回键照常交给下面的应用，应用也不会失去焦点（输入法不收起）。
  怎么知道「手指碰了屏幕」：小胶囊窗口带 `FLAG_WATCH_OUTSIDE_TOUCH`，屏幕任何地方按下时收到一次 `ACTION_OUTSIDE`
  （只有按下那一下，别的应用的坐标是 0；对游戏、自绘界面也有效），立刻把译文改成透明。所以第一下滑动就是在滚动应用，
  点按译文就是点按下面对应的控件（安卓不能把进行中的手势转交给下层窗口，所以「先拦下再放行」做不到）。
  小胶囊在译文层之后加入，所以叠在它上面（同类型的无障碍图层按加入顺序叠放）；译文层在整个翻译期间一直挂着。
  让开后用 `setServiceInfo` 订阅滚动、换页事件（原生和网页应用在手指一动后约 50 ms 就发滚动事件），开始翻译就取消；
  事件停下 450 ms 后重新截屏翻译；按下后一直没有事件（只是点了一下）则 700 ms 后比较这一帧的节点文字指纹
  （包括读不到逐字位置的节点），没变就把网页里还在的译文原样放回来，不重新截屏。截屏和译文显示时只订阅「窗口状态变化」
  （返回键、弹窗、页面过场）：显示时收到就让开、按同样规则处理；截屏、读文字时收到（例如刚点开的页面还在过场动画）就作废这张截图，停稳了再截。会误报的事件：输入法弹出 / 收起（按默认输入法的包名忽略）、
  译文层交出焦点（回复框收起后 600 ms 内的不算）。
  出错且提示上有按钮（去设置、重试）时译文变成可交互，重试成功后回到穿透；网页里的「用 X 回复」按钮在无障碍模式不显示（回复在小胶囊上）。
  读屏：先让译文层消失两帧再截屏，小胶囊所在的区域抹成旁边的颜色；文字优先用 `NodeText`，只要有一个文字节点读不到逐字位置
  （只知道整个节点的框，常把名字、时间、消息合在一起）或一行都没有，就整屏对截图做 OCR。
  网页 `liveCache.ts`：按「块」缓存译文（几行原文 → 译文），新屏幕上连续几行与缓存块的原文一致就直接套用，只把剩下的行发给模型
  （带整屏截图作上下文），换目标语言时清空。
  译文上打开回复框、快捷回复时收起小胶囊（网页发 `composer`），免得挡住输入框。
  网页冷启动发 `hello` 时译文层已经挂上（正在截屏），这时不能暂停网页，否则第一次翻译画不出来。
- **毛玻璃**：只有半透明窗口（`windowIsTranslucent`）才有 `setBackgroundBlurRadius` 背景模糊，所以面板、胶囊用透明主题的 Dialog；
  普通 Dialog 不模糊（模拟器实测）。系统关掉跨窗口模糊（省电模式、不支持）时换成更不透明的深色底。
- **锁屏**：无障碍图层会显示在锁屏上面，所以关屏时收起所有窗口、退出翻译，解锁（`USER_PRESENT`，由系统界面发出，
  接收要 `RECEIVER_EXPORTED`）后再显示；锁屏期间按钮、快捷开关都不响应。
- **识别范围**：去掉顶部状态栏；底部不去（Android 15 起应用都画到导航条下面）。
- **OCR 性能**：检测图最长边 1280（手机截图字大，够用）；用时才载入，不预热（预热要多跑一遍完整识别）。XNNPACK 后端在 ORT 1.30 会崩溃，NNAPI 已弃用，只用 CPU。
  ORT 内存池开着：识别后按最大输入尺寸留着约 500 MB，但关掉它识别慢约 1.7 倍、CPU 多用约 50%（模拟器实测，`ocrBench` 的 `arena` 参数可复测），所以开着、用完整个释放。
  模拟器（x86_64，4 线程）上 20 行聊天截图检测约 270 ms、识别约 600 ms；真机待测。
- **截屏授权模式的界面**：翻译时原生悬浮球藏起，由网页里一模一样的球接替（单击或返回键退出、长按打开菜单、拖动换边）；
  不在翻译时长按悬浮球，同一个网页以 menu 模式打开（退出 / 设置 / 译成 / 快捷回复，常用的在最下面）。回复助手复用桌面组件（`window.lens` 由 `replyHost.ts` 在网页内实现）。
- **省电**：闲置时进程几乎不占 CPU（模拟器上实测每分钟约 40 ms，`.scratch/idle-cpu.sh`、`idle-threads.sh` 可复测）：
  网页不在屏幕上时 `onPause` + `pauseTimers`（`LavaApp.webVisible`）；无障碍服务不订阅任何界面事件；ONNX Runtime 关掉线程自旋（每次识别少用约 20% CPU，速度不变）。
  内存（模拟器实测）：翻译一次后进程约 680 MB PSS（OCR 内存池约 500 MB）+ 网页渲染进程约 250 MB。翻译界面关掉 3 分钟后（或关屏时）
  销毁 WebView、关掉 OCR 会话，降到约 200 MB、渲染进程退出（面板出现时预先载入网页，点「翻译」时不用等）。
  网页引擎载入后只有结束进程才释放，系统会以只带无障碍服务的小进程（约 45 MB）重新拉起；但重新拉起有延迟，反复结束时越来越长
  （模拟器上第二次就等了约 30 s，期间点图标没反应），所以只在关屏 30 分钟后才结束进程（`AlarmManager` 唤醒一次）。
  设置页 `autoRemoveFromRecents`：不留在最近任务里，免得「一键清理」把应用强行停止（强行停止会连带关掉无障碍）。
  截屏授权模式：「退出」（菜单、通知、设置页）停掉前台服务并结束进程；长时间不用（`idleExit` 分钟，默认 60，`AlarmManager.setWindow` 允许推迟 10 分钟）
  或系统打开省电模式（`saverExit`）时自动退出，留一条点了就重新打开的通知。
  `WebView.setWebContentsDebuggingEnabled` 会载入整个 WebView 引擎，所以放在 `createWebView` 里，不放 `Application.onCreate`。

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
  打开应用、截屏授权模式的悬浮球开着时、无障碍模式每次用完时，至多每天自动检查一次；Wi-Fi 下自动下载好并发通知，流量下只提示。第一次要允许「安装未知应用」并确认一次；
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
