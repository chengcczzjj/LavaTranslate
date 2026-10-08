import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronDown,
  Columns2,
  Cpu,
  Download,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  LayoutDashboard,
  Loader2,
  LogIn,
  MessageSquareReply,
  Power,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  KEY_PROVIDERS,
  LANGUAGES,
  PROVIDERS,
  providerForUrl,
  providerInfo,
  type EngineStatus,
  type ModelInfo,
  type OpenAISource,
  type ProviderId,
  type Settings as S,
  type SettingsPatch,
  type UpdateState
} from '@shared/types'
import { UI_LANGS, type MsgKey } from '@shared/i18n'
import { useI18n, type I18n } from '../lib/i18n'

type Page = 'home' | 'translate' | 'engine' | 'general' | 'about'

const NAV: { id: Page; label: MsgKey; icon: ReactNode }[] = [
  { id: 'home', label: 'nav.home', icon: <LayoutDashboard size={17} /> },
  { id: 'translate', label: 'nav.translate', icon: <Languages size={17} /> },
  { id: 'engine', label: 'nav.engine', icon: <Sparkles size={17} /> },
  { id: 'general', label: 'nav.general', icon: <Settings2 size={17} /> },
  { id: 'about', label: 'nav.about', icon: <Info size={17} /> }
]

