// 模型翻译：两种引擎共用同一套提示词与 JSONL 流式解析
//  - ApiEngine：Claude（Anthropic Messages API，官方 Key 或中转）
//  - OpenAIEngine：其余所有服务（OpenAI 兼容接口：Responses 或 Chat Completions）
// 都走 Chromium 网络栈（系统代理、HTTP/2），截图界面一打开就预连接
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { net, session } from 'electron'
import type { ErrorCode, Language, OcrLine, TranslatedBlock, TranslateEvent } from '../shared/types'

export interface EngineCredentials {
  baseURL: string
  apiKey: string
}

export interface TranslateRequest {
  image: { base64: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number }
  lines: OcrLine[]
  target: Language
  styleHint: string
}

export interface TranslateResult {
  firstTokenMs?: number
  usage?: { input: number; output: number }
}

export type Emit = (e: TranslateEvent) => void

export class TranslateError extends Error {
  constructor(
    message: string,
    public code: ErrorCode
  ) {
    super(message)
  }
}

/** 回复助手：把用户用自己语言写的回复，结合屏幕上的对话翻译成对方的语言 */
export interface ReplyRequest {
  text: string
  /** 用户自己的语言 */
  from: Language
  /** 对方的语言 */
  to: Language
  /** 屏幕上的对话（OCR 文本） */
  context: string
  tone: 'auto' | 'formal' | 'casual'
}

