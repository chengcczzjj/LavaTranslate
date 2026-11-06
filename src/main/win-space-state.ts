// Shared with the native message-loop worker. Deadlines wrap safely at 32 bits.
export const KEY_STATE = { mode: 0, thread: 1, stop: 2, capture: 3, held: 4, mainUntil: 5, captureUntil: 6, revision: 7, reset: 8 } as const
export const KEY_STATE_SIZE = 9
export const HOOK_WAKE = 0x8001
export const MAIN_LEASE_MS = 1500
export const CAPTURE_LEASE_MS = 1500
export const deadline = (ms: number) => (Date.now() + ms) | 0
export const live = (until: number) => until !== 0 && ((until - (Date.now() | 0)) | 0) > 0
