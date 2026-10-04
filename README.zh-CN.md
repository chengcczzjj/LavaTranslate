<p align="center">
  <img src="docs/images/icon.png" width="112" alt="LavaTranslate">
</p>

<h1 align="center">LavaTranslate</h1>

<p align="center">
  <b>框选屏幕任意区域，译文按原来的排版直接盖在原文上。</b><br>
  看懂外语聊天后，还能用自己的语言直接回复。
</p>

<p align="center">
  <a href="https://github.com/chengcczzjj/LavaTranslate/releases/latest"><img src="https://img.shields.io/github/v/release/chengcczzjj/LavaTranslate?color=e23e9a&label=%E4%B8%8B%E8%BD%BD" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%20%2F%2011%20x64-5c46ff" alt="Windows 10/11">
  <a href="https://github.com/chengcczzjj/LavaTranslate/releases"><img src="https://img.shields.io/github/downloads/chengcczzjj/LavaTranslate/total?color=ff8c34&label=%E4%B8%8B%E8%BD%BD%E9%87%8F" alt="下载量"></a>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

---

![左：原网页；右：LavaTranslate 原位翻译](docs/images/compare-wiki.png)

## 有什么不一样

一般的截图翻译把结果列在另一个窗口里，你得一句句对回屏幕上去找。LavaTranslate 把每一行译文**放回原文所在的位置**：

- **位置、字号、颜色、粗细、对齐都和原文一致**：字号按笔画的实际高度推算，文字颜色能抵消 ClearType 的彩色边，粗体常规分得清，左对齐、居中、右对齐都保持，绕图排列的段落也保持原来的形状；
- **图标不会被盖掉**：被 OCR 误认成字符的箭头、星星、列表序号都保留可见；
- **模型会看截图**：文字识别在本地完成，再由支持看图的模型纠正识别错误、把折行的句子合成段落，代码、命令、网址、@用户名、品牌名保持原样不翻；
- **快**：按下快捷键约 0.2 秒出现截图界面，本地 OCR 用 GPU 0.1–0.3 秒，译文逐段流式出现，小模型翻完一张截图通常 2–5 秒。

![GitHub 页面翻译前后](docs/images/compare-github.png)

## 回复助手

看懂了对方的消息，接下来就是回复。

<img src="docs/images/reply.png" width="520" align="right" alt="回复助手">

- 截图是**聊天、私信、评论、邮件**这类对话时，翻译完成后工具条下方会自动出现回复框；任何时候按 <kbd>R</kbd> 也能打开；
- 用自己的语言输入，停顿片刻就开始翻译，默认译成截图里识别出的对方语言（可以改）；
- 语气可选「跟随语境 / 正式 / 随意」，模型会参照屏幕上的对话决定措辞和称呼；
- 译文下方附**回译**：再翻回你的语言，不懂对方的语言也能确认意思没变；
- <kbd>Enter</kbd> 复制并关闭，回到聊天软件直接粘贴发送；<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 只复制，<kbd>Shift</kbd>+<kbd>Enter</kbd> 换行，<kbd>↑</kbd> / <kbd>↓</kbd> 翻看发过的回复。

<br clear="right">

## 下载安装

