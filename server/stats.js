import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const statsPath = path.join(config.dataDir, 'stats.json')
const transferPath = path.join(config.dataDir, 'transfer-stats.json')
const walPath = path.join(config.dataDir, 'transfer-stats.wal')

const FLUSH_PARTS = 32
const FLUSH_INTERVAL_MS = 2_000
const TRANSFER_VERSION = 1
const TRANSFER_DAYS_KEPT = 30
const TRANSFER_FILES_MAX = 2000
const DAY_MS = 86_400_000

const DEFAULT_COUNTERS = {
  totalUploads: 0,
  totalDownloads: 0,
  transferOriginalBytes: 0,
  transferWireBytes: 0,
  walOffset: 0,
  updatedAt: 0
}

let pending = null
let pendingParts = 0
let pendingDays = null
let pendingFiles = null
let forgottenFiles = null

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

function readCountersFile() {
  return { ...DEFAULT_COUNTERS, ...readJson(statsPath, {}) }
}

function readTransferFile() {
  const data = readJson(transferPath, null)
  if (!data || typeof data !== 'object') {
    return { version: TRANSFER_VERSION, days: {}, files: {}, resetAt: 0, resetCount: 0, updatedAt: 0 }
  }
  return {
    version: TRANSFER_VERSION,
    days: data.days && typeof data.days === 'object' ? data.days : {},
    files: data.files && typeof data.files === 'object' ? data.files : {},
    resetAt: Number.isFinite(data.resetAt) ? data.resetAt : 0,
    resetCount: Number.isFinite(data.resetCount) ? data.resetCount : 0,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0
  }
}

function emptyBucket() {
  return { originalBytes: 0, wireBytes: 0, parts: 0 }
}

function addInto(target, bucket) {
  target.originalBytes += bucket.originalBytes || 0
  target.wireBytes += bucket.wireBytes || 0
  target.parts += bucket.parts || 0
  return target
}

