import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

const DOWNLOAD_TTL_MS = 10 * 60_000
const UPLOAD_TTL_MS = 30 * 60_000
const UPLOAD_VERSION = 1

const downloadSessions = new Map()
const uploadSessions = new Map()

export function createDownloadSession(code, ip = '') {
  const token = crypto.randomBytes(16).toString('hex')
  downloadSessions.set(token, { code, ip: normalizeIp(ip), expiresAt: Date.now() + DOWNLOAD_TTL_MS })
  return token
}

function normalizeIp(ip) {
  return String(ip ?? '').slice(0, 64)
}

// 会话配额记账：只统计未过期会话，过期会话即便尚未被 sweep 也不占用配额。
export function countDownloadSessions(ip) {
  const key = normalizeIp(ip)
  const now = Date.now()
  let count = 0
  for (const session of downloadSessions.values()) {
    if (session.ip === key && now <= session.expiresAt) count += 1
  }
  return count
}

export function uploadTmpUsage(ip) {
  const key = normalizeIp(ip)
  const now = Date.now()
  let count = 0
  let bytes = 0
  for (const session of uploadSessions.values()) {
    if (session.ip !== key || now > session.expiresAt) continue
    count += 1
    bytes += session.size
  }
  return { count, bytes }
}

// 运维可见性（backlog B7-3）：按 IP 汇总**未过期**会话用量，口径与配额判定完全同源
// （同一批 Map、同一套过期判定），因此不会出现「仪表盘显示没超，却被 429」。
// 空 IP 归入 `''` 桶（旧版位图无 ip 字段时恢复的会话）。
export function usageByIp() {
  const now = Date.now()
  const buckets = new Map()
  const bucketOf = (ip) => {
    const key = normalizeIp(ip)
    if (!buckets.has(key)) {
      buckets.set(key, { ip: key, uploadSessions: 0, downloadSessions: 0, tmpBytes: 0 })
    }
    return buckets.get(key)
  }
  for (const session of downloadSessions.values()) {
    if (now > session.expiresAt) continue
    bucketOf(session.ip).downloadSessions += 1
  }
  for (const session of uploadSessions.values()) {
    if (now > session.expiresAt) continue
    const bucket = bucketOf(session.ip)
    bucket.uploadSessions += 1
    bucket.tmpBytes += Number(session.size) || 0
  }
  return [...buckets.values()].sort(
    (a, b) =>
      b.tmpBytes - a.tmpBytes ||
      b.uploadSessions + b.downloadSessions - (a.uploadSessions + a.downloadSessions)
  )
}

export function getDownloadSession(token) {
  const session = downloadSessions.get(token)
  if (!session || Date.now() > session.expiresAt) return null
  return session
}

export function dropDownloadSession(token) {
  downloadSessions.delete(token)
}

export function markSessionPart(token, key) {
  const session = getDownloadSession(token)
  if (!session) return false
  if (!session.counted) session.counted = new Set()
  if (session.counted.has(key)) return false
  session.counted.add(key)
  return true
}

export function hasActiveSession(code) {
  const now = Date.now()
  for (const session of downloadSessions.values()) {
    if (session.code === code && now <= session.expiresAt) return true
  }
  return false
}

export function sweepDownloadSessions() {
  const now = Date.now()
  const expired = []
  for (const [token, session] of downloadSessions) {
    if (now > session.expiresAt) {
      downloadSessions.delete(token)
      expired.push(session)
    }
  }
  return expired
}

function persistUploadSession(session) {
  const target = session.metaFile
  const tmp = `${target}.tmp`
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: UPLOAD_VERSION,
        uploadId: session.uploadId,
        partSize: session.partSize,
        totalParts: session.totalParts,
        size: session.size,
        ip: session.ip,
        fields: session.fields,
        received: [...session.received].sort((a, b) => a - b),
        expiresAt: session.expiresAt
      })
    )
    fs.renameSync(tmp, target)
  } catch (err) {
    console.error('[上传会话] 位图落盘失败:', err.message)
  }
}

