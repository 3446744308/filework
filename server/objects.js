import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'

// 跨文件内容寻址对象存储（RFC-006 / ADR-015，backlog B4-2）。
// 对象名 = 载荷 sha256 全量 64 位十六进制（不做截断：碰撞后果是「甲的字节被乙替换」）；
// 引用计数不落盘，由清单（data/meta/*.json 的 units[].h）派生，GC 是唯一删除路径。

const HASH_RE = /^[0-9a-f]{64}$/

export function isObjectHash(value) {
  return typeof value === 'string' && HASH_RE.test(value)
}

export function objectPath(hash) {
  return path.join(config.objectsDir, hash.slice(0, 2), hash.slice(2))
}

export function hasObject(hash) {
  return isObjectHash(hash) && fs.existsSync(objectPath(hash))
}

export function objectSize(hash) {
  try {
    return fs.statSync(objectPath(hash)).size
  } catch {
    return -1
  }
}

export function readObject(hash) {
  try {
    return fs.readFileSync(objectPath(hash))
  } catch {
    return null
  }
}

export function streamObject(res, hash, onError) {
  const stream = fs.createReadStream(objectPath(hash))
  stream.on('error', onError)
  stream.pipe(res)
}

// 原子落盘（tmp + rename，ADR-009 惯例）；对象已存在则跳过写入（命中），只回计数。
export function writeObject(payload) {
  const hash = crypto.createHash('sha256').update(payload).digest('hex')
  const target = objectPath(hash)
  if (fs.existsSync(target)) return { hash, bytes: payload.length, hit: true }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, payload)
  fs.renameSync(tmp, target)
  return { hash, bytes: payload.length, hit: false }
}

function listObjectHashes() {
  const result = []
  let buckets = []
  try {
    buckets = fs.readdirSync(config.objectsDir)
  } catch {
    return result
  }
  for (const bucket of buckets) {
    if (bucket.length !== 2 || !/^[0-9a-f]{2}$/.test(bucket)) continue
    let names = []
    try {
      names = fs.readdirSync(path.join(config.objectsDir, bucket))
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) continue
      result.push(`${bucket}${name}`)
    }
  }
  return result
}

// 被引用集合：扫描全部清单，收集 units[].h（全站规模 ≪ 10⁵，一次扫描毫秒级）。
export function collectManifests() {
  const refs = new Set()
  const manifests = []
  let names = []
  try {
    names = fs.readdirSync(config.metaDir)
  } catch {
    return { refs, manifests }
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(path.join(config.metaDir, name), 'utf8'))
    } catch {
      continue
    }
    const units = Array.isArray(meta?.units) ? meta.units : []
    const hashed = units.filter((unit) => isObjectHash(unit.h))
    if (hashed.length === 0) continue
    manifests.push({ code: meta.code, units: hashed })
    for (const unit of hashed) refs.add(unit.h)
  }
  return { refs, manifests }
}

export function objectStats() {
  let objects = 0
  let bytes = 0
  for (const hash of listObjectHashes()) {
    const size = objectSize(hash)
    if (size < 0) continue
    objects += 1
    bytes += size
  }
  return { objects, bytes }
}

// 只统计「被清单引用」的对象字节（孤儿不算入收益比，避免刚写完对象、清单未落盘时虚高）。
export function referencedStats() {
  const { refs, manifests } = collectManifests()
  let objects = 0
  let bytes = 0
  let impliedBytes = 0
  for (const hash of refs) {
    const size = objectSize(hash)
    if (size < 0) continue
    objects += 1
    bytes += size
  }
  for (const manifest of manifests) {
    for (const unit of manifest.units) impliedBytes += unit.c
  }
  return { objects, bytes, impliedBytes, manifests: manifests.length }
}

let lastGcAt = 0
let lastGcRemoved = 0

export function dedupState() {
  const stats = objectStats()
  return {
    enabled: config.crossFileDedup,
    objects: stats.objects,
    bytes: stats.bytes,
    lastGcAt,
    lastGcRemoved
  }
}

// 标记-清扫：不在请求路径上执行；无引用且 mtime 早于宽限期的对象才回收
// （宽限期保护「对象已写、清单未写」的崩溃窗口与「清单已删、响应流在途」的下载窗口）。
export function sweepObjects({ graceMs = config.dedupGcGraceMs, now = Date.now() } = {}) {
  const { refs } = collectManifests()
  let removed = 0
  let bytes = 0
  for (const hash of listObjectHashes()) {
    if (refs.has(hash)) continue
    const file = objectPath(hash)
    let stat = null
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (now - stat.mtimeMs <= graceMs) continue
    try {
      fs.unlinkSync(file)
      removed += 1
      bytes += stat.size
    } catch {}
  }
  lastGcAt = now
  lastGcRemoved = removed
  return { removed, bytes, refs: refs.size }
}