export interface Engine {
  readonly name: string
  /** 截图界面一打开就调用：提前建立连接 */
  warm(): void
  translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult>
  /** 流式输出：译文，一行 ⟲，再是回译 */
  reply(req: ReplyRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<void>
  dispose(): void
}

// ------------------------------------------------------------------ 提示词
const SYSTEM_PROMPT = `You are the translation engine of a desktop screenshot translator. The user selected a region of their screen; you receive that screenshot plus the OCR lines detected in it. Your output is rendered as an overlay that replaces each original text block, in place, with your translation — so it must map exactly onto the OCR lines.

How to work:
1. Read the image. Use it to correct OCR mistakes (wrong characters, lost accents, merged or split words). Lines shown as ⟨?⟩ could not be read by OCR — read them from the image at their box.
2. Group lines into blocks. Lines that are one sentence or paragraph wrapped across several lines form one block. Headings, buttons, menu items, labels, list items, table cells, metadata lines and code lines stay separate blocks. Never merge lines that are visually separate elements. OCR numbers lines top-to-bottom across the whole image, so a paragraph beside an image or sidebar can have non-consecutive ids — group by visual element, not by id order.
3. Translate each block into the target language the way a native speaker would phrase it in this context (UI, article, chat, game, code comment…). Keep it concise so it fits the original space: buttons and menu items short, same tone. Leave untranslated: code, commands, file paths, URLs, emails, @handles, numbers with units, version strings, and brand/product names; in mixed lines translate the prose around them. Feature, menu, tab and button names inside a product (e.g. "Pull requests", "Issues", "Settings", "Inbox") are not brand names — translate them the way that product's localized UI would.
4. If a block is already in the target language, or has nothing translatable (pure code, numbers, symbols), add "keep":true and copy the corrected source as the translation.
5. If one OCR line holds several separate UI items (e.g. a menu bar "Home   Products   About"), translate each item and keep the separators/spacing between them.
6. OCR often reads icons as characters (▲ ☆ ① <> 田, a stray letter or digit next to an icon). Leave such icon glyphs out of both src and dst, and likewise leading list numbers and bullets ("1.", "•") — they stay visible as they are. Text that is part of a logo or stylized artwork gets "keep":true.

Output JSON Lines only — one compact JSON object per line, no prose, no markdown, no code fences.
Line 1: {"lang":"<BCP-47 code of the dominant source language>","name":"<that language's name in Simplified Chinese, e.g. 英语>","chat":<true if the screenshot is a conversation the user may want to answer — chat/IM window, DMs, comment or reply thread, email — else false>}
Then one line per block, in reading order:
{"ids":[<OCR ids>],"role":"title|paragraph|ui|code|caption|other","src":"<corrected source>","dst":"<translation>"}
Every OCR id must appear in exactly one block.`

export function userText(req: TranslateRequest) {
  const rows = req.lines.map((l) => {
    const b = l.box
    const text = l.score < 0.5 || !l.text ? '⟨?⟩' : l.text
    return `${l.id} | ${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)} | ${text}`
  })
  return [
    `Target language: ${req.target.native} (${req.target.code})`,
    req.styleHint ? `Style preference from the user: ${req.styleHint}` : '',
    `Image: ${req.image.width}×${req.image.height} px. OCR lines — id | box x,y,w,h | text:`,
    ...rows
  ]
    .filter(Boolean)
    .join('\n')
}

function userContent(req: TranslateRequest): Anthropic.ContentBlockParam[] {
  return [
    { type: 'image', source: { type: 'base64', media_type: req.image.mediaType, data: req.image.base64 } },
    { type: 'text', text: userText(req) }
  ]
}

// ------------------------------------------------------------------ 回复助手提示词
export const BACK_MARK = '⟲'

const REPLY_PROMPT = `You help a user reply in a chat whose language they don't speak. Translate the user's message into the target language the way a native speaker would write it in this conversation.

- Match the conversation's register: casual chat stays casual, polite stays polite — unless a tone is requested.
- Keep the meaning exactly: don't add, drop or soften anything. Keep emojis, names, numbers, links and line breaks.
- Use the conversation only to choose wording, names and terms; never answer it yourself.
- Output only the translated message. Then a line containing only ⟲, then a faithful back-translation of your message into the user's language so they can check it. No quotes, labels or explanations.`

const TONE_TEXT = {
  auto: 'follow the conversation',
  formal: 'more formal and polite',
  casual: 'more casual and friendly'
} as const

export function replyText(r: ReplyRequest) {
  const ctx = r.context.trim().slice(-3000)
  return [
    ctx ? `Conversation on screen (OCR, may contain errors):\n<<<\n${ctx}\n>>>` : '',
    `Target language: ${r.to.native} (${r.to.code}). User's language: ${r.from.native} (${r.from.code}).`,
    `Tone: ${TONE_TEXT[r.tone]}.`,
    `Message to translate:\n<<<\n${r.text}\n>>>`
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ------------------------------------------------------------------ 流式解析
// 不依赖换行：逐字符跟踪字符串与括号深度，每闭合一个顶层 {...} 就解析一次。
// 这样无论模型输出严格的 JSON Lines、数组，还是带缩进的多行对象都能边收边出。
export class BlockParser {
  private buf = ''
  private depth = 0
  private inStr = false
  private esc = false
  private start = -1
  private seen = new Set<number>()
  private n = 0
  private valid: Set<number>

  constructor(
    lines: OcrLine[],
    private emit: Emit
  ) {
    this.valid = new Set(lines.map((l) => l.id))
  }

  push(chunk: string) {
    for (const ch of chunk) {
      if (this.start >= 0) this.buf += ch
      if (this.inStr) {
        if (this.esc) this.esc = false
        else if (ch === '\\') this.esc = true
        else if (ch === '"') this.inStr = false
        continue
      }
      if (ch === '"') {
        if (this.start >= 0) this.inStr = true
      } else if (ch === '{') {
        if (this.depth === 0) {
          this.start = 0
          this.buf = '{'
        }
        this.depth++
      } else if (ch === '}' && this.depth > 0) {
        this.depth--
        if (this.depth === 0) {
          this.object(this.buf)
          this.buf = ''
          this.start = -1
        }
      }
    }
  }

  end() {}

  get blockCount() {
    return this.n
  }

  private object(raw: string) {
    let o: any
    try {
      o = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof o.lang === 'string' && !o.ids) {
      this.emit({ type: 'lang', code: o.lang, name: typeof o.name === 'string' ? o.name : o.lang, chat: typeof o.chat === 'boolean' ? o.chat : undefined })
      return
    }
    if (!Array.isArray(o.ids) || typeof o.dst !== 'string') return
    const ids = o.ids.map(Number).filter((id: number) => this.valid.has(id) && !this.seen.has(id))
    if (!ids.length) return
    ids.forEach((id: number) => this.seen.add(id))
    const block: TranslatedBlock = {
      key: `b${++this.n}`,
      lineIds: ids,
      source: typeof o.src === 'string' ? o.src : '',
      translation: o.dst,
      keep: o.keep === true || undefined,
      role: o.role
    }
    this.emit({ type: 'block', block })
  }
}

// ------------------------------------------------------------------ API 引擎
export class ApiEngine implements Engine {
  readonly name: string
  private client: Anthropic

  constructor(
    private creds: EngineCredentials,
    private model: string
  ) {
    this.name = model
    // 官方 Key 走 x-api-key；第三方中转通常两种头都认，一并带上
    const official = creds.apiKey.startsWith('sk-ant-')
    this.client = new Anthropic({
      baseURL: creds.baseURL || undefined,
      apiKey: creds.apiKey,
      authToken: official ? null : creds.apiKey,
      maxRetries: 1,
      timeout: 60_000,
      // Chromium 网络栈：自动使用系统代理，支持 HTTP/2 与连接复用
      fetch: ((input: any, init?: any) => net.fetch(input, init)) as any
    })
  }

  warm() {
    const url = this.creds.baseURL || 'https://api.anthropic.com'
    try {
      session.defaultSession.preconnect({ url, numSockets: 2 })
    } catch {
      /* 忽略 */
    }
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    const t0 = Date.now()
    const parser = new BlockParser(req.lines, emit)
    let firstTokenMs: number | undefined
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent(req) }]
        },
        { signal }
      )
      stream.on('text', (delta) => {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - t0
        parser.push(delta)
      })
      const msg = await stream.finalMessage()
      parser.end()
      if (!parser.blockCount) throw new TranslateError('Claude 没有返回可用的译文，请重试', 'unknown')
      return { firstTokenMs, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } }
    } catch (e) {
      if (signal.aborted) throw new TranslateError('已取消', 'unknown')
      if (e instanceof TranslateError) throw e
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
        throw new TranslateError('API Key 无效或已停用', 'auth')
      if (e instanceof Anthropic.RateLimitError) throw new TranslateError('请求过于频繁或额度不足', 'rate-limit')
      if (e instanceof Anthropic.APIConnectionError) throw new TranslateError('无法连接到 API 服务', 'network')
      if (e instanceof Anthropic.APIError) throw new TranslateError(`API 错误 ${e.status ?? ''}：${e.message}`, 'unknown')
      throw new TranslateError(e instanceof Error ? e.message : String(e), 'unknown')
    }
  }

  async reply(req: ReplyRequest, onText: (d: string) => void, signal: AbortSignal): Promise<void> {
    try {
      const stream = this.client.messages.stream(
        { model: this.model, max_tokens: 4096, system: REPLY_PROMPT, messages: [{ role: 'user', content: replyText(req) }] },
        { signal }
      )
      stream.on('text', onText)
      await stream.finalMessage()
    } catch (e) {
      if (signal.aborted) throw new TranslateError('已取消', 'unknown')
      if (e instanceof Anthropic.AuthenticationError) throw new TranslateError('API Key 无效或已停用', 'auth')
      if (e instanceof Anthropic.APIConnectionError) throw new TranslateError('无法连接到 API 服务', 'network')
      throw new TranslateError(e instanceof Error ? e.message : String(e), 'unknown')
    }
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids
  }

  dispose() {}
}

