import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // 保留独立 app 入口，bootstrap 先安装错误处理，再 require 原生依赖。
    build: { minify: 'esbuild', rollupOptions: { input: { index: resolve(__dirname, 'src/main/bootstrap.ts'), app: resolve(__dirname, 'src/main/index.ts'), 'win-space-worker': resolve(__dirname, 'src/main/win-space-worker.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          pin: resolve(__dirname, 'src/renderer/pin.html')
        }
      }
    }
  }
})
