// 开发自测：LENS_AUTOTEST=1 时用测试图伪造截屏，离屏渲染遮罩并模拟鼠标操作，逐步截图到 .scratch/shots
// LENS_MOCK=1 时使用模拟翻译引擎（不消耗额度）
import { app, BrowserWindow, nativeImage, net, protocol, screen } from 'electron'
import { spawn } from 'node:child_process'
import { load } from 'koffi'
import { forceForeground, hwndOf } from './winapi'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type OcrLine, type ProviderId, type SettingsPatch, type TranslatedBlock } from '../shared/types'
import type { DisplayCapture } from './capture'
import { chatgptSession } from './credentials'
import { settings } from './settings'
import { TranslateError, type Emit, type Engine, type ReplyRequest, type TranslateRequest, type TranslateResult } from '../core/translator'

/** 自测用的回复：逐字流式输出，模拟模型的节奏 */
async function mockReply(req: ReplyRequest, onText: (d: string) => void, signal: AbortSignal) {
  const samples: Record<string, [string, string]> = {
    en: ['Thanks! Tomorrow works for me — see you at 3 😊', '谢谢！明天可以——下午三点见 😊'],
    ja: ['ありがとう！明日なら大丈夫です。3時に会いましょう 😊', '谢谢！明天的话没问题。三点见吧 😊']
  }
  const [t, back] = samples[req.to.code] ?? [`(${req.to.native}) ${req.text}`, req.text]
  const out = `${t}
⟲
${back}`
  await sleep(350)
  for (const ch of out) {
    if (signal.aborted) throw new Error('aborted')
    onText(ch)
    await sleep(14)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 把测试图贴到一张"桌面"上，当作整屏截图 */
export function fakeCapture(display: Electron.Display, imagePath: string, at: { x: number; y: number }): DisplayCapture {
  const W = Math.round(display.bounds.width * display.scaleFactor)
  const H = Math.round(display.bounds.height * display.scaleFactor)
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    const y = Math.floor(i / 4 / W)
    rgba[i] = 38 + (y * 20) / H
    rgba[i + 1] = 40 + (y * 16) / H
    rgba[i + 2] = 52 + (y * 30) / H
    rgba[i + 3] = 255
  }
  const img = nativeImage.createFromPath(imagePath)
  const { width: iw, height: ih } = img.getSize()
  const bgra = img.toBitmap()
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const s = (y * iw + x) * 4
      const d = ((at.y + y) * W + at.x + x) * 4
      rgba[d] = bgra[s + 2]
      rgba[d + 1] = bgra[s + 1]
      rgba[d + 2] = bgra[s]
      rgba[d + 3] = 255
    }
  }
  return { display, width: W, height: H, scale: display.scaleFactor, rgba, windows: [{ x: at.x, y: at.y, w: iw, h: ih }] }
}

const MOCK: Record<string, { ids: string[]; dst: string; role?: string; keep?: boolean }[]> = {
  test1: [
    { ids: ['GitHub'], dst: 'GitHub  拉取请求  议题  市场  探索', role: 'ui' },
    { ids: ['Getting'], dst: '设置面板入门', role: 'title' },
    { ids: ['Configure', 'these', 'organization'], dst: '配置新成员加入时工作区的行为方式。你可以随时更改这些偏好设置，下次同步完成后，更改将应用到组织中的所有人。', role: 'paragraph' },
    { ids: ['Save'], dst: '保存更改', role: 'ui' },
    { ids: ['Cancel'], dst: '取消', role: 'ui' },
    { ids: ['設定'], dst: '设置将在下次同步后应用到整个组织。', role: 'paragraph' },
    { ids: ['Last'], dst: '最近由 @octocat 于 3 分钟前更新 · 12 条评论', role: 'caption' },
    { ids: ['npm'], dst: 'npm install --save-dev @types/node  # 安装类型定义', role: 'code' },
    { ids: ['Warning'], dst: '警告：此操作无法撤销。', role: 'paragraph' },
    { ids: ['Learn'], dst: '了解有关权限的更多信息', role: 'ui' }
  ],
  test2: [
    { ids: ['Episode'], dst: '第 12 集 —— 最后的信号', role: 'title' },
    { ids: ['When', 'to trust'], dst: '殖民地与地球失去联系后，玛拉必须决定是否相信那段来自星环之外的神秘信号。', role: 'paragraph' },
    { ids: ['Play', '□'], dst: '▶  播放', role: 'ui' },
    { ids: ['More'], dst: '更多信息', role: 'ui' },
    { ids: ['Season'], dst: '第 2 季 · 45 分钟 · 科幻剧情', role: 'caption' }
  ],
  chat: [
    { ids: ['Emma'], dst: 'Emma Clarke', role: 'ui', keep: true },
    { ids: ['online'], dst: '在线', role: 'caption' },
    { ids: ['Hey', 'workshop'], dst: '嘿！你明天还来参加研讨会吗？', role: 'paragraph' },
    { ids: ['可能'], dst: '可能会晚一点到', role: 'paragraph', keep: true },
    { ids: ['No worries', 'interesting'], dst: '没关系。我们 10 点开始，不过精彩的部分在午饭后。', role: 'paragraph' },
    { ids: ['Could', 'week'], dst: '你能把上周的幻灯片带来吗？我的文件坏了 :(', role: 'paragraph' },
    { ids: ['Write'], dst: '输入消息…', role: 'ui' }
  ]
}

