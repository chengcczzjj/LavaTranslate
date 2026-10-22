// 凭据存储：Mac 使用当前用户可读的本地配置；Windows 保持 safeStorage 加密。界面只拿到打码值。
import { safeStorage } from 'electron'

const ENC = 'enc:'
const isMac = process.platform === 'darwin'
// Mac 按用户选择直接保存在本机配置，文件权限由 SettingsStore 限制为 0600。
// 旧版 enc: 内容保留但不访问钥匙串；需要用户重新填写，不能无密码解密。
export function secretLocked(stored: string): boolean {
  return isMac && stored.startsWith(ENC)
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (plain.startsWith(ENC)) return plain
  if (isMac) return plain
  if (!safeStorage.isEncryptionAvailable()) return plain
  return ENC + safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(ENC)) return stored
  if (isMac) return ''
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
