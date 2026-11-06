import { ThumbsUp, Loader2, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../lib/i18n'

export function OfflineSurvey({ dismissed }: { dismissed: boolean }) {
  const { t } = useI18n()
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (dismissed || hidden) return null
  const open = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      const result = await window.lens.openOfflineSurvey()
      if (result.ok) setHidden(true)
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return (
    <aside className="offline-survey" aria-label={t('offlineSurvey.title')}>
      <span className="offline-survey-icon"><WifiOff size={18} /></span>
      <div className="offline-survey-copy">
        <b>{t('offlineSurvey.title')}</b>
        <p>{t('offlineSurvey.desc')}</p>
        <small>{t('offlineSurvey.note')}</small>
        {failed && <span className="offline-survey-error" role="alert">{t('offlineSurvey.failed')}</span>}
      </div>
      <button className="btn" disabled={busy} onClick={() => void open()}>
        {busy ? <Loader2 size={14} className="spin" /> : <ThumbsUp size={14} />}
        {t('offlineSurvey.vote')}
      </button>
    </aside>
  )
}
