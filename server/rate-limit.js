const buckets = new Map()

function hit(key, limit, windowMs) {
  const now = Date.now()
  const entry = buckets.get(key)
  if (!entry || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { blocked: false, left: limit - 1 }
  }
  entry.count += 1
  if (entry.count > limit) return { blocked: true, left: 0 }
  return { blocked: false, left: limit - entry.count }
}

function clear(key) {
  buckets.delete(key)
}

function sweep() {
  const now = Date.now()
  for (const [key, entry] of buckets) {
    if (now >= entry.resetAt) buckets.delete(key)
  }
}

const sweeper = setInterval(sweep, 60_000)
sweeper.unref()

export function missGuard(limit, windowMs = 60_000, scope = '') {
  return (req, res, next) => {
    const key = `miss:${scope}:${req.ip}`
    const r = hit(key, limit, windowMs)
    if (r.blocked) {
      return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' })
    }
    res.on('finish', () => {
      if (res.statusCode < 400) clear(key)
    })
    next()
  }
}

export function rateGuard(limit, windowMs = 60_000) {
  return (req, res, next) => {
    const r = hit(`rate:${req.ip}`, limit, windowMs)
    if (r.blocked) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' })
    }
    next()
  }
}
