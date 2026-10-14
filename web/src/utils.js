import dayjs from 'dayjs'

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatTime(ts) {
  if (!ts) return '-'
  return dayjs(ts).format('YYYY-MM-DD HH:mm')
}

export function formatDateTime(ts) {
  if (!ts) return '-'
  return dayjs(ts).format('YYYY-MM-DD HH:mm:ss')
}

export function utcLabel(ts) {
  const offsetMin = dayjs(ts).utcOffset()
  if (offsetMin === 0) return 'UTC'
  const sign = offsetMin > 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `UTC${sign}${hh}:${mm}`
}

export function formatDateTimeTz(ts) {
  if (!ts) return '-'
  return `${formatDateTime(ts)} (${utcLabel(ts)})`
}

export function waybillNoOf(createdAt, code) {
  return `${dayjs(createdAt).format('YYYYMMDDHHmmss')}-${code}`
}

export function deviceSummary() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let os = '未知系统'
  if (ua.includes('Windows NT 10') || ua.includes('Windows NT 11')) os = 'Windows 10/11'
  else if (ua.includes('Windows')) os = 'Windows'
  else if (ua.includes('Android')) os = 'Android'
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS'
  else if (ua.includes('Mac OS')) os = 'macOS'
  else if (ua.includes('Linux')) os = 'Linux'
  let browser = '未知浏览器'
  const chrome = ua.match(/Chrome\/([\d.]+)/)
  const firefox = ua.match(/Firefox\/([\d.]+)/)
  const safari = ua.match(/Version\/([\d.]+).*Safari/)
  if (ua.includes('Edg/')) browser = 'Edge'
  else if (chrome) browser = `Chrome ${chrome[1].split('.')[0]}`
  else if (firefox) browser = `Firefox ${firefox[1].split('.')[0]}`
  else if (safari) browser = `Safari ${safari[1].split('.')[0]}`
  return `${os} / ${browser}`
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

// 公告样式（配色 + 字号/圆角/透明度）：0/空 = 跟随默认主题；公告条与弹窗内容块共用。
export function noticeColors(notice) {
  if (!notice) return undefined
  const style = {}
  if (notice.bgColor) style.background = notice.bgColor
  if (notice.textColor) style.color = notice.textColor
  if (Number(notice.fontSize) > 0) style.fontSize = `${Math.round(Number(notice.fontSize))}px`
  if (Number(notice.radius) > 0) style.borderRadius = `${Math.round(Number(notice.radius))}px`
  if (Number(notice.opacity) > 0 && Number(notice.opacity) < 100) {
    style.opacity = Number(notice.opacity) / 100
  }
  return Object.keys(style).length > 0 ? style : undefined
}

export function timeLeft(expiresAt) {
  const diff = expiresAt - Date.now()
  if (diff <= 0) return '已过期'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

export function readLocalJson(key) {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeLocalJson(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeLocal(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {}
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}
