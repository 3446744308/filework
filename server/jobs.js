import crypto from 'node:crypto'

const MAX_JOBS = 200
const jobs = new Map()
const byKey = new Map()
const queue = []
let running = false

// 任务表为纯内存：进程重启即丢（与 ADR-012「上传会话可恢复」的边界一致）。
// 未跑完的压缩由 store.repairPendingCompressions 在启动时按边车把元数据补齐或回退为未压缩。

function prune() {
  if (jobs.size <= MAX_JOBS) return
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break
    if (job.status === 'pending' || job.status === 'running') continue
    jobs.delete(id)
    if (job.key && byKey.get(job.key) === id) byKey.delete(job.key)
  }
}

// 串行队列：压缩是 CPU 密集且会改写文件，并发只会互相抢资源。
async function pump() {
  if (running) return
  const next = queue.shift()
  if (!next) return
  running = true
  const job = jobs.get(next.id)
  if (job) job.status = 'running'
  try {
    const result = await next.task()
    if (job) {
      job.status = 'done'
      job.result = result === undefined ? null : result
      job.finishedAt = Date.now()
    }
  } catch (err) {
    if (job) {
      job.status = 'failed'
      job.error = err && err.message ? err.message : '处理失败'
      job.finishedAt = Date.now()
    }
  } finally {
    running = false
    pump()
  }
}

export function enqueue(label, task, key = '') {
  const id = crypto.randomBytes(8).toString('hex')
  const job = {
    id,
    label,
    key: String(key ?? ''),
    status: 'pending',
    error: '',
    result: null,
    createdAt: Date.now(),
    finishedAt: 0
  }
  jobs.set(id, job)
  if (job.key) byKey.set(job.key, id)
  prune()
  queue.push({ id, task })
  setImmediate(pump)
  return job
}

export function getJob(id) {
  return jobs.get(String(id ?? '')) || null
}

// 按业务键（上传 uploadId / 分享 code）查最近一次任务，供前端轮询压缩进度。
export function getJobByKey(key) {
  const id = byKey.get(String(key ?? ''))
  return id ? jobs.get(id) || null : null
}

export function queueStats() {
  let pending = 0
  let running = 0
  for (const job of jobs.values()) {
    if (job.status === 'pending') pending += 1
    else if (job.status === 'running') running += 1
  }
  return { pending, running }
}
