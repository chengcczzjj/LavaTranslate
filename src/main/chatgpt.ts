// 用 ChatGPT 账号登录（OpenAI 为开源、本地运行的软件提供的「使用 ChatGPT 会员额度」方式）
// 流程：PKCE + 本机回调地址 → 浏览器登录 → 用授权码换令牌 → 校验 ID Token → 之后用 access token 调用 Responses API
// 文档：https://developers.openai.com/siwc/token-sharing-open-source/sign-in
import { net, shell } from 'electron'
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const JWKS = `${ISSUER}/.well-known/jwks.json`
const RESOURCE = 'https://api.openai.com/v1'
/** 使用会员额度的权限；只有带上它的令牌才能调用模型 */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const LOGIN_TIMEOUT = 5 * 60_000

export interface ChatGPTSession {
  subject: string
  email?: string
  /** 第一次登录时签发的 oaiapp_…，之后重新登录沿用 */
  clientId: string
  hostId: string
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

const b64url = (b: Buffer) => b.toString('base64url')

function decodeJwt(jwt: string) {
  const [h, p, sig] = jwt.split('.')
  if (!h || !p || !sig) throw new Error('ID Token 格式不对')
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()), signed: `${h}.${p}`, sig }
}

/** 校验 ID Token：签名（OpenAI 公开的 JWKS）、签发方、接收方、有效期、nonce */
async function verifyIdToken(idToken: string, clientId: string, nonce?: string) {
  const { header, payload, signed, sig } = decodeJwt(idToken)
  if (header.alg !== 'RS256') throw new Error(`不支持的签名算法 ${header.alg}`)
  const res = await net.fetch(JWKS)
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] }
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('找不到 ID Token 的签名公钥')
  const ok = verify('RSA-SHA256', Buffer.from(signed), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))
  if (!ok) throw new Error('ID Token 签名无效')
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (payload.iss !== ISSUER) throw new Error('ID Token 签发方不对')
  if (!aud.includes(clientId)) throw new Error('ID Token 接收方不对')
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now() - 60_000) throw new Error('ID Token 已过期')
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error('ID Token 的 nonce 不匹配')
  return payload as { sub: string; email?: string }
}

async function tokenRequest(form: Record<string, string>) {
  const res = await net.fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok) throw new Error(json.error_description ?? json.error ?? `登录服务返回 ${res.status}`)
  return json as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f3f8;color:#222}
div{padding:36px 44px;border-radius:18px;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center}h1{font-size:20px;margin:0 0 8px}</style>
<div><h1>${title}</h1><p>${body}</p></div>`

let pending: { server: Server; reject: (e: Error) => void } | null = null

/** 取消正在进行的登录（关闭本机回调地址） */
export function cancelSignIn() {
  if (!pending) return
  pending.server.close()
  pending.reject(new Error('已取消登录'))
  pending = null
}

/** 打开浏览器登录；previous 为之前的登录信息（沿用已签发的 client_id） */
export async function signIn(hostId: string, previous: ChatGPTSession | null): Promise<ChatGPTSession> {
  cancelSignIn()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const nonce = b64url(randomBytes(16))
  const firstClient = previous?.clientId ?? 'dynamic_agent_client'

  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`

  const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('登录超时，请重试')), LOGIN_TIMEOUT)
    pending = { server, reject }
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirect)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const q = url.searchParams
      const fail = (msg: string) => {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('登录没有完成', msg))
        clearTimeout(timer)
        reject(new Error(msg))
      }
      if (q.get('state') !== state) return fail('登录状态校验失败，请回到 LavaTranslate 重试。')
      if (q.get('error')) return fail(q.get('error') === 'access_denied' ? '你取消了授权。' : `登录出错：${q.get('error')}`)
      const code = q.get('code')
      const clientId = q.get('client_id') ?? (firstClient === 'dynamic_agent_client' ? '' : firstClient)
      if (!code || !clientId) return fail('登录返回的信息不完整，请重试。')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('登录成功', '可以关闭这个页面，回到 LavaTranslate 了。'))
      clearTimeout(timer)
      resolve({ code, clientId })
    })
  })

  const params = new URLSearchParams({
    client_id: firstClient,
    agent_name_hint: 'LavaTranslate',
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge
  })
  if (previous?.idToken) params.set('id_token_hint', previous.idToken)
  if (previous?.email) params.set('login_hint', previous.email)
  await shell.openExternal(`${AUTHORIZE}?${params}`)

  try {
    const { code, clientId } = await callback
    const tok = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE })
    if (!tok.id_token || !tok.refresh_token) throw new Error('登录服务没有返回完整的令牌')
    const claims = await verifyIdToken(tok.id_token, clientId, nonce)
    const scopes = (tok.scope ?? '').split(/\s+/).filter(Boolean)
    if (!scopes.includes(PLAN_SCOPE)) throw new Error('没有获得使用会员额度的授权：需要 ChatGPT Plus / Pro，并在授权页允许使用会员额度')
    return {
      subject: claims.sub,
      email: claims.email,
      clientId,
      hostId,
      idToken: tok.id_token,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
      scopes
    }
  } finally {
    server.close()
    pending = null
  }
}

/** 刷新令牌（refresh token 每次都会换新，三者一起替换） */
export async function refresh(s: ChatGPTSession): Promise<ChatGPTSession> {
  const tok = await tokenRequest({ grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE })
  return {
    ...s,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? s.refreshToken,
    idToken: tok.id_token ?? s.idToken,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    scopes: tok.scope ? tok.scope.split(/\s+/).filter(Boolean) : s.scopes
  }
}

/** ChatGPT 账号可用的模型：只保留 visibility 为 list 的，用 slug 作为模型名 */
export async function listPlanModels(accessToken: string): Promise<string[]> {
  const res = await net.fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } })
  const json = (await res.json().catch(() => ({}))) as { data?: any[]; models?: any[]; error?: { message?: string } }
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
  return (json.data ?? json.models ?? []).filter((m) => !m.visibility || m.visibility === 'list').map((m) => String(m.slug ?? m.id))
}
