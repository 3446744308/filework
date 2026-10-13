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

export const api = {
  upload(file, { expiresIn, maxDownloads, note = '', customCode = '', password = '', onProgress }) {
    return uploadXhr(file, { expiresIn, maxDownloads, note, customCode, password }, onProgress)
  },
  info(code) {
    return request(`/api/info?code=${encodeURIComponent(code)}`)
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
  notice() {
    return request('/api/notice')
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
  async adminDelete(code, key) {
    return request(`/api/admin/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    })
  }
}
