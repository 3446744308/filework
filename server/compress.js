import fs from 'node:fs'
import { config } from './config.js'
import {
  CODEC_BROTLI,
  CODEC_GZIP,
  CODEC_RAW,
  decodePayload,
  encodeUnit
} from './codec.js'
import {
  chunkBounds,
  chunkFile,
  contentHash,
  downloadRanges,
  uniformRanges,
  unitRanges,
  unitsCoverage,
  unitsCoverageHashed
} from './units.js'
import { isObjectHash, objectSize, readObject, streamObject, writeObject } from './objects.js'

export const COMPRESSION_FORMAT = 'units-v2'
// 跨文件去重（RFC-006 / ADR-015）使用清单化容器：既有 `units-v2` 是内嵌容器，
// 不能被重新定义（会让已存文件被误判），因此新格式另取 `units-v3`。用 meta.storageVersion:2 标记。
export const CAS_FORMAT = 'units-v3'
export const CAS_STORAGE_VERSION = 2

const SKIP_MIME_PREFIX = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'video/',
  'audio/',
  'application/zip',
  'application/x-rar',
  'application/x-7z',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd'
]

const SKIP_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic',
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
  'zip', 'rar', '7z', 'gz', 'xz', 'zst', 'bz2', 'tgz'
])

export function isCompressible(mime, filename) {
  const type = String(mime || '').toLowerCase()
  if (SKIP_MIME_PREFIX.some((prefix) => type.startsWith(prefix))) return false
  const ext = String(filename || '').split('.').pop().toLowerCase()
  return !SKIP_EXTS.has(ext)
}

function metaCorrupt() {
  const err = new Error('压缩元数据损坏')
  err.code = 'META_CORRUPT'
  return err
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd)
  } catch {}
}

function readAt(fd, start, length) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const read = fs.readSync(fd, buffer, filled, length - filled, start + filled)
    if (read <= 0) break
    filled += read
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

function normalizeCasUnits(meta) {
  if (!Array.isArray(meta.units) || meta.units.length === 0) return null
  return meta.units.map((unit) => ({
    h: unit.h,
    c: unit.c,
    r: unit.r,
    z: unit.z === undefined || unit.z === null ? CODEC_RAW : unit.z
  }))
}

function normalizeUnits(meta) {
  if (Array.isArray(meta.units) && meta.units.length > 0) {
    return meta.units.map((unit) => ({
      o: unit.o,
      c: unit.c,
      r: unit.r,
      z: unit.z === 0 ? CODEC_RAW : unit.z === 1 ? CODEC_GZIP : unit.z,
      d: Number.isInteger(unit.d) ? unit.d : undefined
    }))
  }
  if (Array.isArray(meta.blocks) && meta.blocks.length > 0) {
    return meta.blocks.map((block) => ({
      o: block.o,
      c: block.c,
      r: block.r,
      z: block.z === 0 ? CODEC_RAW : CODEC_GZIP
    }))
  }
  return null
}

export function downloadUnits(meta) {
  if (!meta || !meta.compression) return null
  if (meta.compression === CAS_FORMAT) {
    const units = normalizeCasUnits(meta)
    if (!units || !unitsCoverageHashed(units, meta.size)) throw metaCorrupt()
    return units
  }
  const units = normalizeUnits(meta)
  if (!units || !unitsCoverage(units, meta.size)) throw metaCorrupt()
  return units
}

export function downloadPlan(meta, runtime = config) {
  const units = downloadUnits(meta)
  if (units) return { compressed: true, cas: Boolean(units[0] && units[0].h), units, ranges: unitRanges(units) }
  return { compressed: false, cas: false, units: null, ranges: downloadRanges(meta.size, runtime) }
}

// 逐单元从存储态读取（内嵌容器按 fd 偏移，清单化容器按对象哈希）。
function readUnitStored(fd, unit) {
  if (unit.h) {
    const buffer = readObject(unit.h)
    if (!buffer || buffer.length !== unit.c) throw metaCorrupt()
    return buffer
  }
  return readAt(fd, unit.o, unit.c)
}