export class MockEngine implements Engine {
  readonly name = '模拟'
  scenario = 'test1'
  warm() {}
  dispose() {}
  reply = mockReply
  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    await sleep(700)
    emit({ type: 'lang', code: 'en', name: '英语', chat: this.scenario === 'chat' })
    const used = new Set<number>()
    let n = 0
    for (const m of MOCK[this.scenario] ?? []) {
      if (signal.aborted) throw new Error('aborted')
      const ids: number[] = []
      for (const prefix of m.ids) {
        const l = req.lines.find((x: OcrLine) => !used.has(x.id) && x.text.includes(prefix))
        if (l) {
          ids.push(l.id)
          used.add(l.id)
        }
      }
      if (!ids.length) continue
      await sleep(140)
      const block: TranslatedBlock = { key: `b${++n}`, lineIds: ids, source: m.ids.join(' '), translation: m.dst, role: m.role as TranslatedBlock['role'], keep: m.keep }
      emit({ type: 'block', block })
    }
    // 没匹配上的行（如韩文）原样保留
    return { firstTokenMs: 700, usage: { input: 0, output: 0 } }
  }
}

interface Hooks {
  openSettings: () => BrowserWindow
  overlayWin: () => BrowserWindow
  /** refresh：模拟按住 Alt 操作完软件、松开后重新截的图 */
  inject: (cap: DisplayCapture, refresh?: boolean) => Promise<void>
  waitDone: () => Promise<void>
  display: Electron.Display
  mock: MockEngine | null
  setSettings: (p: SettingsPatch) => void
  /** 连按两次快捷键：进入输入翻译 */
  quick?: () => void
  /** 托盘菜单的内容 */
  trayMenu?: () => Electron.MenuItemConstructorOptions[]
}

/**
 * 本地假 OpenAI 服务：/v1/models 给设置页的价格列表；/v1/chat/completions 按 SSE 流式回复。
 * 没有 /v1/responses（返回 404），模拟只支持 Chat Completions 的服务商，用来检查引擎的自动回退。
 */
