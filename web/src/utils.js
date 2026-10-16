import dayjs from 'dayjs'

export { previewKind } from '../../shared/preview.js'

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

export function timeLeft(expiresAt) {
  const diff = expiresAt - Date.now()
  if (diff <= 0) return '已过期'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
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
