import fs from 'node:fs'
import express from 'express'
import { config } from './config.js'
import {
  getMeta,
  getActive,
  tryConsume,
  commitUpload,
  removeShare,
  isActive,
  getFileStreamPath,
  codeTaken,
  hashPassword,
  publicInfo,
  verifyPassword,
  waitForSettledBody,
  bodyAvailable
} from './store.js'
import { compressionJob, compressionPlanned, enqueueCompression } from './compress-job.js'
import {
  createDownloadSession,
  getDownloadSession,
  dropDownloadSession,
  hasActiveSession,
  sweepDownloadSessions,
  createUploadSession,
  getUploadSession,
  markUploadPart,
  dropUploadSession,
  sweepUploadSessions,
  markSessionPart,
  countDownloadSessions,
  uploadTmpUsage
} from './sessions.js'
import { recordTransfer } from './stats.js'
import { missGuard, rateGuard } from './rate-limit.js'
import { effectiveMaxFileSize, getBlockedExts, isCustomCodeEnabled } from './settings.js'
import {
  downloadPlan,
  planPayloadOk,
  readRanges,
  readUnit,
  storedSizeOf,
  streamStoredPayload
} from './compress.js'
import {
  CODEC_RAW,
  codecToEncoding,
  encodeForTransfer,
  parseAcceptEncoding,
  planTransferCodec
} from './codec.js'

const MAX_PARALLEL = 8
const MIN_PARALLEL = 2
const MAX_PARTS = 1024

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

function parseCode(value) {
  const code = String(value ?? '').trim()
  return /^\d{6}$/.test(code) ? code : null
}

