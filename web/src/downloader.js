import { api } from './api.js'
import { readLocalJson, writeLocalJson, removeLocal } from './utils.js'

const MAX_CONCURRENCY = 8
const MIN_CONCURRENCY = 2
const RETRIES = 2
const RAMP_AFTER = 3
const MEMORY_BUDGET = 32 * 1024 * 1024
const STAGE_PREFIX = 'fs-download-'
const STAGE_KEEP_MS = 120_000
// 每 N 个分片提交一次暂存：提交（close）会把已写内容与旧内容整体落盘，逐片提交在
// 大文件上会拖慢落盘（实测 875KB×16 片逐片提交多花约 1s），批量提交兼顾续写粒度与开销。
const STAGE_COMMIT_PARTS = 4

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchPart(url, signal) {
  let lastErr = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const res = await fetch(url, { signal })
      if (res.ok) {
        const buffer = await res.arrayBuffer()
        return {
          buffer,
          codec: res.headers.get('x-transfer-codec') || '',
          wire: Number(res.headers.get('content-length')) || buffer.byteLength
        }
      }
      let data = null
      try {
        data = await res.json()
      } catch {}
      const err = new Error((data && data.error) || `分片下载失败（${res.status}）`)
      err.status = res.status
      if (res.status >= 400 && res.status < 500) throw err
      lastErr = err
    } catch (err) {
      if (err.name === 'AbortError') throw err
      if (err.status && err.status < 500) throw err
      lastErr = err
    }
    await sleep(300 * (attempt + 1))
  }
  throw lastErr || new Error('分片下载失败')
}

export function canStreamToDisk() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

// OPFS 暂存（backlog B4-10）：先把文件写进源私有文件系统的暂存文件，完成后一次性导出给用户，
// 因此内存不再随文件大小增长。每个分片写入后立即 close 提交，所以「暂存文件大小」恒等于
// 已落盘前缀，刷新后按该大小续写即可做到字节级续传（ADR-012 修订二实测结论）。
export function canUseOpfs() {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage) &&
    typeof navigator.storage.getDirectory === 'function'
  )
}

export function stagedName(code) {
  return `${STAGE_PREFIX}${code}.part`
}

async function stagedHandle(code, create) {
  if (!canUseOpfs()) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getFileHandle(stagedName(code), { create })
  } catch {
    return null
  }
}

async function stagedSize(handle) {
  try {
    const file = await handle.getFile()
    return file.size
  } catch {
    return 0
  }
}

async function dropStaged(code) {
  if (!canUseOpfs()) return
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(stagedName(code))
  } catch {}
}

// 已落盘前缀必须正好覆盖若干个完整分片，否则暂存残留不可信（丢弃后从头重写）。
export function stagedResume(ranges, written) {
  if (!written) return { index: 0, offset: 0 }
  let offset = 0
  for (let i = 0; i < ranges.length; i++) {
    offset += ranges[i].end - ranges[i].start
    if (offset === written) return { index: i + 1, offset }
    if (offset > written) return null
  }
  return offset === written ? { index: ranges.length, offset } : null
}

async function openStagedWriter(handle, offset) {
  const writable = await handle.createWritable({ keepExistingData: true })
  await writable.seek(offset)
  return writable
}

// 多标签互斥：同一取件码的暂存写入串行化；拿不到锁的一方回退纯内存拼装。
async function acquireStagedLock(code) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null
  if (!locks || typeof locks.request !== 'function') return { ok: true, release: () => {} }
  let release = () => {}
  const hold = new Promise((resolve) => {
    release = resolve
  })
  let settleGranted
  const granted = new Promise((resolve) => {
    settleGranted = resolve
  })
  locks.request(`fs-download-${code}`, { ifAvailable: true }, (lock) => {
    settleGranted(Boolean(lock))
    return lock ? hold : undefined
  })
  const ok = await granted
  return { ok, release }
}

