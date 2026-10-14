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

const compressionCodecs = String(process.env.COMPRESS_CODECS ?? 'br,gzip')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => name === 'br' || name === 'gzip')

export const config = {
  rootDir,
  port: intEnv('PORT', 3000),
  adminKey,
  generatedAdminKey,
  dataDir,
  metaDir: path.join(dataDir, 'meta'),
  filesDir: path.join(dataDir, 'files'),
  objectsDir: path.join(dataDir, 'objects'),
  tmpDir: path.join(dataDir, 'tmp'),
  feedbackDir: path.join(dataDir, 'feedback'),
  maxFileSize: intEnv('MAX_FILE_SIZE', 100 * 1024 * 1024),
  defaultExpiresIn: intEnv('DEFAULT_EXPIRE_HOURS', 24),
  defaultMaxDownloads: intEnv('DEFAULT_MAX_DOWNLOADS', 5),
  allowedExpiresIn: [1, 24, 72, 168],
  allowedMaxDownloads: [1, 3, 5, 10],
  rateLimitMisses: intEnv('RATE_LIMIT_MISSES', 10),
  uploadLimitPerMinute: intEnv('UPLOAD_LIMIT_PER_MINUTE', 10),
  maxUploadSessionsPerIp: intEnv('MAX_UPLOAD_SESSIONS_PER_IP', 8),
  maxDownloadSessionsPerIp: intEnv('MAX_DOWNLOAD_SESSIONS_PER_IP', 32),
  maxTmpBytesPerIp: intEnv('MAX_TMP_BYTES_PER_IP', 512 * 1024 * 1024),
  transferPartSize: intEnv('TRANSFER_PART_SIZE', 4 * 1024 * 1024),
  unitTargetCount: intEnv('UNIT_TARGET_COUNT', 32),
  unitMinSize: intEnv('UNIT_MIN_SIZE', 256 * 1024),
  unitMaxSize: intEnv('UNIT_MAX_SIZE', 8 * 1024 * 1024),
  unitMaxCount: intEnv('UNIT_MAX_COUNT', 256),
  compressionCodecs: compressionCodecs.length > 0 ? compressionCodecs : ['gzip'],
  maxNoticePresets: intEnv('MAX_NOTICE_PRESETS', 50),
  maxNotices: intEnv('MAX_NOTICES', 20),
  statsWal: String(process.env.STATS_WAL ?? 'off').trim().toLowerCase() === 'on',
  // 跨文件去重（RFC-006 / ADR-015，backlog B4-2）：默认关闭，开启后新上传写清单化容器。
  crossFileDedup: String(process.env.CROSS_FILE_DEDUP ?? 'off').trim().toLowerCase() === 'on',
  dedupGcGraceMs: intEnv('DEDUP_GC_GRACE_MS', 3600_000),
  dedupGcIntervalMs: intEnv('DEDUP_GC_INTERVAL_MS', 6 * 3600_000),
  cleanupIntervalMs: 60_000
}

export function ensureDirs() {
  for (const dir of [config.metaDir, config.filesDir, config.objectsDir, config.tmpDir, config.feedbackDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
