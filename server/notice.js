import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const noticePath = path.join(config.dataDir, 'notice.json')

const DISPLAY_MODES = ['modal', 'bar', 'both']

const DEFAULT_NOTICE = { enabled: false, title: '', content: '', display: 'modal', updatedAt: 0 }

export function getNotice() {
  try {
    const data = JSON.parse(fs.readFileSync(noticePath, 'utf8'))
    return { ...DEFAULT_NOTICE, ...data }
  } catch {
    return { ...DEFAULT_NOTICE }
  }
}

export function saveNotice(input) {
  const notice = {
    enabled: Boolean(input.enabled),
    title: String(input.title ?? '').slice(0, 100).trim(),
    content: String(input.content ?? '').slice(0, 2000).trim(),
    display: DISPLAY_MODES.includes(input.display) ? input.display : 'modal',
    updatedAt: Date.now()
  }
  if (!notice.content) notice.enabled = false
  const tmp = `${noticePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(notice, null, 2))
  fs.renameSync(tmp, noticePath)
  return notice
}
