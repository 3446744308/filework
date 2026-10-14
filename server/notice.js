import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const noticesPath = path.join(config.dataDir, 'notices.json')
const legacyPath = path.join(config.dataDir, 'notice.json')

const STORE_VERSION = 2
const DEFAULT_ID = 'default'
const DEFAULT_PRIORITY = 50

const DISPLAY_MODES = ['modal', 'bar', 'both']
const POSITIONS = ['top', 'bottom', 'fixed-top', 'fixed-bottom']
const SCROLLS = ['none', 'left', 'right', 'up', 'bounce']
const COLOR_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/
const FONT_SIZE_RANGE = [12, 24]
const RADIUS_RANGE = [0, 16]
const OPACITY_RANGE = [50, 100]
const MAX_LINES_OPTIONS = [1, 2, 3]

const DEFAULT_NOTICE = {
  id: DEFAULT_ID,
  enabled: false,
  title: '',
  content: '',
  display: 'modal',
  position: 'top',
  scroll: 'left',
  scrollFill: false,
  bgColor: '',
  textColor: '',
  fontSize: 0,
  radius: 0,
  opacity: 0,
  maxLines: 1,
  priority: DEFAULT_PRIORITY,
  startAt: null,
  endAt: null,
  rev: 1,
  updatedAt: 0
}

function normalizeColor(value) {
  const match = COLOR_RE.exec(String(value ?? '').trim())
  if (!match) return ''
  const hex = match[1].toLowerCase()
  const full = hex.length === 3 ? [...hex].map((char) => char + char).join('') : hex
  return `#${full}`
}

function normalizeRev(value) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

// 样式数值（字号/圆角/透明度）：合法范围内按整数采用，否则回落 0（= 跟随默认主题）。
function normalizeStyleNumber(value, [min, max]) {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : 0
}

// 纵向公告条行数上限：只接受 1/2/3，其余（含缺省）回落 1 行（与旧行为一致）。
function normalizeMaxLines(value) {
  const parsed = Math.round(Number(value))
  return MAX_LINES_OPTIONS.includes(parsed) ? parsed : 1
}

// 单条公告的样式归一化：读写共用，因此旧文件缺字段会自动补齐、非法枚举/颜色自动回落。
// 预设快照直接复用本函数（因此预设天然不含 id/priority/时间窗，见 ADR-014）。
export function normalizeNotice(input = {}) {
  const content = String(input.content ?? '').slice(0, 2000).trim()
  return {
    enabled: Boolean(input.enabled) && Boolean(content),
    title: String(input.title ?? '').slice(0, 100).trim(),
    content,
    display: DISPLAY_MODES.includes(input.display) ? input.display : DEFAULT_NOTICE.display,
    position: POSITIONS.includes(input.position) ? input.position : DEFAULT_NOTICE.position,
    scroll: SCROLLS.includes(input.scroll) ? input.scroll : DEFAULT_NOTICE.scroll,
    scrollFill: Boolean(input.scrollFill),
    bgColor: normalizeColor(input.bgColor),
    textColor: normalizeColor(input.textColor),
    fontSize: normalizeStyleNumber(input.fontSize, FONT_SIZE_RANGE),
    radius: normalizeStyleNumber(input.radius, RADIUS_RANGE),
    opacity: normalizeStyleNumber(input.opacity, OPACITY_RANGE),
    maxLines: normalizeMaxLines(input.maxLines),
    rev: normalizeRev(input.rev),
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : 0
  }
}

function normalizeId(value, fallback = '') {
  const id = String(value ?? '').trim()
  if (ID_RE.test(id)) return id
  return fallback
}

function normalizePriority(value) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_PRIORITY
}

function normalizeTime(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

// 数组条目 = 样式字段 + id/priority/时间窗。时间窗非法（endAt ≤ startAt）时把 endAt 置空，
// 视为「一直有效到手动关闭」，避免出现永不生效的条目。
function normalizeEntry(input = {}, fallbackId = '') {
  const startAt = normalizeTime(input.startAt)
  let endAt = normalizeTime(input.endAt)
  if (startAt !== null && endAt !== null && endAt <= startAt) endAt = null
  return {
    id: normalizeId(input.id, fallbackId),
    ...normalizeNotice(input),
    priority: normalizePriority(input.priority),
    startAt,
    endAt
  }
}

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

function conflictError(message = '公告已被其他管理端修改，请刷新后重试') {
  const err = new Error(message)
  err.code = 'NOTICE_CONFLICT'
  return err
}

function limitError() {
  const err = new Error(`公告数量已达上限（最多 ${config.maxNotices} 条），请先删除或合并`)
  err.code = 'NOTICE_LIMIT'
  return err
}

function notFoundError() {
  const err = new Error('公告不存在')
  err.code = 'NOTICE_NOT_FOUND'
  return err
}

function emptyStore() {
  return { version: STORE_VERSION, rev: 1, notices: [] }
}

// 读盘容错：逐项过滤（id 必须合法且不重复）→ 归一化 → 截断到 MAX_NOTICES。
function normalizeStore(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.notices)) return null
  const seen = new Set()
  const notices = []
  for (const raw of data.notices) {
    if (!raw || typeof raw !== 'object') continue
    const entry = normalizeEntry(raw, '')
    if (!entry.id || seen.has(entry.id)) continue
    seen.add(entry.id)
    notices.push(entry)
    if (notices.length >= config.maxNotices) break
  }
  const rev = Math.floor(Number(data.rev))
  return {
    version: STORE_VERSION,
    rev: Number.isFinite(rev) && rev > 0 ? rev : 1,
    notices
  }
}

