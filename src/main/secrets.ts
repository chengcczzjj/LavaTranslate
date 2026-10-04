// API Key 落盘加密：Windows 上由 DPAPI 绑定当前用户（Electron safeStorage）；界面只拿到打码后的形式
import { safeStorage } from 'electron'

const ENC = 'enc:'

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (plain.startsWith(ENC)) return plain
  if (!safeStorage.isEncryptionAvailable()) return plain
  return ENC + safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(ENC)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

/** 打码：•••• + 末 4 位 */
export function maskSecret(stored: string): string {
  const plain = decryptSecret(stored)
  return plain ? `•••• ${plain.slice(-4)}` : ''
}

export const isMasked = (v: string) => v.startsWith('••••')
