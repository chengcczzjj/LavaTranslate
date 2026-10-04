// 主进程与渲染进程共享的数据结构

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** OCR 识别出的一行文字，坐标为截图物理像素（相对选区左上角） */
export interface OcrLine {
  id: number
  text: string
  score: number
  box: Rect
  vertical?: boolean
  /** 每个字符中心相对 box.x 的横坐标（物理像素），来自 CTC 时间步；用于裁掉误识别成文字的图标 */
  cx?: number[]
}

/** 翻译后的文本块：由一行或多行 OCR 结果合并而成 */
export interface TranslatedBlock {
  key: string
  lineIds: number[]
  source: string
  translation: string
  /** 模型判断此块无需翻译（代码、URL、已是目标语言等） */
  keep?: boolean
  /** 块的语义角色，用于排版微调 */
  role?: 'title' | 'paragraph' | 'ui' | 'code' | 'caption' | 'other'
}

export type Phase = 'idle' | 'ocr' | 'translating' | 'done' | 'error'

export type TranslateEvent =
  | { type: 'ocr'; lines: OcrLine[]; ms: number }
  /** chat：模型判断截图是不是可以回复的对话（聊天、私信、评论、邮件） */
  | { type: 'lang'; code: string; name: string; chat?: boolean }
  | { type: 'block'; block: TranslatedBlock }
  | { type: 'done'; ms: number; firstTokenMs?: number; engine: string; usage?: { input: number; output: number } }
  | { type: 'error'; message: string; code?: ErrorCode }

/** config：翻译服务没配好（没填 Key、没选模型、找不到 Claude Code），界面上引导去设置 */
export type ErrorCode = 'auth' | 'config' | 'network' | 'no-text' | 'rate-limit' | 'unknown'

export interface Language {
  code: string
  name: string
  native: string
}

export const LANGUAGES: Language[] = [
  { code: 'zh-Hans', name: '简体中文', native: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文', native: '繁體中文' },
  { code: 'en', name: '英语', native: 'English' },
  { code: 'ja', name: '日语', native: '日本語' },
  { code: 'ko', name: '韩语', native: '한국어' },
  { code: 'fr', name: '法语', native: 'Français' },
  { code: 'de', name: '德语', native: 'Deutsch' },
  { code: 'es', name: '西班牙语', native: 'Español' },
  { code: 'ru', name: '俄语', native: 'Русский' },
  { code: 'pt', name: '葡萄牙语', native: 'Português' },
  { code: 'it', name: '意大利语', native: 'Italiano' },
  { code: 'vi', name: '越南语', native: 'Tiếng Việt' },
  { code: 'th', name: '泰语', native: 'ไทย' },
  { code: 'ar', name: '阿拉伯语', native: 'العربية' }
]

export type EngineKind = 'claude-code' | 'api' | 'openai'

export interface Settings {
  hotkey: string
  targetLang: string
  model: string
  engine: EngineKind
  /** API 模式：留空则自动读取 Claude Code 的 ~/.claude/settings.json */
  apiBaseUrl: string
  apiKey: string
  /** OpenAI 兼容（Codex / 中转）：留空则自动读取 Codex / CC Switch 的配置 */
  /** OpenAI 兼容服务（Codex 中转 / OpenAI 官方）：Base URL、Key（落盘加密，界面上为打码形式）、模型 */
  openaiBaseUrl: string
  openaiKey: string
  openaiModel: string
  /** 自动检查并下载更新（GitHub Releases） */
  autoUpdate: boolean
  /** 回复助手：翻译完成后自动打开回复框 */
  replyAssist: boolean
  replyTone: 'auto' | 'formal' | 'casual'
  launchAtLogin: boolean
  /** 显示模式：覆盖原文 / 原文下方对照 */
  displayMode: 'overlay' | 'side'
  /** 翻译风格补充说明 */
  styleHint: string
  firstRunDone: boolean
}

export const MODELS = [
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', desc: '最快 · 最省' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: '更准 · 稍慢' },
  { id: 'claude-opus-5', name: 'Opus 5', desc: '最强 · 最慢' }
] as const

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Alt+Q',
  targetLang: 'zh-Hans',
  model: 'claude-haiku-4-5',
  engine: 'openai',
  apiBaseUrl: '',
  apiKey: '',
  openaiBaseUrl: '',
  openaiKey: '',
  openaiModel: '',
  autoUpdate: true,
  replyAssist: true,
  replyTone: 'auto',
  launchAtLogin: false,
  displayMode: 'overlay',
  styleHint: '',
  firstRunDone: false
}

