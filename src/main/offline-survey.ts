import { createHash, randomUUID } from 'node:crypto'
import { settings } from './settings'

export const OFFLINE_VOTES_URL = 'https://lavatranslate-offline-votes.cracker111.chatgpt.site/api/votes'
const CAMPAIGN = 'offline-1.13gb-v1'

export async function submitOfflineVote(): Promise<void> {
  if (settings.get().offlineSurveyDismissed) return
  let installation = settings.get().offlineSurveyId
  if (!installation) {
    installation = randomUUID()
    // Persist before the request so a lost response/retry cannot add a second vote.
    settings.update({ offlineSurveyId: installation })
  }
  const hour = Math.floor(Date.now() / 3600000)
  let nonce = 0
  for (; nonce <= 10000000; nonce++) {
    const proof = createHash('sha256').update(`${CAMPAIGN}:${installation}:${hour}:${nonce}`).digest()
    if (proof[0] === 0 && proof[1] === 0) break
    // Never block keyboard watchdog heartbeats while calculating the anonymous proof.
    if (nonce % 1000 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (nonce > 10000000) throw new Error('Vote proof unavailable')
  const response = await fetch(OFFLINE_VOTES_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation, hour, nonce }), signal: AbortSignal.timeout(10000), redirect: 'error'
  })
  if (!response.ok) throw new Error(`Vote request failed (${response.status})`)
  const result = await response.json() as { ok?: boolean; campaign?: string }
  if (result.ok !== true || result.campaign !== CAMPAIGN) throw new Error('Unexpected vote response')
  settings.update({ offlineSurveyDismissed: true })
}
