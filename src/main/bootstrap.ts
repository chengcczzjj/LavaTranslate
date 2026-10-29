// 此入口只能导入 Electron / Node 内置模块和不依赖原生扩展的诊断模块。
import { app } from 'electron'
import { join } from 'node:path'
import { logError, startupFailed } from './diagnostics'

if (process.env.LENS_AUTOTEST || process.env.LENS_REVIEW || process.env.LENS_ENGINE_TEST || process.env.LENS_DETECT_TEST || process.env.LENS_PASSTEST || process.env.LENS_SIGNIN_TEST) {
  app.setPath('userData', join(app.getPath('temp'), 'lens-autotest'))
}

process.on('uncaughtException', (error) => logError('uncaughtException', error))
process.on('unhandledRejection', (error) => logError('unhandledRejection', error))

try {
  // 单独构建为 app.js；不能改成静态 import，否则原生模块会先于错误处理加载。
  const { startup } = require('./app.js') as typeof import('./index')
  void startup.catch(startupFailed)
} catch (error) {
  startupFailed(error)
}
