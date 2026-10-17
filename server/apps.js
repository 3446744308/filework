import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const appsPath = path.join(config.dataDir, 'apps.json')

export const APP_TYPES = ['android', 'desktop']

function appsDirOf(type) {
  return path.join(config.appsDir, type)
}

function readApps() {
  const result = { android: null, desktop: null }
  try {
    const data = JSON.parse(fs.readFileSync(appsPath, 'utf8'))
    for (const type of APP_TYPES) {
      const item = data && data[type]
      if (item && typeof item.filename === 'string' && item.filename) {
        result[type] = {
          filename: item.filename,
          size: Number(item.size) || 0,
          uploadedAt: Number(item.uploadedAt) || 0
        }
      }
    }
  } catch {}
  return result
}

function writeApps(data) {
  const tmp = `${appsPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, appsPath)
}

export function getApps() {
  return readApps()
}

export function isAppType(type) {
  return APP_TYPES.includes(type)
}

export function appFilePath(type) {
  const meta = readApps()[type]
  if (!meta) return null
  const target = path.join(appsDirOf(type), meta.filename)
  return fs.existsSync(target) ? target : null
}

function sanitizeFilename(name) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
  return base.slice(0, 120) || 'app.bin'
}

export function saveApp(type, tmpFile, originalName, size) {
  const dir = appsDirOf(type)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const filename = sanitizeFilename(originalName)
  fs.renameSync(tmpFile, path.join(dir, filename))
  const apps = readApps()
  apps[type] = { filename, size: Number(size) || 0, uploadedAt: Date.now() }
  writeApps(apps)
  return apps[type]
}

export function removeApp(type) {
  fs.rmSync(appsDirOf(type), { recursive: true, force: true })
  const apps = readApps()
  apps[type] = null
  writeApps(apps)
  return apps
}

export function appsPublicInfo() {
  const apps = readApps()
  const result = { android: null, desktop: null }
  for (const type of APP_TYPES) {
    const meta = apps[type]
    if (!meta || !appFilePath(type)) continue
    result[type] = { ...meta, url: `/api/app/download?type=${type}` }
  }
  return result
}