// ------------------------------------------------------------------ OpenAI 兼容引擎（OpenAI 官方 / Codex 中转 / DeepSeek、通义等）
/**
 * 推理强度依次尝试；模型不支持该档时退到下一档，最后不带 reasoning。
 * 翻译不需要深度思考：DeepSeek V4、GLM 等默认会先思考几百个 token，关掉后首字快 2–4 倍
 */
function effortsFor(_model: string): (string | null)[] {
  // 自测对照用：LENS_OPENAI_EFFORT=default 不传推理参数（模型默认会思考）
  if (process.env.LENS_OPENAI_EFFORT === 'default') return [null]
  return ['none', 'minimal', 'low', null]
}

type Part = { type: 'text'; text: string } | { type: 'image'; url: string }

/** 服务商没有 Responses 接口（多数国产模型的官方 API 只有 Chat Completions） */
function missingEndpoint(e: unknown) {
  if (!(e instanceof OpenAI.APIError)) return false
  if (/model/i.test(e.message) && !/responses/i.test(e.message)) return false // 「模型不存在」也是 404，不能当成没有接口
  if (e.status === 404 || e.status === 405 || e.status === 501) return true
  return e.status === 400 && /(responses|endpoint|not supported|unsupported).*(api|path|url|endpoint|route)|invalid url|unknown url/i.test(e.message)
}

