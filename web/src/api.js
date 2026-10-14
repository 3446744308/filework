import { readLocalJson, writeLocalJson, removeLocal } from './utils.js'

async function request(url, options = {}) {
  const res = await fetch(url, options)
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（${res.status}）`)
    err.status = res.status
    throw err
  }
  return data
}

function uploadXhr(file, fields, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({
          percent: Math.round((e.loaded / e.total) * 100),
          loaded: e.loaded,
          total: e.total
        })
      }
    }
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else {
        const err = new Error((data && data.error) || `上传失败（${xhr.status}）`)
        err.status = xhr.status
        reject(err)
      }
    }
    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.send(form)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function uploadChunked(file, fields, onProgress) {
  const localKey = `fs-upload:${file.name}:${file.size}:${file.lastModified}`
  const saved = readLocalJson(localKey)
  let session = null
  if (saved && saved.uploadId && saved.filename === file.name && Number(saved.size) === file.size) {
    try {
      session = await request(`/api/upload/status?uploadId=${encodeURIComponent(saved.uploadId)}`)
    } catch {
      session = null
    }
  }
  if (!session) {
    removeLocal(localKey)
    const init = await request('/api/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        ...fields
      })
    })
    session = { uploadId: init.uploadId, partSize: init.partSize, totalParts: init.totalParts, received: [] }
    writeLocalJson(localKey, {
      uploadId: session.uploadId,
      filename: file.name,
      size: file.size,
      updatedAt: Date.now()
    })
  }
  const { uploadId, partSize, totalParts } = session
  const received = new Set(
    Array.isArray(session.received)
      ? session.received.filter((index) => Number.isInteger(index) && index >= 0 && index < totalParts)
      : []
  )
  const partLength = (index) => Math.min((index + 1) * partSize, file.size) - index * partSize
  let loaded = 0
  for (const index of received) loaded += partLength(index)
  let resume = received.size > 0 ? { receivedParts: received.size, totalParts } : null
  const report = () => {
    if (onProgress) {
      onProgress({
        percent: file.size ? Math.round((loaded / file.size) * 100) : 100,
        loaded,
        total: file.size,
        resume
      })
    }
    resume = null
  }
  const sendPart = async (index) => {
    const start = index * partSize
    const end = Math.min(start + partSize, file.size)
    let lastErr = null
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`/api/upload/part?uploadId=${uploadId}&index=${index}`, {
          method: 'PUT',
          body: file.slice(start, end)
        })
        if (res.ok) {
          received.add(index)
          loaded += end - start
          report()
          return
        }
        let data = null
        try {
          data = await res.json()
        } catch {}
        const err = new Error((data && data.error) || `分片上传失败（${res.status}）`)
        err.status = res.status
        if (res.status >= 400 && res.status < 500) throw err
        lastErr = err
      } catch (err) {
        if ((err.status && err.status < 500) || err.name === 'AbortError') throw err
        lastErr = err
      }
      await sleep(300 * (attempt + 1))
    }
    throw lastErr || new Error('分片上传失败')
  }
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= totalParts) return
      if (received.has(index)) continue
      await sendPart(index)
    }
  }
  if (resume) report()
  const workers = Math.min(3, Math.max(1, totalParts - received.size))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  const result = await request('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId })
  })
  removeLocal(localKey)
  return result
}

// 轮询压缩任务直到落定（done/failed），超时返回最后一次状态而不是抛错。
async function waitUploadJob({ uploadId, code }, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let job = null
  for (;;) {
    try {
      job = await api.uploadJob({ uploadId, code })
    } catch {
      return null
    }
    if (job.finished || Date.now() >= deadline) return job
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

export const api = {
  upload(file, { expiresIn, maxDownloads, note = '', customCode = '', password = '', onProgress }) {
    return uploadXhr(file, { expiresIn, maxDownloads, note, customCode, password }, onProgress)
  },
  uploadChunked(file, { expiresIn, maxDownloads, note = '', customCode = '', password = '', onProgress }) {
    return uploadChunked(file, { expiresIn, maxDownloads, note, customCode, password }, onProgress)
  },
  waitUploadJob(options) {
    return waitUploadJob(options)
  },
  info(code) {
    return request(`/api/info?code=${encodeURIComponent(code)}`)
  },
  // 压缩后台化（B1-2）：201/complete 只代表文件已落位，压缩结论随后回写元数据。
  uploadJob({ uploadId, code }) {
    const params = new URLSearchParams()
    if (uploadId) params.set('uploadId', uploadId)
    else params.set('code', code)
    return request(`/api/upload/job?${params}`)
  },
  verifyPassword(code, password) {
    return request('/api/verify-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, password })
    })
  },
  downloadUrl(code, password = '') {
    const params = new URLSearchParams({ code })
    if (password) params.set('password', password)
    return `/api/download?${params}`
  },
  createDownloadSession(code, password = '') {
    return request('/api/download/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, password })
    })
  },
  downloadStatus(token) {
    return request(`/api/download/status?token=${encodeURIComponent(token)}`)
  },
  downloadPartUrl(token, index) {
    return `/api/download/part?token=${encodeURIComponent(token)}&index=${index}`
  },
  endDownloadSession(token) {
    return request('/api/download/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    })
  },
  notice() {
    return request('/api/notice')
  },
  adminNotices(key) {
    return request('/api/admin/notices', { headers: { 'x-admin-key': key } })
  },
  createNotice(data, key) {
    return request('/api/admin/notices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  updateNotice(id, data, key) {
    return request(`/api/admin/notices/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  deleteNotice(id, key) {
    return request(`/api/admin/notices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  },
  noticePresets(key) {
    return request('/api/admin/notice/presets', { headers: { 'x-admin-key': key } })
  },
  createNoticePreset(data, key) {
    return request('/api/admin/notice/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  updateNoticePreset(id, data, key) {
    return request(`/api/admin/notice/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  deleteNoticePreset(id, key) {
    return request(`/api/admin/notice/presets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  },
  applyNoticePreset(id, key, noticeRev, noticeId) {
    return request(`/api/admin/notice/presets/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({
        ...(Number.isFinite(Number(noticeRev)) ? { noticeRev: Number(noticeRev) } : null),
        ...(noticeId ? { noticeId } : null)
      })
    })
  },
  async exportNoticePresets(key) {
    const res = await fetch('/api/admin/notice/presets/export', { headers: { 'x-admin-key': key } })
    if (!res.ok) {
      let data = null
      try {
        data = await res.json()
      } catch {}
      const err = new Error((data && data.error) || `导出失败（${res.status}）`)
      err.status = res.status
      throw err
    }
    return res.blob()
  },
  importNoticePresets(payload, key) {
    return request('/api/admin/notice/presets/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(payload)
    })
  },
  reorderNoticePresets(ids, key) {
    return request('/api/admin/notice/presets/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ ids })
    })
  },
  publicIp() {
    return request('/api/ip')
  },
  settings() {
    return request('/api/settings')
  },
  saveSettings(data, key) {
    return request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  uploadLogo(file, key) {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('logo', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/settings/logo')
      xhr.setRequestHeader('x-admin-key', key)
      xhr.onload = () => {
        let data = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data)
        else {
          const err = new Error((data && data.error) || `上传失败（${xhr.status}）`)
          err.status = xhr.status
          reject(err)
        }
      }
      xhr.onerror = () => reject(new Error('网络错误，上传失败'))
      xhr.send(form)
    })
  },
  removeLogo(key) {
    return request('/api/settings/logo', {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  },
  saveNotice(data, key) {
    return request('/api/notice', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(data)
    })
  },
  async adminPing(key) {
    return request('/api/admin/ping', { headers: { 'x-admin-key': key } })
  },
  async adminList(key) {
    return request('/api/admin/list', { headers: { 'x-admin-key': key } })
  },
  async adminStats(key) {
    return request('/api/admin/stats', { headers: { 'x-admin-key': key } })
  },
  async exportTransferStats(key) {
    const res = await fetch('/api/admin/stats/export', { headers: { 'x-admin-key': key } })
    if (!res.ok) {
      let data = null
      try {
        data = await res.json()
      } catch {}
      const err = new Error((data && data.error) || `导出失败（${res.status}）`)
      err.status = res.status
      throw err
    }
    return res.blob()
  },
  async resetTransferStats(key) {
    return request('/api/admin/stats/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ confirm: true })
    })
  },
  async adminDelete(code, key) {
    return request(`/api/admin/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  },
  feedback(data) {
    return request('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    })
  },
  feedbackQuery(code) {
    return request(`/api/feedback/query?code=${encodeURIComponent(code)}`)
  },
  async adminFeedbackList(key) {
    return request('/api/admin/feedback', { headers: { 'x-admin-key': key } })
  },
  async adminFeedbackStatus(id, status, key, reply) {
    return request(`/api/admin/feedback/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(reply == null ? { status } : { status, reply })
    })
  },
  async adminFeedbackTemplates(key) {
    return request('/api/admin/feedback/templates', { headers: { 'x-admin-key': key } })
  },
  async adminSaveFeedbackTemplates(templates, key) {
    return request('/api/admin/feedback/templates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ templates })
    })
  },
  async adminFeedbackDelete(id, key) {
    return request(`/api/admin/feedback/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  }
}
