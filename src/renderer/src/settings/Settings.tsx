import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronDown,
  Columns2,
  Cpu,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  LayoutDashboard,
  ListOrdered,
  Loader2,
  MessageSquareReply,
  Power,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  LANGUAGES,
  PROVIDERS,
  providerInfo,
  type EngineStatus,
  type ModelInfo,
  type OpenAISource,
  type ProviderConfig,
  type ProviderId,
  type ProviderInfo,
  type Settings as S,
  type SettingsPatch,
  type UpdateState
} from '@shared/types'

type Page = 'home' | 'translate' | 'engine' | 'general' | 'about'

const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'home', label: '概览', icon: <LayoutDashboard size={17} /> },
  { id: 'translate', label: '翻译', icon: <Languages size={17} /> },
  { id: 'engine', label: '翻译服务', icon: <Sparkles size={17} /> },
  { id: 'general', label: '快捷键与启动', icon: <Keyboard size={17} /> },
  { id: 'about', label: '关于', icon: <Info size={17} /> }
]

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [ocr, setOcr] = useState('')
  const [version, setVersion] = useState('')

  const refreshStatus = useCallback(() => {
    void window.lens.engineStatus().then(setStatus)
  }, [])

  useEffect(() => {
    void window.lens.getSettings().then(setS)
    void window.lens.ocrInfo().then(setOcr)
    void window.lens.appInfo().then((i) => setVersion(i.version))
    refreshStatus()
    const off = window.lens.onSettings((n) => {
      setS(n)
      refreshStatus()
    })
    // 登录在外部终端完成，定期刷新状态
    const t = setInterval(refreshStatus, 2500)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refreshStatus])

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
            <button key={n.id} className={`nav-item${page === n.id ? ' on' : ''}`} onClick={() => setPage(n.id)}>
              {page === n.id && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          <div className="nav-foot">
            <span className={`dot ${status?.ok ? 'ok' : 'bad'}`} />
            {status?.ok ? '服务就绪' : '需要配置'}
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
function Home({ s, status, ocr, go }: { s: S; status: EngineStatus | null; ocr: string; go: (p: Page) => void }) {
  const target = LANGUAGES.find((l) => l.code === s.targetLang)
  const info = providerInfo(s.provider)
  const model = s.providers[s.provider]?.model
  return (
    <>
      <section className="hero">
        <div className="hero-glow" />
        <img className="hero-icon" src="./icon.png" alt="" />
        <h1>框选即译，原位呈现</h1>
        <p>按下快捷键，框选屏幕上任意区域。译文会按原来的排版直接覆盖在原文位置上。</p>
        <div className="hero-keys">
          {s.hotkey.split('+').map((k, i) => (
            <span key={i} className="keycap-wrap">
              {i > 0 && <span className="plus">+</span>}
              <span className="keycap">{k}</span>
            </span>
          ))}
        </div>
        <button className="btn primary big" onClick={() => window.lens.startCapture()}>
          <Zap size={16} /> 立即试试
        </button>
      </section>

      <div className="tiles">
        <button className="tile" onClick={() => go('engine')}>
          <span className="tile-icon brand" style={{ background: info.color }}>
            {info.id === 'custom' ? <SlidersHorizontal size={17} /> : info.name.slice(0, 1)}
          </span>
          <span className="tile-title">{info.name}</span>
          <span className="tile-sub">{status?.ok ? '翻译服务 · 已就绪' : (status?.detail ?? '检查中…')}</span>
        </button>
        <button className="tile" onClick={() => go('engine')}>
          <span className="tile-icon violet">
            <Sparkles size={18} />
          </span>
          <span className="tile-title">{model || '未选择模型'}</span>
          <span className="tile-sub">翻译与回复使用的模型</span>
        </button>
        <button className="tile" onClick={() => go('translate')}>
          <span className="tile-icon blue">
            <Languages size={18} />
          </span>
          <span className="tile-title">{target?.name}</span>
          <span className="tile-sub">目标语言 · 自动识别原文</span>
        </button>
        <div className="tile">
          <span className="tile-icon teal">
            <Cpu size={18} />
          </span>
          <span className="tile-title">本地 OCR</span>
          <span className="tile-sub">{ocr || 'PP-OCRv6'}</span>
        </div>
      </div>

      {status && !status.ok && (
        <motion.div className="callout" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div>
            <b>还差一步</b>
            <span>{status.detail}。选一个翻译服务、填好 API Key、选好模型就能开始翻译；设置页里有获取 Key 的步骤和链接。</span>
          </div>
          <button className="btn primary" onClick={() => go('engine')}>
            去配置
          </button>
        </motion.div>
      )}

      <h3 className="h3">截图界面里</h3>
      <div className="shortcuts">
        {[
          ['单击', '选中鼠标下的窗口'],
          ['Space', '按住查看原文'],
          ['Tab', '切换 覆盖 / 并排'],
          ['单击译文', '复制该段译文'],
          ['Ctrl C', '复制全部译文'],
          ['Ctrl Shift C', '复制为图片'],
          ['F3', '钉在桌面'],
          ['Enter / 双击', '复制译文并关闭'],
          ['R', '用自己的语言回复对方'],
          ['右键', '重新框选'],
          ['Esc', '退出']
        ].map(([k, d]) => (
          <div key={k} className="sc">
            <kbd>{k}</kbd>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ 翻译
function TranslatePage({ s, update }: { s: S; update: (p: SettingsPatch) => void }) {
  const [hint, setHint] = useState(s.styleHint)
  useEffect(() => setHint(s.styleHint), [s.styleHint])
  return (
    <>
      <h2>翻译</h2>
      <Card title="默认目标语言" desc="截图界面的工具条里也可以随时切换，会记住你上次的选择">
        <LangSelect value={s.targetLang} onChange={(v) => update({ targetLang: v })} />
      </Card>
      <Card stack title="显示方式" desc="截图界面里按 Tab 随时切换">
        <div className="mode-cards">
          <ModeCard on={s.displayMode === 'overlay'} onClick={() => update({ displayMode: 'overlay' })} icon={<Layers size={16} />} title="原位覆盖" desc="译文直接替换原文，排版一致">
            <div className="mini">
              <div className="mini-shot">
                <i className="t1 tr" />
                <i className="t2 tr" />
                <i className="t3 tr" />
              </div>
            </div>
          </ModeCard>
          <ModeCard on={s.displayMode === 'side'} onClick={() => update({ displayMode: 'side' })} icon={<Columns2 size={16} />} title="并排对照" desc="原图保留，旁边显示同排版译文">
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
      <Card
        title="回复助手"
        desc="看懂对方的消息后，直接用你的语言写回复，实时译成对方的语言，Enter 复制即可去发送。开启后，翻译的是聊天、私信、评论、邮件这类对话时自动打开回复框；任何时候都可以在截图界面按 R 打开"
        icon={<MessageSquareReply size={18} />}
      >
        <Toggle on={s.replyAssist} onChange={(v) => update({ replyAssist: v })} />
      </Card>
      <Card stack title="翻译偏好" desc="告诉模型你的习惯，例如术语、语气、领域，会附加到每次翻译中">
        <textarea
          className="input area"
          value={hint}
          placeholder="例如：游戏里的技能名保留英文；语气口语化一些；IT 术语用业内常见译法"
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

function LangSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = LANGUAGES.find((l) => l.code === value)
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  return (
    <div className="select" ref={ref}>
      <button className={`select-btn${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span>{cur?.name}</span>
        {cur && cur.native !== cur.name && <span className="muted">{cur.native}</span>}
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
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                className={`select-item${l.code === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(l.code)
                  setOpen(false)
                }}
              >
                <span>{l.name}</span>
                {l.native !== l.name && <span className="muted">{l.native}</span>}
                {l.code === value && <Check size={14} />}
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
  const [test, setTest] = useState<{ state: 'idle' | 'run' | 'ok' | 'fail'; msg?: string }>({ state: 'idle' })

  const runTest = async () => {
    setTest({ state: 'run' })
    const r = await window.lens.testEngine()
    setTest({ state: r.ok ? 'ok' : 'fail', msg: r.message })
    refresh()
  }

  const pick = (id: ProviderId) => {
    if (id === s.provider) return
    setTest({ state: 'idle' })
    void update({ provider: id })
  }

  return (
    <>
      <h2>翻译服务</h2>
      <div className={`status-bar${status?.ok ? ' ok' : ''}`}>
        <span className={`dot big ${status?.ok ? 'ok' : 'bad'}`} />
        <span className="status-text">{status?.detail ?? '检查中…'}</span>
        <button className="btn primary" disabled={test.state === 'run' || !status?.ok} onClick={runTest}>
          {test.state === 'run' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />} 测试翻译
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

      <div className="prov-grid">
        {PROVIDERS.map((p) => {
          const on = p.id === s.provider
          const ready = !!s.providers[p.id]?.key
          return (
            <button key={p.id} className={`prov${on ? ' on' : ''}`} onClick={() => pick(p.id)}>
              {on && <motion.span layoutId="prov-ring" className="prov-ring" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <span className="prov-mark" style={{ background: p.color }}>
                {p.id === 'custom' ? <SlidersHorizontal size={14} /> : p.name.slice(0, 1)}
              </span>
              <span className="prov-name">
                {p.name}
                {ready && <span className="prov-ready" title="已填写 Key" />}
              </span>
              <span className="prov-blurb">{p.blurb}</span>
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={s.provider}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <ProviderPanel s={s} update={update} info={providerInfo(s.provider)} />
        </motion.div>
      </AnimatePresence>
    </>
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

function ProviderPanel({ s, update, info }: { s: S; update: Upd; info: ProviderInfo }) {
  const conf = s.providers[info.id] ?? { key: '', baseUrl: '', model: '' }
  const hasKey = !!conf.key
  const custom = info.id === 'custom'
  const [key, setKey] = useState('')
  const [base, setBase] = useState(conf.baseUrl)
  const [showBase, setShowBase] = useState(custom || !!conf.baseUrl)
  const [guide, setGuide] = useState(!hasKey)
  const [sources, setSources] = useState<OpenAISource[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [models, setModels] = useState<{ state: 'idle' | 'load' | 'ok' | 'fail'; list: ModelInfo[]; msg?: string }>({ state: 'idle', list: [] })
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const importRef = useRef<HTMLDivElement>(null)

  useEffect(() => setBase(conf.baseUrl), [conf.baseUrl])
  useEffect(() => {
    if (custom) void window.lens.openaiSources().then(setSources)
  }, [custom])
  useEffect(() => {
    if (!importOpen) return
    const away = (e: MouseEvent) => {
      if (importRef.current && !importRef.current.contains(e.target as Node)) setImportOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [importOpen])

  const loadModels = useCallback(async () => {
    setModels((m) => ({ ...m, state: 'load' }))
    const r = await window.lens.listModels(info.id)
    setModels({ state: r.ok ? 'ok' : 'fail', list: r.models, msg: r.message })
  }, [info.id])

  // 有 Key 时自动拉一次模型列表
  useEffect(() => {
    if (hasKey && (!custom || conf.baseUrl)) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const typed = key.trim()
  const keyWarn = typed && info.keyHint && !typed.startsWith(info.keyHint) ? `${info.name} 的 Key 一般以 ${info.keyHint} 开头，确认一下有没有复制错` : ''
  const dirty = !!typed || base.trim() !== conf.baseUrl
  const canSave = (dirty || hasKey) && (!custom || !!base.trim())

  const save = async () => {
    if (!canSave) return
    const patch: Partial<ProviderConfig> = { baseUrl: base.trim() }
    if (typed) patch.key = typed
    await update({ provider: info.id, providers: { [info.id]: patch } })
    setKey('')
    setGuide(false)
    void loadModels()
  }

  const importFrom = async (id: string) => {
    setImportOpen(false)
    await window.lens.openaiImport(id)
    setKey('')
    void loadModels()
  }

  const choose = (model: string) => update({ provider: info.id, providers: { [info.id]: { model } } })

  const chat = models.list.filter((m) => !NON_CHAT.test(m.id))
  const needle = q.trim().toLowerCase()
  const shown = (all ? models.list : chat).filter((m) => m.id.toLowerCase().includes(needle))
  const hidden = models.list.length - chat.length
  // 推荐：服务商目录里的推荐模型优先，否则取名字像快模型里最便宜的那个
  const pick =
    info.suggest.find((id) => models.list.some((m) => m.id === id)) ?? chat.find((m) => m.perCall != null && FAST_HINT.test(m.id))?.id
  const manual = needle && !models.list.some((m) => m.id.toLowerCase() === needle) ? q.trim() : ''

  return (
    <>
      {info.keyUrl && (
        <div className={`guide${guide ? ' open' : ''}`}>
          <button className="guide-head" onClick={() => setGuide((v) => !v)}>
            <KeyRound size={15} />
            <span>如何获取 {info.name} 的 API Key</span>
            <span className="guide-tags">
              {info.tags.map((t) => (
                <span key={t} className={`tag ${t === '免费额度' ? 'free' : t === '国内直连' ? 'cn' : t === '需要代理' ? 'proxy' : 'agg'}`}>
                  {t}
                </span>
              ))}
            </span>
            <ChevronDown size={15} className="chev" />
          </button>
          <AnimatePresence initial={false}>
            {guide && (
              <motion.div className="guide-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }}>
                <ol className="guide-steps">
                  {info.steps.map((t, i) => (
                    <li key={i}>
                      <span className="step-n">{i + 1}</span>
                      {t}
                    </li>
                  ))}
                </ol>
                {info.tip && <div className="guide-tip">{info.tip}</div>}
                <button className="btn primary" onClick={() => window.lens.openExternal(info.keyUrl)}>
                  <ExternalLink size={15} /> {info.keyUrlLabel}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <div className="card stack conn">
        {custom && (
          <div className="card-text">
            <div className="card-title">自定义服务</div>
            <div className="card-desc">{info.tip}</div>
          </div>
        )}
        <div className="conn-fields">
          <label className="field">
            <span className="field-label">
              API Key
              {hasKey && (
                <span className="key-saved">
                  <Check size={12} strokeWidth={3} /> 已保存 {conf.key}
                </span>
              )}
            </span>
            <input
              className="input mono"
              type="password"
              placeholder={hasKey ? '输入新的 Key 可替换' : info.keyHint ? `${info.keyHint}…` : '粘贴 API Key'}
              value={key}
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
            {keyWarn && <span className="field-warn">{keyWarn}</span>}
          </label>
          {showBase ? (
            <label className="field">
              <span className="field-label">接口地址{!custom && <span className="muted">（留空使用官方地址）</span>}</span>
              <input
                className="input"
                placeholder={custom ? 'https://…/v1' : info.baseUrl || 'https://api.anthropic.com'}
                value={base}
                spellCheck={false}
                onChange={(e) => setBase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void save()}
              />
            </label>
          ) : (
            <button className="link inline left" onClick={() => setShowBase(true)}>
              使用中转或自定义接口地址
            </button>
          )}
          <div className="conn-actions">
            <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
              {models.state === 'load' ? <Loader2 size={15} className="spin" /> : <ListOrdered size={15} />}
              {dirty ? '保存并获取模型' : '获取模型列表'}
            </button>
            {custom && sources.length > 0 && (
              <div className="import" ref={importRef}>
                <button className="btn" onClick={() => setImportOpen((v) => !v)}>
                  <Download size={15} /> 从本机导入
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
                      <div className="pop-label">在本机找到的配置（Codex / CC Switch）</div>
                      {sources.map((src) => (
                        <button key={src.id} className="select-item" disabled={!src.hasKey} onClick={() => void importFrom(src.id)}>
                          <span>{src.label}</span>
                          <span className="muted">{src.hasKey ? hostOf(src.baseURL) : '没有 Key'}</span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
            {hasKey && (
              <button
                className="link danger"
                onClick={async () => {
                  await update({ providers: { [info.id]: { key: '', model: '' } } })
                  setModels({ state: 'idle', list: [] })
                  setGuide(true)
                }}
              >
                清除 Key
              </button>
            )}
          </div>
        </div>
      </div>

      <h3 className="h3 row">
        模型
        <span className="muted">· 当前 {conf.model || '未选择'}</span>
        {hasKey && (
          <div className="search">
            <Search size={13} />
            <input
              placeholder="搜索或输入模型名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manual && void choose(manual)}
              spellCheck={false}
            />
          </div>
        )}
        {hasKey && (
          <button className="link" onClick={() => void loadModels()} disabled={models.state === 'load'}>
            <RefreshCw size={12} className={models.state === 'load' ? 'spin' : ''} /> 刷新
          </button>
        )}
      </h3>

      {!hasKey ? (
        <div className="empty-models">
          <KeyRound size={20} />
          <span>填好 API Key 后，这里会列出 {info.name} 的全部模型，按价格从低到高排好</span>
        </div>
      ) : models.state === 'load' && !models.list.length ? (
        <div className="empty-models">
          <Loader2 size={18} className="spin" />
          <span>正在获取模型列表…</span>
        </div>
      ) : (
        <>
          {models.state === 'fail' && <div className="note err">获取模型列表失败：{models.msg}。也可以在上面的搜索框里直接输入模型名，回车使用。</div>}
          {(models.list.length > 0 || manual) && (
            <div className="price-list">
              <div className="price-head">
                <span />
                <span>模型</span>
                <span className="r">输入 / 输出 · 每百万 token</span>
                <span className="r">每千次截图约</span>
              </div>
              <div className="price-body">
                {manual && (
                  <button className="price-row" onClick={() => void choose(manual)}>
                    <span className="radio" />
                    <span className="pm-name">
                      <span className="pm-id">使用「{manual}」</span>
                    </span>
                    <span className="pm-io r muted">手动输入</span>
                    <span className="pm-call r">—</span>
                  </button>
                )}
                {shown.map((m, i) => (
                  <motion.button
                    key={m.id}
                    className={`price-row${m.id === conf.model ? ' on' : ''}`}
                    onClick={() => void choose(m.id)}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.015, 0.25), duration: 0.22 }}
                  >
                    <span className="radio">{m.id === conf.model && <motion.span layoutId="model-dot" className="radio-dot" />}</span>
                    <span className="pm-name">
                      <span className="pm-id">{m.id}</span>
                      {m.id === pick && <span className="tag rec">推荐</span>}
                      {FAST_HINT.test(m.id) && <span className="tag fast">快</span>}
                      {m.vision === false && (
                        <span className="tag text" title="不能看图，只用本地 OCR 的文字翻译，识别纠错能力弱一些">
                          仅文字
                        </span>
                      )}
                    </span>
                    <span className="pm-io r">{m.input == null ? <span className="muted">价格未知</span> : `${perM(m.input)} / ${perM(m.output)}`}</span>
                    <span className="pm-call r">{m.perCall == null ? '—' : money(m.perCall * 1000)}</span>
                  </motion.button>
                ))}
                {!shown.length && !manual && <div className="empty-row">{q ? '没有匹配的模型' : '服务商没有返回模型'}</div>}
              </div>
            </div>
          )}
          <div className="note">
            价格来自 models.dev 的公开数据（按官方价），中转服务的实际计费以服务商为准。每次截图约按 1500 输入 + 700 输出 token 估算。
            {hidden > 0 && (
              <button className="link inline" onClick={() => setAll((v) => !v)}>
                {all ? '隐藏' : '显示'}其余 {hidden} 个非对话模型
              </button>
            )}
          </div>
        </>
      )}
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
  return (
    <>
      <h2>快捷键与启动</h2>
      <Card title="截图翻译快捷键" desc="在任何地方按下即可开始框选" icon={<Keyboard size={18} />}>
        <HotkeyInput value={s.hotkey} />
      </Card>
      <Card title="开机自动启动" desc="登录 Windows 后在托盘后台运行" icon={<Power size={18} />}>
        <Toggle on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
      </Card>
    </>
  )
}

function HotkeyInput({ value }: { value: string }) {
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
        setErr('请至少包含一个修饰键（Ctrl / Alt / Shift）')
        return
      }
      const acc = [...mods, key].join('+')
      const r = await window.lens.setHotkey(acc)
      setErr(r.ok ? '' : r.message ?? '设置失败')
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
          keys.map((k, i) => (
            <motion.span key={k + i} className="keycap sm" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
              {k}
            </motion.span>
          ))
        ) : (
          <span className="muted">按下新的组合键…</span>
        )}
      </button>
      <span className={`hk-hint${err ? ' err' : ''}`}>{err || (rec ? '按 Esc 取消' : '点击后录制')}</span>
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
      <h2>关于</h2>
      <section className="about">
        <img src="./icon.png" alt="" />
        <div>
          <div className="about-name">LavaTranslate</div>
          <div className="muted">版本 {version}</div>
        </div>
      </section>

      <div className={`update-card ${u?.state ?? 'idle'}`}>
        <span className="update-icon">
          {u?.state === 'ready' ? <Check size={18} strokeWidth={2.6} /> : u?.state === 'downloading' || u?.state === 'available' || busy ? <Loader2 size={18} className="spin" /> : <RefreshCw size={17} />}
        </span>
        <div className="card-text">
          <div className="card-title">{updateTitle(u, busy)}</div>
          <div className="card-desc">{updateDesc(u)}</div>
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
            重启并更新
          </button>
        ) : (
          <button className="btn" disabled={busy || u?.state === 'disabled' || u?.state === 'downloading'} onClick={() => void check()}>
            检查更新
          </button>
        )}
      </div>
      <Card title="自动更新" desc="后台从 GitHub 下载新版本，下次启动时自动安装" icon={<Download size={18} />}>
        <Toggle on={s.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
      </Card>

      <h3 className="h3">技术</h3>
      <Card title="翻译" desc="大模型（Gemini、OpenAI、DeepSeek、Claude 等，用你自己的 Key）结合截图画面纠正识别错误、合并段落、判断哪些内容不用翻，并按原排版回填" />
      <Card title="文字识别" desc={`PaddleOCR PP-OCRv6 · 本地运行 · ${ocr || 'ONNX Runtime'}`} />
      <Card title="隐私" desc="截图只在本机做文字识别；只有你框选的区域会发给你配置的翻译服务，不保存任何会话记录" />
    </>
  )
}

function updateTitle(u: UpdateState | null, busy: boolean) {
  if (busy) return '正在检查更新…'
  switch (u?.state) {
    case 'latest':
      return '已是最新版本'
    case 'available':
    case 'downloading':
      return `正在下载 v${u.next}`
    case 'ready':
      return `v${u.next} 已就绪`
    case 'error':
      return '检查更新失败'
    case 'disabled':
      return '自动更新不可用'
    default:
      return '软件更新'
  }
}

function updateDesc(u: UpdateState | null) {
  switch (u?.state) {
    case 'available':
    case 'downloading':
      return `${u.percent}% · 下载完成后提示你重启`
    case 'ready':
      return '重启一下就能用上新版本，也可以等下次启动时自动安装'
    case 'error':
    case 'disabled':
      return u.message
    case 'latest':
      return u.message ?? '每 4 小时自动检查一次'
    default:
      return '从 GitHub Releases 获取新版本'
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
