import { AnimatePresence, motion } from 'motion/react'
import {
  AlertCircle,
  BatteryCharging,
  BatteryLow,
  Check,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Languages,
  MessageSquareReply,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Timer,
  X,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { detectProvider } from '@core/detect'
import { sortByPriceIn, type ModelPrice, type PriceTable } from '@core/prices'
import { OpenAIEngine } from '@core/translator'
import { AMBIGUOUS_KEY_PROVIDERS, LANGUAGES, PROVIDERS, providerByKeyFormat, providerInfo, type ProviderConfig, type ProviderId } from '@shared/types'
import prices from '../../../../resources/model-prices.json'
import testPng from '../../../../resources/test.png?inline'
import appIcon from '../../../../resources/icon.png?url'
import { call, on } from '../bridge'
import { engineFor, type MobileSettings as S } from '../engine'
import { OrbGlyph } from '../overlay/Orb'

interface Status {
  overlay: boolean
  notifications: boolean
  a11ySupported: boolean
  a11yEnabled: boolean
  a11yConnected: boolean
  running: boolean
  projection: boolean
  battery: boolean
  brand: string
  sdk: number
  version: string
}

type Patch = Partial<Omit<S, 'providers'>> & { providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>> }

/** 手机上不提供 ChatGPT 账号登录（桌面版也还在验证中） */
const MOBILE_PROVIDERS = PROVIDERS.filter((p) => p.id !== 'chatgpt')
/** 设置页里拉模型列表、验证 Key：网络不通时尽快给出结果，不重试 */
const LOOKUP = { timeout: 12_000, maxRetries: 0 }
const NON_CHAT = /(embed|tts|whisper|dall-?e|imagen|image-gen|-image|audio|realtime|moderation|transcri|rerank|sora|veo|speech|search-preview|aqa|live)/i

export function MobileSettings() {
  const [s, setS] = useState<S | null>(null)
  const [st, setSt] = useState<Status | null>(null)
  const [insets, setInsets] = useState({ top: 28, bottom: 16, ime: 0 })
  const [modelSheet, setModelSheet] = useState(false)
  const [upd, setUpd] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    void call<Status>('hello').then(setSt)
    void call<S>('getSettings').then(setS)
    void call<UpdateInfo>('update.state').then(setUpd)
    const offs = [on<Status>('status', setSt), on<typeof insets>('insets', setInsets), on<UpdateInfo>('update', setUpd)]
    return () => offs.forEach((f) => f())
  }, [])

  useEffect(
    () =>
      on('back', () => {
        if (modelSheet) setModelSheet(false)
        else void call('exit')
      }),
    [modelSheet]
  )

  const update = useCallback(async (patch: Patch) => {
    try {
      setS(await call<S>('setSettings', patch))
    } catch (e) {
      console.error('setSettings', e)
      setS(await call<S>('getSettings'))
    }
    setSt(await call<Status>('status'))
  }, [])

  if (!s || !st) return <div className="s-boot" />

  return (
    <div className="s-wrap" style={{ paddingTop: insets.top + 18, paddingBottom: Math.max(insets.bottom, insets.ime) + 28 }}>
      <header className="s-head">
        <img className="s-logo" src={appIcon} alt="" />
        <div>
          <h1>LavaTranslate</h1>
          <p>全屏翻译 · 回复外语聊天 · v{st.version}</p>
        </div>
      </header>

      {/* 有新版本：顶部提示，点一下跳到更新那一栏 */}
      <AnimatePresence>
        {upd?.next && (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'ready') && (
          <motion.button
            className="s-upd-banner"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onClick={() => document.getElementById('update')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            <Sparkles size={15} />
            <span>{upd.state === 'ready' ? `新版本 v${upd.next} 已下载，点这里安装` : upd.state === 'downloading' ? `正在下载新版本 v${upd.next} · ${upd.percent}%` : `有新版本 v${upd.next}`}</span>
            <ChevronRight size={15} />
          </motion.button>
        )}
      </AnimatePresence>

      <BubbleCard s={s} st={st} update={update} />
      <CaptureCard s={s} st={st} update={update} />
      <ServiceCard s={s} update={update} openModels={() => setModelSheet(true)} />
      <PrefsCard s={s} update={update} />
      <PowerCard s={s} st={st} update={update} />
      <KeepAliveCard st={st} />
      <UpdateCard s={s} u={upd} update={update} />

      <footer className="s-foot">
        <button onClick={() => void call('openUrl', { url: 'https://github.com/chengcczzjj/LavaTranslate' })}>
          <ExternalLink size={14} /> 开源项目 · MIT
        </button>
        <span>只有截取的屏幕内容会发送给你配置的翻译服务；OCR 在手机本地完成。</span>
      </footer>

      <AnimatePresence>{modelSheet && <ModelSheet s={s} update={update} onClose={() => setModelSheet(false)} bottom={insets.bottom} />}</AnimatePresence>
    </div>
  )
}