export function Settings() {
  const i = useI18n()
  const { t } = i
  const [s, setS] = useState<S | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [ocr, setOcr] = useState('')
  const [version, setVersion] = useState('')
  const [upd, setUpd] = useState<UpdateState | null>(null)

  const refreshStatus = useCallback(() => {
    void window.lens.engineStatus().then(setStatus)
  }, [])

  useEffect(() => {
    void window.lens.getSettings().then(setS)
    void window.lens.appInfo().then((i) => setVersion(i.version))
    void window.lens.updateState().then(setUpd)
    const offUpd = window.lens.onUpdate(setUpd)
    refreshStatus()
    const off = window.lens.onSettings((n) => {
      setS(n)
      refreshStatus()
    })
    // 登录在外部终端完成，定期刷新状态
    const t = setInterval(refreshStatus, 2500)
    return () => {
      off()
      offUpd()
      clearInterval(t)
    }
  }, [refreshStatus])

  // 状态、OCR 说明由主进程按界面语言生成：换语言后重新取
  useEffect(() => {
    void window.lens.ocrInfo().then(setOcr)
    refreshStatus()
  }, [i.lang, refreshStatus])

  const update = useCallback(async (patch: SettingsPatch) => {
    setS(await window.lens.setSettings(patch))
  }, [])

  if (!s) return null
  return (
    <div className="app">
      <header className="titlebar">
        <img src="./icon.png" alt="" />
        <span>LavaTranslate</span>
      </header>
      <div className="body">
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} data-page={n.id} className={`nav-item${page === n.id ? ' on' : ''}`} onClick={() => setPage(n.id)}>
              {page === n.id && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="nav-icon">{n.icon}</span>
              <span>{t(n.label)}</span>
            </button>
          ))}
          <div className="nav-foot">
            <button className="nav-status" onClick={() => setPage('engine')}>
              <span className={`dot ${status?.ok ? 'ok' : 'bad'}`} />
              {status?.ok ? t('nav.ready') : t('nav.needSetup')}
            </button>
            <button className={`nav-ver${upd?.state === 'ready' ? ' hot' : ''}`} onClick={() => setPage('about')}>
              v{version} · {updateShort(upd, i)}
            </button>
          </div>
        </nav>
        <main className="content">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {page === 'home' && <Home s={s} status={status} ocr={ocr} go={setPage} />}
              {page === 'translate' && <TranslatePage s={s} update={update} />}
              {page === 'engine' && <ServicePage s={s} update={update} status={status} refresh={refreshStatus} />}
              {page === 'general' && <GeneralPage s={s} update={update} />}
              {page === 'about' && <About s={s} update={update} version={version} ocr={ocr} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 概览
const SHORTCUTS: [string | MsgKey, MsgKey][] = [
  ['sc.click', 'sc.clickDo'],
  ['sc.alt', 'sc.altDo'],
  ['Space', 'sc.spaceDo'],
  ['Tab', 'sc.tabDo'],
  ['sc.clickText', 'sc.clickTextDo'],
  ['Ctrl C', 'sc.copyAll'],
  ['Ctrl Shift C', 'sc.copyImage'],
  ['F3', 'sc.pin'],
  ['sc.enter', 'sc.enterDo'],
  ['R', 'sc.replyDo'],
  ['sc.double', 'sc.doubleDo'],
  ['sc.tray', 'sc.trayDo'],
  ['sc.exit', 'sc.exitDo']
]

function Home({ s, status, ocr, go }: { s: S; status: EngineStatus | null; ocr: string; go: (p: Page) => void }) {
  const i = useI18n()
  const { t } = i
  const info = providerInfo(s.provider)
  const model = s.providers[s.provider]?.model
  return (
    <>
      <section className="hero">
        <div className="hero-glow" />
        <img className="hero-icon" src="./icon.png" alt="" />
        <h1>{t('home.title')}</h1>
        <p>{t('home.desc')}</p>
        <div className="hero-keys">
          {s.hotkey.split('+').map((k, n) => (
            <span key={n} className="keycap-wrap">
              {n > 0 && <span className="plus">+</span>}
              <span className="keycap">{k}</span>
            </span>
          ))}
        </div>
        <button className="btn primary big" onClick={() => window.lens.startCapture()}>
          <Zap size={16} /> {t('home.try')}
        </button>
      </section>

      <div className="tiles">
        <button className="tile" onClick={() => go('engine')}>
          <span className="tile-icon brand" style={{ background: info.color }}>
            {info.id === 'custom' ? <SlidersHorizontal size={17} /> : info.id === 'chatgpt' ? <Sparkles size={17} /> : i.provider(info.id).slice(0, 1)}
          </span>
          <span className="tile-title">{info.id === 'chatgpt' ? t('home.plan') : i.provider(info.id)}</span>
          <span className="tile-sub">{status?.ok ? t('home.ready') : (status?.detail ?? t('home.checking'))}</span>
        </button>
        <button className="tile" onClick={() => go('engine')}>
          <span className="tile-icon violet">
            <Sparkles size={18} />
          </span>
          <span className="tile-title">{model || t('home.noModel')}</span>
          <span className="tile-sub">{t('home.model')}</span>
        </button>
        <button className="tile" onClick={() => go('translate')}>
          <span className="tile-icon blue">
            <Languages size={18} />
          </span>
          <span className="tile-title">{i.langLabel(s.targetLang)}</span>
          <span className="tile-sub">{t('home.target')}</span>
        </button>
        <div className="tile">
          <span className="tile-icon teal">
            <Cpu size={18} />
          </span>
          <span className="tile-title">{t('home.ocr')}</span>
          <span className="tile-sub">{ocr || 'PP-OCRv6'}</span>
        </div>
      </div>

      {status && !status.ok && (
        <motion.div className="callout" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div>
            <b>{t('home.oneMore')}</b>
            <span>{t('home.oneMoreDesc', { detail: status.detail })}</span>
          </div>
          <button className="btn primary" onClick={() => go('engine')}>
            {t('home.setup')}
          </button>
        </motion.div>
      )}

      <h3 className="h3">{t('home.keys')}</h3>
      <div className="shortcuts">
        {SHORTCUTS.map(([k, d]) => (
          <div key={d} className="sc">
            <kbd>{k.includes('.') ? t(k as MsgKey) : k}</kbd>
            <span>{t(d)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ 翻译
function TranslatePage({ s, update }: { s: S; update: (p: SettingsPatch) => void }) {
  const i = useI18n()
  const { t } = i
  const [hint, setHint] = useState(s.styleHint)
  useEffect(() => setHint(s.styleHint), [s.styleHint])
  return (
    <>
      <h2>{t('tr.title')}</h2>
      <Card title={t('tr.target')} desc={t('tr.targetDesc')}>
        <Select
          value={s.targetLang}
          options={LANGUAGES.map((l) => ({ value: l.code, label: i.langLabel(l.code, l.name), sub: l.native }))}
          onChange={(v) => update({ targetLang: v })}
        />
      </Card>
      <Card stack title={t('tr.display')} desc={t('tr.displayDesc')}>
        <div className="mode-cards">
          <ModeCard on={s.displayMode === 'overlay'} onClick={() => update({ displayMode: 'overlay' })} icon={<Layers size={16} />} title={t('tr.overlay')} desc={t('tr.overlayDesc')}>
            <div className="mini">
              <div className="mini-shot">
                <i className="t1 tr" />
                <i className="t2 tr" />
                <i className="t3 tr" />
              </div>
            </div>
          </ModeCard>
          <ModeCard on={s.displayMode === 'side'} onClick={() => update({ displayMode: 'side' })} icon={<Columns2 size={16} />} title={t('tr.side')} desc={t('tr.sideDesc')}>
            <div className="mini two">
              <div className="mini-shot">
                <i className="t1" />
                <i className="t2" />
                <i className="t3" />
              </div>
              <div className="mini-shot">
                <i className="t1 tr" />
                <i className="t2 tr" />
                <i className="t3 tr" />
              </div>
            </div>
          </ModeCard>
        </div>
      </Card>
      <Card title={t('tr.reply')} desc={t('tr.replyDesc')} icon={<MessageSquareReply size={18} />}>
        <Toggle on={s.replyAssist} onChange={(v) => update({ replyAssist: v })} />
      </Card>
      <Card stack title={t('tr.hint')} desc={t('tr.hintDesc')}>
        <textarea
          className="input area"
          value={hint}
          placeholder={t('tr.hintPlaceholder')}
          onChange={(e) => setHint(e.target.value)}
          onBlur={() => hint !== s.styleHint && update({ styleHint: hint })}
        />
      </Card>
    </>
  )
}

function ModeCard(p: { on: boolean; onClick: () => void; icon: ReactNode; title: string; desc: string; children: ReactNode }) {
  return (
    <button className={`mode-card${p.on ? ' on' : ''}`} onClick={p.onClick}>
      {p.children}
      <div className="mode-meta">
        <span className="mode-title">
          {p.icon}
          {p.title}
        </span>
        <span className="mode-desc">{p.desc}</span>
      </div>
      <AnimatePresence>
        {p.on && (
          <motion.span className="mode-check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 25 }}>
            <Check size={12} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}

/** 下拉选择；sub 是灰色的第二个名字（语言的本地写法） */
function Select({ value, options, onChange }: { value: string; options: { value: string; label: string; sub?: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = options.find((o) => o.value === value)
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  const sub = (o?: { label: string; sub?: string }) => o?.sub && o.sub !== o.label && <span className="muted">{o.sub}</span>
  return (
    <div className="select" ref={ref}>
      <button className={`select-btn${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span>{cur?.label}</span>
        {sub(cur)}
        <ChevronDown size={15} className="chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="select-pop"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ type: 'spring', stiffness: 560, damping: 36 }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                className={`select-item${o.value === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span>{o.label}</span>
                {sub(o)}
                {o.value === value && <Check size={14} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ------------------------------------------------------------------ 翻译服务
type Upd = (p: SettingsPatch) => Promise<void> | void

function ServicePage({ s, update, status, refresh }: { s: S; update: Upd; status: EngineStatus | null; refresh: () => void }) {
  const { t } = useI18n()
  const [test, setTest] = useState<{ state: 'idle' | 'run' | 'ok' | 'fail'; msg?: string }>({ state: 'idle' })

  const runTest = async () => {
    setTest({ state: 'run' })
    const r = await window.lens.testEngine()
    setTest({ state: r.ok ? 'ok' : 'fail', msg: r.message })
    refresh()
  }

  return (
    <>
      <h2>{t('svc.title')}</h2>
      <div className={`status-bar${status?.ok ? ' ok' : ''}`}>
        <span className={`dot big ${status?.ok ? 'ok' : 'bad'}`} />
        <span className="status-text">{status?.detail ?? t('home.checking')}</span>
        <button className="btn primary" disabled={test.state === 'run' || !status?.ok} onClick={runTest}>
          {test.state === 'run' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />} {t('svc.test')}
        </button>
      </div>
      <AnimatePresence>
        {test.state === 'ok' || test.state === 'fail' ? (
          <motion.div className={`test-result ${test.state}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {test.state === 'ok' ? <Check size={15} /> : <Info size={15} />}
            {test.msg}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ChatGPTCard s={s} update={update} />
      <KeyCard s={s} update={update} />
      <SavedServices s={s} update={update} />
      <ModelList key={s.provider} s={s} update={update} />
      <KeyGuides />
    </>
  )
}

/** 用 ChatGPT 账号登录（Plus / Pro 会员额度） */
function ChatGPTCard({ s, update }: { s: S; update: Upd }) {
  const { t } = useI18n()
  const conf = s.providers.chatgpt
  const expired = !!conf?.key && !!conf.expired
  const signedIn = !!conf?.key && !expired
  const current = s.provider === 'chatgpt'
  const who = conf?.label || t('chatgpt.account')
  const [state, setState] = useState<{ busy: boolean; msg?: string }>({ busy: false })

  const signIn = async () => {
    setState({ busy: true })
    const r = await window.lens.chatgptSignIn()
    setState({ busy: false, msg: r.ok ? undefined : r.message })
  }

  return (
    <div className={`login-card${current ? ' on' : ''}`}>
      <span className="prov-mark lg" style={{ background: '#10a37f' }}>
        <Sparkles size={16} />
      </span>
      <div className="card-text">
        <div className="card-title">
          {t('chatgpt.title')}
          {current && <span className="tag rec">{t('common.current')}</span>}
        </div>
        <div className="card-desc">
          {signedIn
            ? t('chatgpt.signedIn', { who })
            : state.busy
              ? t('chatgpt.waiting')
              : expired
                ? t('chatgpt.expiredDesc', { who })
                : t('chatgpt.pitch')}
        </div>
        {state.msg && <div className="note err">{state.msg}</div>}
      </div>
      {signedIn ? (
        <div className="row-gap">
          {!current && (
            <button className="btn" onClick={() => void update({ provider: 'chatgpt' })}>
              {t('chatgpt.use')}
            </button>
          )}
          <button
            className="link danger"
            onClick={async () => {
              await window.lens.chatgptSignOut()
              if (current) await update({ provider: firstConfigured(s, 'chatgpt') })
              else await update({})
            }}
          >
            {t('chatgpt.signOut')}
          </button>
        </div>
      ) : state.busy ? (
        <button className="btn" onClick={() => window.lens.chatgptCancel()}>
          <Loader2 size={15} className="spin" /> {t('common.cancel')}
        </button>
      ) : (
        <button className="btn primary" onClick={() => void signIn()}>
          <LogIn size={15} /> {expired ? t('chatgpt.reSignIn') : t('chatgpt.signIn')}
        </button>
      )}
    </div>
  )
}

/** 除了 except 之外第一个已配置的服务（退出登录 / 清除 Key 后切过去） */
function firstConfigured(s: S, except: ProviderId): ProviderId {
  return (PROVIDERS.find((p) => p.id !== except && s.providers[p.id]?.key)?.id ?? 'gemini') as ProviderId
}

/** 填 API Key：自动识别是哪家，识别不出来再让用户选 */
function KeyCard({ s, update }: { s: S; update: Upd }) {
  const i = useI18n()
  const { t } = i
  const info = providerInfo(s.provider)
  const keyBased = info.id !== 'chatgpt'
  const conf = keyBased ? s.providers[info.id] : undefined
  const [key, setKey] = useState('')
  const [base, setBase] = useState(info.id === 'custom' ? (conf?.baseUrl ?? '') : '')
  const [showBase, setShowBase] = useState(info.id === 'custom')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok'; text: string } | { kind: 'ask' } | { kind: 'err'; text: string } | null>(null)
  const [choice, setChoice] = useState<ProviderId>('openai')
  const [sources, setSources] = useState<OpenAISource[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const importRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.lens.openaiSources().then(setSources)
  }, [i.lang])
  useEffect(() => {
    if (!importOpen) return
    const away = (e: MouseEvent) => {
      if (importRef.current && !importRef.current.contains(e.target as Node)) setImportOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [importOpen])

  const save = async (id: ProviderId, by?: MsgKey) => {
    const baseUrl = id === 'custom' ? base.trim() : ''
    await update({ provider: id, providers: { [id]: { key: key.trim(), baseUrl } } })
    setKey('')
    const name = i.provider(id)
    setResult({ kind: 'ok', text: by ? t('key.savedBy', { name, by: t(by) }) : t('key.savedAs', { name }) })
  }

  const submit = async () => {
    const k = key.trim()
    if (!k) return
    setBusy(true)
    setResult(null)
    try {
      // 填了接口地址：按地址判断（已知服务商的官方地址就归到那家，否则算自定义）
      if (showBase && base.trim()) {
        const id = providerForUrl(base.trim())
        return await save(id, id === 'custom' ? 'key.byCustom' : 'key.byUrl')
      }
      const r = await window.lens.detectKey(k)
      if (r.provider) return await save(r.provider, r.by === 'format' ? 'key.byFormat' : 'key.byProbe')
      setResult({ kind: 'ask' })
    } finally {
      setBusy(false)
    }
  }

  const importFrom = async (id: string) => {
    setImportOpen(false)
    await window.lens.openaiImport(id)
    setResult({ kind: 'ok', text: t('key.imported') })
  }

  const typed = key.trim()
  return (
    <div className="card stack conn">
      <div className="card-text">
        <div className="card-title">API Key</div>
        <div className="card-desc">{t('key.desc')}</div>
      </div>
      <div className="conn-fields">
        {keyBased && conf?.key && (
          <div className="key-current">
            <span className="prov-mark sm" style={{ background: info.color }}>
              {info.id === 'custom' ? <SlidersHorizontal size={11} /> : i.provider(info.id).slice(0, 1)}
            </span>
            {t('key.current', { name: i.provider(info.id) })}
            <span className="key-saved">
              <Check size={12} strokeWidth={3} /> {conf.key}
            </span>
            {info.id === 'custom' && conf.baseUrl && <span className="muted">· {hostOf(conf.baseUrl)}</span>}
            <button
              className="link danger"
              onClick={async () => {
                await update({ provider: firstConfigured(s, info.id), providers: { [info.id]: { key: '', model: '' } } })
                setResult(null)
              }}
            >
              {t('common.clear')}
            </button>
          </div>
        )}
        <input
          className="input mono"
          type="password"
          placeholder={conf?.key ? t('key.placeholderMore') : t('key.placeholder')}
          value={key}
          spellCheck={false}
          onChange={(e) => {
            setKey(e.target.value)
            setResult(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {showBase ? (
          <label className="field">
            <span className="field-label">
              {t('key.baseUrl')}
              <span className="muted">{t('key.baseUrlNote')}</span>
            </span>
            <input className="input" placeholder="https://…/v1" value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          </label>
        ) : (
          <button className="link inline left" onClick={() => setShowBase(true)}>
            {t('key.useBaseUrl')}
          </button>
        )}
        <AnimatePresence>
          {result && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="detect">
              {result.kind === 'ok' && (
                <span className="detect-ok">
                  <Check size={13} strokeWidth={3} /> {result.text}
                </span>
              )}
              {result.kind === 'ask' && (
                <div className="detect-ask">
                  <span>{t('key.ask')}</span>
                  <select className="input sel" value={choice} onChange={(e) => setChoice(e.target.value as ProviderId)}>
                    {KEY_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {i.provider(p.id)}
                      </option>
                    ))}
                    <option value="custom">{t('key.customOption')}</option>
                  </select>
                  <button
                    className="btn primary"
                    onClick={() => {
                      if (choice === 'custom' && !base.trim()) return setShowBase(true)
                      void save(choice, 'key.byManual')
                    }}
                  >
                    {t('common.save')}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="conn-actions">
          <button className="btn primary" disabled={!typed || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
            {busy ? t('key.detecting') : t('key.submit')}
          </button>
          {sources.length > 0 && (
            <div className="import" ref={importRef}>
              <button className="btn" onClick={() => setImportOpen((v) => !v)}>
                <Download size={15} /> {t('key.import')}
                <ChevronDown size={14} className={`chev${importOpen ? ' up' : ''}`} />
              </button>
              <AnimatePresence>
                {importOpen && (
                  <motion.div
                    className="select-pop import-pop"
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
                    transition={{ type: 'spring', stiffness: 560, damping: 36 }}
                  >
                    <div className="pop-label">{t('key.importLabel')}</div>
                    {sources.map((src) => (
                      <button key={src.id} className="select-item" disabled={!src.hasKey} onClick={() => void importFrom(src.id)}>
                        <span>{src.label}</span>
                        <span className="muted">{src.hasKey ? hostOf(src.baseURL) : t('key.noKey')}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 已保存的服务：点一下切换 */
function SavedServices({ s, update }: { s: S; update: Upd }) {
  const i = useI18n()
  const saved = PROVIDERS.filter((p) => s.providers[p.id]?.key)
  if (saved.length < 2) return null
  return (
    <div className="saved">
      <span className="saved-label">{i.t('saved.label')}</span>
      {saved.map((p) => (
        <button key={p.id} className={`saved-chip${p.id === s.provider ? ' on' : ''}`} onClick={() => void update({ provider: p.id })}>
          <span className="prov-mark sm" style={{ background: p.color }}>
            {p.id === 'custom' ? <SlidersHorizontal size={11} /> : i.provider(p.id).slice(0, 1)}
          </span>
          {i.provider(p.id)}
          {s.providers[p.id]?.model && <span className="muted">· {s.providers[p.id]!.model}</span>}
        </button>
      ))}
    </div>
  )
}

/** 速度优先：小而快的模型打上标记 */
const FAST_HINT = /(mini|nano|flash|haiku|lite|air|turbo|spark|instant|luna)/i
/** 不能用来翻译的模型（向量、语音、绘图…），列表里默认不显示 */
const NON_CHAT = /(embed|tts|whisper|dall-?e|imagen|image-gen|-image|audio|realtime|moderation|transcri|rerank|sora|veo|speech|search-preview|aqa|live)/i

function money(v: number) {
  if (v < 0.01) return '<$0.01'
  return '$' + (v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toString())
}
function perM(v: number | null) {
  if (v == null) return '—'
  return '$' + (v >= 10 ? Math.round(v) : Number(v.toFixed(v >= 1 ? 2 : 3)))
}

/** 当前服务的模型列表（价格从低到高） */
function ModelList({ s, update }: { s: S; update: Upd }) {
  const i = useI18n()
  const { t } = i
  const info = providerInfo(s.provider)
  const conf = s.providers[info.id]
  const ready = !!conf?.key && (info.id !== 'custom' || !!conf.baseUrl)
  const plan = info.id === 'chatgpt'
  const [models, setModels] = useState<{ state: 'idle' | 'load' | 'ok' | 'fail'; list: ModelInfo[]; msg?: string }>({ state: 'idle', list: [] })
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)

  const load = useCallback(async () => {
    setModels((m) => ({ ...m, state: 'load' }))
    const r = await window.lens.listModels(info.id)
    setModels({ state: r.ok ? 'ok' : 'fail', list: r.models, msg: r.message })
  }, [info.id])

  // Key 变了（新填 / 换了）就重新拉一次
  useEffect(() => {
    if (ready) void load()
    else setModels({ state: 'idle', list: [] })
  }, [ready, conf?.key, conf?.baseUrl, load])

  const choose = (model: string) => update({ providers: { [info.id]: { model } } })
  const chat = models.list.filter((m) => !NON_CHAT.test(m.id))
  const needle = q.trim().toLowerCase()
  const shown = (all ? models.list : chat).filter((m) => m.id.toLowerCase().includes(needle))
  const hidden = models.list.length - chat.length
  // 推荐只用服务商目录里写好的；中转 / 自定义服务不知道哪些模型真能用，不推荐
  const pick = info.suggest.find((id) => models.list.some((m) => m.id === id))
  const manual = needle && !models.list.some((m) => m.id.toLowerCase() === needle) ? q.trim() : ''

  return (
    <>
      <h3 className="h3 row">
        {t('models.title')}
        <span className="muted">
          · {i.provider(info.id)} · {t('models.current', { model: conf?.model || t('models.none') })}
        </span>
        {ready && (
          <div className="search">
            <Search size={13} />
            <input
              placeholder={t('models.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manual && void choose(manual)}
              spellCheck={false}
            />
          </div>
        )}
        {ready && (
          <button className="link" onClick={() => void load()} disabled={models.state === 'load'}>
            <RefreshCw size={12} className={models.state === 'load' ? 'spin' : ''} /> {t('common.refresh')}
          </button>
        )}
      </h3>

      {!ready ? (
        <div className="empty-models">
          <KeyRound size={20} />
          <span>{t('models.empty')}</span>
        </div>
      ) : models.state === 'load' && !models.list.length ? (
        <div className="empty-models">
          <Loader2 size={18} className="spin" />
          <span>{t('models.loading')}</span>
        </div>
      ) : (
        <>
          {models.state === 'fail' && <div className="note err">{t('models.failed', { msg: models.msg ?? '' })}</div>}
          {(models.list.length > 0 || manual) && (
            <div className="price-list">
              <div className="price-head">
                <span />
                <span>{t('models.col')}</span>
                <span className="r">{plan ? '' : t('models.colPrice')}</span>
                <span className="r">{plan ? t('models.colPlan') : t('models.colPer')}</span>
              </div>
              <div className="price-body">
                {manual && (
                  <button className="price-row" onClick={() => void choose(manual)}>
                    <span className="radio" />
                    <span className="pm-name">
                      <span className="pm-id">{t('models.useManual', { m: manual })}</span>
                    </span>
                    <span className="pm-io r muted">{t('models.manual')}</span>
                    <span className="pm-call r">—</span>
                  </button>
                )}
                {shown.map((m, n) => (
                  <motion.button
                    key={m.id}
                    className={`price-row${m.id === conf?.model ? ' on' : ''}`}
                    onClick={() => void choose(m.id)}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(n * 0.015, 0.25), duration: 0.22 }}
                  >
                    <span className="radio">{m.id === conf?.model && <motion.span layoutId="model-dot" className="radio-dot" />}</span>
                    <span className="pm-name">
                      <span className="pm-id">{m.id}</span>
                      {m.id === pick && <span className="tag rec">{t('models.rec')}</span>}
                      {FAST_HINT.test(m.id) && <span className="tag fast">{t('models.fast')}</span>}
                      {m.vision === false && (
                        <span className="tag text" title={t('models.textOnlyTip')}>
                          {t('models.textOnly')}
                        </span>
                      )}
                    </span>
                    <span className="pm-io r">{plan ? '' : m.input == null ? <span className="muted">{t('models.unknownPrice')}</span> : `${perM(m.input)} / ${perM(m.output)}`}</span>
                    <span className="pm-call r">{plan ? <span className="muted">{t('models.plan')}</span> : m.perCall == null ? '—' : money(m.perCall * 1000)}</span>
                  </motion.button>
                ))}
                {!shown.length && !manual && <div className="empty-row">{q ? t('models.noMatch') : t('models.noneReturned')}</div>}
              </div>
            </div>
          )}
          <div className="note">
            {plan ? t('models.notePlan') : t('models.notePrice')}
            {hidden > 0 && (
              <button className="link inline" onClick={() => setAll((v) => !v)}>
                {all ? t('models.hideHidden', { n: hidden }) : t('models.showHidden', { n: hidden })}
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}

const TAG_KEY = { 免费额度: 'tag.free', 国内直连: 'tag.cn', 需要代理: 'tag.proxy', 聚合: 'tag.agg' } as const
const TAG_CLASS = { 免费额度: 'free', 国内直连: 'cn', 需要代理: 'proxy', 聚合: 'agg' } as const

/** 还没有 Key：各家获取方式 */
function KeyGuides() {
  const i = useI18n()
  const [open, setOpen] = useState<ProviderId | null>(null)
  return (
    <>
      <h3 className="h3">{i.t('guides.title')}</h3>
      <div className="guide-list">
        {KEY_PROVIDERS.map((p) => {
          const text = i.providerText(p.id)
          // 「国内直连 / 需要代理」只对国内网络有意义
          const tags = p.tags.filter((g) => i.zh || (g !== '国内直连' && g !== '需要代理'))
          return (
            <div key={p.id} className={`guide-row${open === p.id ? ' open' : ''}`}>
              <button className="guide-row-head" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <span className="prov-mark" style={{ background: p.color }}>
                  {i.provider(p.id).slice(0, 1)}
                </span>
                <span className="gr-name">{i.provider(p.id)}</span>
                <span className="gr-blurb">{text.blurb}</span>
                <span className="guide-tags">
                  {tags.map((g) => (
                    <span key={g} className={`tag ${TAG_CLASS[g]}`}>
                      {i.t(TAG_KEY[g])}
                    </span>
                  ))}
                </span>
                <ChevronDown size={15} className="chev" />
              </button>
              <AnimatePresence initial={false}>
                {open === p.id && (
                  <motion.div className="guide-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}>
                    <ol className="guide-steps">
                      {text.steps.map((step, n) => (
                        <li key={n}>
                          <span className="step-n">{n + 1}</span>
                          {step}
                        </li>
                      ))}
                    </ol>
                    {text.tip && <div className="guide-tip">{text.tip}</div>}
                    <button className="btn primary" onClick={() => window.lens.openExternal(p.keyUrl)}>
                      <ExternalLink size={15} /> {text.link}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </>
  )
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ------------------------------------------------------------------ 通用
function GeneralPage({ s, update }: { s: S; update: (p: SettingsPatch) => void }) {
  const { t } = useI18n()
  const known = UI_LANGS.some((l) => l.code === s.uiLang)
  return (
    <>
      <h2>{t('gen.title')}</h2>
      <Card title={t('gen.hotkey')} desc={t('gen.hotkeyDesc')} icon={<Keyboard size={18} />}>
        <HotkeyInput value={s.hotkey} />
      </Card>
      <Card title={t('gen.uiLang')} desc={t('gen.uiLang') === 'Language' ? undefined : 'Language'} icon={<Globe size={18} />}>
        <Select
          value={known ? s.uiLang : 'auto'}
          options={[{ value: 'auto', label: t('tray.langSystem') }, ...UI_LANGS.map((l) => ({ value: l.code, label: l.native }))]}
          onChange={(v) => update({ uiLang: v })}
        />
      </Card>
      <Card title={t('gen.launch')} desc={t('gen.launchDesc')} icon={<Power size={18} />}>
        <Toggle on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
      </Card>
    </>
  )
}

function HotkeyInput({ value }: { value: string }) {
  const { t } = useI18n()
  const [rec, setRec] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!rec) return
    void window.lens.suspendHotkey(true)
    const down = async (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setRec(false)
        return
      }
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
      const key = keyName(e.code)
      setDraft(key ? [...mods, key] : mods)
      if (!key) return
      if (!mods.length && !/^F\d+$/.test(key)) {
        setErr('hotkey.needMod')
        return
      }
      const acc = [...mods, key].join('+')
      const r = await window.lens.setHotkey(acc)
      setErr(r.ok ? '' : (r.message ?? 'hotkey.failed'))
      if (r.ok) setRec(false)
    }
    window.addEventListener('keydown', down)
    return () => {
      window.removeEventListener('keydown', down)
      void window.lens.suspendHotkey(false)
    }
  }, [rec])

  const keys = rec ? draft : value.split('+')
  return (
    <div className="hotkey-wrap">
      <button
        className={`hotkey${rec ? ' rec' : ''}`}
        onClick={() => {
          setDraft([])
          setErr('')
          setRec((v) => !v)
        }}
      >
        {keys.length ? (
          keys.map((k, n) => (
            <motion.span key={k + n} className="keycap sm" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
              {k}
            </motion.span>
          ))
        ) : (
          <span className="muted">{t('hotkey.press')}</span>
        )}
      </button>
      <span className={`hk-hint${err ? ' err' : ''}`}>{err ? (err.startsWith('hotkey.') ? t(err as MsgKey) : err) : rec ? t('hotkey.escCancel') : t('hotkey.clickToRecord')}</span>
    </div>
  )
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  const map: Record<string, string> = {
    Space: 'Space',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    PrintScreen: 'PrintScreen',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  return map[code] ?? null
}

// ------------------------------------------------------------------ 关于
function About({ s, update, version, ocr }: { s: S; update: (p: SettingsPatch) => void; version: string; ocr: string }) {
  const i = useI18n()
  const { t } = i
  const [u, setU] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    void window.lens.updateState().then(setU)
    return window.lens.onUpdate(setU)
  }, [])
  const check = async () => {
    setChecking(true)
    setU(await window.lens.updateCheck())
    setChecking(false)
  }
  const busy = checking || u?.state === 'checking'
  return (
    <>
      <h2>{t('about.title')}</h2>
      <section className="about">
        <img src="./icon.png" alt="" />
        <div>
          <div className="about-name">LavaTranslate</div>
          <div className="muted">{t('about.version', { v: version })}</div>
        </div>
      </section>

      <div className={`update-card ${u?.state ?? 'idle'}`}>
        <span className="update-icon">
          {u?.state === 'ready' ? <Check size={18} strokeWidth={2.6} /> : u?.state === 'downloading' || u?.state === 'available' || busy ? <Loader2 size={18} className="spin" /> : <RefreshCw size={17} />}
        </span>
        <div className="card-text">
          <div className="card-title">{updateTitle(u, busy, i)}</div>
          <div className="card-desc">{updateDesc(u, i)}</div>
          <AnimatePresence>
            {(u?.state === 'downloading' || u?.state === 'available') && (
              <motion.div className="update-bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <motion.div className="update-fill" animate={{ width: `${Math.max(3, u.percent)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {u?.state === 'ready' ? (
          <button className="btn primary" onClick={() => window.lens.updateInstall()}>
            {t('about.restart')}
          </button>
        ) : (
          <button className="btn" disabled={busy || u?.state === 'disabled' || u?.state === 'downloading'} onClick={() => void check()}>
            {t('about.check')}
          </button>
        )}
      </div>
      <Card title={t('about.autoUpdate')} desc={t('about.autoUpdateDesc')} icon={<Download size={18} />}>
        <Toggle on={s.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
      </Card>

      <h3 className="h3">{t('about.tech')}</h3>
      <Card title={t('about.translate')} desc={t('about.translateDesc')} />
      <Card title={t('about.ocr')} desc={t('about.ocrDesc', { ocr: ocr || 'ONNX Runtime' })} />
      <Card title={t('about.privacy')} desc={t('about.privacyDesc')} />
    </>
  )
}

function updateShort(u: UpdateState | null, { t }: I18n) {
  switch (u?.state) {
    case 'ready':
      return t('upd.short.ready', { v: u.next })
    case 'available':
    case 'downloading':
      return t('upd.short.downloading', { p: u.percent })
    case 'checking':
      return t('upd.short.checking')
    case 'latest':
      return t('upd.short.latest')
    case 'error':
      return t('upd.short.error')
    case 'disabled':
      return t('upd.short.dev')
    default:
      return t('upd.short.idle')
  }
}

function updateTitle(u: UpdateState | null, busy: boolean, { t }: I18n) {
  if (busy) return t('upd.title.checking')
  switch (u?.state) {
    case 'latest':
      return t('upd.title.latest')
    case 'available':
    case 'downloading':
      return t('upd.title.downloading', { v: u.next })
    case 'ready':
      return t('upd.title.ready', { v: u.next })
    case 'error':
      return t('upd.title.error')
    case 'disabled':
      return t('upd.title.disabled')
    default:
      return t('upd.title.idle')
  }
}

function updateDesc(u: UpdateState | null, { t }: I18n) {
  switch (u?.state) {
    case 'available':
    case 'downloading':
      return t('upd.desc.downloading', { p: u.percent })
    case 'ready':
      return t('upd.desc.ready')
    case 'error':
    case 'disabled':
      return u.message
    case 'latest':
      return u.message ?? t('upd.desc.latest')
    default:
      return t('upd.desc.idle')
  }
}

// ------------------------------------------------------------------ 组件
function Card({ title, desc, icon, children, stack }: { title: string; desc?: string; icon?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`card${stack ? ' stack' : ''}`}>
      {icon && <span className="card-icon">{icon}</span>}
      <div className="card-text">
        <div className="card-title">{title}</div>
        {desc && <div className="card-desc">{desc}</div>}
      </div>
      {children && <div className="card-ctl">{children}</div>}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <motion.span className="knob" layout transition={{ type: 'spring', stiffness: 700, damping: 35 }} />
    </button>
  )
}
