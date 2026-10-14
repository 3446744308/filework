import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { recordUpload, recordDownload, forgetFileStat } from './stats.js'
import { hasActiveSession } from './sessions.js'
import { CAS_FORMAT } from './compress.js'

const metaPath = (code) => path.join(config.metaDir, `${code}.json`)
const filePath = (code) => path.join(config.filesDir, code)

function readMeta(code) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(code), 'utf8'))
  } catch {
    return null
  }
}

function writeMeta(meta) {
  const target = metaPath(meta.code)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta))
  fs.renameSync(tmp, target)
}

export function getMeta(code) {
  return readMeta(code)
}

// 压缩后台化（backlog B1-2）：元数据是「文件当前是什么形态」的唯一真源，
// 因此压缩完成后才把 compression/units 写进去；任务进行中先标 compressionState='pending'。
export function updateCompression(code, patch = {}) {
  const meta = readMeta(code)
  if (!meta) return null
  const next = { ...meta, ...patch }
  if (!next.compression) {
    delete next.units
    delete next.dedup
  }
  writeMeta(next)
  return next
}

// 压缩边车：改名前先落盘「容器长什么样」，这样进程被杀在「已改名、未回写元数据」之间时
// 也能在启动时把元数据补齐（零丢失）。后缀刻意不用 .json，避免被 meta 目录的扫描器当成分享。
const pendingPath = (code) => path.join(config.metaDir, `${code}.packmeta`)

export function writePendingCompression(code, result) {
  const target = pendingPath(code)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        format: result.format,
        storedSize: result.storedSize,
        units: result.units,
        dedup: result.dedup
      })
    )
    fs.renameSync(tmp, target)
  } catch (err) {
    console.error('[压缩] 边车落盘失败:', err.message)
    return false
  }
  return true
}

function readPendingCompression(code) {
  try {
    const data = JSON.parse(fs.readFileSync(pendingPath(code), 'utf8'))
    if (
      !data ||
      typeof data.format !== 'string' ||
      !data.format ||
      !Number.isFinite(data.storedSize) ||
      !Array.isArray(data.units) ||
      data.units.length === 0
    ) {
      return null
    }
    return data
  } catch {
    return null
  }
}

export function clearPendingCompression(code) {
  try {
    fs.unlinkSync(pendingPath(code))
  } catch {}
}

const PENDING_SETTLE_MS = 15_000

// 下载闸门：compressionState 仍为 pending 时文件濒临／正在被容器替换，
// 而下载计划（ranges/units）在会话建立时就固定了，因此先等任务落定再发计划；
// 超时（大文件压缩较慢）回 busy 让客户端稍后重试，绝不返回可能损坏的字节。
export async function waitForSettledBody(code, timeoutMs = PENDING_SETTLE_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const meta = readMeta(code)
    if (!meta) return { ok: false, reason: 'missing' }
    if (meta.compressionState !== 'pending') return { ok: true, meta }
    if (Date.now() >= deadline) return { ok: false, reason: 'busy' }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// 启动修复：进程被杀可能留下 pending。
// ① 边车存在且文件大小等于容器声明 ⇒ 改名已发生，用边车把元数据补齐（零丢失）；
// ② 否则文件仍是原始字节 ⇒ 回退为未压缩；两种情形都清掉边车与残留 .pack。
export function repairPendingCompressions() {
  let names = []
  try {
    names = fs.readdirSync(config.metaDir)
  } catch {
    return 0
  }
  let repaired = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const code = name.slice(0, -5)
    const meta = readMeta(code)
    if (!meta || meta.compressionState !== 'pending') continue
    let size = -1
    try {
      size = fs.statSync(filePath(code)).size
    } catch {}
    const sidecar = readPendingCompression(code)
    if (sidecar && size === sidecar.storedSize && size !== meta.size) {
      updateCompression(code, {
        compression: sidecar.format,
        compressionState: '',
        storedSize: sidecar.storedSize,
        units: sidecar.units,
        dedup: sidecar.dedup || 0
      })
    } else {
      updateCompression(code, {
        compression: '',
        compressionState: '',
        storedSize: meta.size,
        units: [],
        dedup: 0
      })
    }
    clearPendingCompression(code)
    try {
      fs.unlinkSync(`${filePath(code)}.pack`)
    } catch {}
    repaired += 1
  }
  return repaired
}

