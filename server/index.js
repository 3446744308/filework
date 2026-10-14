import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import multer from 'multer'
import { config, ensureDirs } from './config.js'
import {
  commitUpload,
  getActive,
  getMeta,
  tryConsume,
  getFileStreamPath,
  listAll,
  removeShare,
  publicInfo,
  verifyPassword,
  repairPendingCompressions,
  waitForSettledBody,
  bodyAvailable
} from './store.js'
import { restoreUploadSessions, usageByIp } from './sessions.js'
import { dedupState, referencedStats } from './objects.js'
import { registerTransferRoutes } from './transfer.js'
import { streamOriginal, downloadPlan, planPayloadOk } from './compress.js'
import { compressionPlanned, enqueueCompression } from './compress-job.js'
import { queueStats } from './jobs.js'
import { startCleanup } from './cleanup.js'
import { missGuard, rateGuard } from './rate-limit.js'
import {
  createFeedback,
  findFeedbackByCode,
  getReplyTemplates,
  listFeedback,
  removeFeedback,
  saveReplyTemplates,
  updateFeedbackStatus,
  FEEDBACK_STATUSES
} from './feedback.js'
import {
  createNotice,
  deleteNotice,
  getNotice,
  noticeSnapshot,
  noticeStats,
  saveNotice,
  updateNotice
} from './notice.js'
import {
  exportPresets,
  importPresets,
  reorderPresets,
  applyPreset,
  createPreset,
  deletePreset,
  listPresets,
  updatePreset
} from './notice-presets.js'
import {
  readCounters,
  readTransferStats,
  resetTransferStats,
  transferExportRows,
  toCsv,
  flushCounters,
  dayKey,
  replayWal,
  savedBytesOf
} from './stats.js'
import {
  getSettings,
  saveSettings,
  saveLogo,
  removeLogo,
  logoFilePath,
  effectiveMaxFileSize,
  getBlockedExts,
  isCustomCodeEnabled,
  getCompressionCodecs,
  getCompressionCodecCap,
  effectivePresetLimit,
  LOGO_TYPES
} from './settings.js'

ensureDirs()
replayWal()
// 压缩后台任务的内存表不落盘，因此启动时要把上次被杀留下的 pending 按边车收尾（零丢失）。
repairPendingCompressions()
restoreUploadSessions(config.tmpDir)

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(express.json({ limit: '64kb' }))

const distDir = path.join(config.rootDir, 'web', 'dist')
const hasDist = fs.existsSync(path.join(distDir, 'index.html'))

