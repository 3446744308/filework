import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const statsPath = path.join(config.dataDir, 'stats.json')

const DEFAULT_COUNTERS = { totalUploads: 0, totalDownloads: 0, updatedAt: 0 }

export function readCounters() {
  try {
    return { ...DEFAULT_COUNTERS, ...JSON.parse(fs.readFileSync(statsPath, 'utf8')) }
  } catch {
    return { ...DEFAULT_COUNTERS }
  }
}

function writeCounters(data) {
  const tmp = `${statsPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, statsPath)
}

export function recordUpload() {
  const data = readCounters()
  data.totalUploads += 1
  data.updatedAt = Date.now()
  writeCounters(data)
}

export function recordDownload() {
  const data = readCounters()
  data.totalDownloads += 1
  data.updatedAt = Date.now()
  writeCounters(data)
}
