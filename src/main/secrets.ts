// API Key 落盘加密：Electron safeStorage（Windows DPAPI / macOS Keychain）；界面只拿到打码后的形式
import { safeStorage } from 'electron'

const ENC = 'enc:'
const isMac = process.platform === 'darwin'
// macOS 启动与状态查询只读内存；钥匙串只在用户明确解锁或保存时异步访问。
const unlocked = new Map<string, string>()
const unlocking = new Map<string, Promise<void>>()
let recovery: 'failed' | 'timeout' | undefined

export function credentialRecovery() { return recovery }

/** Electron caches its macOS encryptor, including a denied Keychain lookup, for
 * the lifetime of the process. Retrying that instance cannot show a fresh prompt.
 * Bound the wait, discard late results, and let the user reopen the app to retry. */
async function macCrypto<T>(operation: () => Promise<T>): Promise<T> {
  if (recovery) throw new Error('MAC_KEYCHAIN_RESTART_REQUIRED')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        recovery = 'timeout'
        reject(new Error('MAC_KEYCHAIN_TIMEOUT'))
      }, 60_000)
    })
    const result = await Promise.race([operation(), timeout])
    // Another concurrent operation may already have failed or timed out.
    if (recovery) throw new Error('MAC_KEYCHAIN_RESTART_REQUIRED')
    return result
  } catch (error) {
    recovery ??= 'failed'
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function secretLocked(stored: string): boolean {
  return isMac && stored.startsWith(ENC) && !unlocked.has(stored)
}

export async function unlockSecret(stored: string): Promise<void> {
  if (!secretLocked(stored)) return
  let pending = unlocking.get(stored)
  if (!pending) {
    pending = macCrypto(() => safeStorage.decryptStringAsync(Buffer.from(stored.slice(ENC.length), 'base64')))
      .then(({ result }) => { unlocked.set(stored, result) })
      .finally(() => { unlocking.delete(stored) })
    unlocking.set(stored, pending)
  }
  await pending
}

export async function encryptSecretAsync(plain: string): Promise<string> {
  if (!isMac || !plain || plain.startsWith(ENC)) return encryptSecret(plain)
  // 失败时抛错，保留原配置，不把明文作为降级方案写入磁盘。
  const encrypted = ENC + (await macCrypto(() => safeStorage.encryptStringAsync(plain))).toString('base64')
  unlocked.set(encrypted, plain)
  return encrypted
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (plain.startsWith(ENC)) return plain
  if (isMac) throw new Error('macOS credentials must be saved with asynchronous encryption')
  if (!safeStorage.isEncryptionAvailable()) return plain
  return ENC + safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(ENC)) return stored
  if (isMac) return unlocked.get(stored) ?? ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

/** 打码：•••• + 末 4 位 */
export function maskSecret(stored: string): string {
  if (secretLocked(stored)) return '••••'
  const plain = decryptSecret(stored)
  return plain ? `•••• ${plain.slice(-4)}` : ''
}

export const isMasked = (v: string) => v.startsWith('••••')
