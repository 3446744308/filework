import fs from 'node:fs'
import {
  CAS_FORMAT,
  CAS_STORAGE_VERSION,
  COMPRESSION_FORMAT,
  discardPack,
  isCompressible,
  packContainer,
  packManifest
} from './compress.js'
import { getCompressionCodecs, getCompressionEnabled } from './settings.js'
import { config } from './config.js'
import {
  clearPendingCompression,
  getFileStreamPath,
  getMeta,
  updateCompression,
  writePendingCompression
} from './store.js'
import { enqueue, getJobByKey } from './jobs.js'

// 压缩后台化（backlog B1-2）：complete 立即返回 201，压缩在串行队列里跑。
// 元数据是「文件当前是什么形态」的唯一真源：任务开始前先标 compressionState='pending'，
// 只有容器/清单真正落位后才回写 compression/units/storedSize。
// 跨文件去重开启时（RFC-006 / ADR-015）优先写清单化容器：对象落 data/objects/，
// 清单落 meta，源文件在元数据落定后删除；无收益则回退内嵌容器（原路径不变）。
export function compressionPlanned(mime, filename) {
  return getCompressionEnabled() && isCompressible(mime, filename)
}

function settleUncompressed(code, size) {
  updateCompression(code, {
    compression: '',
    compressionState: '',
    storedSize: size,
    units: [],
    dedup: 0
  })
  return { compressed: false, storedSize: size, dedup: 0 }
}

function commitManifest(code, target, meta, result) {
  const next = updateCompression(code, {
    compression: CAS_FORMAT,
    storageVersion: CAS_STORAGE_VERSION,
    compressionState: '',
    storedSize: result.storedSize,
    units: result.units,
    dedup: 0,
    crossHits: result.crossHits || 0
  })
  // 元数据是唯一真源：清单落定后才删除内嵌源文件（此前若被杀，只是多一个孤儿文件）。
  try {
    fs.unlinkSync(target)
  } catch {}
  return {
    compressed: Boolean(next && next.compression),
    storedSize: next ? next.storedSize : result.storedSize,
    dedup: 0,
    mode: 'cas',
    crossHits: result.crossHits || 0,
    source: meta.size
  }
}

function commitInline(code, target, meta, result) {
  writePendingCompression(code, {
    format: COMPRESSION_FORMAT,
    storedSize: result.storedSize,
    units: result.units,
    dedup: result.dedup
  })
  try {
    fs.renameSync(result.packPath, target)
  } catch (err) {
    console.error('[压缩] 容器落位失败，保留原始文件:', err.message)
    clearPendingCompression(code)
    return settleUncompressed(code, meta.size)
  }
  const next = updateCompression(code, {
    compression: COMPRESSION_FORMAT,
    compressionState: '',
    storedSize: result.storedSize,
    units: result.units,
    dedup: result.dedup
  })
  clearPendingCompression(code)
  return {
    compressed: Boolean(next && next.compression),
    storedSize: next ? next.storedSize : result.storedSize,
    dedup: result.dedup,
    mode: 'inline'
  }
}

export function enqueueCompression(code, { mime, filename }) {
  const target = getFileStreamPath(code)
  return enqueue(
    'compress',
    async () => {
      const meta = getMeta(code)
      // 分享已被销毁/过期回收，或元数据已被修复过：无事可做。
      if (!meta || meta.compressionState !== 'pending') {
        return { compressed: Boolean(meta && meta.compression), storedSize: meta ? meta.storedSize : 0 }
      }
      const options = {
        mime,
        filename,
        enabled: getCompressionEnabled(),
        codecs: getCompressionCodecs()
      }
      if (config.crossFileDedup) {
        let manifest = null
        try {
          manifest = await packManifest(target, options)
        } catch (err) {
          console.error('[去重] 任务失败，回退内嵌容器:', err.message)
        }
        if (manifest && manifest.ok) return commitManifest(code, target, meta, manifest)
      }
      let result = null
      try {
        result = await packContainer(target, options)
      } catch (err) {
        console.error('[压缩] 任务失败，保留原始文件:', err.message)
      }
      if (!result || !result.ok) {
        discardPack(result ? result.packPath : `${target}.pack`)
        return settleUncompressed(code, meta.size)
      }
      return commitInline(code, target, meta, result)
    },
    code
  )
}

// 前端按 uploadId（分片上传）或取件码（单请求上传）轮询压缩进度。
export function compressionJob(key) {
  const job = getJobByKey(key)
  if (!job) return null
  return {
    status: job.status,
    error: job.error || '',
    compressed: job.result ? Boolean(job.result.compressed) : false,
    storedSize: job.result ? job.result.storedSize : 0,
    mode: job.result && job.result.mode ? job.result.mode : '',
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  }
}