// 载荷可用性：对象存在且长度等于清单声明（CAS）／文件内偏移合法（内嵌容器）。
export function unitsPayloadOk(units, storedSize = 0) {
  return units.every((unit) =>
    unit.h ? isObjectHash(unit.h) && objectSize(unit.h) === unit.c : unitPayloadFits(unit, storedSize)
  )
}

// 按下载计划校验载荷完整性（未压缩文件无需校验）；调用方失败时报「文件损坏」。
export function planPayloadOk(plan, filePath) {
  if (!plan.compressed) return true
  return unitsPayloadOk(plan.units, plan.cas ? 0 : storedSizeOf(filePath))
}

// 打包（不改名）：只产出 `<filePath>.pack` 与元数据，是否落位由调用方决定。
// 压缩后台化（backlog B1-2）需要「先写边车、再改名、最后回写元数据」的顺序，
// 因此这里不再自行 rename，避免调用方在元数据落定前就看到新形态的字节。
async function packUnits(filePath, size, codecs) {
  const packPath = `${filePath}.pack`
  const bounds = chunkBounds(size, config)
  const fd = fs.openSync(filePath, 'r')
  const out = fs.openSync(packPath, 'w')
  let result = null
  try {
    let ranges = chunkFile(fd, size, {
      min: bounds.min,
      avg: bounds.avg,
      max: bounds.max,
      maxCount: config.unitMaxCount
    })
    if (!ranges) ranges = uniformRanges(size, Math.ceil(size / config.unitMaxCount))
    const units = []
    const seen = new Map()
    let offset = 0
    let dedup = 0
    for (const [start, end] of ranges) {
      const raw = readAt(fd, start, end - start)
      const hash = contentHash(raw)
      const hit = seen.get(hash)
      if (hit !== undefined) {
        const source = units[hit]
        units.push({ o: source.o, c: source.c, r: source.r, z: source.z, d: hit })
        dedup += 1
        continue
      }
      const encoded = await encodeUnit(raw, codecs)
      fs.writeSync(out, encoded.buffer, 0, encoded.buffer.length, offset)
      units.push({ o: offset, c: encoded.buffer.length, r: raw.length, z: encoded.codec })
      seen.set(hash, units.length - 1)
      offset += encoded.buffer.length
    }
    if (offset < size && unitsCoverage(units, size)) {
      result = { ok: true, storedSize: offset, units, dedup }
    } else {
      result = { ok: false }
    }
  } finally {
    closeQuietly(fd)
    closeQuietly(out)
    if (!result || !result.ok) {
      try {
        fs.unlinkSync(packPath)
      } catch {}
    }
  }
  if (!result.ok) return { ...result, packPath }
  return { ...result, packPath }
}

// 产出压缩容器（不强求收益，无收益时返回 ok:false 并自行清理 .pack）。
export async function packContainer(filePath, { mime, filename, enabled, codecs }) {
  if (!enabled || !isCompressible(mime, filename)) return null
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    return null
  }
  if (size <= 0) return null
  const candidates = Array.isArray(codecs) && codecs.length > 0 ? codecs : config.compressionCodecs
  try {
    const result = await packUnits(filePath, size, candidates)
    return result.ok ? result : null
  } catch (err) {
    console.error('[压缩] 失败，保留原始文件:', err.message)
    return null
  }
}

export function discardPack(packPath) {
  try {
    fs.unlinkSync(packPath)
  } catch {}
}

