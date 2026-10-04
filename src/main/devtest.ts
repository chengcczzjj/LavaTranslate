// 开发自测：LENS_AUTOTEST=1 时用测试图伪造截屏，离屏渲染遮罩并模拟鼠标操作，逐步截图到 .scratch/shots
// LENS_MOCK=1 时使用模拟翻译引擎（不消耗额度）
import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { OcrLine, SettingsPatch, TranslatedBlock } from '../shared/types'
import type { DisplayCapture } from './capture'
import type { Emit, Engine, ReplyRequest, TranslateRequest, TranslateResult } from './translator'

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
  inject: (cap: DisplayCapture) => Promise<void>
  waitDone: () => Promise<void>
  display: Electron.Display
  mock: MockEngine | null
  setSettings: (p: SettingsPatch) => void
  /** 连按两次快捷键：进入输入翻译 */
  quick?: () => void
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
  const pages = ['概览', '翻译', '翻译服务', '快捷键与启动', '关于']
  const sshot = async (name: string) => {
    const img = await sw.webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    console.log('[autotest] shot', name)
  }
  for (let i = 0; i < pages.length; i++) {
    await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes(${JSON.stringify(pages[i])}))?.click()`)
    await sleep(700)
    await sshot(`settings-${i + 1}`)
  }
  // 填好 Key 后的模型价格列表（假服务，不涉及真实 Key）
  const fake = await fakeModelServer()
  h.setSettings({ provider: 'custom', providers: { custom: { baseUrl: fake.url, key: 'sk-test-0000-abcd', model: 'deepseek-v4-flash' } } })
  await sleep(400)
  await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('概览'))?.click()`)
  await sleep(400)
  await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('翻译服务'))?.click()`)
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
    const { BlockParser, userText } = await import('./translator')
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
