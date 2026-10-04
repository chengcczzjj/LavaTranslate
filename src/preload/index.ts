import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CaptureFrame,
  EngineStatus,
  ModelInfo,
  OpenAISource,
  ReplyEvent,
  ReplyStartMsg,
  UpdateState,
  PinPayload,
  ProviderId,
  Rect,
  Settings,
  SettingsPatch,
  TranslateEvent,
  TranslateRequestMsg
} from '../shared/types'

function on<T>(channel: string, cb: (data: T) => void) {
  const fn = (_e: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, fn)
  return () => {
    ipcRenderer.removeListener(channel, fn)
  }
}

const api = {
  // 遮罩
  onFrame: (cb: (f: CaptureFrame) => void) => on('overlay:frame', cb),
  onShown: (cb: () => void) => on('overlay:shown', cb),
  onReset: (cb: () => void) => on('overlay:reset', cb),
  frameReady: () => ipcRenderer.send('overlay:frame-ready'),
  visible: () => ipcRenderer.send('overlay:visible'),
  focusOverlay: () => ipcRenderer.send('overlay:focus'),
  close: () => ipcRenderer.send('overlay:close'),

  // 翻译
  translate: (msg: TranslateRequestMsg) => ipcRenderer.send('translate:start', msg),
  cancel: () => ipcRenderer.send('translate:cancel'),
  onTranslate: (cb: (d: { requestId: number; event: TranslateEvent }) => void) => on('translate:event', cb),

  // 回复助手
  replyStart: (msg: ReplyStartMsg) => ipcRenderer.send('reply:start', msg),
  replyCancel: () => ipcRenderer.send('reply:cancel'),
  onReply: (cb: (d: { requestId: number; event: ReplyEvent }) => void) => on('reply:event', cb),

  // 输出
  copyText: (text: string) => ipcRenderer.send('clipboard:text', text),
  copyImage: (rect: Rect): Promise<boolean> => ipcRenderer.invoke('image:copy', rect),
  saveImage: (rect: Rect): Promise<boolean> => ipcRenderer.invoke('image:save', rect),
  pin: (p: PinPayload) => ipcRenderer.send('pin:create', p),

  // 钉图
  onPinData: (cb: (p: PinPayload) => void) => on('pin:data', cb),
  pinReady: () => ipcRenderer.send('pin:ready'),
  pinClose: () => ipcRenderer.send('pin:close'),
  pinDrag: (on: boolean) => ipcRenderer.send('pin:drag', on),
  pinZoom: (factor: number) => ipcRenderer.send('pin:zoom', factor),

  // 设置
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: SettingsPatch): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  onSettings: (cb: (s: Settings) => void) => on('settings:changed', cb),
  openSettings: () => ipcRenderer.send('settings:open'),
  engineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('engine:status'),
  testEngine: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('engine:test'),
  openaiSources: (): Promise<OpenAISource[]> => ipcRenderer.invoke('openai:sources'),
  openaiImport: (id: string): Promise<Settings> => ipcRenderer.invoke('openai:import', id),
  listModels: (provider?: ProviderId): Promise<{ ok: boolean; models: ModelInfo[]; message?: string }> => ipcRenderer.invoke('models:list', provider),
  openExternal: (url: string) => ipcRenderer.send('shell:open', url),

  // 更新
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdate: (cb: (s: UpdateState) => void) => on('update:state', cb),
  setHotkey: (hotkey: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('hotkey:set', hotkey),
  suspendHotkey: (on: boolean) => ipcRenderer.invoke('hotkey:suspend', on),
  appInfo: (): Promise<{ version: string }> => ipcRenderer.invoke('app:info'),
  ocrInfo: (): Promise<string> => ipcRenderer.invoke('ocr:info'),
  startCapture: () => ipcRenderer.send('capture:start')
}

export type LensApi = typeof api

contextBridge.exposeInMainWorld('lens', api)
