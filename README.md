<p align="center">
  <img src="docs/images/icon.png" width="112" alt="LavaTranslate">
</p>

<h1 align="center">LavaTranslate</h1>

<p align="center">
  <b>Select any part of your screen — the translation appears right on top of it, in the same layout.</b><br>
  Then answer foreign-language chats in your own language.
</p>

<p align="center">
  <a href="https://github.com/chengcczzjj/LavaTranslate/releases/latest"><img src="https://img.shields.io/github/v/release/chengcczzjj/LavaTranslate?color=e23e9a&label=download" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20x64-5c46ff" alt="Windows 10/11">
  <a href="https://github.com/chengcczzjj/LavaTranslate/releases"><img src="https://img.shields.io/github/downloads/chengcczzjj/LavaTranslate/total?color=ff8c34" alt="Downloads"></a>
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

---

![Original page (left) and LavaTranslate's in-place translation (right)](docs/images/compare-wiki.png)

## Why LavaTranslate

Most screenshot translators show a list of sentences in a separate window, so you have to match each one back to the screen. LavaTranslate puts every translated line **exactly where the original was**:

- **Same position, size, color, weight and alignment.** Each line keeps its font size (measured from the actual stroke height), text color (robust to ClearType fringes), bold or regular weight, and left/center/right alignment. Paragraphs that wrap around images keep their shape.
- **Icons stay visible.** Arrows, stars, list numbers and other icons that OCR mistakes for letters are not painted over.
- **The model looks at the screenshot itself.** OCR runs locally; a vision model then fixes recognition errors, merges wrapped lines into paragraphs, and leaves code, commands, URLs, @handles and brand names untranslated.
- **Fast.** The capture overlay appears in about 0.2 s, local OCR takes 0.1–0.3 s on the GPU, and translations stream in block by block. A small model finishes a typical screenshot in 2–5 s.

![Before and after on GitHub](docs/images/compare-github.png)

## Reply assistant

You can read the other person's message now — LavaTranslate also helps you answer it.

<img src="docs/images/reply.png" width="520" align="right" alt="Reply assistant">

- When the screenshot is a **chat, DM, comment thread or email**, a reply box opens under the toolbar after the translation finishes. Press <kbd>R</kbd> to open it anytime.
- Type in your own language. It starts translating after a short pause, into the language detected on screen (you can change it).
- Pick a tone: **Match the conversation**, **Formal** or **Casual**. The model reads the conversation on screen to get the wording and form of address right.
- A **back-translation** below the result shows you what you are actually sending.
- <kbd>Enter</kbd> copies and closes so you can paste straight into the chat. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> copies only, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a new line, and <kbd>↑</kbd>/<kbd>↓</kbd> go through your previous replies.

<br clear="right">

## Download and install

1. Download **`LavaTranslate-Setup-x.y.z.exe`** from [Releases](https://github.com/chengcczzjj/LavaTranslate/releases/latest). It runs on Windows 10/11 x64.
2. Run the installer. If Windows SmartScreen warns about an unknown publisher, click **More info → Run anyway**.
3. LavaTranslate runs in the system tray. Updates are downloaded automatically in the background (see [Updates](#updates)).

> The interface is currently in Simplified Chinese. You can translate between any languages the model supports.

## Setup: bring your own API key

LavaTranslate does not ship with a key. You use your own, and you only pay your provider for what you translate.

1. Open **Settings** (double-click the tray icon) → **翻译服务 (Translation service)** and pick a provider.
2. Follow the built-in steps under **如何获取 API Key (How to get an API key)** — the button opens the provider's key page. Paste the key and click **保存并获取模型 (Save & fetch models)**.
3. Pick a model. The list is sorted by estimated cost per 1,000 screenshots and marks the recommended, fast and text-only models.
4. Click **测试翻译 (Test)**, then press <kbd>Alt</kbd>+<kbd>Q</kbd> anywhere and drag over some text.

Each provider keeps its own key and model, so you can switch back and forth without re-entering anything.

<img src="docs/images/settings-service.png" width="560" alt="Translation service settings">

**Providers**

| Provider | Get a key | Good fast models | Notes |
| --- | --- | --- | --- |
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `gemini-3.5-flash-lite` | Free tier; free-tier data may be used by Google. Needs a proxy in mainland China. |
| OpenAI | [OpenAI Platform](https://platform.openai.com/api-keys) | `gpt-6-luna`, `gpt-5-mini` | ChatGPT plans don't include API credit. |
| DeepSeek | [DeepSeek Platform](https://platform.deepseek.com/api_keys) | `deepseek-flash` | Reads images, ~1 s to first token, half price off-peak. |
| Qwen (Alibaba Cloud) | [Model Studio](https://bailian.console.aliyun.com/?tab=model#/api-key) | `qwen3.8-flash` | Free quota for new users. |
| Zhipu GLM | [BigModel](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) | `glm-4.6v-flash` | Free vision model (one request at a time). |
| Kimi | [Kimi Platform](https://platform.kimi.com/console/api-keys) | | |
| Doubao (Volcano Engine) | [Ark console](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) | `doubao-seed-2.0-mini` | Free quota for new users. |
| Claude | [Claude Console](https://platform.claude.com/settings/keys) | `claude-haiku-4-5` | API key only — Anthropic doesn't allow third-party apps to use Claude Pro/Max logins. |
| OpenRouter | [OpenRouter](https://openrouter.ai/settings/keys) | | One key for many vendors. |
| Custom | — | | Any OpenAI-compatible endpoint: relays, Ollama, LM Studio… |

LavaTranslate asks every model to skip "thinking" (each provider's own switch, falling back automatically), which makes translation 2–4× faster on models such as DeepSeek V4 Flash and GLM Flash. Models without image input still work: they translate from the OCR text alone, so they can't correct OCR mistakes. On the Custom provider, **从本机导入 (Import from this PC)** can fill in a key from Codex or CC Switch.

## Shortcuts

| Key | Action |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>Q</kbd> (configurable) or click the tray icon | Start a capture |
| Double-click the tray icon | Open Settings |
| Drag / click | Select a region / select the window under the cursor |
| Drag the selection or its handles | Move / resize — it translates again when you let go |
| Hold <kbd>Space</kbd> | Show the original |
| <kbd>Tab</kbd> | Switch between *in place* and *side by side* |
| Click a translated block | Copy that block |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Alt</kbd>+<kbd>C</kbd> | Copy all translations / all original text |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>S</kbd> | Copy / save the translated screenshot |
| <kbd>F3</kbd> | Pin the result on the desktop (drag to move, scroll to zoom, double-click to close) |
| <kbd>R</kbd> | Open the reply assistant |
| <kbd>Enter</kbd> or double-click | Copy all translations and close |
| Right-click / <kbd>Esc</kbd> | Select again / exit |

## Privacy

- Text recognition (OCR) runs **locally** on your PC.
- Only the region you select (image + recognized text), plus any reply you type, is sent to **the service you configured**. Nothing goes to us. LavaTranslate keeps no history.
- Your API key is encrypted with Windows DPAPI and stays on your PC. The settings page only ever shows its last 4 characters.

## Updates

LavaTranslate checks this repository's Releases every 4 hours and downloads only the parts of the installer that changed. When an update is ready, **重启并更新 (Restart & update)** appears in the tray menu and on the About page. If you don't restart, it installs the next time you quit. You can turn this off in Settings → 关于 (About).

## FAQ

**Can I use my ChatGPT / Codex subscription?**
No. A ChatGPT login doesn't come with an API key. You need an API key from OpenAI or another provider.

**The translation is slow.**
Choose a smaller model (marked 快 / fast). Reasoning-heavy models spend seconds thinking before they write.

**Which languages are supported?**
The local OCR reads Chinese, Japanese, English and other Latin-script languages, Cyrillic and more. A vision model reads anything the OCR can't (for example Korean) straight from the screenshot. You can translate into any language you pick on the toolbar.

**How do I uninstall?**
Go to Windows Settings → Apps → LavaTranslate → Uninstall.

## Build from source

Requirements: Windows 10/11 x64, Node.js 22+, and Python 3 with `onnx` (optional, used to patch the OCR model for speed).

```bash
npm install
npm run models   # download the PP-OCRv6 models (~30 MB)
npm run dev      # run in development mode
npm run dist     # build the NSIS installer into dist/
```

Architecture, the layout engine and the test harnesses are described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Chinese).

Built with Electron, React, Motion, [PaddleOCR PP-OCRv6](https://github.com/PaddlePaddle/PaddleOCR) models run by ONNX Runtime (DirectML), and the OpenAI / Anthropic SDKs.

## License

[MIT](LICENSE) © 2026 chengcczzjj

---

<p align="center">Bug reports and ideas: <a href="https://github.com/chengcczzjj/LavaTranslate/issues">Issues</a></p>
