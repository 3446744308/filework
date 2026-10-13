import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile(path.join(rootDir, '.env'))

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

let adminKey = process.env.ADMIN_KEY || ''
let generatedAdminKey = false
if (!adminKey) {
  adminKey = crypto.randomBytes(16).toString('hex')
  generatedAdminKey = true
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(rootDir, process.env.DATA_DIR)
  : path.join(rootDir, 'data')

export const config = {
  rootDir,
  port: intEnv('PORT', 3000),
  adminKey,
  generatedAdminKey,
  dataDir,
  metaDir: path.join(dataDir, 'meta'),
  filesDir: path.join(dataDir, 'files'),
  tmpDir: path.join(dataDir, 'tmp'),
  feedbackDir: path.join(dataDir, 'feedback'),
  maxFileSize: intEnv('MAX_FILE_SIZE', 100 * 1024 * 1024),
  defaultExpiresIn: intEnv('DEFAULT_EXPIRE_HOURS', 24),
  defaultMaxDownloads: intEnv('DEFAULT_MAX_DOWNLOADS', 5),
  allowedExpiresIn: [1, 24, 72, 168],
  allowedMaxDownloads: [1, 3, 5, 10],
  rateLimitMisses: intEnv('RATE_LIMIT_MISSES', 10),
  uploadLimitPerMinute: intEnv('UPLOAD_LIMIT_PER_MINUTE', 10),
  cleanupIntervalMs: 60_000
}

export function ensureDirs() {
  for (const dir of [config.metaDir, config.filesDir, config.tmpDir, config.feedbackDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