// 清单化容器：每个单元写入全局对象存储，命中既有对象则不写盘（跨文件去重）。
// 接受条件：整体有压缩收益，或至少命中一个既有对象（跨文件命中本身就是收益）。
async function packObjects(filePath, size, codecs) {
  const bounds = chunkBounds(size, config)
  const fd = fs.openSync(filePath, 'r')
  try {
    let ranges = chunkFile(fd, size, {
      min: bounds.min,
      avg: bounds.avg,
      max: bounds.max,
      maxCount: config.unitMaxCount
    })
    if (!ranges) ranges = uniformRanges(size, Math.ceil(size / config.unitMaxCount))
    const units = []
    let storedSize = 0
    let hits = 0
    for (const [start, end] of ranges) {
      const raw = readAt(fd, start, end - start)
      const encoded = await encodeUnit(raw, codecs)
      const written = writeObject(encoded.buffer)
      if (written.hit) hits += 1
      units.push({ h: written.hash, c: encoded.buffer.length, r: raw.length, z: encoded.codec })
      storedSize += encoded.buffer.length
    }
    if (storedSize >= size && hits === 0) return { ok: false }
    if (!unitsCoverageHashed(units, size)) return { ok: false }
    return { ok: true, storedSize, units, dedup: 0, crossHits: hits }
  } finally {
    closeQuietly(fd)
  }
}

export async function packManifest(filePath, { mime, filename, enabled, codecs }) {
  if (!enabled || !isCompressible(mime, filename)) return null
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    return null
  }
  if (size <= 0) return null
  const candidates = Array.isArray(codecs) && codecs.length > 0 ? codecs : config.compressionCodecs
  try {
    const result = await packObjects(filePath, size, candidates)
    return result.ok ? result : null
  } catch (err) {
    console.error('[去重] 对象打包失败，保留原始文件:', err.message)
    return null
  }
}

export function storedSizeOf(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function openBodyIfNeeded(filePath, units) {
  if (!units.some((unit) => !unit.h)) return -1
  return fs.openSync(filePath, 'r')
}

export async function readUnit(filePath, unit) {
  const fd = openBodyIfNeeded(filePath, [unit])
  try {
    return await decodePayload(unit.z, readUnitStored(fd, unit))
  } finally {
    if (fd >= 0) closeQuietly(fd)
  }
}

export async function readRanges(filePath, units, start, end) {
  const fd = openBodyIfNeeded(filePath, units)
  try {
    const chunks = []
    let pos = 0
    for (const unit of units) {
      const unitStart = pos
      const unitEnd = pos + unit.r
      pos = unitEnd
      if (unitEnd <= start || unitStart >= end) continue
      const stored = readUnitStored(fd, unit)
      const raw = await decodePayload(unit.z, stored)
      chunks.push(
        raw.subarray(Math.max(start - unitStart, 0), Math.min(end - unitStart, unit.r))
      )
    }
    return Buffer.concat(chunks)
  } finally {
    if (fd >= 0) closeQuietly(fd)
  }
}

export function unitPayloadFits(unit, storedSize) {
  return unit.o >= 0 && unit.c > 0 && unit.o + unit.c <= storedSize
}

// 传输直通（store 模式）：内嵌容器按偏移流式读出，清单化容器直接流式读对象。
export function streamStoredPayload(res, filePath, unit) {
  const onError = () => {
    if (!res.headersSent) {
      res.status(500).json({ error: '下载失败，请重试' })
      return
    }
    res.destroy()
  }
  if (unit.h) return streamObject(res, unit.h, onError)
  return streamPayload(res, filePath, unit.o, unit.c)
}

export function streamPayload(res, filePath, offset, length) {
  const stream = fs.createReadStream(filePath, { start: offset, end: offset + length - 1 })
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: '下载失败，请重试' })
      return
    }
    res.destroy()
  })
  stream.pipe(res)
}

function contentDisposition(filename) {
  const name = String(filename || 'download')
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function drain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

export async function streamOriginal(res, filePath, meta, units) {
  res.setHeader('Content-Type', meta.mime || 'application/octet-stream')
  res.setHeader('Content-Length', String(meta.size))
  res.setHeader('Content-Disposition', contentDisposition(meta.filename))
  res.setHeader('Accept-Ranges', 'none')
  const fd = openBodyIfNeeded(filePath, units)
  try {
    for (const unit of units) {
      const stored = readUnitStored(fd, unit)
      const raw = await decodePayload(unit.z, stored)
      if (res.destroyed) return
      if (!res.write(raw)) await drain(res)
    }
    if (!res.destroyed) res.end()
  } finally {
    if (fd >= 0) closeQuietly(fd)
  }
}