/** Key 无效：多数服务返回 401，Gemini 返回 400 */
function badKey(e: unknown) {
  return e instanceof OpenAI.BadRequestError && /api[ _-]?key|API_KEY_INVALID/i.test(e.message)
}

/** 模型不能看图 */
function imageUnsupported(e: unknown) {
  return e instanceof OpenAI.APIError && /image|vision|multimodal|modalit|unsupported.*(content|type)|content.*type|unknown variant/i.test(e.message)
}

export class OpenAIEngine implements Engine {
  readonly name: string
  private client: OpenAI
  /** 已知该模型可用的推理强度，避免每次都从头试 */
  private effortIdx = 0
  /** 模型不支持看图：只发 OCR 文本 */
  private textOnly = false
  /** 先用 Responses（与 Codex 相同），服务商没有这个接口时改用 Chat Completions 并记住 */
  private api: 'responses' | 'chat'
  /** Chat Completions 里关掉思考的参数（各家写法不同）；服务商不认时去掉并记住 */
  private extra: Record<string, unknown> | null

  constructor(
    private creds: EngineCredentials,
    private model: string,
    opts: { api?: 'responses' | 'chat' | 'auto'; chatExtra?: Record<string, unknown> } = {}
  ) {
    this.name = model
    this.api = opts.api === 'chat' || process.env.LENS_OPENAI_API === 'chat' ? 'chat' : 'responses'
    this.extra = process.env.LENS_OPENAI_EFFORT === 'default' ? null : (opts.chatExtra ?? null)
    this.client = new OpenAI({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      maxRetries: 1,
      timeout: 60_000,
      fetch: ((input: any, init?: any) => net.fetch(input, init)) as any
    })
  }

  warm() {
    try {
      session.defaultSession.preconnect({ url: this.creds.baseURL, numSockets: 2 })
    } catch {
      /* 忽略 */
    }
  }

  /** 模型不支持当前推理强度时自动换下一档 */
  private async withEffort<T>(call: (effort: string | null) => Promise<T>): Promise<T> {
    const efforts = effortsFor(this.model)
    for (;;) {
      const effort = efforts[Math.min(this.effortIdx, efforts.length - 1)]
      try {
        return await call(effort)
      } catch (e) {
        if (e instanceof OpenAI.BadRequestError && effort && !badKey(e)) {
          // 明确是这一档不支持：试下一档；其他 400（可能根本不认 reasoning 参数）：直接不带它重试
          this.effortIdx = /reason|effort/i.test(e.message) ? this.effortIdx + 1 : efforts.length - 1
          continue
        }
        throw e
      }
    }
  }

  /** 流式请求，逐段回调文本，返回用量 */
  private async run(instructions: string, parts: Part[], signal: AbortSignal, onText: (d: string) => void): Promise<TranslateResult['usage']> {
    if (this.api === 'responses') {
      try {
        const stream = await this.withEffort((effort) =>
          this.client.responses.create(
            {
              model: this.model,
              instructions,
              input: [
                {
                  role: 'user',
                  content: parts.map((p) =>
                    p.type === 'text' ? { type: 'input_text' as const, text: p.text } : { type: 'input_image' as const, image_url: p.url, detail: 'high' as const }
                  )
                }
              ],
              stream: true,
              store: false,
              ...(effort ? { reasoning: { effort: effort as OpenAI.ReasoningEffort } } : {})
            },
            { signal }
          )
        )
        return await this.drain(stream, onText)
      } catch (e) {
        if (!missingEndpoint(e)) throw e
        this.api = 'chat'
      }
    }
    return this.chat(instructions, parts, signal, onText)
  }