export function dayKey(ts) {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function savedBytesOf(bucket) {
  if (!bucket) return 0
  return Math.max((bucket.originalBytes || 0) - (bucket.wireBytes || 0), 0)
}

export function readCounters() {
  const data = readCountersFile()
  if (pending) {
    data.transferOriginalBytes += pending.originalBytes
    data.transferWireBytes += pending.wireBytes
  }
  return data
}

export function readTransferStats() {
  const data = readTransferFile()
  const days = { ...data.days }
  if (pendingDays) {
    for (const [date, bucket] of pendingDays) {
      days[date] = addInto({ ...(days[date] || emptyBucket()) }, bucket)
    }
  }
  const files = { ...data.files }
  if (pendingFiles) {
    for (const [code, bucket] of pendingFiles) {
      files[code] = addInto({ ...(files[code] || emptyBucket()) }, bucket)
      files[code].updatedAt = bucket.updatedAt
    }
  }
  if (forgottenFiles) {
    for (const code of forgottenFiles) delete files[code]
  }
  return {
    version: TRANSFER_VERSION,
    days,
    files,
    resetAt: data.resetAt,
    resetCount: data.resetCount,
    updatedAt: data.updatedAt
  }
}

export function recordUpload() {
  const data = readCounters()
  data.totalUploads += 1
  data.updatedAt = Date.now()
  writeJson(statsPath, data)
  pending = null
}

export function recordDownload() {
  const data = readCounters()
  data.totalDownloads += 1
  data.updatedAt = Date.now()
  writeJson(statsPath, data)
  pending = null
}

function clearPending() {
  pending = null
  pendingParts = 0
  pendingDays = null
  pendingFiles = null
  forgottenFiles = null
}

function pruneTransfer(data, now) {
  const cutoff = dayKey(now - (TRANSFER_DAYS_KEPT - 1) * DAY_MS)
  for (const date of Object.keys(data.days)) {
    if (date < cutoff) delete data.days[date]
  }
  const codes = Object.keys(data.files)
  if (codes.length <= TRANSFER_FILES_MAX) return
  codes
    .sort((a, b) => (data.files[a].updatedAt || 0) - (data.files[b].updatedAt || 0))
    .slice(0, codes.length - TRANSFER_FILES_MAX)
    .forEach((code) => delete data.files[code])
}

export function flushCounters() {
  const hasTransferWork = pendingParts > 0 || (forgottenFiles && forgottenFiles.size > 0)
  if (!hasTransferWork) return false
  const now = Date.now()
  const counters = readCounters()
  counters.updatedAt = now
  // WAL 全量已被本次刷盘消费，记录偏移以便重启时从断点重放（不会重复累加）。
  if (walEnabled()) counters.walOffset = walSize()
  writeJson(statsPath, counters)
  const transfer = readTransferStats()
  pruneTransfer(transfer, now)
  transfer.updatedAt = now
  writeJson(transferPath, transfer)
  clearPending()
  return true
}

export function forgetFileStat(code) {
  if (!code) return
  if (!forgottenFiles) forgottenFiles = new Set()
  forgottenFiles.add(code)
}

function walEnabled() {
  return config.statsWal === true
}

function walSize() {
  try {
    return fs.statSync(walPath).size
  } catch {
    return 0
  }
}

// 追加日志（backlog B4-8，默认关）：开启后每次记账先落一行 WAL，
// 崩溃重启时从「已被刷盘消费的字节偏移」之后重放，因此不会重复累加。
function appendWal(entry) {
  try {
    fs.appendFileSync(walPath, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.error('[统计] WAL 写入失败:', err.message)
  }
}

function applyTransfer(original, wire, code, now) {
  if (!pending) pending = { originalBytes: 0, wireBytes: 0 }
  pending.originalBytes += original
  pending.wireBytes += wire
  if (!pendingDays) pendingDays = new Map()
  const date = dayKey(now)
  pendingDays.set(date, addInto(pendingDays.get(date) || emptyBucket(), { originalBytes: original, wireBytes: wire, parts: 1 }))
  if (code) {
    if (!pendingFiles) pendingFiles = new Map()
    const file = pendingFiles.get(code) || emptyBucket()
    addInto(file, { originalBytes: original, wireBytes: wire, parts: 1 })
    file.updatedAt = now
    pendingFiles.set(code, file)
  }
  pendingParts += 1
}

export function recordTransfer({ originalBytes, wireBytes, code } = {}) {
  const original = Number.isFinite(originalBytes) && originalBytes > 0 ? Math.round(originalBytes) : 0
  if (original === 0) return
  const wire = Number.isFinite(wireBytes) && wireBytes > 0 ? Math.round(wireBytes) : 0
  if (walEnabled()) appendWal({ o: original, w: wire, c: code || '' })
  applyTransfer(original, wire, code, Date.now())
  if (pendingParts >= FLUSH_PARTS) flushCounters()
}

// 启动重放：只处理「刷盘偏移之后」的记录；半截行（崩溃中断）直接跳过。
export function replayWal() {
  if (!walEnabled() || !fs.existsSync(walPath)) return 0
  let buf
  try {
    buf = fs.readFileSync(walPath)
  } catch {
    return 0
  }
  const stored = Number(readCountersFile().walOffset)
  const offset = Number.isFinite(stored) && stored > 0 ? Math.min(stored, buf.length) : 0
  if (offset >= buf.length) return 0
  let applied = 0
  const now = Date.now()
  for (const line of buf.subarray(offset).toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let entry = null
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const original = Number.isFinite(entry.o) && entry.o > 0 ? Math.round(entry.o) : 0
    if (original === 0) continue
    const wire = Number.isFinite(entry.w) && entry.w > 0 ? Math.round(entry.w) : 0
    applyTransfer(original, wire, typeof entry.c === 'string' ? entry.c : '', now)
    applied += 1
  }
  if (applied > 0) flushCounters()
  return applied
}

export function resetTransferStats(now = Date.now()) {
  const counters = readCounters()
  counters.transferOriginalBytes = 0
  counters.transferWireBytes = 0
  counters.updatedAt = now
  // 清零同时丢弃 WAL 历史（否则重启会把清零前的记录重放回来）。
  if (walEnabled()) counters.walOffset = walSize()
  writeJson(statsPath, counters)
  const transfer = readTransferFile()
  const resetCount = transfer.resetCount + 1
  writeJson(transferPath, {
    version: TRANSFER_VERSION,
    days: {},
    files: {},
    resetAt: now,
    resetCount,
    updatedAt: now
  })
  clearPending()
  return { resetAt: now, resetCount }
}

const EXPORT_HEADER = ['维度', '标识', '文件名', '原始字节', '线上字节', '节省字节', '片数']

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function transferExportRows(nameOf) {
  const data = readTransferStats()
  const rows = [EXPORT_HEADER]
  for (const date of Object.keys(data.days).sort().reverse()) {
    const bucket = data.days[date]
    rows.push([
      '按日',
      date,
      '',
      bucket.originalBytes || 0,
      bucket.wireBytes || 0,
      savedBytesOf(bucket),
      bucket.parts || 0
    ])
  }
  const codes = Object.keys(data.files).sort(
    (a, b) => savedBytesOf(data.files[b]) - savedBytesOf(data.files[a]) || a.localeCompare(b)
  )
  for (const code of codes) {
    const bucket = data.files[code]
    rows.push([
      '按文件',
      code,
      nameOf ? nameOf(code) : '',
      bucket.originalBytes || 0,
      bucket.wireBytes || 0,
      savedBytesOf(bucket),
      bucket.parts || 0
    ])
  }
  return rows
}

export function toCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

const flushTimer = setInterval(() => {
  try {
    flushCounters()
  } catch (err) {
    console.error('[统计] 刷盘失败:', err.message)
  }
}, FLUSH_INTERVAL_MS)
flushTimer.unref()
