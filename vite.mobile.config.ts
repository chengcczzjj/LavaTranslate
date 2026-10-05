// 安卓版界面（src/mobile）：构建到 out/mobile，由 android/app 打进 APK 的 assets/web
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    minify: 'esbuild',
    // 国产手机的系统 WebView 不一定跟着 Chrome 更新
    target: 'chrome87',
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, 'src/mobile/overlay.html'),
        settings: resolve(__dirname, 'src/mobile/settings.html')
      }
    }
  }
})