  private async drain(stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>, onText: (d: string) => void) {
    let usage: TranslateResult['usage']
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') onText(ev.delta)
      else if (ev.type === 'response.completed') {
        const u = ev.response.usage
        if (u) usage = { input: u.input_tokens, output: u.output_tokens }
      } else if (ev.type === 'response.failed') throw new TranslateError(ev.response.error?.message ?? '模型返回失败', 'unknown')
      else if (ev.type === 'error') throw new TranslateError(ev.message ?? '模型返回错误', 'unknown')
    }
    return usage
  }

  private async chat(instructions: string, parts: Part[], signal: AbortSignal, onText: (d: string) => void) {
    const content =
      parts.length === 1 && parts[0].type === 'text'
        ? parts[0].text
        : parts.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'image_url' as const, image_url: { url: p.url, detail: 'high' as const } }))
    const create = (usage: boolean, more: Record<string, unknown>) =>
      this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content }
          ],
          stream: true,
          ...(usage ? { stream_options: { include_usage: true } } : {}),
          ...more
        } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal }
      )
    // 有服务商专用的"关闭思考"参数就用它，否则用 reasoning_effort 逐档尝试
    const open = (usage: boolean) =>
      this.extra ? create(usage, this.extra) : this.withEffort((effort) => create(usage, effort ? { reasoning_effort: effort } : {}))
    let stream
    for (let usage = true; ; ) {
      try {
        stream = await open(usage)
        break
      } catch (e) {
        if (!(e instanceof OpenAI.BadRequestError)) throw e
        // 少数服务不认 stream_options
        if (usage && /stream_options|include_usage/i.test(e.message)) usage = false
        else if (this.extra && !badKey(e)) this.extra = null
        else throw e
      }
    }
    let usage: TranslateResult['usage']
    for await (const ch of stream) {
      const d = ch.choices?.[0]?.delta?.content
      if (d) onText(d)
      if (ch.usage) usage = { input: ch.usage.prompt_tokens, output: ch.usage.completion_tokens }
    }
    return usage
  }

  private fail(e: unknown, signal: AbortSignal): never {
    if (signal.aborted) throw new TranslateError('已取消', 'unknown')
    if (e instanceof TranslateError) throw e
    if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError || badKey(e)) throw new TranslateError('API Key 无效或已停用', 'auth')
    if (e instanceof OpenAI.RateLimitError) throw new TranslateError('请求过于频繁或额度不足', 'rate-limit')
    if (e instanceof OpenAI.APIConnectionError) throw new TranslateError('无法连接到 API 服务', 'network')
    if (e instanceof OpenAI.APIError) {
      if (/no available .*accounts? support/i.test(e.message)) throw new TranslateError(`服务商当前没有可用的 ${this.model}，请在设置里换个模型`, 'unknown')
      throw new TranslateError(`API 错误 ${e.status ?? ''}：${e.message}`, 'unknown')
    }
    throw new TranslateError(e instanceof Error ? e.message : String(e), 'unknown')
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    const t0 = Date.now()
    const parser = new BlockParser(req.lines, emit)
    let firstTokenMs: number | undefined
    const parts = (): Part[] => [
      ...(this.textOnly ? [] : [{ type: 'image' as const, url: `data:${req.image.mediaType};base64,${req.image.base64}` }]),
      { type: 'text', text: userText(req) }
    ]
    const onText = (d: string) => {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - t0
      parser.push(d)
    }
    try {
      let usage
      try {
        usage = await this.run(SYSTEM_PROMPT, parts(), signal, onText)
      } catch (e) {
        // 纯文本模型：去掉截图，只用 OCR 文本翻译
        if (this.textOnly || firstTokenMs !== undefined || !imageUnsupported(e)) throw e
        this.textOnly = true
        usage = await this.run(SYSTEM_PROMPT, parts(), signal, onText)
      }
      parser.end()
      if (!parser.blockCount) throw new TranslateError('模型没有返回可用的译文，请重试或换个模型', 'unknown')
      return { firstTokenMs, usage }
    } catch (e) {
      this.fail(e, signal)
    }
  }

  async reply(req: ReplyRequest, onText: (d: string) => void, signal: AbortSignal): Promise<void> {
    try {
      await this.run(REPLY_PROMPT, [{ type: 'text', text: replyText(req) }], signal, onText)
    } catch (e) {
      this.fail(e, signal)
    }
  }

  async listModels(): Promise<string[]> {
    const url = new URL(this.creds.baseURL)
    // Gemini 的 OpenAI 兼容接口不一定提供模型列表，改用原生接口，只保留能生成内容的模型
    if (url.host === 'generativelanguage.googleapis.com') {
      const res = await net.fetch(`${url.origin}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': this.creds.apiKey } })
      const json = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { message: string } }
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
      return (json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''))
    }
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id.replace(/^models\//, ''))
    return ids
  }

  dispose() {}
}