function makeUpload(maxFileSize) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, config.tmpDir),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`)
    }),
    limits: { fileSize: maxFileSize, files: 1 },
    defParamCharset: 'utf8'
  })
}

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function adminAuth(req, res, next) {
  const key = req.get('x-admin-key') || ''
  if (!key || !safeEqual(key, config.adminKey)) return fail(res, 401, '管理密钥错误')
  next()
}

function parseCode(value) {
  const code = String(value ?? '').trim()
  return /^\d{6}$/.test(code) ? code : null
}

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    features: [
      'siteSettings',
      'maxFileSize',
      'blockedExts',
      'noticeDisplay',
      'displayMode',
      'waybill',
      'publicIp',
      'customCode',
      'password',
      'compression',
      'chunkedUpload',
      'parallelDownload',
      'downloadSession',
      'transferCompression',
      'adaptiveChunking',
      'unitDedup',
      'multiCodec',
      'transferStats',
      'codecToggle',
      'transferExport',
      'uploadResume',
      'downloadResume',
      'sessionQuota',
      'multiNotice',
      'compressQueue',
      'crossFileDedup',
      'beian',
      'gongan',
      'feedback'
    ],
    notice: noticeStats(),
    compressQueue: queueStats(),
    dedup: dedupState()
  })
)

const PUBLIC_IP_API = 'https://openapi.lddgo.net/base/gtool/api/v1/GetIp'
const PUBLIC_IP_TTL = 60_000
let publicIpCache = { ip: '', at: 0 }

async function fetchPublicIp() {
  if (publicIpCache.ip && Date.now() - publicIpCache.at < PUBLIC_IP_TTL) return publicIpCache.ip
  try {
    const res = await fetch(PUBLIC_IP_API, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = await res.json()
    const ip = body?.data?.ip
    if (typeof ip === 'string' && ip) {
      publicIpCache = { ip, at: Date.now() }
      return ip
    }
  } catch {}
  return null
}

app.get('/api/ip', async (req, res) => {
  const ip = (await fetchPublicIp()) || req.ip || ''
  res.json({ ip })
})

app.get('/api/notice', (req, res) => res.json(getNotice()))

app.put('/api/notice', adminAuth, (req, res) => {
  const body = req.body || {}
  try {
    res.json({ ok: true, notice: saveNotice(body, { expectedRev: body.rev }) })
  } catch (err) {
    if (err.code === 'NOTICE_CONFLICT' || err.code === 'NOTICE_LIMIT') return fail(res, 409, err.message)
    throw err
  }
})

function noticeFail(res, err) {
  if (err.code === 'NOTICE_NOT_FOUND') return fail(res, 404, err.message)
  if (err.code === 'NOTICE_CONFLICT' || err.code === 'NOTICE_LIMIT') return fail(res, 409, err.message)
  return fail(res, 400, err.message)
}

app.get('/api/admin/notices', adminAuth, (req, res) => res.json({ ok: true, ...noticeSnapshot() }))

app.post('/api/admin/notices', adminAuth, (req, res) => {
  try {
    const notice = createNotice(req.body || {})
    res.status(201).json({ ok: true, notice, rev: noticeSnapshot().rev })
  } catch (err) {
    noticeFail(res, err)
  }
})

app.put('/api/admin/notices/:id', adminAuth, (req, res) => {
  const body = req.body || {}
  try {
    const notice = updateNotice(String(req.params.id), body, { expectedRev: body.rev })
    res.json({ ok: true, notice, rev: noticeSnapshot().rev })
  } catch (err) {
    noticeFail(res, err)
  }
})

app.delete('/api/admin/notices/:id', adminAuth, (req, res) => {
  if (!deleteNotice(String(req.params.id))) return fail(res, 404, '公告不存在')
  res.json({ ok: true, rev: noticeSnapshot().rev })
})

function publicSettings(data) {
  const settings = data || getSettings()
  return {
    siteName: settings.siteName,
    beian: settings.beian || '',
    gongan: settings.gongan || '',
    hasLogo: Boolean(settings.logo) && Boolean(logoFilePath()),
    maxFileSize: effectiveMaxFileSize(),
    maxFileSizeCap: config.maxFileSize,
    blockedExts: getBlockedExts(),
    displayMode: settings.displayMode === 'waybill' ? 'waybill' : 'simple',
    customCodeEnabled: settings.customCodeEnabled !== false,
    compressionEnabled: settings.compressionEnabled !== false,
    compressionCodecs: getCompressionCodecs().join(','),
    compressionCodecCap: getCompressionCodecCap().join(','),
    presetLimit: effectivePresetLimit(),
    presetLimitCap: config.maxNoticePresets,
    updatedAt: settings.updatedAt
  }
}

app.get('/api/settings', (req, res) => res.json(publicSettings()))

app.get('/api/logo', (req, res) => {
  const target = logoFilePath()
  if (!target) return fail(res, 404, '未设置 logo')
  res.sendFile(target)
})

app.put('/api/settings', adminAuth, (req, res) => {
  res.json({ ok: true, settings: publicSettings(saveSettings(req.body || {})) })
})

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.tmpDir),
    filename: (req, file, cb) => cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }
})

app.post('/api/settings/logo', adminAuth, (req, res) => {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'logo 不能超过 2MB')
      return fail(res, 400, '上传失败：' + err.message)
    }
    if (!req.file) return fail(res, 400, '请选择图片文件')
    const ext = LOGO_TYPES[req.file.mimetype]
    const cleanup = () => fs.unlink(req.file.path, () => {})
    if (!ext) {
      cleanup()
      return fail(res, 400, '仅支持 png / jpg / webp / svg / gif / ico 格式')
    }
    try {
      const settings = saveLogo(req.file.path, ext)
      res.json({ ok: true, settings: publicSettings(settings) })
    } catch (e) {
      cleanup()
      fail(res, 500, '保存失败：' + e.message)
    }
  })
})

app.delete('/api/settings/logo', adminAuth, (req, res) => {
  res.json({ ok: true, settings: publicSettings(removeLogo()) })
})

app.post('/api/upload', rateGuard(config.uploadLimitPerMinute), (req, res) => {
  const maxFileSize = effectiveMaxFileSize()
  makeUpload(maxFileSize).single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 413, `文件超过大小限制（最大 ${Math.max(1, Math.floor(maxFileSize / 1024 / 1024))}MB）`)
      }
      return fail(res, 400, '上传失败：' + err.message)
    }
    if (!req.file) return fail(res, 400, '请选择要上传的文件')

    const cleanup = () => fs.unlink(req.file.path, () => {})

    let expiresIn = Number.parseInt(req.body.expiresIn ?? '', 10)
    if (!config.allowedExpiresIn.includes(expiresIn)) expiresIn = config.defaultExpiresIn

    let maxDownloads = Number.parseInt(req.body.maxDownloads ?? '', 10)
    if (!config.allowedMaxDownloads.includes(maxDownloads)) maxDownloads = config.defaultMaxDownloads

    if (req.file.size === 0) {
      cleanup()
      return fail(res, 400, '文件内容为空')
    }

    const fileExt = path.extname(path.basename(req.file.originalname || '')).slice(1).toLowerCase()
    if (fileExt && getBlockedExts().includes(fileExt)) {
      cleanup()
      return fail(res, 400, `禁止上传 .${fileExt} 类型的文件`)
    }

    try {
      const note = String(req.body.note ?? '').slice(0, 200).trim()
      const customCodeRaw = isCustomCodeEnabled() ? String(req.body.customCode ?? '').trim() : ''
      const customCode = /^\d{6}$/.test(customCodeRaw) ? customCodeRaw : ''
      const password = String(req.body.password ?? '').slice(0, 64).trim()
      const filename = req.file.originalname || '未命名文件'
      // 压缩后台任务化（backlog B1-2）：单请求路径与分片路径同一口径——先标 pending，
      // 压缩交给串行队列，201 不再包含压缩耗时。
      const planned = compressionPlanned(req.file.mimetype, filename)
      const meta = commitUpload(req.file.path, {
        filename,
        size: req.file.size,
        mime: req.file.mimetype,
        note,
        password,
        customCode,
        expiresIn,
        maxDownloads,
        compressionState: planned ? 'pending' : '',
        storedSize: req.file.size
      })
      if (planned) {
        enqueueCompression(meta.code, { mime: req.file.mimetype, filename })
      }
      res.status(201).json({
        ...publicInfo(meta),
        compressionState: meta.compressionState || '',
        storedSize: meta.storedSize,
        compressed: Boolean(meta.compression),
        clientIp: req.ip
      })
    } catch (e) {
      cleanup()
      if (e.code === 'CODE_TAKEN') return fail(res, 409, e.message)
      fail(res, 500, '保存失败：' + e.message)
    }
  })
})

app.get('/api/info', missGuard(config.rateLimitMisses), (req, res) => {
  const code = parseCode(req.query.code)
  if (!code) return fail(res, 400, '取件码格式不正确')
  const found = getActive(code)
  if (!found.ok) return fail(res, 404, reasonMessage(found.reason))
  res.json(publicInfo(found.meta))
})

app.post('/api/verify-password', missGuard(config.rateLimitMisses), (req, res) => {
  const code = parseCode(req.body?.code)
  if (!code) return fail(res, 400, '取件码格式不正确')
  const found = getActive(code)
  if (!found.ok) return fail(res, 404, reasonMessage(found.reason))
  if (!found.meta.password) return res.json({ ok: true })
  const password = String(req.body?.password ?? '')
  if (!password || !verifyPassword(found.meta, password)) {
    return fail(res, 403, '取件密码错误')
  }
  res.json({ ok: true })
})

app.get('/api/download', missGuard(config.rateLimitMisses), async (req, res) => {
  const code = parseCode(req.query.code)
  if (!code) return fail(res, 400, '取件码格式不正确')
  const found = getActive(code)
  if (!found.ok) return fail(res, 404, reasonMessage(found.reason))
  if (found.meta.password) {
    const password = String(req.query.password ?? '')
    if (!password || !verifyPassword(found.meta, password)) {
      return fail(res, 403, '取件密码错误')
    }
  }
  const settled = await waitForSettledBody(code)
  if (!settled.ok) {
    return settled.reason === 'busy'
      ? fail(res, 503, '文件正在处理，请稍后重试')
      : fail(res, 404, reasonMessage(settled.reason))
  }
  const result = tryConsume(code)
  if (!result.ok) return fail(res, 404, reasonMessage(result.reason))
  const target = getFileStreamPath(code)
  if (!bodyAvailable(result.meta)) {
    removeShare(code)
    return fail(res, 404, '文件已不存在')
  }
  let plan
  try {
    plan = downloadPlan(result.meta)
  } catch {
    return fail(res, 500, '文件损坏，请联系管理员')
  }
  if (plan.compressed) {
    if (!planPayloadOk(plan, target)) return fail(res, 500, '文件损坏，请联系管理员')
    try {
      await streamOriginal(res, target, result.meta, plan.units)
    } catch (e) {
      if (!res.headersSent) fail(res, 500, '下载失败，请重试')
    }
    return
  }
  res.download(target, result.meta.filename, (err) => {
    if (err && !res.headersSent) fail(res, 500, '下载失败，请重试')
  })
})

// 反馈（合并自同事版：公开提交 + 凭反馈号自查 + 管理端处理）
app.post('/api/feedback', rateGuard(config.uploadLimitPerMinute), (req, res) => {
  try {
    const item = createFeedback(req.body || {})
    res.status(201).json({ ok: true, id: item.id, code: item.code })
  } catch (e) {
    if (e.code === 'INVALID') return fail(res, 400, e.message)
    fail(res, 500, '提交失败：' + e.message)
  }
})

app.get('/api/feedback/query', missGuard(config.rateLimitMisses, 60_000, 'fbquery'), (req, res) => {
  const code = String(req.query.code ?? '').trim().toUpperCase()
  if (!/^FB-\d{8}$/.test(code)) return fail(res, 400, '反馈号格式不正确')
  const item = findFeedbackByCode(code)
  if (!item) return fail(res, 404, '反馈号不存在')
  res.json({
    code: item.code,
    type: item.type,
    content: item.content,
    status: item.status,
    reply: item.status === 'done' ? item.reply || '' : '',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  })
})

app.get('/api/admin/feedback/templates', adminAuth, (req, res) => {
  res.json({ templates: getReplyTemplates() })
})

app.put('/api/admin/feedback/templates', adminAuth, (req, res) => {
  res.json({ ok: true, templates: saveReplyTemplates(req.body?.templates) })
})

app.get('/api/admin/feedback', adminAuth, (req, res) => {
  res.json({ list: listFeedback() })
})

app.put('/api/admin/feedback/:id', adminAuth, (req, res) => {
  const id = String(req.params.id ?? '')
  if (!id || id.includes('/') || id.includes('\\')) return fail(res, 400, '反馈 ID 不正确')
  if (!FEEDBACK_STATUSES.includes(req.body?.status)) {
    return fail(res, 400, '状态不正确')
  }
  let item
  try {
    item = updateFeedbackStatus(id, req.body.status, req.body.reply)
  } catch (e) {
    if (e.code === 'REPLY_REQUIRED') return fail(res, 400, e.message)
    throw e
  }
  if (!item) return fail(res, 404, '反馈不存在')
  res.json({ ok: true, feedback: item })
})

app.delete('/api/admin/feedback/:id', adminAuth, (req, res) => {
  const id = String(req.params.id ?? '')
  if (!id || id.includes('/') || id.includes('\\')) return fail(res, 400, '反馈 ID 不正确')
  removeFeedback(id)
  res.json({ ok: true })
})

app.get('/api/admin/ping', adminAuth, (req, res) => res.json({ ok: true }))

function presetFail(res, err) {
  if (err.code === 'PRESET_NOT_FOUND') return fail(res, 404, err.message)
  if (err.code === 'PRESET_LIMIT' || err.code === 'PRESET_CONFLICT') return fail(res, 409, err.message)
  if (err.code === 'NOTICE_CONFLICT') return fail(res, 409, err.message)
  return fail(res, 400, err.message)
}

app.get('/api/admin/notice/presets', adminAuth, (req, res) => {
  res.json({
    ok: true,
    limit: effectivePresetLimit(),
    limitCap: config.maxNoticePresets,
    presets: listPresets()
  })
})

app.get('/api/admin/notice/presets/export', adminAuth, (req, res) => {
  const payload = exportPresets()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="notice-presets-${csvStamp(Date.now())}.json"`
  )
  res.send(JSON.stringify(payload, null, 2))
})