function migrateLegacy() {
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
    return {
      version: STORE_VERSION,
      rev: 1,
      notices: [normalizeEntry({ ...legacy, id: DEFAULT_ID }, DEFAULT_ID)]
    }
  } catch {
    return null
  }
}

function writeMirror(store) {
  const winner = activeEntries(store).at(0)
  const shape = winner ? { ...winner } : { ...DEFAULT_NOTICE, id: DEFAULT_ID }
  shape.rev = store.rev
  try {
    const tmp = `${legacyPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(shape, null, 2))
    fs.renameSync(tmp, legacyPath)
  } catch {}
}

function writeStore(store) {
  const tmp = `${noticesPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, noticesPath)
  writeMirror(store)
}

function readStore() {
  if (!fs.existsSync(noticesPath)) {
    const migrated = migrateLegacy()
    if (migrated) {
      try {
        writeStore(migrated)
      } catch {}
      return migrated
    }
    return emptyStore()
  }
  try {
    const store = normalizeStore(JSON.parse(fs.readFileSync(noticesPath, 'utf8')))
    return store || emptyStore()
  } catch {
    return emptyStore()
  }
}

function isActive(entry, now) {
  if (!entry.enabled || !entry.content) return false
  if (entry.startAt !== null && now < entry.startAt) return false
  if (entry.endAt !== null && now >= entry.endAt) return false
  return true
}

// 仲裁序：priority desc → updatedAt desc → id 升序。最后一级保证完全并列时结果确定。
function compareRank(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function activeEntries(store, now = Date.now()) {
  return store.notices.filter((entry) => isActive(entry, now)).sort(compareRank)
}

// 管理端列表：返回文件级 rev（乐观锁）与按仲裁序排好的全部条目（含未生效/已过期）。
export function noticeSnapshot() {
  const store = readStore()
  return {
    rev: store.rev,
    limit: config.maxNotices,
    notices: [...store.notices].sort(compareRank)
  }
}

export function listActiveNotices() {
  return activeEntries(readStore())
}

// 公开接口：顶层 = 最高优先级胜者（老前端与首页弹窗零改动），另加按仲裁序排好的 notices[]。
export function getNotice() {
  const store = readStore()
  const active = activeEntries(store)
  const shape = active.length > 0 ? { ...active[0] } : { ...DEFAULT_NOTICE }
  shape.rev = store.rev
  return { ...shape, notices: active.map((entry) => ({ ...entry })) }
}

// 兼容单条写入（PUT /api/notice 与预设启用）：默认落到 id === 'default' 的条目。
export function saveNotice(input = {}, { expectedRev, targetId = DEFAULT_ID } = {}) {
  const store = readStore()
  if (Number.isFinite(Number(expectedRev)) && Math.floor(Number(expectedRev)) !== store.rev) {
    throw conflictError()
  }
  return upsert(store, normalizeId(targetId, DEFAULT_ID), input)
}

function upsert(store, id, input) {
  const index = store.notices.findIndex((entry) => entry.id === id)
  const current = index >= 0 ? store.notices[index] : null
  const entry = {
    ...normalizeEntry({ ...input, id }, current ? current.id : id || newId()),
    rev: (current ? current.rev : 0) + 1,
    updatedAt: Date.now()
  }
  if (index >= 0) store.notices[index] = entry
  else {
    if (store.notices.length >= config.maxNotices) throw limitError()
    store.notices.push(entry)
  }
  store.rev += 1
  writeStore(store)
  return entry
}

export function createNotice(input = {}) {
  const store = readStore()
  const requested = normalizeId(input.id, '')
  if (requested && store.notices.some((entry) => entry.id === requested)) {
    throw conflictError('同名公告已存在')
  }
  return upsert(store, requested || newId(), input)
}

export function updateNotice(id, input = {}, { expectedRev } = {}) {
  const store = readStore()
  const index = store.notices.findIndex((entry) => entry.id === id)
  if (index < 0) throw notFoundError()
  const current = store.notices[index]
  if (Number.isFinite(Number(expectedRev)) && Math.floor(Number(expectedRev)) !== current.rev) {
    throw conflictError()
  }
  return upsert(store, id, input)
}

export function deleteNotice(id) {
  const store = readStore()
  const index = store.notices.findIndex((entry) => entry.id === id)
  if (index < 0) return false
  store.notices.splice(index, 1)
  store.rev += 1
  writeStore(store)
  return true
}

// 运维可观测性：总数 / 有效数 / 当前胜者 / 下一次时间窗边界（无则 null）。
export function noticeStats(now = Date.now()) {
  const store = readStore()
  const active = activeEntries(store, now)
  let nextChangeAt = null
  for (const entry of store.notices) {
    for (const boundary of [entry.startAt, entry.endAt]) {
      if (boundary !== null && boundary > now) {
        nextChangeAt = nextChangeAt === null ? boundary : Math.min(nextChangeAt, boundary)
      }
    }
  }
  return {
    total: store.notices.length,
    active: active.length,
    winnerId: active.length > 0 ? active[0].id : '',
    nextChangeAt
  }
}
