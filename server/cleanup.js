import { config } from './config.js'
import { cleanupExpired } from './store.js'

export function startCleanup(logger = console) {
  const run = () => {
    try {
      const removed = cleanupExpired()
      if (removed > 0) logger.log(`[清理] 已销毁 ${removed} 个失效分享的文件（记录留存）`)
    } catch (err) {
      logger.error('[清理] 失败:', err.message)
    }
  }
  run()
  const timer = setInterval(run, config.cleanupIntervalMs)
  timer.unref()
  return timer
}