app.post('/api/admin/notice/presets/import', adminAuth, (req, res) => {
  try {
    res.json({ ok: true, ...importPresets(req.body || {}) })
  } catch (err) {
    presetFail(res, err)
  }
})

app.put('/api/admin/notice/presets/order', adminAuth, (req, res) => {
  try {
    res.json({ ok: true, presets: reorderPresets((req.body || {}).ids) })
  } catch (err) {
    presetFail(res, err)
  }
})

app.post('/api/admin/notice/presets', adminAuth, (req, res) => {
  try {
    res.status(201).json({ ok: true, preset: createPreset(req.body || {}) })
  } catch (err) {
    presetFail(res, err)
  }
})

app.put('/api/admin/notice/presets/:id', adminAuth, (req, res) => {
  const body = req.body || {}
  try {
    res.json({ ok: true, preset: updatePreset(String(req.params.id), body, { expectedRev: body.rev }) })
  } catch (err) {
    presetFail(res, err)
  }
})

app.delete('/api/admin/notice/presets/:id', adminAuth, (req, res) => {
  if (!deletePreset(String(req.params.id))) return fail(res, 404, '预设不存在')
  res.json({ ok: true })
})

app.post('/api/admin/notice/presets/:id/apply', adminAuth, (req, res) => {
  try {
    const body = req.body || {}
    const { preset, notice } = applyPreset(String(req.params.id), {
      expectedNoticeRev: body.noticeRev,
      targetNoticeId: body.noticeId
    })
    res.json({ ok: true, notice, preset })
  } catch (err) {
    presetFail(res, err)
  }
})

