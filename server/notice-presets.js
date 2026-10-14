import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { normalizeNotice, saveNotice } from './notice.js'
import { effectivePresetLimit } from './settings.js'

const presetsPath = path.join(config.dataDir, 'notice-presets.json')

const NAME_MAX = 50
const GROUP_MAX = 20
const STORE_VERSION = 1
const EXPORT_FORMAT = 'file-share-notice-presets'
const EXPORT_VERSION = 1
const MAX_IMPORT_ITEMS = 200

function presetError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function emptyStore() {
  return { version: STORE_VERSION, presets: [] }
}

// 存储层上限：始终不小于运行上限，保证调低上限时既有预设不被静默删除。
function storeCap() {
  return Math.max(config.maxNoticePresets, effectivePresetLimit())
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(presetsPath, 'utf8'))
    if (!Array.isArray(data.presets)) return emptyStore()
    const presets = data.presets
      .filter((preset) => preset && typeof preset.id === 'string' && preset.id)
      .map((preset, index) => ({
        id: preset.id,
        name: normalizeName(preset.name, normalizeNotice(preset.notice), index + 1),
        group: normalizeGroup(preset.group),
        notice: stripNotice(normalizeNotice(preset.notice)),
        order: normalizeOrder(preset.order, index + 1),
        rev: normalizeRev(preset.rev),
        createdAt: Number.isFinite(Number(preset.createdAt)) ? Number(preset.createdAt) : 0,
        updatedAt: Number.isFinite(Number(preset.updatedAt)) ? Number(preset.updatedAt) : 0,
        appliedAt: Number.isFinite(Number(preset.appliedAt)) ? Number(preset.appliedAt) : 0,
        appliedBy: String(preset.appliedBy ?? '').slice(0, 32),
        appliedCount: Number.isFinite(Number(preset.appliedCount)) ? Number(preset.appliedCount) : 0
      }))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .slice(0, storeCap())
    return { version: STORE_VERSION, presets }
  } catch {
    return emptyStore()
  }
}