// ------------------------------------------------------------------ 悬浮球
function BubbleCard({ s, st, update }: { s: S; st: Status; update: (p: Patch) => Promise<void> }) {
  const on = s.bubbleEnabled && st.running
  const a11y = s.captureMode === 'accessibility'
  const toggle = async () => {
    if (on) {
      await call('stopBubble')
      await update({})
      return
    }
    if (!st.overlay) return void call('requestOverlay')
    await call('startBubble').catch(() => call('requestOverlay'))
    await update({})
  }
  const line = !on
    ? '打开后，在任何应用里点悬浮球就能翻译整个屏幕'
    : a11y
      ? st.a11yConnected
        ? '已就绪 · 免授权截屏'
        : '免授权截屏还没开启，见下方「截屏方式」'
      : st.projection
        ? '已就绪 · 截屏已授权'
        : '点悬浮球时会先请你授权截屏（锁屏后需要重新授权）'

  return (
    <section className={`s-card s-hero${on ? ' on' : ''}`}>
      <div className="s-hero-top">
        <div className={`s-orb${on ? ' on' : ''}`}>
          <OrbGlyph />
        </div>
        <div className="s-hero-text">
          <div className="s-hero-title">悬浮球</div>
          <div className="s-hero-line">{line}</div>
        </div>
        <Switch on={on} onClick={() => void toggle()} />
      </div>
      <div className="s-checks">
        <Check2 ok={st.overlay} label="显示在其他应用上层" hint="悬浮球与翻译界面都需要" action="去开启" onAction={() => void call('requestOverlay')} />
        {st.sdk >= 33 && (
          <Check2 ok={st.notifications} label="通知" hint="显示「悬浮球已开启」的常驻通知，可以从通知栏翻译、退出" action="允许" onAction={() => void call('requestNotifications')} />
        )}
        {on && !a11y && !st.projection && <Check2 ok={false} label="截屏授权" hint="授权一次后一直有效，直到锁屏或你在状态栏停止共享" action="授权" onAction={() => void call('authorize')} />}
      </div>
      {on && (
        <div className="s-tip">
          <Sparkles size={14} />
          <span>单击悬浮球翻译屏幕，长按打开菜单（快捷回复、译成、设置、退出）。翻译时单击悬浮球或按返回键退出，长按打开菜单。也可以在下拉快捷开关里添加「翻译屏幕」。</span>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ 截屏方式
function CaptureCard({ s, st, update }: { s: S; st: Status; update: (p: Patch) => Promise<void> }) {
  const modes = [
    {
      id: 'projection' as const,
      title: '截屏授权',
      tag: '推荐',
      desc: '系统的屏幕共享授权：开启悬浮球时点一次「开始」。锁屏后系统会结束授权，解锁后第一次翻译要再点一次；授权期间状态栏会显示共享标识。'
    },
    {
      id: 'accessibility' as const,
      title: '免授权（无障碍）',
      tag: '',
      desc: '在系统「无障碍」里打开一次，之后一直有效：不弹授权、没有共享标识、锁屏也不失效。系统会提示该权限可以控制设备，LavaTranslate 只用它截屏。'
    }
  ]
  return (
    <section className="s-card">
      <h2>截屏方式</h2>
      <div className="s-modes">
        {modes.map((m) => {
          const disabled = m.id === 'accessibility' && !st.a11ySupported
          return (
            <button key={m.id} className={`s-mode${s.captureMode === m.id ? ' on' : ''}`} disabled={disabled} onClick={() => void update({ captureMode: m.id })}>
              <span className="s-radio">{s.captureMode === m.id && <motion.span layoutId="s-radio-dot" className="s-radio-dot" />}</span>
              <span className="s-mode-body">
                <span className="s-mode-title">
                  {m.title}
                  {m.tag && <em>{m.tag}</em>}
                </span>
                <span className="s-mode-desc">{disabled ? '需要 Android 11 或更高版本' : m.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
      {s.captureMode === 'accessibility' && st.a11ySupported && (
        <div className="s-a11y">
          <Check2
            ok={st.a11yConnected}
            label={st.a11yConnected ? '无障碍已开启' : st.a11yEnabled ? '无障碍已打开，正在连接…' : '无障碍未开启'}
            hint="系统设置 → 无障碍 → 已下载的应用 → LavaTranslate 免授权截屏"
            action="去开启"
            onAction={() => void call('openAccessibility')}
          />
          {!st.a11yConnected && st.sdk >= 33 && (
            <p className="s-small">
              开关是灰色、提示「受限制的设置」时：先到 <button onClick={() => void call('openAppDetails')}>应用信息</button> → 右上角 ⋮ →「允许受限制的设置」，再回来打开。
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ 翻译服务
// 先选服务商，再填它的 Key：官方渠道只填 Key（接口地址固定），自定义才填接口地址。
// 保存时直接存到所选服务商（不再挨家试探，国内网络下试探 OpenAI 会卡很久）；
// Key 的格式明显属于另一家（AIza → Gemini、sk-ant- → Claude…）时自动切过去。保存后拉一次模型列表验证 Key，并选好推荐模型
function ServiceCard({ s, update, openModels }: { s: S; update: (p: Patch) => Promise<void>; openModels: () => void }) {
  const info = providerInfo(s.provider)
  return (
    <section className="s-card">
      <h2>翻译服务</h2>
      <div className="s-providers">
        {MOBILE_PROVIDERS.map((p) => {
          const has = !!s.providers[p.id]?.key
          return (
            <button key={p.id} className={`s-prov${p.id === info.id ? ' on' : ''}`} onClick={() => p.id !== info.id && void update({ provider: p.id })}>
              <span className="s-mark sm" style={{ background: p.color }}>
                {p.name.slice(0, 1)}
              </span>
              <span className="s-prov-name">{p.name}</span>
              {has && <span className="s-prov-dot" title="已填 Key" />}
            </button>
          )
        })}
      </div>
      {/* 换服务商时整块重建，输入框、提示都回到该服务商自己的状态 */}
      <ProviderSetup key={info.id} s={s} update={update} openModels={openModels} />
    </section>
  )
}

type Verify = { state: 'run'; text: string } | { state: 'ok'; text: string } | { state: 'err'; text: string; switchTo?: ProviderId }

function ProviderSetup({ s, update, openModels }: { s: S; update: (p: Patch) => Promise<void>; openModels: () => void }) {
  const info = providerInfo(s.provider)
  const conf = s.providers[info.id]
  const custom = info.id === 'custom'
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [url, setUrl] = useState(custom ? (conf?.baseUrl ?? '') : '')
  const [busy, setBusy] = useState(false)
  const [verify, setVerify] = useState<Verify | null>(null)
  const [test, setTest] = useState<{ state: 'run' | 'ok' | 'err'; text: string } | null>(null)
  const urlChanged = custom && url.trim().toLowerCase() !== (conf?.baseUrl ?? '').toLowerCase()

  /** 用已保存的 Key 拉模型列表：验证 Key，顺便在还没选模型时选上推荐的 */
  const check = async (id: ProviderId, note = '') => {
    const pi = providerInfo(id)
    setVerify({ state: 'run', text: `${note}正在验证…` })
    try {
      const p = await call<ProviderConfig>('provider', { id })
      const baseURL = (p.baseUrl || pi.baseUrl).replace(/\/+$/, '')
      const ids = await new OpenAIEngine({ baseURL, apiKey: p.key }, 'x', LOOKUP).listModels()
      // 验证期间用户可能已经手动选了模型：以最新的为准
      const now = await call<ProviderConfig>('provider', { id })
      let picked = now.model
      if (!picked) {
        picked = pi.suggest.find((m) => ids.includes(m)) ?? ''
        if (picked) await update({ providers: { [id]: { model: picked } } })
      }
      setVerify({ state: 'ok', text: `${note}Key 可用${picked ? `，已选推荐模型 ${picked}` : ''}` })
    } catch (e) {
      const err: Verify = { state: 'err', text: note + explain(e, pi.tags.includes('需要代理')) }
      setVerify(err)
      // sk- 开头的几家格式一样：Key 不对时看看是不是别家的
      if (isAuthError(e) && AMBIGUOUS_KEY_PROVIDERS.includes(id)) {
        const p = await call<ProviderConfig>('provider', { id })
        const r = await detectProvider(p.key).catch(() => null)
        if (r?.provider && r.provider !== id) setVerify({ ...err, text: `${note}这个 Key 不是 ${pi.name} 的，看起来是 ${providerInfo(r.provider).name} 的`, switchTo: r.provider })
      }
    }
  }

  const save = async () => {
    const k = key.trim()
    if (custom && !url.trim()) return setVerify({ state: 'err', text: '请先填写接口地址' })
    if (!k && !urlChanged) return
    setBusy(true)
    try {
      // 格式能确定是别家的 Key：自动切换过去
      const byFormat = k && !custom ? providerByKeyFormat(k) : null
      const id = byFormat && byFormat !== info.id ? byFormat : info.id
      const note = id !== info.id ? `这是 ${providerInfo(id).name} 的 Key，已切换过去。` : ''
      const baseUrl = url.trim().replace(/^https?:\/\//i, (m) => m.toLowerCase())
      if (custom && baseUrl !== url) setUrl(baseUrl)
      await update({ provider: id, providers: { [id]: { ...(k ? { key: k } : {}), ...(custom ? { baseUrl } : {}) } } })
      setKey('')
      if (!k && !conf?.key) setVerify({ state: 'ok', text: '接口地址已保存，再填上 API Key' })
      else if (id === info.id) await check(id, note)
      // 切到别家时本组件会重建，由新服务商那边自己验证
      else pendingCheck = { id, note }
    } finally {
      setBusy(false)
    }
  }

  // 刚因 Key 格式切换过来：接着验证
  useEffect(() => {
    if (pendingCheck?.id === info.id) {
      const { id, note } = pendingCheck
      pendingCheck = null
      void check(id, note)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clear = async () => {
    await update({ providers: { [info.id]: { key: '', model: '' } } })
    setVerify(null)
    setTest(null)
  }

  const runTest = async () => {
    setTest({ state: 'run', text: '正在测试…' })
    const p = await call<ProviderConfig>('provider', { id: s.provider })
    const eng = engineFor({ ...s, providers: { ...s.providers, [s.provider]: p } })
    if (!eng) return setTest({ state: 'err', text: '还没有填好 Key 或选择模型' })
    const img = await loadImage(testPng)
    const t0 = performance.now()
    let got = ''
    try {
      await eng.translate(
        {
          image: { base64: testPng.split(',')[1], mediaType: 'image/png', width: img.width, height: img.height },
          lines: [{ id: 1, text: 'Good morning!', score: 1, box: { x: 8, y: 8, w: img.width - 16, h: img.height - 16 } }],
          target: LANGUAGES.find((l) => l.code === s.targetLang) ?? LANGUAGES[0],
          styleHint: ''
        },
        (ev) => {
          if (ev.type === 'block') got = ev.block.translation
        },
        new AbortController().signal
      )
      setTest({ state: 'ok', text: `「Good morning!」→「${got}」 · ${((performance.now() - t0) / 1000).toFixed(1)} s` })
    } catch (e) {
      setTest({ state: 'err', text: (e as Error).message })
    }
  }

  return (
    <div className="s-setup">
      <div className="s-setup-head">
        <span className="s-mark" style={{ background: info.color }}>
          {info.name.slice(0, 1)}
        </span>
        <div className="s-setup-title">
          <div>{info.name}</div>
          <div className="s-small">{info.blurb}</div>
        </div>
        {info.tags.length > 0 && (
          <div className="s-tags">
            {info.tags.map((t) => (
              <span key={t} className={`s-tag${t === '需要代理' ? ' warn' : ''}`}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {custom && (
        <label className="s-label">
          接口地址
          <input
            className="s-input mono"
            type="url"
            inputMode="url"
            placeholder="https://…/v1（中转站、Ollama、LM Studio 等）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
      )}

      <label className="s-label">
        API Key
        {conf?.key && (
          <span className="s-saved">
            <Check size={12} strokeWidth={3} /> 已保存 {conf.key}
            <button className="s-link" onClick={() => void clear()}>
              清除
            </button>
          </span>
        )}
      </label>
      <div className="s-keybox">
        <KeyRound size={16} className="s-keyicon" />
        <input
          className="s-input mono"
          type={show ? 'text' : 'password'}
          placeholder={conf?.key ? '粘贴新的 Key 可替换' : `粘贴 ${info.name} 的 Key${info.keyHint ? `（${info.keyHint} 开头）` : ''}`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="s-icon-btn" onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button className="s-btn primary" disabled={busy || (!key.trim() && !urlChanged)} onClick={() => void save()}>
          {busy ? <RefreshCw size={14} className="spin" /> : '保存'}
        </button>
      </div>

      {verify && (
        <div className={`s-msg ${verify.state}`}>
          {verify.state === 'run' ? <RefreshCw size={13} className="spin" /> : verify.state === 'ok' ? <Check size={13} strokeWidth={3} /> : <AlertCircle size={13} />}
          <span>
            {verify.text}
            {verify.state === 'ok' && conf?.key && !conf.model && '，请选择一个模型'}
          </span>
          {verify.state === 'err' && verify.switchTo && (
            <button className="s-btn sm" onClick={() => void moveKey(info.id, verify.switchTo!, update)}>
              改存到 {providerInfo(verify.switchTo).name}
            </button>
          )}
        </div>
      )}

      {!conf?.key && (info.keyUrl || info.steps.length > 0) && (
        <div className="s-steps">
          <ol>
            {info.steps.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
          {info.tip && <p className="s-small">{info.tip}</p>}
          {info.keyUrl && (
            <button className="s-btn" onClick={() => void call('openUrl', { url: info.keyUrl })}>
              <ExternalLink size={14} /> {info.keyUrlLabel}
            </button>
          )}
        </div>
      )}

      {conf?.key && (
        <>
          <button className="s-row" onClick={openModels}>
            <span className="s-row-label">模型</span>
            <span className={`s-row-value${conf.model ? '' : ' warn'}`}>{conf.model || '请选择'}</span>
            <ChevronRight size={16} className="s-row-chev" />
          </button>
          <div className="s-test">
            <button className="s-btn" onClick={() => void runTest()} disabled={test?.state === 'run' || !conf.model}>
              <Zap size={14} /> 测试
            </button>
            {test && <span className={`s-test-text ${test.state}`}>{test.text}</span>}
          </div>
        </>
      )}
    </div>
  )
}

/** 保存后因 Key 格式切换到别家：新服务商的面板挂载后接着验证 */
let pendingCheck: { id: ProviderId; note: string } | null = null

/** 把 Key 从一家挪到另一家（验证时发现填错了服务商） */
async function moveKey(from: ProviderId, to: ProviderId, update: (p: Patch) => Promise<void>) {
  const p = await call<ProviderConfig>('provider', { id: from })
  pendingCheck = { id: to, note: '' }
  await update({ provider: to, providers: { [to]: { key: p.key }, [from]: { key: '', model: '' } } })
}

function isAuthError(e: unknown) {
  const status = (e as { status?: number }).status
  return status === 401 || status === 403 || /api[ _-]?key|unauthori[sz]ed|authenticat|invalid.*key/i.test((e as Error)?.message ?? '')
}

/** 把接口错误说成人话 */
function explain(e: unknown, needsProxy: boolean) {
  if (isAuthError(e)) return 'Key 无效或已停用，请检查是否复制完整、是否选对了服务商'
  const msg = (e as Error)?.message ?? String(e)
  const status = (e as { status?: number }).status
  if (!status && /fetch|network|connect|timed? ?out|abort|网络|连接/i.test(msg)) return needsProxy ? '连不上服务（国内网络需要开代理）' : '连不上服务，请检查网络'
  if (status === 429) return '请求过于频繁或额度不足'
  if (status === 404) return '接口地址不对（自定义服务通常以 /v1 结尾）'
  return `验证失败：${msg}`
}

function ModelSheet({ s, update, onClose, bottom }: { s: S; update: (p: Patch) => Promise<void>; onClose: () => void; bottom: number }) {
  const info = providerInfo(s.provider)
  const [state, setState] = useState<{ load: boolean; list: ModelPrice[]; err?: string }>({ load: true, list: [] })
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setState((v) => ({ ...v, load: true, err: undefined }))
    try {
      const p = await call<ProviderConfig>('provider', { id: info.id })
      const baseURL = (p.baseUrl || info.baseUrl).replace(/\/+$/, '')
      const ids = await new OpenAIEngine({ baseURL, apiKey: p.key }, 'x', LOOKUP).listModels()
      setState({ load: false, list: sortByPriceIn(prices as unknown as PriceTable, ids) })
    } catch (e) {
      setState({ load: false, list: [], err: explain(e, info.tags.includes('需要代理')) })
    }
  }, [info.id, info.baseUrl, info.tags])

  useEffect(() => void load(), [load])

  // 先收起面板再保存：不让一次慢的保存卡住界面
  const choose = (model: string) => {
    onClose()
    void update({ providers: { [info.id]: { model } } })
  }
  const needle = q.trim().toLowerCase()
  const list = useMemo(() => state.list.filter((m) => !NON_CHAT.test(m.id) && m.id.toLowerCase().includes(needle)), [state.list, needle])
  const manual = needle && !state.list.some((m) => m.id.toLowerCase() === needle) ? q.trim() : ''
  const current = s.providers[info.id]?.model

  return (
    <>
      <motion.div className="s-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="s-sheet"
        style={{ paddingBottom: bottom + 12 }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%', transition: { duration: 0.2 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 40 }}
      >
        <div className="s-sheet-grip" />
        <div className="s-sheet-head">
          <span>选择模型 · {info.name}</span>
          <button className="s-icon-btn" onClick={() => void load()} disabled={state.load}>
            <RefreshCw size={15} className={state.load ? 'spin' : ''} />
          </button>
          <button className="s-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="s-search">
          <Search size={15} />
          <input placeholder="搜索，或直接输入模型名" autoCapitalize="off" autoCorrect="off" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && manual && choose(manual)} spellCheck={false} />
        </div>
        <div className="s-models">
          {manual && (
            <button className="s-model" onClick={() => choose(manual)}>
              <span className="s-model-id">使用「{manual}」</span>
            </button>
          )}
          {state.err && <div className="s-msg err">{state.err}</div>}
          {state.load && !state.list.length && <div className="s-loading">正在获取模型列表…</div>}
          {list.map((m) => {
            const rec = info.suggest.includes(m.id)
            return (
              <button key={m.id} className={`s-model${m.id === current ? ' on' : ''}`} onClick={() => choose(m.id)}>
                <span className="s-model-id">
                  {m.id}
                  {rec && <em>推荐</em>}
                  {m.vision === false && <i>不能看图</i>}
                </span>
                {m.id === current ? <Check size={16} strokeWidth={3} className="s-model-check" /> : <span className="s-model-price">{m.perCall == null ? '—' : `${money(m.perCall * 1000)} / 千次`}</span>}
              </button>
            )
          })}
        </div>
      </motion.div>
    </>
  )
}

// ------------------------------------------------------------------ 翻译偏好
function PrefsCard({ s, update }: { s: S; update: (p: Patch) => Promise<void> }) {
  const [hint, setHint] = useState(s.styleHint)
  return (
    <section className="s-card">
      <h2>翻译</h2>
      <div className="s-field">
        <div className="s-field-head">
          <Languages size={15} /> 译成
        </div>
        <div className="s-langs">
          {LANGUAGES.map((l) => (
            <button key={l.code} className={`s-lang${l.code === s.targetLang ? ' on' : ''}`} onClick={() => void update({ targetLang: l.code })}>
              {l.name}
            </button>
          ))}
        </div>
      </div>
      <div className="s-toggle-row">
        <MessageSquareReply size={16} />
        <div>
          <div className="s-toggle-title">聊天截图提示回复</div>
          <div className="s-small">模型判断是聊天、私信、评论时，底部出现「回复」按钮：用你的语言写，自动译成对方的语言，附回译确认意思</div>
        </div>
        <Switch on={s.replyAssist} onClick={() => void update({ replyAssist: !s.replyAssist })} />
      </div>
      <div className="s-field">
        <div className="s-field-head">
          <Sparkles size={15} /> 翻译风格（可选）
        </div>
        <input
          className="s-input"
          placeholder="例如：游戏术语保留英文；语气口语化"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          onBlur={() => hint !== s.styleHint && void update({ styleHint: hint })}
        />
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ 省电
const IDLE_EXIT = [
  { min: 30, label: '30 分钟' },
  { min: 60, label: '1 小时' },
  { min: 180, label: '3 小时' },
  { min: 0, label: '从不' }
]

function PowerCard({ s, st, update }: { s: S; st: Status; update: (p: Patch) => Promise<void> }) {
  return (
    <section className="s-card">
      <h2>省电</h2>
      <div className="s-field">
        <div className="s-field-head">
          <Timer size={15} /> 不用时自动退出
        </div>
        <div className="s-langs">
          {IDLE_EXIT.map((o) => (
            <button key={o.min} className={`s-lang${s.idleExit === o.min ? ' on' : ''}`} onClick={() => void update({ idleExit: o.min })}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="s-small">这么久没用悬浮球就自动退出，不在后台常驻；通知栏会留一条提醒，点一下就能重新打开</div>
      </div>
      <div className="s-toggle-row">
        <BatteryLow size={16} />
        <div>
          <div className="s-toggle-title">省电模式下自动退出</div>
          <div className="s-small">打开系统省电模式（包括电量低时自动打开）时，悬浮球自动退出</div>
        </div>
        <Switch on={s.saverExit} onClick={() => void update({ saverExit: !s.saverExit })} />
      </div>
      <p className="s-small s-power-note">悬浮球不用时不截屏、不联网，界面也会暂停，几乎不耗电。退出后点 LavaTranslate 图标，或下拉快捷开关里的「翻译屏幕」，就能重新打开。</p>
      {st.running && (
        <button className="s-btn s-quit" onClick={() => void call('quitApp')}>
          <Power size={14} /> 立即退出 LavaTranslate
        </button>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ 后台保活
const BRAND_TIPS: { match: RegExp; name: string; steps: string[] }[] = [
  {
    match: /vivo|iqoo/i,
    name: 'vivo / iQOO',
    steps: ['设置 → 电池 → 后台耗电管理 → LavaTranslate → 允许后台高耗电', 'i管家 → 应用管理 → 权限管理 → 自启动 → 打开 LavaTranslate', '最近任务里把 LavaTranslate 下拉锁定']
  },
  {
    match: /xiaomi|redmi|poco/i,
    name: '小米 / 红米',
    steps: ['应用信息 → 省电策略 → 无限制', '应用信息 → 自启动 → 打开', '最近任务里长按 LavaTranslate → 锁定']
  },
  {
    match: /oppo|oneplus|realme/i,
    name: 'OPPO / 一加 / realme',
    steps: ['应用信息 → 耗电管理 → 允许后台运行、允许自启动', '最近任务里把 LavaTranslate 锁定']
  },
  {
    match: /honor|huawei/i,
    name: '荣耀 / 华为',
    steps: ['设置 → 电池 → 启动管理 → LavaTranslate → 改为手动管理，三项全开', '最近任务里把 LavaTranslate 下拉锁定']
  }
]

function KeepAliveCard({ st }: { st: Status }) {
  const tip = BRAND_TIPS.find((b) => b.match.test(st.brand))
  return (
    <section className="s-card">
      <h2>让悬浮球不被系统清理</h2>
      <Check2 ok={st.battery} label="不受电池优化限制" hint="否则系统可能在后台关掉悬浮球" action="去设置" onAction={() => void call('requestBattery')} />
      {tip && (
        <div className="s-brand">
          <div className="s-brand-title">
            <BatteryCharging size={15} /> {tip.name}（不同系统版本位置可能略有不同）
          </div>
          <ol>
            {tip.steps.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
          <button className="s-btn" onClick={() => void call('openAppDetails')}>
            <ShieldCheck size={14} /> 打开应用信息
          </button>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ 版本与更新
interface UpdateInfo {
  state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  version: string
  next?: string
  notes?: string
  size?: number
  percent: number
  message: string
}

function UpdateCard({ s, u, update }: { s: S; u: UpdateInfo | null; update: (p: Patch) => Promise<void> }) {
  const [hint, setHint] = useState('')
  if (!u) return null
  const install = async () => {
    const r = await call<string>('update.install')
    setHint(r === 'permission' ? '请在打开的页面里允许 LavaTranslate「安装未知应用」，返回后会自动继续安装' : '')
  }
  const mb = u.size ? `${(u.size / 1048576).toFixed(0)} MB` : ''
  return (
    <section className="s-card" id="update">
      <h2>版本与更新</h2>
      <div className="s-upd-head">
        <span>
          当前版本 <b>v{u.version}</b>
        </span>
        <button className="s-btn sm" disabled={u.state === 'checking' || u.state === 'downloading' || u.state === 'installing'} onClick={() => void call('update.check')}>
          {u.state === 'checking' ? <RefreshCw size={13} className="spin" /> : <RefreshCw size={13} />} 检查更新
        </button>
      </div>

      {u.state === 'latest' && (
        <div className="s-msg ok">
          <Check size={13} strokeWidth={3} />
          <span>已是最新版本</span>
        </div>
      )}
      {u.state === 'error' && (
        <div className="s-msg err">
          <AlertCircle size={13} />
          <span>{u.message}</span>
        </div>
      )}

      {(u.state === 'available' || u.state === 'downloading' || u.state === 'ready' || u.state === 'installing') && u.next && (
        <div className="s-upd">
          <div className="s-upd-title">
            <Sparkles size={15} /> 新版本 v{u.next}
            {mb && <span className="s-small">{mb}</span>}
          </div>
          {u.notes && <div className="s-upd-notes">{plainNotes(u.notes)}</div>}
          {u.state === 'downloading' ? (
            <div className="s-upd-progress">
              <div className="s-bar">
                <motion.div className="s-bar-fill" animate={{ width: `${u.percent}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
              </div>
              <span className="s-small">{u.percent}%</span>
              <button className="s-link" onClick={() => void call('update.cancel')}>
                取消
              </button>
            </div>
          ) : u.state === 'available' ? (
            <button className="s-btn primary wide" onClick={() => void call('update.download')}>
              下载并安装
            </button>
          ) : (
            <button className="s-btn primary wide" disabled={u.state === 'installing'} onClick={() => void install()}>
              {u.state === 'installing' ? <RefreshCw size={14} className="spin" /> : null}
              {u.state === 'installing' ? '正在打开系统安装器…' : '安装更新'}
            </button>
          )}
          {u.message && <div className="s-small">{u.message}</div>}
          {hint && <div className="s-small warn">{hint}</div>}
        </div>
      )}

      <div className="s-toggle-row s-upd-auto">
        <RefreshCw size={16} />
        <div>
          <div className="s-toggle-title">自动检查更新</div>
          <div className="s-small">打开应用时、悬浮球开着时每天检查一次；连着 Wi-Fi 会自动下载好，通知你安装</div>
        </div>
        <Switch on={s.autoUpdate} onClick={() => void update({ autoUpdate: !s.autoUpdate })} />
      </div>
    </section>
  )
}

/** 发布说明是 Markdown：去掉标题、加粗等符号，只留文字 */
function plainNotes(md: string) {
  return md
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

// ------------------------------------------------------------------ 小组件
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={`s-switch${on ? ' on' : ''}`} onClick={onClick} role="switch" aria-checked={on}>
      <motion.span className="s-knob" layout transition={{ type: 'spring', stiffness: 700, damping: 36 }} />
    </button>
  )
}

function Check2({ ok, label, hint, action, onAction }: { ok: boolean; label: string; hint: string; action: string; onAction: () => void }) {
  return (
    <div className={`s-check${ok ? ' ok' : ''}`}>
      <span className="s-check-icon">{ok ? <Check size={13} strokeWidth={3} /> : <AlertCircle size={14} />}</span>
      <div className="s-check-text">
        <div>{label}</div>
        {!ok && <div className="s-small">{hint}</div>}
      </div>
      {!ok && (
        <button className="s-btn sm" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  )
}

function money(v: number) {
  if (v < 0.01) return '<$0.01'
  return '$' + (v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toString())
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