function transferSummary(bucket) {
  return {
    originalBytes: bucket ? bucket.originalBytes || 0 : 0,
    wireBytes: bucket ? bucket.wireBytes || 0 : 0,
    parts: bucket ? bucket.parts || 0 : 0,
    savedBytes: savedBytesOf(bucket)
  }
}

const TRANSFER_DAYS_SHOWN = 7

app.get('/api/admin/list', adminAuth, (req, res) => {
  const transfer = readTransferStats()
  res.json({
    list: listAll().map((meta) => ({
      ...publicInfo(meta),
      storedSize: meta.storedSize || meta.size,
      compressed: Boolean(meta.compression),
      compressionState: meta.compressionState || '',
      crossHashed: meta.storageVersion === 2,
      transfer: transferSummary(transfer.files[meta.code])
    }))
  })
})

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const list = listAll()
  const counters = readCounters()
  const totalSize = list.reduce((sum, meta) => sum + meta.size, 0)
  const totalStoredSize = list.reduce((sum, meta) => sum + (meta.storedSize || meta.size), 0)
  const transferOriginalBytes = counters.transferOriginalBytes
  const transferWireBytes = counters.transferWireBytes
  const transfer = readTransferStats()
  const today = dayKey(Date.now())
  const transferDays = Object.keys(transfer.days)
    .sort()
    .reverse()
    .slice(0, TRANSFER_DAYS_SHOWN)
    .map((date) => ({ date, ...transferSummary(transfer.days[date]) }))
  res.json({
    fileCount: list.length,
    totalSize,
    totalStoredSize,
    savedBytes: Math.max(totalSize - totalStoredSize, 0),
    transferOriginalBytes,
    transferWireBytes,
    transferSavedBytes: Math.max(transferOriginalBytes - transferWireBytes, 0),
    transferToday: { date: today, ...transferSummary(transfer.days[today]) },
    transferDays,
    transferResetAt: transfer.resetAt,
    transferResetCount: transfer.resetCount,
    activeDownloads: list.reduce((sum, meta) => sum + meta.downloads, 0),
    totalUploads: counters.totalUploads,
    totalDownloads: counters.totalDownloads,
    sessionQuota: {
      maxUploadSessionsPerIp: config.maxUploadSessionsPerIp,
      maxDownloadSessionsPerIp: config.maxDownloadSessionsPerIp,
      maxTmpBytesPerIp: config.maxTmpBytesPerIp,
      topIps: usageByIp().slice(0, 10)
    },
    ...crossDedupStats()
  })
})