function writeStore(store) {
  const tmp = `${presetsPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, presetsPath)
}

function normalizeOrder(value, fallback) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeRev(value) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

// 预设保存的是「公告样式快照」：不带 updatedAt/rev，避免把时间戳与版本号带进公告写入。
function stripNotice(notice) {
  const { updatedAt, rev, ...rest } = notice
  return rest
}

// 分组：仅作展示归类，不参与 order（order 仍是全局唯一）；空串 = 未分组。
function normalizeGroup(value) {
  return String(value ?? '').slice(0, GROUP_MAX).trim()
}

function normalizeName(name, notice, index) {
  const trimmed = String(name ?? '').slice(0, NAME_MAX).trim()
  if (trimmed) return trimmed
  if (notice.title) return notice.title.slice(0, NAME_MAX)
  return `预设 ${index}`
}

function presetPayload(input = {}, index) {
  const source = input.notice && typeof input.notice === 'object' ? input.notice : input
  const notice = stripNotice(normalizeNotice(source))
  return {
    name: normalizeName(input.name, notice, index),
    group: normalizeGroup(input.group),
    notice
  }
}

function nextOrder(presets) {
  return presets.reduce((max, preset) => Math.max(max, preset.order || 0), 0) + 1
}

// 审计标识口径：无管理员身份体系，用管理密钥指纹（sha256 前 8 位）区分操作者；
// 换密钥即换标识，指纹无法反推密钥，且仅对已鉴权的管理端可见。
export function adminFingerprint() {
  return `key:${crypto.createHash('sha256').update(String(config.adminKey)).digest('hex').slice(0, 8)}`
}

export function listPresets() {
  return readStore().presets
}

export function createPreset(input = {}) {
  const store = readStore()
  const limit = effectivePresetLimit()
  if (store.presets.length >= Math.min(limit, storeCap())) {
    throw presetError(
      'PRESET_LIMIT',
      `预设数量已达上限（最多 ${Math.min(limit, storeCap())} 个），请先删除或在站点设置中调整上限`
    )
  }
  const now = Date.now()
  const preset = {
    id: crypto.randomBytes(8).toString('hex'),
    ...presetPayload(input, store.presets.length + 1),
    order: nextOrder(store.presets),
    rev: 1,
    createdAt: now,
    updatedAt: now,
    appliedAt: 0,
    appliedBy: '',
    appliedCount: 0
  }
  store.presets.push(preset)
  writeStore(store)
  return preset
}

export function updatePreset(id, input = {}, { expectedRev } = {}) {
  const store = readStore()
  const index = store.presets.findIndex((preset) => preset.id === id)
  if (index < 0) throw presetError('PRESET_NOT_FOUND', '预设不存在')
  const current = store.presets[index]
  if (Number.isFinite(Number(expectedRev)) && Math.floor(Number(expectedRev)) !== current.rev) {
    throw presetError('PRESET_CONFLICT', '预设已被其他管理端修改，请刷新后重试')
  }
  const preset = {
    ...current,
    ...presetPayload(
      {
        name: input.name ?? current.name,
        group: input.group ?? current.group,
        notice: input.notice ?? current.notice
      },
      index + 1
    ),
    rev: current.rev + 1,
    updatedAt: Date.now()
  }
  store.presets[index] = preset
  writeStore(store)
  return preset
}

export function deletePreset(id) {
  const store = readStore()
  const index = store.presets.findIndex((preset) => preset.id === id)
  if (index < 0) return false
  store.presets.splice(index, 1)
  writeStore(store)
  return true
}

// 排序：按传入 id 顺序重排，未列出的预设保持原有相对顺序排在末尾。
export function reorderPresets(ids) {
  const store = readStore()
  const incoming = Array.isArray(ids) ? ids.map((id) => String(id)) : []
  const ordered = []
  for (const id of incoming) {
    if (store.presets.some((preset) => preset.id === id) && !ordered.includes(id)) ordered.push(id)
  }
  if (ordered.length === 0) {
    throw presetError('PRESET_ORDER_INVALID', '排序列表为空或与现有预设不匹配')
  }
  const byId = new Map(store.presets.map((preset) => [preset.id, preset]))
  const rest = store.presets.filter((preset) => !ordered.includes(preset.id)).map((p) => p.id)
  store.presets = [...ordered, ...rest].map((id, index) => ({ ...byId.get(id), order: index + 1 }))
  writeStore(store)
  return store.presets
}

export function exportPresets() {
  const presets = listPresets().map((preset) => ({
    name: preset.name,
    group: preset.group,
    notice: preset.notice
  }))
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    count: presets.length,
    presets
  }
}

function uniqueName(base, taken) {
  const trimmed = String(base ?? '').slice(0, NAME_MAX).trim() || '导入预设'
  if (!taken.has(trimmed)) {
    taken.add(trimmed)
    return trimmed
  }
  for (let n = 2; n <= 99; n++) {
    const suffix = `（${n}）`
    const candidate = `${trimmed.slice(0, NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  const fallback = `${trimmed.slice(0, NAME_MAX - 6)}（导入）`
  taken.add(fallback)
  return fallback
}

export function importPresets(input = {}) {
  const mode = input.mode === 'replace' ? 'replace' : 'merge'
  if (!Array.isArray(input.presets)) {
    throw presetError('IMPORT_INVALID', '导入内容缺少 presets 数组')
  }
  if (input.format && input.format !== EXPORT_FORMAT) {
    throw presetError('IMPORT_INVALID', `导出文件格式不匹配（期望 ${EXPORT_FORMAT}）`)
  }
  if (Number(input.version) > EXPORT_VERSION) {
    throw presetError('IMPORT_INVALID', '导出文件版本高于当前服务，无法导入')
  }
  const entries = input.presets
  if (entries.length === 0) throw presetError('IMPORT_INVALID', '导入内容为空')
  if (entries.length > MAX_IMPORT_ITEMS) {
    throw presetError('IMPORT_INVALID', `单次最多导入 ${MAX_IMPORT_ITEMS} 条`)
  }
  if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw presetError('IMPORT_INVALID', '导入条目必须是对象（{ name, notice }）')
  }

  const store = mode === 'replace' ? emptyStore() : readStore()
  const capacity = Math.min(storeCap(), effectivePresetLimit())
  const taken = new Set(store.presets.map((preset) => preset.name))
  const now = Date.now()
  let imported = 0
  let skipped = 0

  for (const entry of entries) {
    if (store.presets.length >= capacity) {
      skipped += 1
      continue
    }
    const payload = presetPayload(entry, store.presets.length + 1)
    const name = uniqueName(payload.name, taken)
    store.presets.push({
      id: crypto.randomBytes(8).toString('hex'),
      name,
      group: payload.group,
      notice: payload.notice,
      order: nextOrder(store.presets),
      rev: 1,
      createdAt: now,
      updatedAt: now,
      appliedAt: 0,
      appliedBy: '',
      appliedCount: 0
    })
    imported += 1
  }

  writeStore(store)
  return {
    mode,
    imported,
    skipped,
    limit: capacity,
    total: store.presets.length,
    presets: store.presets
  }
}

// 启用目标：缺省落到 id === 'default' 的公告（RFC-007 REQ-054），可显式指定目标公告。
export function applyPreset(id, { expectedNoticeRev, targetNoticeId } = {}) {
  const store = readStore()
  const index = store.presets.findIndex((preset) => preset.id === id)
  if (index < 0) throw presetError('PRESET_NOT_FOUND', '预设不存在')
  const current = store.presets[index]
  // 先写公告（可能因并发冲突抛错），成功后再记审计，避免失败却留下审计痕迹。
  const notice = saveNotice(current.notice, {
    expectedRev: expectedNoticeRev,
    targetId: targetNoticeId
  })
  const applied = {
    ...current,
    appliedAt: notice.updatedAt,
    appliedBy: adminFingerprint(),
    appliedCount: current.appliedCount + 1
  }
  store.presets[index] = applied
  writeStore(store)
  return { preset: applied, notice }
}
