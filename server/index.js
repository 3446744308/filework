import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import multer from 'multer'
import { config, ensureDirs } from './config.js'
import {
  commitUpload,
  getActive,
  tryConsume,
  getFileStreamPath,
  listAll,
  removeShare,
  clearTmp,
  clearInvalid,
  isActive,
  publicInfo,
  verifyPassword
} from './store.js'
import { startCleanup } from './cleanup.js'
import { missGuard, rateGuard } from './rate-limit.js'
import { isPreviewable, previewKind } from '../shared/preview.js'
import {
  createFeedback,
  listFeedback,
  updateFeedbackStatus,
  removeFeedback,
  findFeedbackByCode,
  getReplyTemplates,
  saveReplyTemplates,
  FEEDBACK_STATUSES
} from './feedback.js'
import { getNotice, saveNotice } from './notice.js'
import { readCounters } from './stats.js'
import {
  getApps,
  appsPublicInfo,
  appFilePath,
  saveApp,
  removeApp,
  isAppType
} from './apps.js'
import {
  getSettings,
  saveSettings,
  saveLogo,
  removeLogo,
  logoFilePath,
  effectiveMaxFileSize,
  getBlockedExts,
  isCustomCodeEnabled,
  isPreviewEnabled,
  LOGO_TYPES
} from './settings.js'

ensureDirs()
clearTmp()

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
      'beian',
      'gongan',
      'feedback',
      'preview',
      'apps'
    ]
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
  res.json({ ok: true, notice: saveNotice(req.body || {}) })
})

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
    previewEnabled: settings.previewEnabled !== false,
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

app.get('/api/apps', (req, res) => res.json(appsPublicInfo()))

app.get('/api/app/download', rateGuard(config.uploadLimitPerMinute), (req, res) => {
  const type = String(req.query.type ?? '')
  if (!isAppType(type)) return fail(res, 400, 'type 仅支持 android 或 desktop')
  const target = appFilePath(type)
  if (!target) return fail(res, 404, '暂未提供该客户端下载')
  const meta = getApps()[type]
  res.download(target, meta.filename, (err) => {
    if (err && !res.headersSent) fail(res, 500, '下载失败，请重试')
  })
})

const appUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.tmpDir),
    filename: (req, file, cb) => cb(null, `app-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  }),
  limits: { fileSize: config.appMaxFileSize, files: 1 }
})

app.post('/api/admin/apps/:type', adminAuth, (req, res) => {
  const type = String(req.params.type ?? '')
  if (!isAppType(type)) return fail(res, 400, 'type 仅支持 android 或 desktop')
  appUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 413, `安装包不能超过 ${Math.floor(config.appMaxFileSize / 1024 / 1024)}MB`)
      }
      return fail(res, 400, '上传失败：' + err.message)
    }
    if (!req.file) return fail(res, 400, '请选择安装包文件')
    const cleanup = () => fs.unlink(req.file.path, () => {})
    try {
      const app = saveApp(type, req.file.path, req.file.originalname, req.file.size)
      res.json({ ok: true, type, app })
    } catch (e) {
      cleanup()
      fail(res, 500, '保存失败：' + e.message)
    }
  })
})

app.delete('/api/admin/apps/:type', adminAuth, (req, res) => {
  const type = String(req.params.type ?? '')
  if (!isAppType(type)) return fail(res, 400, 'type 仅支持 android 或 desktop')
  res.json({ ok: true, apps: removeApp(type) })
})

app.post('/api/upload', rateGuard(config.uploadLimitPerMinute), (req, res) => {
  const maxFileSize = effectiveMaxFileSize()
  makeUpload(maxFileSize).single('file')(req, res, (err) => {
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
      const meta = commitUpload(req.file.path, {
        filename: req.file.originalname || '未命名文件',
        size: req.file.size,
        mime: req.file.mimetype,
        note,
        password,
        customCode,
        expiresIn,
        maxDownloads
      })
      res.status(201).json({ ...publicInfo(meta), clientIp: req.ip })
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

app.get('/api/download', missGuard(config.rateLimitMisses), (req, res) => {
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
  const result = tryConsume(code)
  if (!result.ok) return fail(res, 404, reasonMessage(result.reason))
  const target = getFileStreamPath(code)
  if (!fs.existsSync(target)) {
    removeShare(code)
    return fail(res, 404, '文件已不存在')
  }
  res.download(target, result.meta.filename, (err) => {
    if (err && !res.headersSent) fail(res, 500, '下载失败，请重试')
  })
})

app.get('/api/preview', missGuard(config.rateLimitMisses), (req, res) => {
  if (!isPreviewEnabled()) return fail(res, 403, '预览功能已关闭')
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
  if (!isPreviewable(found.meta.mime, found.meta.filename, found.meta.size)) {
    return fail(res, 400, '该文件类型不支持预览，仅支持图片、视频与文本')
  }
  const result = tryConsume(code)
  if (!result.ok) return fail(res, 404, reasonMessage(result.reason))
  const target = getFileStreamPath(code)
  if (!fs.existsSync(target)) {
    removeShare(code)
    return fail(res, 404, '文件已不存在')
  }
  const kind = previewKind(result.meta.mime, result.meta.filename, result.meta.size)
  let type = result.meta.mime || 'application/octet-stream'
  if (kind === 'text' && !type.startsWith('text/')) type = 'text/plain; charset=utf-8'
  else if (type.startsWith('text/') && !type.includes('charset')) type += '; charset=utf-8'
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.meta.filename)}`)
  res.sendFile(target, (err) => {
    if (err && !res.headersSent) fail(res, 500, '预览失败，请重试')
  })
})

app.get('/api/admin/ping', adminAuth, (req, res) => res.json({ ok: true }))

app.get('/api/admin/list', adminAuth, (req, res) => {
  res.json({ list: listAll().map(publicInfo) })
})

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const active = listAll().filter(isActive)
  const counters = readCounters()
  res.json({
    fileCount: active.length,
    totalSize: active.reduce((sum, meta) => sum + meta.size, 0),
    activeDownloads: active.reduce((sum, meta) => sum + meta.downloads, 0),
    totalUploads: counters.totalUploads,
    totalDownloads: counters.totalDownloads
  })
})

app.delete('/api/admin/expired', adminAuth, (req, res) => {
  res.json({ ok: true, removed: clearInvalid() })
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
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