// 跨文件去重收益（RFC-006 REQ-046）：「若无去重需存字节」= 全部清单的 Σc，实际对象字节 = 被引用对象之和。
function crossDedupStats() {
  const stats = referencedStats()
  const implied = stats.impliedBytes
  const actual = Math.max(stats.bytes, 1)
  return {
    dedupCrossEnabled: config.crossFileDedup,
    dedupCrossManifests: stats.manifests,
    dedupCrossObjects: stats.objects,
    dedupCrossBytes: stats.bytes,
    dedupCrossImpliedBytes: implied,
    dedupCrossSavedBytes: Math.max(implied - stats.bytes, 0),
    dedupCrossRatio: implied > 0 ? Number((implied / actual).toFixed(3)) : 1
  }
}

function csvStamp(ts) {
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

app.get('/api/admin/stats/export', adminAuth, (req, res) => {
  const rows = transferExportRows((code) => {
    const meta = getMeta(code)
    return meta ? meta.filename : ''
  })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="transfer-stats-${csvStamp(Date.now())}.csv"`)
  res.setHeader('Cache-Control', 'no-store')
  res.send(`\uFEFF${toCsv(rows)}`)
})

app.post('/api/admin/stats/reset', adminAuth, (req, res) => {
  if (!req.body || req.body.confirm !== true) return fail(res, 400, '清零需要显式确认')
  const { resetAt, resetCount } = resetTransferStats()
  res.json({ ok: true, resetAt, resetCount })
})

app.delete('/api/admin/:code', adminAuth, (req, res) => {
  const code = parseCode(req.params.code)
  if (!code) return fail(res, 400, '取件码格式不正确')
  removeShare(code)
  res.json({ ok: true })
})

function reasonMessage(reason) {
  if (reason === 'expired') return '该分享已过期'
  if (reason === 'exhausted') return '该文件已被取走'
  return '取件码不存在'
}

registerTransferRoutes(app)

app.use('/api', (req, res) => fail(res, 404, '接口不存在'))

if (hasDist) {
  app.use(express.static(distDir))
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return fail(res, 404, '接口不存在')
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('前端尚未构建，请先执行：npm run build')
  })
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  fail(res, 500, '服务器内部错误')
})

const server = app.listen(config.port, () => {
  console.log(`文件驿站已启动: http://localhost:${config.port}`)
  if (config.generatedAdminKey) {
    console.log(`[提示] ADMIN_KEY 未设置，本次管理密钥为: ${config.adminKey}`)
    console.log('[提示] 写入 .env 可固定该密钥（参考 .env.example）')
  }
  startCleanup()
})

function shutdown() {
  try {
    flushCounters()
  } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