1. 在 [Releases](https://github.com/chengcczzjj/LavaTranslate/releases/latest) 下载 **`LavaTranslate-Setup-x.y.z.exe`**（Windows 10/11 x64）；
2. 运行安装程序。如果 Windows SmartScreen 提示「未知发布者」，点 **更多信息 → 仍要运行**；
3. 装好后 LavaTranslate 常驻在系统托盘，之后的新版本会在后台自动下载（见[自动更新](#自动更新)）。

## 配置：填写你自己的 API Key

软件不内置任何 Key，用你自己的；翻译多少，就按服务商的价格付多少。

1. 双击托盘图标打开 **设置** → **翻译服务**，选一个服务商；
2. 按「**如何获取 API Key**」里的步骤操作，点按钮直接打开服务商的 Key 页面；把 Key 粘贴进来，点「**保存并获取模型**」；
3. 选一个模型。列表按「每千次截图约多少钱」从低到高排序，并标出「推荐」「快」「仅文字」；
4. 点「**测试翻译**」，然后在任意地方按 <kbd>Alt</kbd>+<kbd>Q</kbd>，拖动框选文字即可。

每个服务商分别保存自己的 Key 和模型，来回切换不用重新填写。

<img src="docs/images/settings-service.png" width="560" alt="翻译服务设置">

**支持的服务商**

| 服务商 | 获取 Key | 推荐的快模型 | 说明 |
| --- | --- | --- | --- |
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `gemini-3.5-flash-lite` | 有免费额度，免费额度内的数据可能被 Google 使用；国内需要代理 |
| OpenAI | [OpenAI Platform](https://platform.openai.com/api-keys) | `gpt-6-luna`、`gpt-5-mini` | ChatGPT 会员不包含 API 额度 |
| DeepSeek | [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) | `deepseek-flash` | 能看图，首字约 1 秒，非高峰时段半价，国内直连 |
| 通义千问 | [阿里云百炼](https://bailian.console.aliyun.com/?tab=model#/api-key) | `qwen3.8-flash` | 新用户有免费额度，国内直连 |
| 智谱 GLM | [智谱开放平台](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) | `glm-4.6v-flash` | 免费且能看图（同一时间只处理一个请求） |
| Kimi | [Kimi 开放平台](https://platform.kimi.com/console/api-keys) | | 国内直连 |
| 豆包 | [火山方舟](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) | `doubao-seed-2.0-mini` | 新用户有免费额度，国内直连 |
| Claude | [Claude Console](https://platform.claude.com/settings/keys) | `claude-haiku-4-5` | 只能用 API Key：Anthropic 不允许第三方软件使用 Claude Pro / Max 会员登录 |
| OpenRouter | [OpenRouter](https://openrouter.ai/settings/keys) | | 一个 Key 用遍各家模型 |
| 自定义 | — | | 任何兼容 OpenAI 接口的服务：中转站、Ollama、LM Studio 等 |

软件会让所有模型跳过「思考」直接作答（按各家自己的参数，不支持时自动退回），DeepSeek V4 Flash、GLM Flash 这类模型因此快 2–4 倍。不能看图的模型也能用，只是只根据 OCR 文字翻译，没法纠正识别错误。在「自定义」里点「**从本机导入**」，可以直接用 Codex 或 CC Switch 里现成的 Key。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>Q</kbd>（可改）或单击托盘图标 | 开始截图翻译 |
| 双击托盘图标 | 打开设置 |
| 拖动 / 单击 | 框选区域 / 选中鼠标下的窗口 |
| 拖动选区、拖动手柄 | 移动、调整选区，松开后自动重新翻译 |
| 按住 <kbd>Space</kbd> | 查看原文 |
| <kbd>Tab</kbd> | 切换「原位覆盖 / 并排对照」 |
| 单击某段译文 | 复制这一段 |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Alt</kbd>+<kbd>C</kbd> | 复制全部译文 / 全部原文 |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>S</kbd> | 复制 / 保存翻译后的截图 |
| <kbd>F3</kbd> | 钉在桌面（可拖动、滚轮缩放、双击关闭） |
| <kbd>R</kbd> | 打开回复助手 |
| <kbd>Enter</kbd> 或双击选区 | 复制全部译文并关闭 |
| 右键 / <kbd>Esc</kbd> | 重新框选 / 退出 |

## 隐私

- 文字识别（OCR）**在本机完成**；
- 只有你框选的区域（图片和识别出的文字）以及你写的回复，会发给**你自己配置的服务**，不经过我们的服务器，也不保存任何记录；
- API Key 用 Windows DPAPI 加密保存在本机，设置页只显示末 4 位。

## 自动更新

软件每 4 小时检查一次本仓库的 Releases，只下载安装包里有变化的部分。下载完成后，托盘菜单和「关于」页会出现「**重启并更新**」；不点的话，下次退出软件时自动安装。可以在 设置 → 关于 里关闭自动更新。

## 常见问题

**能用 ChatGPT / Codex 会员吗？**
不能。ChatGPT 账号登录没有 API Key，需要 OpenAI 或其他服务商的 API Key。

**翻译比较慢？**
换一个标着「快」的小模型。推理型模型写之前要先思考好几秒。

**支持哪些语言？**
本地 OCR 能识别中文、日文、英文等拉丁字母语言、俄文等；OCR 认不出的文字（比如韩文）由能看图的模型直接从截图里读出来。译成什么语言，在工具条上随时切换。

**怎么卸载？**
Windows 设置 → 应用 → LavaTranslate → 卸载。

## 从源码构建

需要 Windows 10/11 x64、Node.js 22 以上；有 Python 3 和 `onnx` 时会顺便给 OCR 模型打加速补丁（可选）。

```bash
npm install
npm run models   # 下载 PP-OCRv6 模型（约 30 MB）
npm run dev      # 开发模式运行
npm run dist     # 打包 NSIS 安装程序到 dist/
```

架构、排版引擎和自动测试的说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

技术栈：Electron、React、Motion，[PaddleOCR PP-OCRv6](https://github.com/PaddlePaddle/PaddleOCR) 模型由 ONNX Runtime（DirectML）运行，OpenAI / Anthropic SDK。

## 许可证

[MIT](LICENSE) © 2026 chengcczzjj

---

<p align="center">问题和建议欢迎提 <a href="https://github.com/chengcczzjj/LavaTranslate/issues">Issues</a></p>