export async function fakeModelServer() {
  const ids = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'deepseek-v4-flash', 'claude-haiku-4-5', 'glm-4.6', 'qwen3-max', 'text-embedding-3-small', 'tts-1', 'my-custom-model']
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'test' })) }))
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const msg = JSON.parse(body)
        const user = msg.messages?.[1]?.content
        const hasImage = Array.isArray(user) && user.some((p: { type: string }) => p.type === 'image_url')
        console.log('[fake] chat.completions', msg.model, 'image:', hasImage, 'stream_options:', !!msg.stream_options)
        const reply = /Message to translate/.test(JSON.stringify(user))
          ? 'Sure, see you tomorrow!\n⟲\n好的，明天见！'
          : '{"lang":"en","name":"英语","chat":false}\n{"ids":[1],"role":"title","src":"GitHub","dst":"GitHub"}\n'
        res.setHeader('content-type', 'text/event-stream')
        const chunk = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        for (const piece of reply.match(/[\s\S]{1,12}/g) ?? []) chunk({ id: 'c', object: 'chat.completion.chunk', created: 0, model: msg.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
        chunk({ id: 'c', object: 'chat.completion.chunk', created: 0, model: msg.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
        res.end('data: [DONE]\n\n')
      })
      return
    }
    console.log('[fake] 404', req.method, req.url)
    res.statusCode = 404
    res.end(JSON.stringify({ error: { message: 'Not Found', type: 'invalid_request_error' } }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() }
}

export async function runAutotest(h: Hooks) {
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  const dir = join(root, '.scratch', 'shots')
  mkdirSync(dir, { recursive: true })
  const shot = async (name: string) => {
    const img = await h.overlayWin().webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    console.log('[autotest] shot', name)
  }
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const key = (keyCode: string, mods: ('control' | 'shift')[] = []) => {
    wc().sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
    wc().sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
  }
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 12; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12)
      await sleep(16)
    }
    mouse('mouseUp', x1, y1)
  }

  const scenarios = [
    { name: 'test1', file: join(root, '.scratch', 'test1.png'), at: { x: 420, y: 220 }, size: { w: 900, h: 560 } },
    { name: 'test2', file: join(root, '.scratch', 'test2.png'), at: { x: 600, y: 300 }, size: { w: 720, h: 300 } }
  ]
  const s = h.display.scaleFactor
  for (const sc of scenarios) {
    if (h.mock) h.mock.scenario = sc.name
    await h.inject(fakeCapture(h.display, sc.file, sc.at))
    await sleep(700)
    mouse('mouseMove', (sc.at.x + 100) / s, (sc.at.y + 100) / s)
    await sleep(400)
    await shot(`${sc.name}-1-idle`)
    const x0 = sc.at.x / s - 6
    const y0 = sc.at.y / s - 6
    const x1 = (sc.at.x + sc.size.w) / s + 6
    const y1 = (sc.at.y + sc.size.h) / s + 6
    await drag(x0, y0, x1, y1)
    await sleep(450)
    await shot(`${sc.name}-2-working`)
    await h.waitDone()
    await sleep(900)
    await shot(`${sc.name}-3-done`)
    // 悬停一个译文块看原文提示
    mouse('mouseMove', x0 + 120, y0 + (sc.name === 'test1' ? 150 : 90))
    await sleep(900)
    await shot(`${sc.name}-4-hover`)
    mouse('mouseMove', x1 - 40, y1 + 140)
    // 并排模式
    key('Tab')
    await sleep(900)
    await shot(`${sc.name}-5-side`)
    key('Tab')
    await sleep(500)
  }
  // 按住 Alt 操作完回来：选区里画面没变 → 译文原样保留；变了 → 同一块重新翻译
  {
    const sc = scenarios[0]
    if (h.mock) h.mock.scenario = sc.name
    await h.inject(fakeCapture(h.display, sc.file, sc.at))
    await sleep(600)
    await drag(sc.at.x / s - 6, sc.at.y / s - 6, (sc.at.x + sc.size.w) / s + 6, (sc.at.y + sc.size.h) / s + 6)
    await h.waitDone()
    await sleep(700)
    const blocks = () => wc().executeJavaScript(`document.querySelectorAll('[data-block]').length`) as Promise<number>
    console.log('[autotest] alt before', await blocks())
    const again = h.waitDone().then(() => true)
    await h.inject(fakeCapture(h.display, sc.file, sc.at), true)
    console.log('[autotest] alt same: retranslated', await Promise.race([again, sleep(1800).then(() => false)]), 'blocks', await blocks())
    await shot('alt-1-same')
    if (h.mock) h.mock.scenario = 'test2'
    await h.inject(fakeCapture(h.display, scenarios[1].file, sc.at), true)
    await again
    await sleep(900)
    console.log('[autotest] alt changed: blocks', await blocks())
    await shot('alt-2-changed')
  }

  // 钉图：重新框选 test1，完成后按 F3
  if (h.mock) h.mock.scenario = 'test1'
  await h.inject(fakeCapture(h.display, scenarios[0].file, scenarios[0].at))
  await sleep(600)
  await drag(scenarios[0].at.x / s - 6, scenarios[0].at.y / s - 6, (scenarios[0].at.x + 900) / s + 6, (scenarios[0].at.y + 560) / s + 6)
  await h.waitDone()
  await sleep(700)
  key('F3')
  await sleep(1500)
  const pinWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('pin.html'))
  if (pinWin) {
    const img = await pinWin.webContents.capturePage()
    writeFileSync(join(dir, 'pin.png'), img.toPNG())
    console.log('[autotest] shot pin', JSON.stringify(pinWin.getBounds()), 'visible', pinWin.isVisible())
    pinWin.close()
    console.log('[autotest] pin closed')
  } else console.log('[autotest] pin window missing')

  // 回复助手：英文聊天截图 → 自动弹出回复框 → 输入中文 → 实时译成英语
  {
    const at = { x: 380, y: 160 }
    if (h.mock) h.mock.scenario = 'chat'
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), at))
    await sleep(600)
    await drag(at.x / s - 4, at.y / s - 4, (at.x + 560) / s + 4, (at.y + 640) / s + 4)
    await h.waitDone()
    await sleep(900)
    await shot('reply-1-open')
    wc().insertText('好的，我明天带上。下午三点见')
    await sleep(300)
    await shot('reply-2-typing')
    await sleep(1600)
    await shot('reply-3-result')
    // 语言菜单
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(500)
    await shot('reply-4-langs')
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(300)
    // 选区贴着屏幕底部、整屏高：回复框应放到侧边
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), { x: 300, y: Math.round(h.display.bounds.height * s) - 640 }))
    await sleep(600)
    await drag(300 / s - 4, 20 / s, (300 + 560) / s + 4, h.display.bounds.height - 2)
    await h.waitDone()
    await sleep(900)
    await shot('reply-5-tall')
  }

  // 输入翻译：连按两次快捷键，不框选，直接输入（停顿约 1.4 秒后才翻译）
  if (h.quick) {
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), { x: 380, y: 160 }))
    await sleep(500)
    h.quick()
    await sleep(700)
    await shot('quick-1-open')
    wc().insertText('谢谢！明天可以，下午三点见')
    await sleep(600)
    await shot('quick-2-typing')
    await sleep(3600)
    await shot('quick-3-result')
  }

  // 设置窗口各页
  console.log('[autotest] open settings')
  const sw = h.openSettings()
  console.log('[autotest] settings loading', sw.webContents.isLoading())
  if (sw.webContents.isLoading())
    await Promise.race([new Promise<void>((r) => sw.webContents.once('did-finish-load', () => r())), sleep(6000).then(() => console.log('[autotest] load timeout', sw.webContents.getURL(), sw.isVisible()))])
  await sleep(1200)
  const pages = ['home', 'translate', 'engine', 'general', 'about']
  const sshot = async (name: string) => {
    const img = await sw.webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    console.log('[autotest] shot', name)
  }
  for (let i = 0; i < pages.length; i++) {
    await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=${pages[i]}]')?.click()`)
    await sleep(700)
    await sshot(`settings-${i + 1}`)
  }
  // 填好 Key 后的模型价格列表（假服务，不涉及真实 Key）
  const fake = await fakeModelServer()
  h.setSettings({ provider: 'custom', providers: { custom: { baseUrl: fake.url, key: 'sk-test-0000-abcd', model: 'deepseek-v4-flash' } } })
  await sleep(400)
  await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=home]')?.click()`)
  await sleep(400)
  await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=engine]')?.click()`)
  await sleep(1800)
  await sshot('settings-engine-models')
  await sw.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 9999`)
  await sleep(400)
  await sshot('settings-engine-models-2')
  fake.close()
  // 各家获取 Key 的引导：展开 Gemini 一行
  await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.guide-row-head')].find(b => b.textContent.includes('Gemini'))?.click()`)
  await sleep(700)
  await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.guide-row-head')].find(b => b.textContent.includes('Gemini'))?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  await sshot('settings-guides')
  console.log('[autotest] done')
  app.quit()
}

