import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const settingsPath = path.join(config.dataDir, 'settings.json')

export const LOGO_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
  'image/x-icon': '.ico'
}

const DEFAULT_SETTINGS = {
  siteName: '',
  beian: '',
  gongan: '',
  logo: '',
  maxFileSize: 0,
  blockedExts: [],
  displayMode: 'simple',
  customCodeEnabled: true,
  compressionEnabled: true,
  compressionCodecs: ['br', 'gzip'],
  presetLimit: 0,
  updatedAt: 0
}

const DEFAULT_PRESET_LIMIT = 10

const CODEC_NAMES = ['br', 'gzip']

function normalizeCodecs(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const names = raw
    .map((name) => String(name).trim().toLowerCase())
    .filter((name) => CODEC_NAMES.includes(name))
  return names.includes('br') ? ['br', 'gzip'] : ['gzip']
}

function normalizeExts(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const raw of value.slice(0, 100)) {
    const ext = String(raw ?? '').trim().toLowerCase().replace(/^\.+/, '')
    if (/^[a-z0-9]{1,20}$/.test(ext) && !result.includes(ext)) result.push(ext)
  }
  return result
}

export function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(data) {
  const tmp = `${settingsPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, settingsPath)
}

export function saveSettings(input) {
  const data = getSettings()
  data.siteName = String(input.siteName ?? data.siteName).slice(0, 50).trim()
  data.beian = String(input.beian ?? data.beian).slice(0, 100).trim()
  data.gongan = String(input.gongan ?? data.gongan).slice(0, 100).trim()
  if ('maxFileSize' in input) {
    const value = Number(input.maxFileSize)
    if (Number.isFinite(value) && value > 0) {
      const min = 1024 * 1024
      data.maxFileSize = Math.min(Math.max(Math.round(value), min), config.maxFileSize)
    } else {
      data.maxFileSize = 0
    }
  }
  if ('blockedExts' in input) data.blockedExts = normalizeExts(input.blockedExts)
  if ('displayMode' in input) {
    data.displayMode = input.displayMode === 'waybill' ? 'waybill' : 'simple'
  }
  if ('customCodeEnabled' in input) data.customCodeEnabled = Boolean(input.customCodeEnabled)
  if ('compressionEnabled' in input) data.compressionEnabled = Boolean(input.compressionEnabled)
  if ('compressionCodecs' in input) data.compressionCodecs = normalizeCodecs(input.compressionCodecs)
  if ('presetLimit' in input) {
    // 0 / 非法值 = 回到默认上限；否则钳制到 [1, MAX_NOTICE_PRESETS]。
    const value = Number(input.presetLimit)
    data.presetLimit =
      Number.isFinite(value) && value > 0
        ? Math.max(1, Math.min(Math.round(value), config.maxNoticePresets))
        : 0
  }
  data.updatedAt = Date.now()
  writeSettings(data)
  return data
}

export function getBlockedExts() {
  return normalizeExts(getSettings().blockedExts)
}

export function isCustomCodeEnabled() {
  return getSettings().customCodeEnabled !== false
}

export function getCompressionEnabled() {
  return getSettings().compressionEnabled !== false
}

export function getCompressionCodecs() {
  const allowed = config.compressionCodecs
  const wanted = normalizeCodecs(getSettings().compressionCodecs)
  const effective = wanted.filter((name) => allowed.includes(name))
  if (effective.length > 0) return effective
  return allowed.includes('gzip') ? ['gzip'] : allowed
}

export function getCompressionCodecCap() {
  return config.compressionCodecs
}

// 公告预设上限：站点设置可调（0 = 默认 10），env `MAX_NOTICE_PRESETS` 同时是默认硬上限。
export function effectivePresetLimit() {
  const cap = config.maxNoticePresets
  const stored = Number(getSettings().presetLimit)
  const wanted = Number.isFinite(stored) && stored > 0 ? Math.round(stored) : DEFAULT_PRESET_LIMIT
  return Math.max(1, Math.min(wanted, cap))
}

export function effectiveMaxFileSize() {
  const value = getSettings().maxFileSize
  if (!Number.isFinite(value) || value <= 0) return config.maxFileSize
  return Math.min(value, config.maxFileSize)
}

function logoFiles() {
  let names = []
  try {
    names = fs.readdirSync(config.dataDir)
  } catch {
    return []
  }
  return names.filter((name) => /^logo\.[a-z0-9]+$/i.test(name))
}

export function logoFilePath() {
  const ext = getSettings().logo
  if (!ext) return null
  const target = path.join(config.dataDir, `logo${ext}`)
  return fs.existsSync(target) ? target : null
}

export function saveLogo(tmpFile, ext) {
  for (const name of logoFiles()) {
    try {
      fs.unlinkSync(path.join(config.dataDir, name))
    } catch {}
  }
  const target = path.join(config.dataDir, `logo${ext}`)
  fs.renameSync(tmpFile, target)
  const data = getSettings()
  data.logo = ext
  data.updatedAt = Date.now()
  writeSettings(data)
  return data
}

export function removeLogo() {
  for (const name of logoFiles()) {
    try {
      fs.unlinkSync(path.join(config.dataDir, name))
    } catch {}
  }
  const data = getSettings()
  data.logo = ''
  data.updatedAt = Date.now()
  writeSettings(data)
  return data
}