/** 在本机找到的 OpenAI 兼容凭据（Codex 配置 / CC Switch） */
export interface OpenAISource {
  id: string
  label: string
  baseURL: string
  hasKey: boolean
  model?: string
}

/** 回复助手：渲染进程 → 主进程 */
export interface ReplyStartMsg {
  requestId: number
  text: string
  /** 对方的语言代码（默认取截图识别出的语言） */
  to: string
  toName?: string
  tone: 'auto' | 'formal' | 'casual'
  /** 屏幕上的对话文本，供模型把握语气和称呼 */
  context: string
}

export type ReplyEvent = { type: 'delta'; text: string } | { type: 'done'; ms: number } | { type: 'error'; message: string }

/** 模型列表里的一项（价格来自 models.dev） */
export interface ModelInfo {
  id: string
  input: number | null
  output: number | null
  vision: boolean | null
  perCall: number | null
}

export type UpdateState =
  | { state: 'idle' | 'checking' | 'latest' | 'disabled'; version: string; message?: string }
  | { state: 'available' | 'downloading'; version: string; next: string; percent: number }
  | { state: 'ready'; version: string; next: string }
  | { state: 'error'; version: string; message: string }

export interface EngineStatus {
  engine: EngineKind
  ok: boolean
  detail: string
}

/** 截图帧：主进程 → 遮罩窗口 */
export interface CaptureFrame {
  displayId: number
  width: number
  height: number
  scale: number
  /** RGBA 像素 */
  pixels: Uint8Array
  /** 截图时鼠标所在位置（CSS 像素，相对显示器） */
  cursor: { x: number; y: number } | null
  /** 可见窗口区域（物理像素，按 z 序从上到下），用于单击选中窗口 */
  windows: Rect[]
  targetLang: string
  displayMode: Settings['displayMode']
  hotkey: string
  replyAssist: boolean
  replyTone: Settings['replyTone']
}

export interface PinPayload {
  /** 选区在屏幕上的位置（DIP） */
  screenRect: Rect
  /** 选区截图（物理像素 RGBA → PNG dataURL） */
  image: string
  scale: number
  lines: OcrLine[]
  blocks: TranslatedBlock[]
  /** 按 OCR 行 id 采样的颜色 */
  colors: Record<number, BlockColors>
  langName: string
  targetLang: string
  targetName: string
}

/** 一行原文的视觉样式（从截图像素分析得到） */
export interface BlockColors {
  bg: string
  fg: string
  bold: boolean
  /** 文字在其所在容器（按钮、标签、对话框）里是否居中 */
  center: boolean
  /** 右对齐（右侧紧贴边界、左侧空白很大，如表格里靠右的时间列） */
  right: boolean
  /** 框左右两侧连续背景的宽度（物理像素），译文可向其中扩展 */
  freeL: number
  freeR: number
  /** 逐列文字笔画的上下边界（相对框顶，物理像素；-1 表示该列无笔画） */
  inkTop: number[]
  inkBot: number[]
}

export interface TranslateRequestMsg {
  requestId: number
  displayId: number
  /** 选区（物理像素，相对显示器） */
  rect: Rect
  targetLang: string
  reuseOcr: boolean
}
