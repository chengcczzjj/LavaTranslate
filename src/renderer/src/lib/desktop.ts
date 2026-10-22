// Android 复用这些组件时仍保留 Ctrl；只有 Mac 桌面使用 Command。
export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
export const primaryKey = isMac ? 'Cmd' : 'Ctrl'
export const primaryModifier = (event: { ctrlKey: boolean; metaKey: boolean }) => event.ctrlKey || (isMac && event.metaKey)
export const shortcutLabel = (label: string) => isMac ? label.replace(/Ctrl/g, 'Cmd').replace(/Alt/g, 'Option').replace(/Super|Command/g, 'Cmd') : label