export function planRanges(session) {
  if (Array.isArray(session.units) && session.units.length > 0) {
    return session.units.map((range) => ({ start: range[0], end: range[1] }))
  }
  const size = Number(session.size) || 0
  const partSize = Number(session.partSize) > 0 ? Number(session.partSize) : size || 1
  const ranges = []
  for (let start = 0; start < size; start += partSize) {
    ranges.push({ start, end: Math.min(start + partSize, size) })
  }
  return ranges
}

export function initialConcurrency(session, ranges) {
  const unitBytes = ranges.length > 0 ? (Number(session.size) || 0) / ranges.length : 0
  const memoryCap = unitBytes > 0 ? Math.floor(MEMORY_BUDGET / unitBytes) : MAX_CONCURRENCY
  const suggested = Number(session.parallel) > 0 ? Number(session.parallel) : 4
  const byMemory = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, memoryCap))
  return Math.max(1, Math.min(MAX_CONCURRENCY, suggested, byMemory, ranges.length))
}

function saveBlobToDisk(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), STAGE_KEEP_MS)
}

export async function parallelDownload({
  code,
  password = '',
  filename = 'download',
  onProgress,
  signal
}) {
  const localKey = `fs-download:${code}`
  const saved = readLocalJson(localKey)
  let session = null
  let resumed = false
  if (saved && saved.token) {
    try {
      const status = await api.downloadStatus(saved.token)
      if (status.filename === filename && Number(status.size) === Number(saved.size)) {
        session = status
        resumed = true
      }
    } catch {
      session = null
    }
  }
  if (!session) removeLocal(localKey)

  // 用户在手势期选定的目标文件优先级最高：直接写用户句柄（无暂存，因此不跨刷新续写）。
  let handle = null
  if (canStreamToDisk()) {
    handle = await window.showSaveFilePicker({ suggestedName: filename })
  }

  let staged = null
  if (!handle && canUseOpfs()) {
    const fileHandle = await stagedHandle(code, true)
    if (fileHandle) {
      let size = await stagedSize(fileHandle)
      // 没有可续用的会话（上次已完成/已过期）时不保留旧暂存，避免残留长度污染结果。
      if (!resumed && size > 0) {
        await dropStaged(code)
        size = 0
      }
      staged = { handle: fileHandle, size }
    }
  }

  if (!session) {
    try {
      session = await api.createDownloadSession(code, password)
      writeLocalJson(localKey, {
        token: session.token,
        filename: session.filename,
        size: session.size,
        updatedAt: Date.now()
      })
    } catch (err) {
      if (handle) {
        try {
          await handle.remove()
        } catch {}
      }
      if (staged) await dropStaged(code)
      throw err
    }
  }

  const controller = new AbortController()
  const abortFromOutside = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abortFromOutside, { once: true })
  }

  const ranges = planRanges(session)
  const total = ranges.length
  const size = Number(session.size) || 0

  let stagedIndex = 0
  let stagedOffset = 0
  if (staged && staged.size > 0) {
    const point = staged.size <= size ? stagedResume(ranges, staged.size) : null
    if (point) {
      stagedIndex = point.index
      stagedOffset = point.offset
    } else {
      await dropStaged(code)
      staged = { handle: await stagedHandle(code, true), size: 0 }
      if (!staged.handle) staged = null
    }
  }
  let stagedSink = staged && staged.handle ? staged : null
  const lock = stagedSink ? await acquireStagedLock(code) : null
  if (stagedSink && lock && !lock.ok) {
    // 另一标签正在写同一暂存文件 ⇒ 本次回退内存拼装（暂存前缀用不上，必须整份重取）。
    stagedSink = null
    stagedIndex = 0
    stagedOffset = 0
  }

  const slots = new Array(total)
  for (let i = 0; i < total; i++) {
    const slot = {}
    slot.promise = new Promise((resolve, reject) => {
      slot.resolve = resolve
      slot.reject = reject
    })
    slot.promise.catch(() => {})
    slots[i] = slot
  }
  for (let i = 0; i < stagedIndex; i++) slots[i].resolve(null)

  let loaded = stagedSink ? stagedOffset : 0
  let wire = 0
  let codec = ''
  let firstError = null
  let succeeded = false
  let concurrency = initialConcurrency(session, ranges)
  let active = 0
  let launched = stagedSink ? stagedIndex : 0
  let successes = 0

  const report = () => {
    if (!onProgress) return
    onProgress({
      loaded,
      wire,
      codec,
      resumed: resumed || stagedOffset > 0,
      staged: stagedSink ? stagedOffset : 0,
      total: size,
      percent: size ? Math.round((loaded / size) * 100) : 100
    })
  }

  const run = (index) => {
    const { start, end } = ranges[index]
    const expected = end - start
    active += 1
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      active -= 1
    }
    fetchPart(api.downloadPartUrl(session.token, index), controller.signal)
      .then((part) => {
        if (part.buffer.byteLength !== expected) {
          throw new Error('分片数据校验失败，请重试')
        }
        successes += 1
        loaded += expected
        wire += part.wire
        if (!codec && part.codec) codec = part.codec
        release()
        slots[index].resolve(part.buffer)
        report()
        if (successes % RAMP_AFTER === 0 && concurrency < MAX_CONCURRENCY && concurrency < total) {
          concurrency += 1
        }
        pump()
      })
      .catch((err) => {
        release()
        if (!firstError) firstError = err
        if (concurrency > MIN_CONCURRENCY) {
          concurrency = Math.max(MIN_CONCURRENCY, Math.ceil(concurrency / 2))
        }
        slots[index].reject(err)
        controller.abort()
      })
  }

  const pump = () => {
    while (!firstError && active < concurrency && launched < total) {
      run(launched++)
    }
  }

  const writeAll = async (write) => {
    for (let i = 0; i < total; i++) {
      let buffer
      try {
        buffer = await slots[i].promise
      } catch (err) {
        throw firstError || err
      }
      await write(buffer, i)
    }
  }

  const downloadIntoStaged = async () => {
    pump()
    let writable = null
    let pending = 0
    const commit = async () => {
      if (!writable) return
      const handle = writable
      writable = null
      pending = 0
      await handle.close()
    }
    try {
      await writeAll(async (buffer, i) => {
        if (!buffer) return
        const { start } = ranges[i]
        if (!writable) writable = await openStagedWriter(stagedSink.handle, start)
        await writable.write(new Uint8Array(buffer))
        stagedOffset = start + buffer.byteLength
        pending += 1
        if (pending >= STAGE_COMMIT_PARTS) await commit()
        report()
      })
      await commit()
    } catch (err) {
      if (writable) {
        try {
          await writable.abort()
        } catch {}
      }
      throw err
    }
    // OPFS 文件直接交给 blob URL：浏览器按需从磁盘读取，不会整份进内存。
    const file = await stagedSink.handle.getFile()
    saveBlobToDisk(file, filename)
    setTimeout(() => {
      dropStaged(code)
    }, STAGE_KEEP_MS)
  }

  try {
    if (handle) {
      const writable = await handle.createWritable()
      pump()
      try {
        await writeAll(async (buffer) => {
          await writable.write(new Uint8Array(buffer))
        })
        await writable.close()
      } catch (err) {
        try {
          await writable.abort()
        } catch {}
        throw err
      }
    } else if (stagedSink) {
      try {
        await downloadIntoStaged()
      } finally {
        if (lock) lock.release()
      }
    } else {
      pump()
      const buffers = new Array(total)
      await writeAll(async (buffer, i) => {
        buffers[i] = buffer
      })
      saveBlobToDisk(new Blob(buffers), filename)
    }
    succeeded = true
    return { filename, size, codec, wire, resumed }
  } finally {
    if (signal) signal.removeEventListener('abort', abortFromOutside)
    if (succeeded) {
      removeLocal(localKey)
      api.endDownloadSession(session.token).catch(() => {})
    }
  }
}