// 未压缩文件是 `files/<code>` 单文件（`res.download` 零改动）；清单化容器（CAS）没有该文件，
// 载荷全在 `data/objects/`，因此「主体是否存在」需要按类型判断。
export function bodyAvailable(meta) {
  if (!meta) return false
  if (meta.compression === CAS_FORMAT) return true
  return fs.existsSync(filePath(meta.code))
}

export function removeShare(code) {
  for (const p of [metaPath(code), filePath(code)]) {
    try {
      fs.unlinkSync(p)
    } catch {}
  }
  forgetFileStat(code)
}

export function generateCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(100000, 1000000))
    if (!codeTaken(code)) return code
  }
  throw new Error('取件码生成失败，请稍后重试')
}

export function codeTaken(code) {
  return fs.existsSync(metaPath(code)) || fs.existsSync(filePath(code))
}

export function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex')
}

export function commitUpload(tmpFile, info) {
  let code = info.customCode || ''
  if (code) {
    if (!/^\d{6}$/.test(code)) throw new Error('自定义取件码必须是 6 位数字')
    if (codeTaken(code)) {
      const err = new Error('取件码已被占用')
      err.code = 'CODE_TAKEN'
      throw err
    }
  } else {
    code = generateCode()
  }
  const now = Date.now()
  const meta = {
    code,
    filename: info.filename,
    size: info.size,
    mime: info.mime || 'application/octet-stream',
    note: info.note || '',
    password: info.passwordHash || (info.password ? hashPassword(info.password) : ''),
    createdAt: now,
    expiresAt: now + info.expiresIn * 3600_000,
    maxDownloads: info.maxDownloads,
    downloads: 0,
    compression: info.compression || '',
    storedSize: Number.isFinite(info.storedSize) ? info.storedSize : info.size
  }
  if (info.compressionState) meta.compressionState = info.compressionState
  if (info.storageVersion) meta.storageVersion = info.storageVersion
  if (info.crossHits) meta.crossHits = info.crossHits
  if (info.compression) {
    meta.units = info.units
    meta.dedup = info.dedup || 0
  }
  fs.renameSync(tmpFile, filePath(code))
  try {
    writeMeta(meta)
  } catch (err) {
    removeShare(code)
    throw err
  }
  recordUpload()
  return meta
}

export function verifyPassword(meta, password) {
  if (!meta.password) return true
  return safeEqual(hashPassword(password), meta.password)
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function isActive(meta) {
  return Date.now() <= meta.expiresAt && meta.downloads < meta.maxDownloads
}

export function getActive(code) {
  const meta = readMeta(code)
  if (!meta) return { ok: false, reason: 'not_found' }
  if (Date.now() > meta.expiresAt) {
    if (!hasActiveSession(code)) removeShare(code)
    return { ok: false, reason: 'expired' }
  }
  if (meta.downloads >= meta.maxDownloads) {
    if (!hasActiveSession(code)) removeShare(code)
    return { ok: false, reason: 'exhausted' }
  }
  return { ok: true, meta }
}

export function tryConsume(code) {
  const found = getActive(code)
  if (!found.ok) return found
  const meta = found.meta
  meta.downloads += 1
  const last = meta.downloads >= meta.maxDownloads
  writeMeta(meta)
  recordDownload()
  return { ok: true, meta, last }
}

export function getFileStreamPath(code) {
  return filePath(code)
}

export function listAll() {
  const result = []
  let names = []
  try {
    names = fs.readdirSync(config.metaDir)
  } catch {
    return result
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const code = name.slice(0, -5)
    const meta = readMeta(code)
    if (meta && isActive(meta)) result.push(meta)
  }
  result.sort((a, b) => b.createdAt - a.createdAt)
  return result
}

export function cleanupExpired() {
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(config.metaDir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const code = name.slice(0, -5)
    const meta = readMeta(code)
    if (!meta || !isActive(meta)) {
      if (hasActiveSession(code)) continue
      removeShare(code)
      removed++
    }
  }
  return removed
}

export function publicInfo(meta) {
  return {
    code: meta.code,
    filename: meta.filename,
    size: meta.size,
    mime: meta.mime,
    note: meta.note || '',
    hasPassword: Boolean(meta.password),
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    maxDownloads: meta.maxDownloads,
    downloads: meta.downloads
  }
}
