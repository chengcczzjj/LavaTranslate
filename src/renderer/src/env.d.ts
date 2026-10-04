/// <reference types="vite/client" />
import type { LensApi } from '../../preload'

declare global {
  interface Window {
    lens: LensApi
  }
}

export {}
