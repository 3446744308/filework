import fs from 'node:fs'
import crypto from 'node:crypto'

const READ_WINDOW = 1024 * 1024
const MIN_CHUNK = 16 * 1024
const HASH_HEX_LENGTH = 32
const MASK_BITS_MIN = 4
const MASK_BITS_MAX = 24

const GEAR = buildGearTable()

function buildGearTable() {
  const table = new Uint32Array(256)
  let state = 0x9e3779b9 >>> 0
  for (let i = 0; i < 256; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    table[i] = state >>> 0
  }
  return table
}

export function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, HASH_HEX_LENGTH)
}

export function chunkBounds(size, config) {
  const target = chunkPlan(size, config)
  const min = Math.max(Math.floor(target.unit / 4), MIN_CHUNK)
  const max = Math.max(target.unit, Math.min(min, size))
  return { min, avg: target.unit, max }
}

export function chunkPlan(size, config) {
  if (!Number.isFinite(size) || size <= 0) return { unit: 0, count: 0 }
  let unit = Math.ceil(size / config.unitTargetCount)
  unit = Math.max(config.unitMinSize, Math.min(config.unitMaxSize, unit))
  let count = Math.ceil(size / unit)
  if (count > config.unitMaxCount) {
    unit = Math.ceil(size / config.unitMaxCount)
    count = Math.ceil(size / unit)
  }
  return { unit, count }
}

export function uniformRanges(size, unit) {
  const ranges = []
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(unit) || unit <= 0) return ranges
  for (let start = 0; start < size; start += unit) {
    ranges.push([start, Math.min(start + unit, size)])
  }
  return ranges
}

export function downloadRanges(size, config) {
  const plan = chunkPlan(size, config)
  if (plan.count > config.unitMaxCount) {
    return uniformRanges(size, Math.ceil(size / config.unitMaxCount))
  }
  return uniformRanges(size, plan.unit)
}

export function maskBits(avg, min) {
  const expected = Math.max(avg - min, 1024)
  const bits = Math.round(Math.log2(expected))
  return Math.max(MASK_BITS_MIN, Math.min(MASK_BITS_MAX, bits))
}

export function chunkRanges(buffer, { min, avg, max, maxCount }) {
  const size = buffer.length
  if (size === 0) return []
  const floor = Math.min(min, size)
  if (size <= floor) return [[0, size]]
  const mask = (1 << maskBits(avg, floor)) - 1
  const ranges = []
  let start = 0
  let hash = 0
  for (let i = 0; i < size; i++) {
    hash = ((hash << 1) + GEAR[buffer[i]]) >>> 0
    const length = i + 1 - start
    if (length >= max || (length >= floor && (hash & mask) === 0)) {
      ranges.push([start, i + 1])
      start = i + 1
      hash = 0
      if (ranges.length > maxCount) return null
    }
  }
  if (start < size) ranges.push([start, size])
  if (ranges.length > maxCount) return null
  return ranges
}

export function chunkFile(fd, size, { min, avg, max, maxCount }) {
  if (size === 0) return []
  const floor = Math.min(min, size)
  if (size <= floor) return [[0, size]]
  const mask = (1 << maskBits(avg, floor)) - 1
  const ranges = []
  const window = Buffer.allocUnsafe(Math.min(READ_WINDOW, size))
  let pos = 0
  let start = 0
  let hash = 0
  while (pos < size) {
    const read = fs.readSync(fd, window, 0, window.length, pos)
    if (read <= 0) break
    for (let i = 0; i < read; i++) {
      hash = ((hash << 1) + GEAR[window[i]]) >>> 0
      const absolute = pos + i + 1
      const length = absolute - start
      if (length >= max || (length >= floor && (hash & mask) === 0)) {
        ranges.push([start, absolute])
        start = absolute
        hash = 0
        if (ranges.length > maxCount) return null
      }
    }
    pos += read
  }
  if (start < size) ranges.push([start, size])
  if (ranges.length > maxCount) return null
  return ranges
}

export function unitRanges(units) {
  const ranges = []
  let cursor = 0
  for (const unit of units) {
    ranges.push([cursor, cursor + unit.r])
    cursor += unit.r
  }
  return ranges
}

// 清单化容器（CAS）的覆盖自检：无文件内偏移，靠 Σr == size 与合法对象哈希保证无缝覆盖。
export function unitsCoverageHashed(units, size) {
  if (!Array.isArray(units) || units.length === 0) return false
  let cursor = 0
  for (const unit of units) {
    if (typeof unit.h !== 'string' || !/^[0-9a-f]{64}$/.test(unit.h)) return false
    if (!Number.isInteger(unit.c) || unit.c <= 0) return false
    if (!Number.isInteger(unit.r) || unit.r <= 0) return false
    cursor += unit.r
  }
  return cursor === size
}

export function unitsCoverage(units, size) {
  if (!Array.isArray(units) || units.length === 0) return false
  let cursor = 0
  for (const unit of units) {
    if (!Number.isInteger(unit.o) || unit.o < 0) return false
    if (!Number.isInteger(unit.c) || unit.c <= 0) return false
    if (!Number.isInteger(unit.r) || unit.r <= 0) return false
    if (unit.d !== undefined && !Number.isInteger(unit.d)) return false
    cursor += unit.r
  }
  return cursor === size
}