/**
 * LENS_I18N=all|<语言,…>（配合 LENS_AUTOTEST=1 LENS_MOCK=1）：逐个界面语言截设置页各页、截图界面（提示条、工具条、回复框），
 * 存到 .scratch/i18n/<语言>-<名称>.png，检查翻译后的文字有没有挤爆、截断
 */
export async function runI18nShots(h: Hooks, langs: string[]) {
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  const dir = join(root, '.scratch', 'i18n')
  mkdirSync(dir, { recursive: true })
  const s = h.display.scaleFactor
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const save = async (win: BrowserWindow, name: string) => {
    writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    console.log('[i18n] shot', name)
  }
  const sw = h.openSettings()
  if (sw.webContents.isLoading()) await new Promise<void>((r) => sw.webContents.once('did-finish-load', () => r()))
  await sleep(1200)
  const fake = await fakeModelServer()
  for (const lang of langs) {
    h.setSettings({ uiLang: lang, provider: 'custom', providers: { custom: { baseUrl: fake.url, key: 'sk-test-0000-abcd', model: 'deepseek-v4-flash' } } })
    await sleep(500)
    const labels = (items: Electron.MenuItemConstructorOptions[]): unknown[] =>
      items.filter((m) => m.type !== 'separator').map((m) => (m.submenu ? { [m.label!]: labels(m.submenu as Electron.MenuItemConstructorOptions[]) } : m.checked ? `(*) ${m.label}` : m.label))
    if (h.trayMenu) console.log('[i18n] tray', lang, JSON.stringify(labels(h.trayMenu())))
    for (const page of ['home', 'translate', 'engine', 'general', 'about']) {
      await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=${page}]')?.click()`)
      await sleep(100)
      await sw.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 0`)
      await sleep(page === 'engine' ? 1600 : 600)
      await save(sw, `${lang}-settings-${page}`)
    }
    await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=engine]')?.click()`)
    await sleep(900)
    await sw.webContents.executeJavaScript(`document.querySelector('.guide-row-head')?.click()`)
    await sleep(500)
    await sw.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 9999`)
    await sleep(400)
    await save(sw, `${lang}-settings-guides`)

    // 截图界面：提示条 → 框选翻译后的工具条 → 回复框
    const at = { x: 380, y: 160 }
    if (h.mock) h.mock.scenario = 'chat'
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), at))
    await sleep(700)
    mouse('mouseMove', (at.x + 100) / s, (at.y + 100) / s)
    await sleep(300)
    await save(h.overlayWin(), `${lang}-overlay-hint`)
    const [x0, y0, x1, y1] = [at.x / s - 4, at.y / s - 4, (at.x + 560) / s + 4, (at.y + 640) / s + 4]
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 12; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12)
      await sleep(16)
    }
    mouse('mouseUp', x1, y1)
    await h.waitDone()
    await sleep(900)
    wc().insertText('OK')
    await sleep(2600)
    await save(h.overlayWin(), `${lang}-overlay-reply`)
  }
  fake.close()
  console.log('[i18n] done')
  app.quit()
}

/** LENS_ENGINE_TEST=1：用测试图走一遍真实引擎，打印事件与耗时 */
export async function runEngineTest(engine: Engine, ocrLines: OcrLine[], image: TranslateRequest['image']) {
  const t0 = Date.now()
  engine.warm()
  await sleep(Number(process.env.LENS_WARM_MS ?? 2500))
  const t1 = Date.now()
  const ctl = new AbortController()
  try {
    const res = await engine.translate(
      { image, lines: ocrLines, target: { code: 'zh-Hans', name: '简体中文', native: '简体中文' }, styleHint: '' },
      (e) => console.log(`[engine +${Date.now() - t1}ms]`, JSON.stringify(e)),
      ctl.signal
    )
    console.log('[engine] ok', JSON.stringify(res), 'total', Date.now() - t1, 'ms (warm', t1 - t0, 'ms)')
  } catch (e: any) {
    console.log('[engine] error', e?.code, e?.message, 'after', Date.now() - t1, 'ms')
  }
  // 回复助手：用截图里的文字做上下文
  if (process.env.LENS_REPLY_TEST) {
    const t2 = Date.now()
    let out = ''
    let first = 0
    try {
      await engine.reply(
        {
          text: process.env.LENS_REPLY_TEST,
          from: { code: 'zh-Hans', name: '简体中文', native: '简体中文' },
          to: { code: process.env.LENS_REPLY_TO ?? 'en', name: 'English', native: 'English' },
          context: ocrLines.map((l) => l.text).join('\n'),
          tone: (process.env.LENS_REPLY_TONE as 'auto') ?? 'auto'
        },
        (d) => {
          if (!first) first = Date.now() - t2
          out += d
        },
        ctl.signal
      )
      console.log('[reply] first token', first, 'ms, total', Date.now() - t2, 'ms')
      console.log('[reply]\n' + out)
    } catch (e: any) {
      console.log('[reply] error', e?.message)
    }
  }
  engine.dispose()
  app.quit()
}

// ------------------------------------------------------------------ 排版审查（LENS_REVIEW=1）
// 场景：.scratch/review.json  [{ name, page, region:{x,y,w,h}, target }]
// 每个场景先输出模型将看到的 OCR 输入到 .scratch/fixtures/<name>.prompt.txt；
// 若存在 .scratch/fixtures/<name>.jsonl（模型输出），则以流式小块回放，渲染后截图并生成原图/译图对照
export class FixtureEngine implements Engine {
  readonly name = '回放'
  scenario = ''
  root = ''
  warm() {}
  dispose() {}
  reply = mockReply
  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    const { BlockParser, userText } = await import('../core/translator')
    const fx = join(this.root, '.scratch', 'fixtures')
    mkdirSync(fx, { recursive: true })
    writeFileSync(join(fx, `${this.scenario}.prompt.txt`), userText(req))
    const file = join(fx, `${this.scenario}.jsonl`)
    if (!existsSync(file)) throw new Error('no fixture')
    const text = readFileSync(file, 'utf8')
    const parser = new BlockParser(req.lines, emit)
    await sleep(300)
    for (let i = 0; i < text.length; i += 40) {
      if (signal.aborted) throw new Error('aborted')
      parser.push(text.slice(i, i + 40))
      await sleep(8)
    }
    parser.end()
    return { firstTokenMs: 300 }
  }
}

export async function runReview(h: Hooks & { engine: FixtureEngine; setTarget: (code: string) => void; scenarios?: string[] }) {
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  h.engine.root = root
  const dir = join(root, '.scratch', 'review')
  mkdirSync(dir, { recursive: true })
  const all = JSON.parse(readFileSync(join(root, '.scratch', 'review.json'), 'utf8')) as {
    name: string
    page: string
    region: { x: number; y: number; w: number; h: number }
    target: string
    at?: { x: number; y: number }
  }[]
  const list = all.filter((s) => !h.scenarios?.length || h.scenarios.includes(s.name))
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const key = (keyCode: string) => {
    wc().sendInputEvent({ type: 'keyDown', keyCode })
    wc().sendInputEvent({ type: 'keyUp', keyCode })
  }
  const s = h.display.scaleFactor
  for (const sc of list) {
    const at = sc.at ?? { x: 240, y: 150 }
    h.engine.scenario = sc.name
    h.setTarget(sc.target)
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'pages', `${sc.page}.png`), at))
    await sleep(600)
    const x0 = (at.x + sc.region.x) / s
    const y0 = (at.y + sc.region.y) / s
    const x1 = (at.x + sc.region.x + sc.region.w) / s
    const y1 = (at.y + sc.region.y + sc.region.h) / s
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 10; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10)
      await sleep(12)
    }
    mouse('mouseUp', x1, y1)
    await h.waitDone()
    await sleep(900)
    // 把鼠标移出选区，避免悬停高亮
    mouse('mouseMove', 5, 5)
    await sleep(300)
    const rect = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }
    const full = await wc().capturePage()
    writeFileSync(join(dir, `${sc.name}-full.png`), full.toPNG())
    const tr = await wc().capturePage(rect)
    writeFileSync(join(dir, `${sc.name}-tr.png`), tr.toPNG())
    key('Tab')
    await sleep(900)
    writeFileSync(join(dir, `${sc.name}-side.png`), (await wc().capturePage()).toPNG())
    key('Tab')
    await sleep(400)
    console.log('[review] shot', sc.name)
  }
  console.log('[review] done')
  app.quit()
}

/**
 * LENS_PASSTEST=1：在真窗口上走一遍「按住 Alt 穿透」。模拟按下 Alt → 遮罩应透明、鼠标穿透；
 * 打开另一个程序的窗口抢走焦点 → 松开 Alt → 遮罩应重新截图显示，并把焦点抢回来。屏幕会闪几秒。
 */
export async function runPassTest(h: { start: () => Promise<void>; hide: () => Promise<void>; overlays: () => BrowserWindow[] }) {
  const u = load('user32.dll')
  const keybd = u.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)')
  // POINT 按值传：x64 下等同一个 64 位整数
  const fromPoint = u.func('intptr_t __stdcall WindowFromPoint(int64_t pt)')
  const rootOf = u.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)')
  const foreground = u.func('intptr_t __stdcall GetForegroundWindow()')
  const VK_MENU = 0x12
  const KEYUP = 2
  const state = (tag: string) => {
    for (const w of h.overlays()) {
      if (!w.isVisible()) continue
      const hwnd = hwndOf(w.getNativeWindowHandle())
      const b = w.getBounds()
      const c = screen.dipToScreenPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) })
      const hit = Number(rootOf(fromPoint((BigInt(c.y) << 32n) | BigInt(c.x >>> 0)), 2))
      console.log(`[passtest] ${tag}`, JSON.stringify({ opacity: +w.getOpacity().toFixed(2), focused: w.isFocused(), foreground: Number(foreground()) === hwnd, hitOverlay: hit === hwnd }))
    }
  }
  let child: ReturnType<typeof spawn> | null = null
  try {
    await h.start()
    await sleep(1500)
    const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
    const mine = h.overlays().find((w) => w.isVisible() && w.getBounds().x === cur.x && w.getBounds().y === cur.y)
    if (mine) {
      forceForeground(hwndOf(mine.getNativeWindowHandle()))
      mine.focus()
      mine.webContents.focus()
    }
    await sleep(300)
    state('shown')
    keybd(VK_MENU, 0, 0, 0)
    await sleep(500)
    state('alt-down')
    // 另一个进程的窗口抢走焦点（相当于按着 Alt 点进了别的软件）
    child = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'passtest'; $f.Add_Shown({ $f.Activate() }); [Windows.Forms.Application]::Run($f)"], { stdio: 'ignore' })
    const mineHwnd = mine ? hwndOf(mine.getNativeWindowHandle()) : 0
    for (let i = 0; i < 60 && Number(foreground()) === mineHwnd; i++) await sleep(100)
    await sleep(300)
    state('other-app')
    keybd(VK_MENU, 0, KEYUP, 0)
    await sleep(1000)
    state('alt-up')
  } finally {
    keybd(VK_MENU, 0, KEYUP, 0)
    child?.kill()
    await h.hide()
    app.quit()
  }
}

/**
 * LENS_SIGNIN_TEST=1：ChatGPT 登录的刷新与设置保存。在应用内拦截 OpenAI 的令牌接口换成假响应（不联网、不需要真账号），
 * 检查：同时发起的请求只刷新一次；网络 / 服务端临时故障不算登录失效；刷新令牌失效时标记过期且不反复请求；
 * 刷新期间重新登录不被旧结果覆盖；令牌被拒时强制刷新；设置文件不留临时文件、损坏时另存一份
 */
export async function runSignInTest(h: {
  ensure: (id?: ProviderId, force?: boolean) => Promise<string | null>
  authProblem: (err: unknown) => Promise<string | null>
  status: () => { ok: boolean; detail: string }
}) {
  type Mode = 'ok' | 'slow' | 'network' | 'server' | 'invalid_grant' | 'reused' | 'slow-invalid'
  let mode: Mode = 'ok'
  let calls = 0
  protocol.handle('https', async (req) => {
    if (!req.url.startsWith('https://auth.openai.com/api/accounts/oauth/token')) return net.fetch(req, { bypassCustomProtocolHandlers: true })
    const n = ++calls
    const form = new URLSearchParams(await req.text())
    if (form.get('grant_type') !== 'refresh_token') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
    if (mode === 'slow' || mode === 'slow-invalid') await sleep(300)
    if (mode === 'network') throw new Error('fake network failure')
    if (mode === 'server') return new Response('<html>Bad Gateway</html>', { status: 502 })
    if (mode === 'invalid_grant' || mode === 'slow-invalid') return Response.json({ error: 'invalid_grant', error_description: 'Refresh token has expired' }, { status: 400 })
    if (mode === 'reused') return Response.json({ error: { code: 'refresh_token_reused', message: 'Refresh token was already used' } }, { status: 401 })
    return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, id_token: 'id', expires_in: 3600, scope: 'openid' })
  })

  const session = () => chatgptSession(settings.get())
  const conf = () => settings.get().providers.chatgpt
  const seed = (rt: string, expiresIn: number) =>
    settings.update({
      provider: 'chatgpt',
      providers: {
        chatgpt: {
          key: JSON.stringify({ subject: 'user-test', email: 'test@example.com', clientId: 'oaiapp_test', hostId: 'urn:uuid:test', idToken: 'id', accessToken: 'at-0', refreshToken: rt, expiresAt: Date.now() + expiresIn, scopes: [] }),
          label: 'test@example.com',
          model: 'gpt-test',
          expired: false
        }
      }
    })
  let failed = 0
  const check = (name: string, ok: boolean, info = '') => {
    if (!ok) failed++
    console.log(`[signin] ${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`)
  }
  const run = <T>(m: Mode, f: () => Promise<T>) => {
    mode = m
    calls = 0
    return f()
  }

  // 1. 同时发起 5 个请求：只刷新一次，都拿到新令牌
  seed('rt-old', 30_000)
  const many = await run('slow', () => Promise.all([1, 2, 3, 4, 5].map(() => h.ensure())))
  check('5 个并发请求只刷新 1 次', calls === 1, `刷新 ${calls} 次`)
  check('并发请求都可以继续', many.every((r) => r === null))
  check('新令牌已保存', session()?.refreshToken === 'rt-1' && session()?.accessToken === 'at-1', session()?.refreshToken)

  // 2. 离过期还早：不刷新
  seed('rt-fresh', 3600_000)
  await run('ok', () => h.ensure())
  check('令牌还新：不刷新', calls === 0, `刷新 ${calls} 次`)

  // 3. 临时故障：不算登录失效
  for (const m of ['server', 'network'] as const) {
    seed('rt-t', -1000)
    const r = await run(m, () => h.ensure())
    check(`${m}：令牌已过期时提示稍后再试`, !!r?.includes('暂时无法刷新'), r ?? 'null')
    check(`${m}：不标记登录过期`, !conf()?.expired && !!conf()?.key)
    seed('rt-t', 60_000)
    const r2 = await run(m, () => h.ensure())
    check(`${m}：令牌还没过期就继续用`, r2 === null, String(r2))
  }

  // 4. 刷新令牌失效（标准 OAuth 写法 / OpenAI 写法）：标记过期，保留登录信息，之后不再反复请求
  for (const m of ['invalid_grant', 'reused'] as const) {
    seed('rt-dead', -1000)
    const r = await run(m, () => h.ensure())
    check(`${m}：提示登录已过期`, !!r?.includes('已过期'), r ?? 'null')
    check(`${m}：标记为过期`, conf()?.expired === true)
    check(`${m}：保留登录信息（client_id、账号）`, session()?.clientId === 'oaiapp_test' && conf()?.label === 'test@example.com')
    const st = h.status()
    check(`${m}：状态显示需要重新登录`, !st.ok && st.detail.includes('已过期'), st.detail)
    const again = await run('ok', () => h.ensure())
    check(`${m}：之后不再请求令牌接口`, calls === 0 && !!again?.includes('已过期'), `请求 ${calls} 次`)
  }

  // 5. 刷新期间重新登录：旧的刷新结果（成功或失败）都不能覆盖新登录
  seed('rt-A', 30_000)
  const p1 = run('slow', () => h.ensure())
  await sleep(50)
  seed('rt-NEW', 3600_000)
  await p1
  check('刷新期间重新登录：新登录不被覆盖', session()?.refreshToken === 'rt-NEW', session()?.refreshToken)
  seed('rt-B', -1000)
  const p2 = run('slow-invalid', () => h.ensure())
  await sleep(50)
  seed('rt-NEW2', 3600_000)
  await p2
  check('刷新期间重新登录：旧登录失效不影响新登录', !conf()?.expired && session()?.refreshToken === 'rt-NEW2')

  // 6. 令牌被拒（401）：强制刷新一次
  seed('rt-401', 3600_000)
  const a1 = await run('ok', () => h.authProblem(new TranslateError('API Key 无效或已停用', 'auth')))
  check('令牌被拒：强制刷新并提示重试', calls === 1 && !!a1?.includes('请再试一次'), `${a1} / 刷新 ${calls} 次`)
  seed('rt-401b', 3600_000)
  const a2 = await run('invalid_grant', () => h.authProblem(new TranslateError('API Key 无效或已停用', 'auth')))
  check('令牌被拒且刷新不了：提示登录已过期', !!a2?.includes('已过期'), String(a2))
  const a3 = await run('ok', () => h.authProblem(new TranslateError('请求过于频繁或额度不足', 'rate-limit')))
  check('其他错误不处理', a3 === null && calls === 0)

  // 7. 设置文件：不留临时文件；损坏时另存一份，不被默认设置悄悄覆盖
  protocol.unhandle('https')
  const dir = app.getPath('userData')
  const file = join(dir, 'settings.json')
  check('保存后没有遗留临时文件', !existsSync(`${file}.tmp`))
  let label = ''
  try {
    label = JSON.parse(readFileSync(file, 'utf8')).providers?.chatgpt?.label ?? ''
  } catch {
    /* 留空即失败 */
  }
  check('设置文件完整', label === 'test@example.com', label)
  const broken = '{"hotkey": "Alt+Q", "provider": "chatg'
  writeFileSync(file, broken)
  const loaded = settings.load()
  const copies = readdirSync(dir).filter((f) => f.startsWith('settings.json.broken-'))
  check('损坏的设置文件另存了一份', copies.some((f) => readFileSync(join(dir, f), 'utf8') === broken), copies.join(', '))
  check('损坏时先用默认设置', loaded.provider === DEFAULT_SETTINGS.provider)
  for (const f of copies) rmSync(join(dir, f))
  rmSync(file, { force: true })

  console.log(`[signin] ${failed ? `${failed} 项失败` : '全部通过'}`)
  app.exit(failed ? 1 : 0)
}