function parseIndexParam(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function hasIndexParam(value) {
  return value !== undefined && value !== null && value !== ''
}

function reasonMessage(reason) {
  if (reason === 'expired') return '该分享已过期'
  if (reason === 'exhausted') return '该文件已被取走'
  return '取件码不存在'
}

function suggestParallel(unitCount) {
  return Math.max(MIN_PARALLEL, Math.min(MAX_PARALLEL, Math.ceil(unitCount / 6)))
}

function countTransferPart(token, key, originalBytes, wireBytes) {
  if (!markSessionPart(token, key)) return
  const session = getDownloadSession(String(token ?? ''))
  recordTransfer({ originalBytes, wireBytes, code: session ? session.code : '' })
}

// 压缩尚未落定时不发下载计划：计划（ranges/units）在会话建立时就固定了，
// 若中途从「未压缩」切到「容器」，同一 index 会指向不同字节。
function bodyBusyReason(reason) {
  return reason === 'busy' ? '文件正在处理，请稍后重试' : '文件已不存在'
}

function releaseIfInactive(code) {
  if (hasActiveSession(code)) return
  const meta = getMeta(code)
  if (!meta || !isActive(meta)) removeShare(code)
}

function prepareFields(input) {
  let expiresIn = Number.parseInt(input.expiresIn ?? '', 10)
  if (!config.allowedExpiresIn.includes(expiresIn)) expiresIn = config.defaultExpiresIn
  let maxDownloads = Number.parseInt(input.maxDownloads ?? '', 10)
  if (!config.allowedMaxDownloads.includes(maxDownloads)) maxDownloads = config.defaultMaxDownloads
  const note = String(input.note ?? '').slice(0, 200).trim()
  const password = String(input.password ?? '').slice(0, 64).trim()
  let customCode = isCustomCodeEnabled() ? String(input.customCode ?? '').trim() : ''
  if (customCode && !/^\d{6}$/.test(customCode)) customCode = ''
  return { expiresIn, maxDownloads, note, passwordHash: password ? hashPassword(password) : '', customCode }
}

function uploadSizeLimit() {
  const maxFileSize = effectiveMaxFileSize()
  return {
    maxFileSize,
    message: `文件超过大小限制（最大 ${Math.max(1, Math.floor(maxFileSize / 1024 / 1024))}MB）`
  }
}

function mbLabel(bytes) {
  return Math.max(1, Math.round(bytes / 1024 / 1024))
}

// 上传分片大小：默认取 TRANSFER_PART_SIZE；仅当按该尺寸会超出分片数上限时向上翻倍，
// 使「MAX_FILE_SIZE 大于 1024 × TRANSFER_PART_SIZE」的部署仍可上传，而不是直接拒绝。
// 默认配置下任何尺寸都不会触发翻倍，行为与既往完全一致。
function effectiveUploadPartSize(size) {
  let partSize = config.transferPartSize
  while (Math.ceil(size / partSize) > MAX_PARTS) partSize *= 2
  return partSize
}

// 会话配额：限制单个 IP 的在途上传/下载会话数与待处理临时空间，防止无限建会话放大磁盘。
// 已存在会话的续传（init 带 uploadId）不新建会话，因此不受配额限制。
function hitUploadQuota(ip, size) {
  const usage = uploadTmpUsage(ip)
  if (usage.count >= config.maxUploadSessionsPerIp) {
    return `同时上传的任务过多（上限 ${config.maxUploadSessionsPerIp} 个），请先完成或等待会话过期`
  }
  if (usage.bytes + size > config.maxTmpBytesPerIp) {
    return `待处理上传的总大小超出配额（上限 ${mbLabel(config.maxTmpBytesPerIp)}MB），请先完成或等待会话过期`
  }
  return ''
}

const acceptUploadInit = rateGuard(config.uploadLimitPerMinute)

export function registerTransferRoutes(app) {
  app.get('/api/upload/status', (req, res) => {
    const session = getUploadSession(String(req.query.uploadId ?? ''))
    if (!session) return fail(res, 404, '上传会话不存在或已过期')
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      uploadId: session.uploadId,
      filename: session.fields.filename,
      size: session.size,
      mime: session.fields.mime,
      partSize: session.partSize,
      totalParts: session.totalParts,
      received: [...session.received].sort((a, b) => a - b),
      expiresAt: session.expiresAt
    })
  })

  app.post('/api/upload/init', (req, res) => {
    const body = req.body || {}
    const resumeId = String(body.uploadId ?? '').trim().slice(0, 64)
    if (resumeId) {
      const existing = getUploadSession(resumeId)
      if (existing) {
        const filename = String(body.filename ?? '').slice(0, 255).trim()
        const size = Number.parseInt(body.size ?? '', 10)
        if (filename !== existing.fields.filename || !Number.isFinite(size) || size !== existing.size) {
          return fail(res, 409, '上传会话与文件不匹配')
        }
        return res.json({
          uploadId: existing.uploadId,
          partSize: existing.partSize,
          totalParts: existing.totalParts,
          resumed: true,
          received: [...existing.received].sort((a, b) => a - b)
        })
      }
    }

    acceptUploadInit(req, res, () => {
      const size = Number.parseInt(body.size ?? '', 10)
      if (!Number.isFinite(size) || size <= 0) return fail(res, 400, '文件大小不正确')
      const limit = uploadSizeLimit()
      if (size > limit.maxFileSize) return fail(res, 413, limit.message)

      const filename = String(body.filename ?? '').slice(0, 255).trim() || '未命名文件'
      const mime = String(body.mime ?? '').slice(0, 128).trim() || 'application/octet-stream'
      const ext = filename.split('.').pop().toLowerCase()
      if (ext && getBlockedExts().includes(ext)) {
        return fail(res, 400, `禁止上传 .${ext} 类型的文件`)
      }

      const fields = prepareFields(body)
      if (fields.customCode && codeTaken(fields.customCode)) {
        return fail(res, 409, '取件码已被占用')
      }

      const partSize = effectiveUploadPartSize(size)
      const totalParts = Math.ceil(size / partSize)
      if (totalParts > MAX_PARTS) return fail(res, 400, '文件过大，分片数量超出限制')

      const quotaMessage = hitUploadQuota(req.ip, size)
      if (quotaMessage) return fail(res, 429, quotaMessage)

      const session = createUploadSession({
        tmpDir: config.tmpDir,
        partSize,
        totalParts,
        size,
        ip: req.ip,
        fields: { filename, mime, ...fields }
      })
      res.json({
        uploadId: session.uploadId,
        partSize: session.partSize,
        totalParts: session.totalParts,
        resumed: false,
        received: []
      })
    })
  })

  // 分片体上限按会话实际 partSize 设定（放宽后的会话会大于 TRANSFER_PART_SIZE）。
  const rawPart = (limit) => express.raw({ limit, type: () => true })

  app.put('/api/upload/part', (req, res, next) => {
    const expectedSession = getUploadSession(String(req.query.uploadId ?? ''))
    rawPart(expectedSession ? expectedSession.partSize : config.transferPartSize)(req, res, (err) => {
      if (err) {
        if (err.type === 'entity.too.large') return fail(res, 413, '分片超出大小限制')
        return fail(res, 400, '分片解析失败')
      }
      next()
    })
  }, (req, res) => {
    const session = getUploadSession(String(req.query.uploadId ?? ''))
    if (!session) return fail(res, 404, '上传会话不存在或已过期')
    const index = Number.parseInt(req.query.index ?? '', 10)
    if (!Number.isInteger(index) || index < 0 || index >= session.totalParts) {
      return fail(res, 400, '分片序号不正确')
    }
    const expected =
      index === session.totalParts - 1 ? session.size - index * session.partSize : session.partSize
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length !== expected) {
      return fail(res, 400, '分片大小不正确')
    }
    let fd
    try {
      fd = fs.openSync(session.tmpFile, 'r+')
    } catch {
      fd = fs.openSync(session.tmpFile, 'w')
    }
    try {
      fs.writeSync(fd, body, 0, body.length, index * session.partSize)
    } finally {
      fs.closeSync(fd)
    }
    markUploadPart(session, index)
    res.json({ ok: true, received: session.received.size })
  })

  app.post('/api/upload/complete', async (req, res) => {
    const session = getUploadSession(String(req.body?.uploadId ?? ''))
    if (!session) return fail(res, 404, '上传会话不存在或已过期')
    if (session.received.size !== session.totalParts) {
      return fail(res, 400, '分片不完整，请重试')
    }
    let stat
    try {
      stat = fs.statSync(session.tmpFile)
    } catch {
      return fail(res, 400, '上传内容不存在，请重新上传')
    }
    if (stat.size !== session.size) return fail(res, 400, '文件大小校验失败')

    const fields = session.fields
    // 压缩后台任务化（backlog B1-2）：complete 只负责落位文件并标 pending，
    // 压缩交给串行队列，响应时间不再包含压缩耗时。
    const planned = compressionPlanned(fields.mime, fields.filename)
    try {
      const meta = commitUpload(session.tmpFile, {
        filename: fields.filename,
        size: session.size,
        mime: fields.mime,
        note: fields.note,
        passwordHash: fields.passwordHash,
        customCode: fields.customCode,
        expiresIn: fields.expiresIn,
        maxDownloads: fields.maxDownloads,
        compressionState: planned ? 'pending' : '',
        storedSize: session.size
      })
      dropUploadSession(session.uploadId)
      if (planned) enqueueCompression(meta.code, { mime: fields.mime, filename: fields.filename })
      res.status(201).json({
        ...publicInfo(meta),
        compressionState: meta.compressionState || '',
        storedSize: meta.storedSize,
        compressed: Boolean(meta.compression),
        clientIp: req.ip
      })
    } catch (e) {
      if (e.code === 'CODE_TAKEN') {
        dropUploadSession(session.uploadId)
        return fail(res, 409, e.message)
      }
      fail(res, 500, '保存失败：' + e.message)
    }
  })

  // 压缩任务进度（前端在 upload/complete 后轮询，避免让用户以「已保存」误以为压缩已完成）。
  app.get('/api/upload/job', (req, res) => {
    const key = String(req.query.uploadId ?? req.query.code ?? '').trim()
    if (!/^(\d{6}|[a-f0-9]{16,24})$/.test(key)) return fail(res, 400, '任务标识格式不正确')
    const job = compressionJob(key)
    const meta = /^\d{6}$/.test(key) ? getMeta(key) : null
    if (!job && !meta) return fail(res, 404, '任务不存在或已结束')
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      status: job ? job.status : 'done',
      error: job ? job.error : '',
      compressed: job ? job.compressed : Boolean(meta.compression),
      storedSize: job && job.storedSize ? job.storedSize : meta ? meta.storedSize : 0,
      compressionState: meta ? meta.compressionState || '' : '',
      finished: !job || job.status === 'done' || job.status === 'failed'
    })
  })

  app.post('/api/download/session', missGuard(config.rateLimitMisses), async (req, res) => {
    const code = parseCode(req.body?.code)
    if (!code) return fail(res, 400, '取件码格式不正确')
    const found = getActive(code)
    if (!found.ok) return fail(res, 404, reasonMessage(found.reason))
    const settled = await waitForSettledBody(code)
    if (!settled.ok) {
      return settled.reason === 'busy'
        ? fail(res, 503, bodyBusyReason(settled.reason))
        : fail(res, 404, reasonMessage(settled.reason))
    }
    if (settled.meta.password) {
      const password = String(req.body?.password ?? '')
      if (!password || !verifyPassword(settled.meta, password)) {
        return fail(res, 403, '取件密码错误')
      }
    }
    let plan
    try {
      plan = downloadPlan(settled.meta)
    } catch {
      return fail(res, 500, '文件损坏，请联系管理员')
    }
    if (countDownloadSessions(req.ip) >= config.maxDownloadSessionsPerIp) {
      return fail(
        res,
        429,
        `同时进行的下载过多（上限 ${config.maxDownloadSessionsPerIp} 个），请稍后再试`
      )
    }
    const result = tryConsume(code)
    if (!result.ok) return fail(res, 404, reasonMessage(result.reason))
    const token = createDownloadSession(code, req.ip)
    const session = getDownloadSession(token)
    res.json({
      token,
      partSize: config.transferPartSize,
      filename: result.meta.filename,
      size: result.meta.size,
      mime: result.meta.mime,
      expiresAt: session.expiresAt,
      compressed: plan.compressed,
      units: plan.ranges,
      unitCount: plan.ranges.length,
      parallel: suggestParallel(plan.ranges.length)
    })
  })

  app.get('/api/download/status', async (req, res) => {
    const token = String(req.query.token ?? '')
    const session = getDownloadSession(token)
    if (!session) return fail(res, 404, '下载会话不存在或已过期')
    const settled = await waitForSettledBody(session.code)
    if (!settled.ok) return fail(res, 503, bodyBusyReason(settled.reason))
    const meta = settled.meta
    const target = getFileStreamPath(session.code)
    if (!bodyAvailable(meta)) return fail(res, 404, '文件已不存在')
    let plan
    try {
      plan = downloadPlan(meta)
    } catch {
      return fail(res, 500, '文件损坏，请联系管理员')
    }
    if (!planPayloadOk(plan, target)) return fail(res, 500, '文件损坏，请联系管理员')
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      token,
      partSize: config.transferPartSize,
      filename: meta.filename,
      size: meta.size,
      mime: meta.mime,
      expiresAt: session.expiresAt,
      compressed: plan.compressed,
      units: plan.ranges,
      unitCount: plan.ranges.length,
      parallel: suggestParallel(plan.ranges.length)
    })
  })

  app.get('/api/download/part', async (req, res) => {
    const session = getDownloadSession(String(req.query.token ?? ''))
    if (!session) return fail(res, 404, '下载会话不存在或已过期')
    const settled = await waitForSettledBody(session.code)
    if (!settled.ok) return fail(res, 503, bodyBusyReason(settled.reason))
    const meta = settled.meta
    const target = getFileStreamPath(session.code)
    if (!bodyAvailable(meta)) return fail(res, 404, '文件已不存在')

    let plan
    try {
      plan = downloadPlan(meta)
    } catch {
      return fail(res, 500, '文件损坏，请联系管理员')
    }

    if (!planPayloadOk(plan, target)) return fail(res, 500, '文件损坏，请联系管理员')
    let storedSize = 0
    if (plan.compressed && !plan.cas) storedSize = storedSizeOf(target)

    const indexed = hasIndexParam(req.query.index)
    const index = parseIndexParam(req.query.index)
    let start
    let end
    let unit = null
    if (indexed) {
      if (index === null || index >= plan.ranges.length) return fail(res, 400, '分片序号不正确')
      start = plan.ranges[index][0]
      end = plan.ranges[index][1]
      unit = plan.units ? plan.units[index] : null
    } else {
      start = Number.parseInt(req.query.start ?? '', 10)
      end = Number.parseInt(req.query.end ?? '', 10)
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > meta.size
      ) {
        return fail(res, 400, '分片范围不正确')
      }
      if (end - start > config.transferPartSize) return fail(res, 400, '分片范围过大')
    }

    const accepted = parseAcceptEncoding(req.headers['accept-encoding'])
    const stored = unit ? unit.z : plan.compressed ? CODEC_RAW : null
    const transfer = stored ? planTransferCodec(stored, accepted) : { encoding: '', passthrough: false }

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Vary', 'Accept-Encoding')
    if (indexed) res.setHeader('X-Transfer-Part', String(index))

    if (transfer.passthrough) {
      res.setHeader('Content-Encoding', transfer.encoding)
      res.setHeader('Content-Length', String(unit.c))
      res.setHeader('X-Transfer-Mode', 'store')
      res.setHeader('X-Transfer-Codec', transfer.encoding)
      countTransferPart(req.query.token, indexed ? index : `${start}-${end}`, end - start, unit.c)
      streamStoredPayload(res, target, unit)
      return
    }

    if (!plan.compressed) {
      if (storedSizeOf(target) < end) return fail(res, 500, '文件损坏，请联系管理员')
      res.setHeader('Content-Length', String(end - start))
      res.setHeader('X-Transfer-Mode', 'raw')
      res.setHeader('X-Transfer-Codec', 'raw')
      countTransferPart(req.query.token, indexed ? index : `${start}-${end}`, end - start, end - start)
      const stream = fs.createReadStream(target, { start, end: end - 1 })
      stream.on('error', () => {
        if (!res.headersSent) fail(res, 500, '下载失败，请重试')
      })
      stream.pipe(res)
      return
    }

    let raw
    try {
      raw = unit ? await readUnit(target, unit) : await readRanges(target, plan.units, start, end)
    } catch {
      return fail(res, 500, '下载失败，请重试')
    }

    let body = raw
    let encoding = ''
    if (transfer.encoding) {
      const packed = await encodeForTransfer(raw, transfer.encoding)
      if (packed) {
        body = packed
        encoding = transfer.encoding
      }
    }
    if (encoding) res.setHeader('Content-Encoding', encoding)
    res.setHeader('Content-Length', String(body.length))
    res.setHeader('X-Transfer-Mode', encoding ? 'recompress' : 'raw')
    res.setHeader('X-Transfer-Codec', encoding || 'raw')
    res.setHeader('X-Transfer-Algo', codecToEncoding(unit ? unit.z : '') || 'mixed')
    countTransferPart(req.query.token, indexed ? index : `${start}-${end}`, end - start, body.length)
    res.end(body)
  })

  app.post('/api/download/end', (req, res) => {
    const token = String(req.body?.token ?? '')
    const session = getDownloadSession(token)
    if (session) {
      dropDownloadSession(token)
      releaseIfInactive(session.code)
    }
    res.json({ ok: true })
  })

  const timer = setInterval(() => {
    for (const session of sweepDownloadSessions()) releaseIfInactive(session.code)
    sweepUploadSessions()
  }, 60_000)
  timer.unref()
}
