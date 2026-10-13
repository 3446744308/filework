import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { recordUpload, recordDownload } from './stats.js'

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

export function removeShare(code) {
  for (const p of [metaPath(code), filePath(code)]) {
    try {
      fs.unlinkSync(p)
    } catch {}
  }
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

function hashPassword(password) {
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
    password: info.password ? hashPassword(info.password) : '',
    createdAt: now,
    expiresAt: now + info.expiresIn * 3600_000,
    maxDownloads: info.maxDownloads,
    downloads: 0
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
    removeShare(code)
    return { ok: false, reason: 'expired' }
  }
  if (meta.downloads >= meta.maxDownloads) {
    removeShare(code)
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
      removeShare(code)
      removed++
    }
  }
  return removed
}

export function clearTmp() {
  let names = []
  try {
    names = fs.readdirSync(config.tmpDir)
  } catch {
    return
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(config.tmpDir, name))
    } catch {}
  }
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