function removeUploadFiles(session) {
  for (const file of [session.tmpFile, session.metaFile]) {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
}

export function createUploadSession({ tmpDir, partSize, totalParts, size, fields, ip = '' }) {
  const uploadId = crypto.randomBytes(12).toString('hex')
  const session = {
    uploadId,
    partSize,
    totalParts,
    size,
    ip: normalizeIp(ip),
    fields,
    received: new Set(),
    tmpFile: path.join(tmpDir, `${uploadId}.bin`),
    metaFile: path.join(tmpDir, `${uploadId}.json`),
    expiresAt: Date.now() + UPLOAD_TTL_MS
  }
  uploadSessions.set(uploadId, session)
  persistUploadSession(session)
  return session
}

export function getUploadSession(uploadId) {
  const session = uploadSessions.get(uploadId)
  if (!session || Date.now() > session.expiresAt) return null
  return session
}

export function markUploadPart(session, index) {
  if (!session || !Number.isInteger(index)) return session
  session.received.add(index)
  persistUploadSession(session)
  return session
}

export function dropUploadSession(uploadId) {
  const session = uploadSessions.get(uploadId)
  uploadSessions.delete(uploadId)
  if (session) removeUploadFiles(session)
}

export function sweepUploadSessions() {
  const now = Date.now()
  const expired = []
  for (const [uploadId, session] of uploadSessions) {
    if (now > session.expiresAt) {
      uploadSessions.delete(uploadId)
      removeUploadFiles(session)
      expired.push(uploadId)
    }
  }
  return expired
}

function sessionFromMeta(tmpDir, uploadId, data) {
  const valid =
    data &&
    typeof data === 'object' &&
    data.version === UPLOAD_VERSION &&
    Number.isFinite(data.expiresAt) &&
    data.expiresAt > Date.now() &&
    Number.isInteger(data.partSize) &&
    data.partSize > 0 &&
    Number.isInteger(data.totalParts) &&
    data.totalParts > 0 &&
    Number.isFinite(data.size) &&
    data.size > 0 &&
    data.fields &&
    typeof data.fields === 'object' &&
    Array.isArray(data.received) &&
    data.received.every((index) => Number.isInteger(index) && index >= 0 && index < data.totalParts)
  if (!valid) return null
  const tmpFile = path.join(tmpDir, `${uploadId}.bin`)
  if (!fs.existsSync(tmpFile)) return null
  return {
    uploadId,
    partSize: data.partSize,
    totalParts: data.totalParts,
    size: data.size,
    // 旧版本位图无 ip 字段：恢复后归入空 IP 桶，不占用任何真实 IP 的配额。
    ip: normalizeIp(data.ip),
    fields: data.fields,
    received: new Set(data.received),
    tmpFile,
    metaFile: path.join(tmpDir, `${uploadId}.json`),
    expiresAt: data.expiresAt
  }
}

export function restoreUploadSessions(tmpDir) {
  let names = []
  try {
    names = fs.readdirSync(tmpDir)
  } catch {
    return 0
  }
  const restored = new Set()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const uploadId = name.slice(0, -5)
    const metaFile = path.join(tmpDir, name)
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    } catch {}
    const session = sessionFromMeta(tmpDir, uploadId, data)
    if (!session) {
      try {
        fs.unlinkSync(metaFile)
      } catch {}
      try {
        fs.unlinkSync(path.join(tmpDir, `${uploadId}.bin`))
      } catch {}
      continue
    }
    uploadSessions.set(uploadId, session)
    restored.add(uploadId)
  }
  for (const name of names) {
    if (name.endsWith('.json')) continue
    const uploadId = name.endsWith('.bin') ? name.slice(0, -4) : ''
    if (uploadId && restored.has(uploadId)) continue
    try {
      fs.unlinkSync(path.join(tmpDir, name))
    } catch {}
  }
  return restored.size
}
