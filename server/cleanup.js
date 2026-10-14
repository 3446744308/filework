import { config } from './config.js'
import { cleanupExpired } from './store.js'
import { sweepObjects } from './objects.js'

function runGc(logger) {
  try {
    const result = sweepObjects()
    if (result.removed > 0) {
      logger.log(`[回收] 已清理 ${result.removed} 个无引用对象（${result.bytes} 字节）`)
    }
  } catch (err) {
    logger.error('[回收] 失败:', err.message)
  }
}

export function startCleanup(logger = console) {
  const run = () => {
    try {
      const removed = cleanupExpired()
      if (removed > 0) logger.log(`[清理] 已销毁 ${removed} 个失效分享`)
    } catch (err) {
      logger.error('[清理] 失败:', err.message)
    }
  }
  run()
  const timer = setInterval(run, config.cleanupIntervalMs)
  timer.unref()

  // 对象回收（RFC-006 REQ-044/045）：仅启动一次 + 周期执行，绝不在请求路径上遍历目录。
  runGc(logger)
  const gcTimer = setInterval(() => runGc(logger), config.dedupGcIntervalMs)
  gcTimer.unref()
  return timer
}
