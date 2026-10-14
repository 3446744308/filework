import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.E2E_PORT || 3998)
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT || 9333)
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_KEY = 'e2e-admin-key'
const DATA_DIR = path.join(rootDir, 'data-e2e')
const PROFILE_DIR = path.join(os.tmpdir(), `file-share-e2e-profile-${Date.now()}`)
const DOWNLOAD_DIR = path.join(os.tmpdir(), `file-share-e2e-downloads-${Date.now()}`)
const THROTTLE_BYTES_PER_SECOND = 12.5 * 1024 * 1024

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

let passed = 0
let failed = 0

function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

function bad(name, detail) {
  failed++
  console.log(`  ✗ ${name} — ${detail}`)
}

function assert(cond, name, detail = '') {
  cond ? ok(name) : bad(name, detail)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

// 压缩已后台化（backlog B1-2）：上传 201 只代表文件落位，压缩结论随后回写；
// 需要「最终形态」的断言先等任务落定。
async function settleCompression(code) {
  for (let i = 0; i < 400; i++) {
    const res = await fetch(`${BASE}/api/upload/job?code=${code}`)
    if (res.status === 404) return null
    if (res.ok) {
      const body = await res.json()
      if (body.finished && body.compressionState !== 'pending') return body
    }
    await sleep(30)
  }
  return null
}

async function upload(content, filename, mime) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: mime }), filename)
  form.append('expiresIn', '24')
  form.append('maxDownloads', '10')
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })
  const body = await res.json()
  if (res.status !== 201) throw new Error(`上传失败 ${res.status}: ${JSON.stringify(body)}`)
  body.compressionStateAtUpload = body.compressionState
  const settled = await settleCompression(body.code)
  if (settled) {
    body.compressed = settled.compressed
    body.storedSize = settled.storedSize
    body.compressionState = settled.compressionState
  }
  return body
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Set()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        for (const handler of this.handlers) handler(message)
        return
      }
      if (!this.pending.has(message.id)) return
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  on(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }
}

async function pickDebugPort() {
  for (let port = DEBUG_PORT; port < DEBUG_PORT + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500)
      })
      if (res.ok) continue
    } catch {}
    return port
  }
  return DEBUG_PORT
}

async function connectDebugger(debugPort = DEBUG_PORT) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) {
        const info = await res.json()
        if (info.webSocketDebuggerUrl) {
          const ws = new WebSocket(info.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', () => reject(new Error('调试端口连接失败')), {
              once: true
            })
          })
          return new Cdp(ws)
        }
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('无法连接 Chrome 调试端口')
}

async function waitForFile(dir, timeoutMs = 120000, match = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let names = []
    try {
      names = fs.readdirSync(dir).filter((name) => !name.endsWith('.crdownload'))
    } catch {}
    for (const name of names) {
      if (match && !match(name)) continue
      const full = path.join(dir, name)
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (size > 0) {
        await sleep(300)
        let sizeAgain = 0
        try {
          sizeAgain = fs.statSync(full).size
        } catch {
          continue
        }
        if (sizeAgain === size && !fs.existsSync(`${full}.crdownload`)) {
          return full
        }
      }
    }
    await sleep(150)
  }
  return null
}

async function clickButtonByText(page, text) {
  const rect = await evaluate(
    page,
    `(() => {
      const wanted = ${JSON.stringify(text)}.replace(/\\s+/g, '')
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.innerText.replace(/\\s+/g, '').includes(wanted)
      )
      if (!button) return null
      button.scrollIntoView({ block: 'center' })
      const r = button.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`
  )
  if (!rect) throw new Error(`按钮不存在：${text}`)
  await page('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
  await page('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
}

async function evaluate(page, expression, awaitPromise = false) {
  const result = await page('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '页面执行异常')
  }
  return result.result.value
}

async function probeNoticeBar(page, waitModal = false) {
  return evaluate(
    page,
    `new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const alert = document.querySelector('.notice-bar-alert')
        const modal = document.querySelector('.notice-content')
        if (alert && (!${waitModal} || modal)) {
          clearInterval(timer)
          const cs = getComputedStyle(alert)
          const content = document.querySelector('.notice-bar-content')
          const marquee = document.querySelector('.notice-bar-marquee')
          const viewport = document.querySelector('.notice-bar-viewport')
          const item = document.querySelector('.notice-bar-item')
          const marqueeStyle = marquee ? getComputedStyle(marquee) : null
          const modalStyle = modal ? getComputedStyle(modal) : null
          resolve({
            cls: alert.className,
            position: cs.position,
            top: cs.top,
            bottom: cs.bottom,
            background: cs.backgroundColor,
            color: content ? getComputedStyle(content).color : '',
            animation: marqueeStyle ? marqueeStyle.animationName : '',
            marqueeCls: marquee ? marquee.className : '',
            items: document.querySelectorAll('.notice-bar-item').length,
            trackWidth: marquee ? marquee.scrollWidth : 0,
            viewportWidth: viewport ? viewport.clientWidth : 0,
            role: viewport ? viewport.getAttribute('role') : '',
            ariaLive: viewport ? viewport.getAttribute('aria-live') : '',
            title: viewport ? viewport.getAttribute('title') : '',
            overflowY: Boolean(item && viewport && item.scrollHeight > viewport.clientHeight + 1),
            overflowX: Boolean(item && viewport && item.scrollWidth > viewport.clientWidth + 1),
            modal: modalStyle ? { background: modalStyle.backgroundColor, color: modalStyle.color } : null
          })
          return
        }
        if (Date.now() - started > 20000) {
          clearInterval(timer)
          resolve(null)
        }
      }, 100)
    })`,
    true
  )
}

async function run() {
  const chromePath = findChrome()
  if (!chromePath) {
    console.log('未找到 Chrome，跳过浏览器 E2E（可用 CHROME_PATH 指定可执行文件）')
    process.exit(0)
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_KEY,
      DATA_DIR,
      MAX_FILE_SIZE: String(64 * 1024 * 1024),
      UNIT_TARGET_COUNT: '16',
      UNIT_MIN_SIZE: '262144',
      UNIT_MAX_SIZE: '8388608',
      UNIT_MAX_COUNT: '64',
      COMPRESS_CODECS: 'br,gzip'
    }
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (data) => process.stderr.write(data))

  let chrome = null
  let cdp = null
  try {
    if (!(await waitForHealth())) throw new Error('服务启动失败')
    const health = await (await fetch(`${BASE}/api/health`)).json()

    console.log('\n[E2E-1] 准备测试数据')
    const textLines = []
    for (let i = 0; textLines.length < 200000; i++) {
      textLines.push(
        `2026-10-12T10:00:${String(i % 60).padStart(2, '0')} 取件码 ${100000 + (i % 900000)} 文件已就绪，请及时取件\n`
      )
    }
    const bigText = Buffer.from(textLines.join(''))
    const bigUp = await upload(bigText, '浏览器大文件.txt', 'text/plain')
    const randomBuf = crypto.randomBytes(4 * 1024 * 1024)
    const randomUp = await upload(randomBuf, '浏览器随机.bin', 'application/octet-stream')
    assert(
      bigUp.compressed === true && bigUp.storedSize < bigUp.size * 0.6,
      '可压缩文件在服务端完成单元压缩存储',
      JSON.stringify({ size: bigUp.size, storedSize: bigUp.storedSize })
    )
    assert(
      randomUp.compressed === false,
      '不可压缩文件保留原样（不做无意义压缩）',
      JSON.stringify(randomUp.compressed)
    )

    const debugPort = await pickDebugPort()
    chrome = spawn(
      chromePath,
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        'about:blank'
      ],
      { stdio: 'ignore' }
    )

    cdp = await connectDebugger(debugPort)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const page = (method, params) => cdp.send(method, params, sessionId)
    await page('Page.enable')
    await page('Runtime.enable')
    await page('Network.enable')
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR,
        eventsEnabled: true
      })
    } catch {
      await page('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR })
    }
    await page('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.showSaveFilePicker = undefined;'
    })
    await page('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: THROTTLE_BYTES_PER_SECOND,
      uploadThroughput: THROTTLE_BYTES_PER_SECOND
    })

    console.log('\n[E2E-2] 浏览器真实并行下载（Content-Encoding 自动解压）')
    const requestedEncodings = []
    const responseEncodings = []
    const headerValue = (headers, name) => {
      const key = Object.keys(headers || {}).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase()
      )
      return key ? headers[key] : ''
    }
    const requestUrls = new Map()
    cdp.on((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        requestUrls.set(message.params.requestId, message.params.request?.url || '')
        return
      }
      if (message.method === 'Network.requestWillBeSentExtraInfo') {
        const url = requestUrls.get(message.params.requestId) || ''
        if (!url.includes('/api/download/part')) return
        requestedEncodings.push(headerValue(message.params.headers, 'accept-encoding') || '(none)')
        return
      }
      if (message.method === 'Network.responseReceived') {
        const url = message.params?.response?.url || ''
        if (!url.includes('/api/download/part')) return
        responseEncodings.push(
          headerValue(message.params.response.headers, 'content-encoding') || 'raw'
        )
      }
    })
    await page('Page.navigate', { url: `${BASE}/d/${bigUp.code}` })
    let rendered = false
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      rendered = await evaluate(
        page,
        `!![...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))`
      )
      if (rendered) break
    }
    assert(rendered, '取件页渲染出下载按钮')

    const userAgent = await evaluate(page, `navigator.userAgent`)
    const before = Date.now()
    await evaluate(
      page,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))
        if (!button) throw new Error('下载按钮不存在')
        button.click()
        return true
      })()`
    )
    const progressText = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        let last = ''
        const timer = setInterval(() => {
          const node = document.querySelector('.download-progress')
          if (node && node.innerText.trim()) last = node.innerText.replace(/\\s+/g, ' ').trim()
          if (last.includes('传输压缩') || Date.now() - started > 20000) {
            clearInterval(timer)
            resolve(last)
          }
        }, 50)
      })`,
      true
    )
    const saved = await waitForFile(DOWNLOAD_DIR)
    const elapsed = Date.now() - before
    assert(saved !== null, '浏览器完成文件落地', saved || '未生成下载文件')
    const savedBuf = saved ? fs.readFileSync(saved) : Buffer.alloc(0)
    assert(
      savedBuf.length === bigText.length && sha256(savedBuf) === sha256(bigText),
      '落地文件与原始内容逐字节一致（浏览器自动解压后拼装）',
      `${savedBuf.length}/${bigText.length}`
    )
    assert(
      progressText.includes('传输压缩'),
      '下载进度区展示了传输压缩信息',
      progressText || '(未捕获到进度文本)'
    )

    const perf = await evaluate(
      page,
      `JSON.stringify(performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('/api/download/part'))
        .map((e) => ({ encoded: e.encodedBodySize, decoded: e.decodedBodySize, start: e.startTime, end: e.responseEnd })))`
    )
    const distinctRequests = [...new Set(requestedEncodings)]
    const encodingCounts = responseEncodings.reduce((acc, value) => {
      acc[value] = (acc[value] || 0) + 1
      return acc
    }, {})
    console.log(`      · 浏览器 Accept-Encoding: ${distinctRequests.join(' | ')}`)
    console.log(`      · 分片响应编码分布: ${JSON.stringify(encodingCounts)}`)
    assert(
      responseEncodings.length > 0 &&
        responseEncodings.some((value) => value !== 'raw') &&
        distinctRequests.every((value) => /gzip|br|deflate/.test(value)),
      '真实浏览器声明压缩支持，服务端据此启用 Content-Encoding（浏览器自动解压）',
      `请求=${distinctRequests.join(' | ') || '(未捕获)'} 响应=${JSON.stringify(encodingCounts)}`
    )

    const entries = JSON.parse(perf || '[]')
    const encodedTotal = entries.reduce((sum, item) => sum + item.encoded, 0)
    const decodedTotal = entries.reduce((sum, item) => sum + item.decoded, 0)
    const spanMs = entries.length
      ? Math.max(...entries.map((item) => item.end)) - Math.min(...entries.map((item) => item.start))
      : 0
    assert(
      entries.length >= 4 && decodedTotal === bigText.length,
      '浏览器按服务端计划分片拉取（≥4 片且解码总字节 = 原始大小）',
      JSON.stringify({ parts: entries.length, decodedTotal, raw: bigText.length })
    )
    assert(
      encodedTotal > 0 && encodedTotal < decodedTotal * 0.6,
      '浏览器实测：线上字节 < 60% 原始（资源计时 encoded/decoded）',
      JSON.stringify({
        encodedTotal,
        decodedTotal,
        saved: `${(100 - (encodedTotal / decodedTotal) * 100).toFixed(1)}%`
      })
    )

    console.log('\n[E2E-3] 同速网络下的 A/B 提速对比')
    const baselineUp = await upload(bigText, '浏览器大文件基线.txt', 'text/plain')
    const baseline = await evaluate(
      page,
      `(async () => {
        const started = performance.now()
        const res = await fetch('/api/download?code=${baselineUp.code}')
        const buf = await res.arrayBuffer()
        return { ms: performance.now() - started, bytes: buf.byteLength, encoding: res.headers.get('content-encoding') || '' }
      })()`,
      true
    )
    const speedup = baseline.ms / spanMs
    console.log(
      `      · 传输窗口：并行+压缩 ${spanMs.toFixed(0)}ms / 单流基线 ${baseline.ms.toFixed(0)}ms → 提速 ${speedup.toFixed(2)}x（限速 ${(THROTTLE_BYTES_PER_SECOND / 1024 / 1024).toFixed(1)}MB/s）`
    )
    console.log(
      `      · 端到端（含 UI、落盘）：${elapsed}ms；线上字节 ${encodedTotal} / 原始 ${decodedTotal}（${(100 - (encodedTotal / decodedTotal) * 100).toFixed(1)}% 省）`
    )
    assert(
      baseline.bytes === bigText.length && baseline.encoding === '',
      '基线为单流原始字节（无 Content-Encoding）',
      JSON.stringify({ bytes: baseline.bytes, encoding: baseline.encoding })
    )
    assert(
      spanMs > 0 && spanMs < baseline.ms && elapsed < baseline.ms,
      '并行 + 传输压缩对比单流下载有明显提速',
      `传输窗口 ${spanMs.toFixed(0)}ms / 端到端 ${elapsed}ms vs 基线 ${baseline.ms.toFixed(0)}ms`
    )

    console.log('\n[E2E-4] 不可压缩文件不产生虚假收益')
    const randomPerf = await evaluate(
      page,
      `(async () => {
        const info = await (await fetch('/api/info?code=${randomUp.code}')).json()
        const session = await (await fetch('/api/download/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: '${randomUp.code}' })
        })).json()
        let decoded = 0
        let encoded = 0
        const buffers = []
        await Promise.all(session.units.map(async (_, index) => {
          const res = await fetch('/api/download/part?token=' + session.token + '&index=' + index)
          const buf = await res.arrayBuffer()
          decoded += buf.byteLength
          encoded += Number(res.headers.get('content-length') || 0)
          buffers[index] = new Uint8Array(buf)
        }))
        const merged = new Uint8Array(buffers.reduce((sum, part) => sum + part.length, 0))
        let offset = 0
        for (const part of buffers) { merged.set(part, offset); offset += part.length }
        const digest = await crypto.subtle.digest('SHA-256', merged)
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        await fetch('/api/download/end', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: session.token })
        })
        return { decoded, encoded, digest: hex, units: session.units.length, compressed: session.compressed, size: info.size }
      })()`,
      true
    )
    assert(
      randomPerf.digest === sha256(randomBuf) && randomPerf.decoded === randomBuf.length,
      '不可压缩文件在浏览器端分片拼装后哈希一致',
      JSON.stringify({ digest: randomPerf.digest, decoded: randomPerf.decoded })
    )
    assert(
      randomPerf.encoded === randomPerf.decoded && randomPerf.compressed === false,
      '不可压缩文件不触发传输压缩（线上字节 = 原始字节）',
      JSON.stringify({ encoded: randomPerf.encoded, decoded: randomPerf.decoded })
    )

    console.log('\n[E2E-5] Chromium 文件系统直写路径（边下边写盘）')
    await page('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.showSaveFilePicker = async ({ suggestedName }) => {
        const root = await navigator.storage.getDirectory()
        return root.getFileHandle(suggestedName || 'download.bin', { create: true })
      }`
    })
    await page('Page.navigate', { url: `${BASE}/d/${bigUp.code}` })
    let readyAgain = false
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      readyAgain = await evaluate(
        page,
        `!![...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))`
      )
      if (readyAgain) break
    }
    assert(readyAgain, '重新进入取件页并渲染下载按钮')
    await evaluate(
      page,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))
        if (!button) throw new Error('下载按钮不存在')
        button.click()
        return true
      })()`
    )
    const streamed = await evaluate(
      page,
      `(async () => {
        const root = await navigator.storage.getDirectory()
        const deadline = Date.now() + 40000
        let last = null
        while (Date.now() < deadline) {
          try {
            const handle = await root.getFileHandle('浏览器大文件.txt')
            const file = await handle.getFile()
            if (file.size === ${bigText.length}) {
              const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
              last = {
                size: file.size,
                digest: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
              }
              break
            }
            last = { size: file.size, digest: '' }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return last || { size: -1, digest: '' }
      })()`,
      true
    )
    assert(
      streamed.size === bigText.length && streamed.digest === sha256(bigText),
      '流式写盘（无中间压缩文件）最终内容逐字节一致',
      JSON.stringify(streamed)
    )

    console.log('\n[E2E-6] 管理仪表盘：传输节省卡片（真实浏览器）')
    await page('Page.navigate', { url: `${BASE}/admin` })
    let stage = ''
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      stage = await evaluate(
        page,
        `(() => {
          if (document.querySelector('input[placeholder="管理密钥"]')) return 'login'
          if ([...document.querySelectorAll('.ant-card')].some((node) => node.innerText.includes('传输节省'))) {
            return 'dashboard'
          }
          return ''
        })()`
      )
      if (stage) break
    }
    assert(stage !== '', '管理入口渲染出登录页或仪表盘', stage || '(未捕获)')
    if (stage === 'login') {
      await evaluate(
        page,
        `(() => {
          const input = document.querySelector('input[placeholder="管理密钥"]')
          input.focus()
          return true
        })()`
      )
      await page('Input.insertText', { text: ADMIN_KEY })
      await evaluate(
        page,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('进入管理后台'))
          if (!button) throw new Error('登录按钮不存在')
          button.click()
          return true
        })()`
      )
    }
    const savingCard = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const card = [...document.querySelectorAll('.ant-card')].find((node) => node.innerText.includes('传输节省'))
          const text = card ? card.innerText.replace(/\\s+/g, ' ').trim() : ''
          if (text.includes('线上') && text.includes('原始')) {
            clearInterval(timer)
            resolve(text)
          } else if (Date.now() - started > 20000) {
            clearInterval(timer)
            resolve('')
          }
        }, 100)
      })`,
      true
    )
    const adminStats = await (
      await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    const expectedPercent =
      adminStats.transferOriginalBytes > 0
        ? Math.round((adminStats.transferSavedBytes / adminStats.transferOriginalBytes) * 100)
        : 0
    console.log(
      `      · 卡片文本：${savingCard || '(未捕获)'}｜接口：线上 ${adminStats.transferWireBytes} / 原始 ${adminStats.transferOriginalBytes}`
    )
    assert(
      savingCard.includes('传输节省') && savingCard.includes('线上') && savingCard.includes('原始'),
      '仪表盘渲染出「传输节省」卡片（含线上/原始字节）',
      savingCard || '(未捕获)'
    )
    assert(
      adminStats.transferWireBytes > 0 &&
        adminStats.transferSavedBytes > 0 &&
        savingCard.includes(`省 ${expectedPercent}%`),
      '卡片数值与接口统计一致（线上字节 < 原始字节）',
      JSON.stringify({
        card: savingCard,
        wire: adminStats.transferWireBytes,
        original: adminStats.transferOriginalBytes,
        percent: expectedPercent
      })
    )

    assert(
      savingCard.includes('今日') && !savingCard.includes('今日暂无传输'),
      '卡片展示今日传输节省（与总量分开）',
      savingCard
    )
    const dayCard = await evaluate(
      page,
      `(() => {
        const card = [...document.querySelectorAll('.ant-card')].find((node) => node.innerText.includes('近 7 日传输节省'))
        if (!card) return ''
        const row = card.querySelector('.ant-table-tbody tr')
        return row ? row.innerText.replace(/\\s+/g, ' ').trim() : ''
      })()`
    )
    const expectedDate = adminStats.transferDays.length ? adminStats.transferDays[0].date : ''
    assert(
      expectedDate !== '' && dayCard.includes(expectedDate),
      '近 7 日明细首行为今日（日期与接口一致）',
      JSON.stringify({ expectedDate, dayCard })
    )

    await page('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    await page('Page.navigate', { url: `${BASE}/admin/files` })
    const fileRow = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const row = [...document.querySelectorAll('.ant-table-tbody tr')].find((node) => node.innerText.includes('${bigUp.code}'))
          if (row) {
            clearInterval(timer)
            resolve(row.innerText.replace(/\\s+/g, ' ').trim())
          } else if (Date.now() - started > 20000) {
            clearInterval(timer)
            resolve('')
          }
        }, 100)
      })`,
      true
    )
    assert(
      fileRow.includes('传输节省') || fileRow.includes('线上'),
      '文件管理页展示单文件传输节省（线上/原始）',
      fileRow || '(未捕获)'
    )

    console.log('\n[E2E-7] 管理端导出与清零（真实浏览器）')
    await page('Page.navigate', { url: `${BASE}/admin` })
    const transferCardText = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const card = [...document.querySelectorAll('.ant-card')].find((node) => node.innerText.includes('近 7 日传输节省'))
          const text = card ? card.innerText.replace(/\\s+/g, ' ').trim() : ''
          if (text.includes('导出 CSV') && text.includes('清零')) {
            clearInterval(timer)
            resolve(text)
          } else if (Date.now() - started > 20000) {
            clearInterval(timer)
            resolve(text)
          }
        }, 100)
      })`,
      true
    )
    assert(
      transferCardText.includes('导出 CSV') && transferCardText.includes('清零'),
      '仪表盘提供导出 CSV 与清零入口',
      transferCardText || '(未捕获)'
    )

    const preResetStats = await (
      await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    await evaluate(
      page,
      `(() => {
        const card = [...document.querySelectorAll('.ant-card')].find((node) => node.innerText.includes('近 7 日传输节省'))
        const button = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('导出 CSV'))
        if (!button) throw new Error('导出按钮不存在')
        button.click()
        return true
      })()`
    )
    let csvPath = null
    const csvDeadline = Date.now() + 20000
    while (Date.now() < csvDeadline && !csvPath) {
      for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
        if (!name.startsWith('transfer-stats-') || !name.endsWith('.csv')) continue
        const full = path.join(DOWNLOAD_DIR, name)
        const size = fs.statSync(full).size
        if (size > 0) {
          await sleep(300)
          if (fs.statSync(full).size === size) csvPath = full
        }
      }
      if (!csvPath) await sleep(200)
    }
    assert(csvPath !== null, '点击「导出 CSV」后浏览器落盘 CSV 文件', csvPath || '未生成')
    const csvRaw = csvPath ? fs.readFileSync(csvPath) : Buffer.alloc(0)
    const csvText = csvRaw.toString('utf8').replace(/^\uFEFF/, '')
    const csvHeader = csvText.split(/\r?\n/)[0] || ''
    assert(
      csvRaw[0] === 0xef && csvRaw[1] === 0xbb && csvRaw[2] === 0xbf,
      '浏览器下载的 CSV 带 UTF-8 BOM',
      [...csvRaw.slice(0, 4)].map((b) => b.toString(16)).join(' ')
    )
    assert(
      csvHeader === '维度,标识,文件名,原始字节,线上字节,节省字节,片数',
      '浏览器下载的 CSV 表头与契约一致',
      csvHeader || '(空)'
    )
    assert(
      csvText.includes('按日') && csvText.includes('按文件') && csvText.includes(bigUp.code),
      'CSV 含按日与按文件明细（含已下载文件取件码）',
      csvText.slice(0, 160)
    )

    await evaluate(
      page,
      `(() => {
        const card = [...document.querySelectorAll('.ant-card')].find((node) => node.innerText.includes('近 7 日传输节省'))
        const button = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('清零'))
        if (!button) throw new Error('清零按钮不存在')
        button.click()
        return true
      })()`
    )
    const confirmed = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const button = [...document.querySelectorAll('.ant-popconfirm button, .ant-popover button')].find(
            (b) => b.innerText.trim() === '确认清零'
          )
          if (button) {
            clearInterval(timer)
            button.click()
            resolve(true)
          } else if (Date.now() - started > 10000) {
            clearInterval(timer)
            resolve(false)
          }
        }, 100)
      })`,
      true
    )
    assert(confirmed, '清零前出现二次确认并可确认')
    const resetStats = await (async () => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const stats = await (
          await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
        ).json()
        if (stats.transferResetAt > 0 && stats.transferSavedBytes === 0) return stats
        await sleep(200)
      }
      return null
    })()
    assert(
      resetStats !== null &&
        resetStats.transferOriginalBytes === 0 &&
        resetStats.transferWireBytes === 0 &&
        resetStats.transferToday.originalBytes === 0 &&
        resetStats.transferDays.length === 0 &&
        resetStats.transferResetCount >= 1 &&
        resetStats.totalDownloads === preResetStats.totalDownloads,
      '清零后接口：传输统计归零、明细清空、上传/下载次数保留',
      JSON.stringify(
        resetStats && {
          totals: [resetStats.transferOriginalBytes, resetStats.transferWireBytes],
          days: resetStats.transferDays.length,
          downloads: [preResetStats.totalDownloads, resetStats.totalDownloads]
        }
      )
    )
    const resetUi = await evaluate(
      page,
      `new Promise((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const text = document.body.innerText.replace(/\\s+/g, ' ')
          if (text.includes('今日暂无传输') && text.includes('上次清零')) {
            clearInterval(timer)
            resolve(text)
          } else if (Date.now() - started > 20000) {
            clearInterval(timer)
            resolve(text)
          }
        }, 100)
      })`,
      true
    )
    assert(
      resetUi.includes('今日暂无传输') && resetUi.includes('上次清零'),
      '清零后界面归零并展示审计行（上次清零）',
      resetUi.slice(0, 300)
    )

    console.log('\n[E2E-8] 下载中断后续传（OPFS 暂存 + 字节级续写，真实浏览器）')
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
    const dlKey = `fs-download:${randomUp.code}`
    const stagedKey = `fs-download-${randomUp.code}.part`
    const stagedSizeExpr = `(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(${JSON.stringify(stagedKey)})
        const file = await handle.getFile()
        return file.size
      } catch {
        return -1
      }
    })()`
    const statsBeforeResume = await (
      await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    await page('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.showSaveFilePicker = undefined;'
    })
    // 压低带宽，保证能在下载完成前中断出「部分已落盘」的暂存前缀。
    await page('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: 2 * 1024 * 1024,
      uploadThroughput: 2 * 1024 * 1024
    })
    await page('Page.navigate', { url: `${BASE}/d/${randomUp.code}` })
    let resumeReady = false
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      resumeReady = await evaluate(
        page,
        `!![...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))`
      )
      if (resumeReady) break
    }
    assert(resumeReady, '中断用例进入取件页并渲染下载按钮')
    await clickButtonByText(page, '下载文件')
    let stagedAtCut = -1
    let partsAtCut = -1
    for (let i = 0; i < 300; i++) {
      await sleep(30)
      const value = await evaluate(page, stagedSizeExpr, true)
      const parts = requestedEncodings.length
      if (value >= 2 * 262144 && parts >= 2) {
        stagedAtCut = value
        partsAtCut = parts
        break
      }
    }
    await page('Page.reload', {})
    await page('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: THROTTLE_BYTES_PER_SECOND,
      uploadThroughput: THROTTLE_BYTES_PER_SECOND
    })
    assert(
      stagedAtCut > 0 && partsAtCut >= 2,
      '中断前已有分片提交进 OPFS 暂存（形成可续写前缀）',
      JSON.stringify({ stagedAtCut, partsAtCut })
    )
    const statsAfterFail = await (
      await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    assert(
      statsAfterFail.totalDownloads === statsBeforeResume.totalDownloads + 1,
      '首次尝试消费 1 次下载次数',
      JSON.stringify({
        before: statsBeforeResume.totalDownloads,
        afterFail: statsAfterFail.totalDownloads
      })
    )
    await page('Page.navigate', { url: `${BASE}/d/${randomUp.code}` })
    let reloadReady = false
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      reloadReady = await evaluate(
        page,
        `!![...document.querySelectorAll('button')].find((b) => b.innerText.includes('下载文件'))`
      )
      if (reloadReady) break
    }
    const tokenAfterReload = await evaluate(
      page,
      `(() => {
        try {
          const saved = JSON.parse(localStorage.getItem(${JSON.stringify(dlKey)}) || 'null')
          return saved && saved.token ? String(saved.token) : ''
        } catch {
          return ''
        }
      })()`
    )
    assert(reloadReady && tokenAfterReload !== '', '刷新后本地仍保留续传 token', tokenAfterReload ? 'ok' : '(缺失)')
    // 必须在消费前读计划：下载成功后会话会被 end 掉，status 就查不到了。
    const resumedPlan = await (
      await fetch(`${BASE}/api/download/status?token=${encodeURIComponent(tokenAfterReload)}`)
    ).json()
    const planTotal = Array.isArray(resumedPlan.units) ? resumedPlan.units.length : 0
    const partBytes = planTotal > 0 ? resumedPlan.units[0][1] - resumedPlan.units[0][0] : 0
    const downloadEvents = []
    const stopDownloadEvents = cdp.on((message) => {
      if (message.method === 'Browser.downloadWillBegin') {
        downloadEvents.push({
          guid: message.params.guid,
          name: message.params.suggestedFilename,
          state: 'begin'
        })
      }
      if (message.method === 'Browser.downloadProgress') {
        const entry = downloadEvents.find((item) => item.guid === message.params.guid)
        if (entry) entry.state = message.params.state
      }
    })
    const partsBefore = requestedEncodings.length
    await clickButtonByText(page, '下载文件')
    const resumedFile = await waitForFile(DOWNLOAD_DIR, 120000, (name) => name.endsWith('.bin'))
    stopDownloadEvents()
    const resumedParts = requestedEncodings.length - partsBefore
    const stagedPartsAtCut = partBytes > 0 ? stagedAtCut / partBytes : -1
    console.log(
      `      · 中断时暂存 ${stagedAtCut}B（${stagedPartsAtCut} 片）｜续传只请求 ${resumedParts}/${planTotal} 片｜下载事件：${JSON.stringify(downloadEvents)}`
    )
    assert(resumedFile !== null, '续传后浏览器完成文件落地', resumedFile || '未生成')
    assert(
      planTotal > 0 && resumedParts > 0 && resumedParts < planTotal,
      '续传只补缺口分片（少于全量分片数）',
      JSON.stringify({ resumedParts, planTotal, stagedPartsAtCut })
    )
    const resumedBuf = resumedFile ? fs.readFileSync(resumedFile) : Buffer.alloc(0)
    assert(
      resumedBuf.length === randomBuf.length && sha256(resumedBuf) === sha256(randomBuf),
      '续传后落地文件与原始内容逐字节一致',
      `${resumedBuf.length}/${randomBuf.length}`
    )
    const statsAfterResume = await (
      await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    assert(
      statsAfterResume.totalDownloads === statsBeforeResume.totalDownloads + 1,
      '续传不重复消费下载次数（全程只 +1）',
      JSON.stringify({
        before: statsBeforeResume.totalDownloads,
        after: statsAfterResume.totalDownloads
      })
    )
    const tokenCleared = await evaluate(
      page,
      `(() => {
        try {
          return localStorage.getItem(${JSON.stringify(dlKey)})
        } catch {
          return 'blocked'
        }
      })()`
    )
    assert(tokenCleared === null, '续传成功后清理本地 token', String(tokenCleared))
    const stagedAtEnd = await evaluate(page, stagedSizeExpr, true)
    assert(
      stagedAtEnd === randomBuf.length,
      'OPFS 暂存写满原始大小（导出后仍由浏览器读取）',
      `${stagedAtEnd}/${randomBuf.length}`
    )

    console.log('\n[E2E-9] 公告样式：位置/滚动/配色（真实浏览器）')
    const saveNotice = (payload) =>
      fetch(`${BASE}/api/notice`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
        body: JSON.stringify(payload)
      }).then((res) => res.json())
    const longNotice =
      '为保障服务稳定，本周末将进行两次例行维护：周六 02:00 至 04:00、周日 02:00 至 04:00。维护期间上传与取件会短暂不可用，请提前完成取件；如有紧急文件，请联系管理员登记离线转存，或改用其他渠道发送。感谢配合。'

    await saveNotice({
      enabled: true,
      title: '维护公告',
      content: longNotice,
      display: 'both',
      position: 'fixed-bottom',
      scroll: 'up',
      bgColor: '#112233',
      textColor: '#ffee00'
    })
    await page('Page.navigate', { url: `${BASE}/` })
    const styled = await probeNoticeBar(page, true)
    assert(
      styled !== null && styled.position === 'fixed' && styled.bottom === '0px',
      '公告条按配置悬浮在视口底部',
      JSON.stringify(styled)
    )
    assert(
      styled !== null && styled.background === 'rgb(17, 34, 51)' && styled.color === 'rgb(255, 238, 0)',
      '公告条应用自定义背景色与文字色',
      JSON.stringify(styled)
    )
    assert(
      styled !== null &&
        styled.animation === 'notice-bar-marquee-up' &&
        styled.items === 2 &&
        styled.overflowY === true &&
        styled.overflowX === false,
      '纵向滚动生效（长内容换行、复制一份以无缝循环）',
      JSON.stringify(styled)
    )
    assert(
      styled !== null &&
        styled.modal !== null &&
        styled.modal.background === 'rgb(17, 34, 51)' &&
        styled.modal.color === 'rgb(255, 238, 0)',
      '弹窗内容套用同一套配色',
      JSON.stringify(styled && styled.modal)
    )

    await saveNotice({
      enabled: true,
      title: '维护公告',
      content: longNotice,
      display: 'bar',
      position: 'top',
      scroll: 'none'
    })
    await page('Page.navigate', { url: `${BASE}/` })
    const plain = await probeNoticeBar(page)
    assert(
      plain !== null && plain.position === 'relative' && !plain.marqueeCls.includes('scrolling'),
      '顶部流内公告条不滚动（未进入滚动状态）',
      JSON.stringify(plain)
    )
    assert(
      plain !== null && plain.animation === 'none' && plain.overflowX === true,
      '静态模式即使内容超长也不做动画（保留单行省略）',
      JSON.stringify(plain)
    )
    assert(
      plain !== null && plain.background !== 'rgb(17, 34, 51)' && plain.color !== 'rgb(255, 238, 0)',
      '未配色时回退默认主题色',
      JSON.stringify(plain)
    )

    await saveNotice({
      enabled: true,
      title: '维护公告',
      content: longNotice,
      display: 'bar',
      position: 'fixed-top',
      scroll: 'left'
    })
    await page('Page.navigate', { url: `${BASE}/` })
    const marquee = await probeNoticeBar(page)
    assert(
      marquee !== null && marquee.position === 'fixed' && marquee.top === '0px',
      '公告条按配置悬浮在视口顶部',
      JSON.stringify(marquee)
    )
    assert(
      marquee !== null &&
        marquee.animation === 'notice-bar-marquee-left' &&
        marquee.items >= 2 &&
        marquee.trackWidth >= marquee.viewportWidth,
      '横向右→左滚动生效（超宽内容复制一份以无缝循环）',
      JSON.stringify(marquee)
    )

    const shortNotice = {
      enabled: true,
      title: '短公告',
      content: '本站只适合临时传文件使用',
      display: 'bar',
      position: 'fixed-top',
      scroll: 'left'
    }
    await saveNotice({ ...shortNotice, scrollFill: false })
    await page('Page.navigate', { url: `${BASE}/` })
    const noFill = await probeNoticeBar(page)
    assert(
      noFill !== null &&
        noFill.animation === 'none' &&
        noFill.items === 1 &&
        !noFill.marqueeCls.includes('scrolling'),
      '关闭自动填满时，内容未超出可视宽度就不滚动（保留原有行为）',
      JSON.stringify(noFill)
    )

    await saveNotice({ ...shortNotice, scrollFill: true })
    await page('Page.navigate', { url: `${BASE}/` })
    const filled = await probeNoticeBar(page)
    assert(
      filled !== null &&
        filled.animation === 'notice-bar-marquee-left' &&
        filled.items >= 2 &&
        filled.trackWidth >= filled.viewportWidth,
      '开启自动填满后，内容装得下时横向滚动也生效',
      JSON.stringify(filled)
    )
    assert(
      filled !== null && filled.items > 2,
      '短内容被复制到至少 3 份才能填满可视宽度',
      JSON.stringify({ items: filled && filled.items, widths: filled && [filled.trackWidth, filled.viewportWidth] })
    )
    assert(
      marquee !== null &&
        marquee.role === 'status' &&
        marquee.ariaLive === 'polite' &&
        marquee.title.includes('维护公告') &&
        marquee.title.includes('本周末将进行两次例行维护'),
      '公告条带 role=status + aria-live=polite 语义，且标题给出完整内容（读屏与悬停均可用）',
      JSON.stringify({ role: marquee && marquee.role, live: marquee && marquee.ariaLive, title: marquee && marquee.title.slice(0, 20) })
    )

    await page('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await saveNotice({
      enabled: true,
      title: '维护公告',
      content: longNotice,
      display: 'bar',
      position: 'fixed-top',
      scroll: 'left',
      scrollFill: true
    })
    await page('Page.navigate', { url: `${BASE}/` })
    const reduced = await probeNoticeBar(page)
    assert(
      reduced !== null &&
        reduced.animation === 'none' &&
        !reduced.marqueeCls.includes('scrolling') &&
        reduced.items === 1,
      '系统开启「减少动态效果」时，即使配置为滚动+自动填满也降级为静态（无动画、不复制内容）',
      JSON.stringify(reduced)
    )
    assert(
      reduced !== null && reduced.overflowX === true && reduced.role === 'status',
      '降级后仍保留单行省略与 aria-live 语义（信息不丢）',
      JSON.stringify({ overflowX: reduced && reduced.overflowX, role: reduced && reduced.role })
    )
    await page('Emulation.setEmulatedMedia', { features: [] })
    await page('Page.navigate', { url: `${BASE}/` })
    const restored = await probeNoticeBar(page)
    assert(
      restored !== null && restored.animation === 'notice-bar-marquee-left',
      '取消模拟后动画恢复（偏好切换即时生效）',
      JSON.stringify({ animation: restored && restored.animation })
    )

    console.log('\n[E2E-10] 公告预设：保存/套用/启用/删除（真实浏览器）')
    const presetName = `E2E 预设-${Date.now()}`
    await page('Page.navigate', { url: `${BASE}/admin` })
    let adminStage = ''
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      adminStage = await evaluate(
        page,
        `(() => {
          if (document.querySelector('input[placeholder="管理密钥"]')) return 'login'
          if ([...document.querySelectorAll('button')].some((b) => b.innerText.includes('保存为预设'))) {
            return 'dashboard'
          }
          return ''
        })()`
      )
      if (adminStage) break
    }
    assert(adminStage !== '', '管理端进入公告设置（已登录或登录页）', adminStage || '(未捕获)')
    if (adminStage === 'login') {
      await evaluate(
        page,
        `(() => {
          const input = document.querySelector('input[placeholder="管理密钥"]')
          input.focus()
          return true
        })()`
      )
      await page('Input.insertText', { text: ADMIN_KEY })
      await evaluate(
        page,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('进入管理后台'))
          if (!button) throw new Error('登录按钮不存在')
          button.click()
          return true
        })()`
      )
      for (let i = 0; i < 60; i++) {
        await sleep(200)
        const ready = await evaluate(
          page,
          `[...document.querySelectorAll('button')].some((b) => b.innerText.includes('保存为预设'))`
        )
        if (ready) break
      }
    }
    const previewState = await evaluate(
      page,
      `(() => {
        const wrap = document.querySelector('.notice-preview-wrap')
        const bar = wrap ? wrap.querySelector('.notice-bar-alert-preview') : null
        const hint = wrap && wrap.lastElementChild ? wrap.lastElementChild.innerText.trim() : ''
        return {
          hasPreviewBar: Boolean(bar),
          position: bar ? getComputedStyle(bar).position : '',
          reason: hint
        }
      })()`
    )
    assert(
      previewState.hasPreviewBar && previewState.position !== 'fixed',
      '管理端实时预览渲染公告条且不悬浮在页面上',
      JSON.stringify(previewState)
    )
    assert(
      previewState.reason.startsWith('实时预览：') && previewState.reason.length > '实时预览：'.length,
      '实时预览给出滚动状态说明',
      JSON.stringify(previewState)
    )

    const readScrollFill = () =>
      evaluate(
        page,
        `(() => {
          const node = document.querySelector('.notice-scroll-fill')
          if (!node) return null
          node.scrollIntoView({ block: 'center' })
          return { checked: node.classList.contains('ant-switch-checked'), text: node.innerText.trim() }
        })()`
      )
    const clickScrollFill = () =>
      evaluate(
        page,
        `(() => {
          const node = document.querySelector('.notice-scroll-fill')
          if (!node) return false
          node.click()
          return true
        })()`
      )
    const switchInitial = await readScrollFill()
    assert(switchInitial !== null, '公告设置提供「内容不足时」开关', JSON.stringify(switchInitial))
    await clickScrollFill()
    const switchFlipped = await readScrollFill()
    assert(
      switchFlipped !== null && switchFlipped.checked === !switchInitial.checked,
      '「内容不足时」开关点击一次即翻转状态',
      JSON.stringify({ before: switchInitial, after: switchFlipped })
    )
    if (!switchFlipped.checked) await clickScrollFill()
    const switchOn = await readScrollFill()
    assert(
      switchOn !== null && switchOn.checked === true && switchOn.text.includes('自动填满'),
      '「自动填满滚动」可开启',
      JSON.stringify(switchOn)
    )
    const switchOff = await (async () => {
      await clickScrollFill()
      const off = await readScrollFill()
      await clickScrollFill()
      return off
    })()
    assert(
      switchOff !== null && switchOff.checked === false && switchOff.text.includes('不滚动'),
      '「内容不足时不滚动」可切回（两种模式都支持）',
      JSON.stringify(switchOff)
    )

    const noticeBeforePreset = await (await fetch(`${BASE}/api/notice`)).json()
    await evaluate(
      page,
      `(() => {
        const input = document.querySelector('input[placeholder^="预设名称"]')
        if (!input) throw new Error('预设名称输入框不存在')
        input.scrollIntoView({ block: 'center' })
        input.focus()
        return true
      })()`
    )
    await page('Input.insertText', { text: presetName })
    await clickButtonByText(page, '保存为预设')
    let presetRows = []
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      presetRows = await evaluate(
        page,
        `[...document.querySelectorAll('.notice-preset-row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim())`
      )
      if (presetRows.length > 0) break
    }
    const presetApi = await (
      await fetch(`${BASE}/api/admin/notice/presets`, { headers: { 'x-admin-key': ADMIN_KEY } })
    ).json()
    const savedPreset = (presetApi.presets || []).find((item) => item.name === presetName)
    assert(
      presetApi.limit === 10 && Boolean(savedPreset),
      '预设保存到服务端（列表可读回，上限 10）',
      JSON.stringify({ limit: presetApi.limit, names: (presetApi.presets || []).map((p) => p.name) })
    )
    assert(
      presetRows.length === 1 && presetRows[0].includes(presetName),
      '预设列表渲染出新保存的预设',
      JSON.stringify(presetRows)
    )
    assert(
      presetRows.length === 1 &&
        presetRows[0].includes('公告条') &&
        presetRows[0].includes('悬浮顶部') &&
        presetRows[0].includes('右→左') &&
        presetRows[0].includes('自动填满滚动') &&
        /(默认底色|底色 #)/.test(presetRows[0]),
      '预设摘要展示显示方式/位置/滚动/自动填满/配色标签',
      presetRows[0] || '(空)'
    )

    await clickButtonByText(page, '套用')
    const appliedForm = await evaluate(
      page,
      `(() => {
        const active = document.querySelector('.ant-radio-button-wrapper-checked')
        const checked = [...document.querySelectorAll('.ant-radio-button-wrapper-checked')].map((el) => el.innerText.trim())
        const inputs = [...document.querySelectorAll('input[placeholder="公告标题（可选，默认显示“公告”）"]')]
        return { checked, title: inputs[0] ? inputs[0].value : '', name: (document.querySelector('input[placeholder^="预设名称"]') || {}).value || '' }
      })()`
    )
    assert(
      appliedForm.name === presetName && appliedForm.checked.length >= 3,
      '套用把预设回填表单（含名称与选项状态）',
      JSON.stringify(appliedForm)
    )

    await clickButtonByText(page, '启用')
    let noticeAfterActivate = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      noticeAfterActivate = await (await fetch(`${BASE}/api/notice`)).json()
      if (noticeAfterActivate.updatedAt > noticeBeforePreset.updatedAt) break
    }
    assert(
      noticeAfterActivate !== null &&
        noticeAfterActivate.updatedAt > noticeBeforePreset.updatedAt &&
        noticeAfterActivate.position === savedPreset.notice.position &&
        noticeAfterActivate.bgColor === savedPreset.notice.bgColor &&
        noticeAfterActivate.scroll === savedPreset.notice.scroll &&
        noticeAfterActivate.scrollFill === true,
      '启用预设即成为当前公告（字段与预设一致）',
      JSON.stringify({ after: noticeAfterActivate, preset: savedPreset.notice })
    )

    await clickButtonByText(page, '删除')
    const confirmClicked = await evaluate(
      page,
      `(() => {
        const button = [...document.querySelectorAll('.ant-popover button, .ant-popconfirm button')].find(
          (b) => b.innerText.replace(/\\s+/g, '') === '删除'
        )
        if (!button) return false
        button.click()
        return true
      })()`
    )
    let presetsAfterDelete = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      presetsAfterDelete = await (
        await fetch(`${BASE}/api/admin/notice/presets`, { headers: { 'x-admin-key': ADMIN_KEY } })
      ).json()
      if ((presetsAfterDelete.presets || []).length === 0) break
    }
    const noticeAfterDelete = await (await fetch(`${BASE}/api/notice`)).json()
    assert(confirmClicked === true, '删除预设弹出二次确认', String(confirmClicked))
    assert(
      (presetsAfterDelete.presets || []).length === 0,
      '确认后预设被删除',
      JSON.stringify((presetsAfterDelete.presets || []).map((p) => p.name))
    )
    assert(
      noticeAfterDelete.updatedAt === noticeAfterActivate.updatedAt,
      '删除预设不影响已启用的当前公告',
      JSON.stringify({ after: noticeAfterDelete.updatedAt, activated: noticeAfterActivate.updatedAt })
    )

    console.log('\n[E2E-11] 公告预设：排序 / 审计 / 导出（真实浏览器）')
    const presetStamp = Date.now()
    const presetA = `E2E 排序A-${presetStamp}`
    const presetB = `E2E 排序B-${presetStamp}`
    const sortNotice = {
      enabled: true,
      title: 'E2E 排序预设',
      content: '排序与审计用例公告内容',
      display: 'bar',
      position: 'top',
      scroll: 'left',
      scrollFill: false
    }
    const createPresetApi = (name) =>
      fetch(`${BASE}/api/admin/notice/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
        body: JSON.stringify({ name, notice: sortNotice })
      }).then((res) => res.json())
    const presetsApi = async () =>
      (await fetch(`${BASE}/api/admin/notice/presets`, { headers: { 'x-admin-key': ADMIN_KEY } })).json()
    const clickRect = async (rect) => {
      if (!rect) return false
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      return true
    }

    await createPresetApi(presetA)
    await createPresetApi(presetB)
    await page('Page.navigate', { url: `${BASE}/admin` })
    let orderRows = []
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      orderRows = await evaluate(
        page,
        `[...document.querySelectorAll('.notice-preset-row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim())`
      )
      if (orderRows.length === 2) break
    }
    assert(
      orderRows.length === 2 && orderRows[0].includes(presetA) && orderRows[1].includes(presetB),
      '管理端按 order 渲染预设顺序（先存的服务端在前）',
      JSON.stringify(orderRows)
    )
    const presetControls = await evaluate(
      page,
      `(() => {
        const exportBtn = document.querySelector('.notice-preset-export')
        const importFile = document.querySelector('.notice-preset-import-file')
        const moveDown = document.querySelector('.notice-preset-row button[aria-label="下移"]')
        const moveUp = document.querySelector('.notice-preset-row button[aria-label="上移"]')
        return {
          exportDisabled: exportBtn ? exportBtn.disabled : null,
          hasImportInput: Boolean(importFile),
          moveDownEnabled: moveDown ? !moveDown.disabled : null,
          firstMoveUpDisabled: moveUp ? moveUp.disabled : null
        }
      })()`
    )
    assert(
      presetControls.exportDisabled === false &&
        presetControls.hasImportInput === true &&
        presetControls.moveDownEnabled === true &&
        presetControls.firstMoveUpDisabled === true,
      '管理端提供导出/导入入口与排序按钮（首行不可上移、可下移）',
      JSON.stringify(presetControls)
    )

    const moveRect = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('.notice-preset-row button[aria-label="下移"]')
        if (!button) return null
        button.scrollIntoView({ block: 'center' })
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    )
    await clickRect(moveRect)
    let orderAfterMove = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      orderAfterMove = await presetsApi()
      if ((orderAfterMove.presets || [])[0] && orderAfterMove.presets[0].name === presetB) break
    }
    assert(
      orderAfterMove.presets[0].name === presetB &&
        orderAfterMove.presets[1].name === presetA &&
        orderAfterMove.presets.map((p) => p.order).join(',') === '1,2',
      '点击「下移」即交换顺序并落库（order 重排为 1,2）',
      JSON.stringify(orderAfterMove.presets.map((p) => `${p.order}:${p.name}`))
    )

    await clickButtonByText(page, '启用')
    let auditedPreset = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      const list = await presetsApi()
      auditedPreset = (list.presets || []).find((item) => item.name === presetB)
      if (auditedPreset && auditedPreset.appliedAt > 0) break
    }
    assert(
      auditedPreset &&
        auditedPreset.appliedAt > 0 &&
        auditedPreset.appliedCount === 1 &&
        /^key:[0-9a-f]{8}$/.test(String(auditedPreset.appliedBy)),
      '启用预设写入审计（时间 + 管理密钥指纹 + 次数）',
      JSON.stringify(auditedPreset && {
        at: auditedPreset.appliedAt,
        by: auditedPreset.appliedBy,
        count: auditedPreset.appliedCount
      })
    )
    let auditRowText = ''
    for (let i = 0; i < 40; i++) {
      await sleep(200)
      auditRowText = await evaluate(
        page,
        `(() => {
          const row = [...document.querySelectorAll('.notice-preset-row')].find((r) =>
            r.innerText.includes(${JSON.stringify(presetB)})
          )
          return row ? row.innerText.replace(/\\s+/g, ' ').trim() : ''
        })()`
      )
      if (auditRowText.includes('上次启用')) break
    }
    assert(
      auditRowText.includes('上次启用') &&
        auditRowText.includes(auditedPreset.appliedBy) &&
        auditRowText.includes('共 1 次'),
      '预设行展示审计信息（上次启用时间 / 指纹 / 次数）',
      auditRowText.slice(0, 140)
    )

    const downloadsBefore = new Set(fs.readdirSync(DOWNLOAD_DIR))
    const exportRect = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('.notice-preset-export')
        if (!button) return null
        button.scrollIntoView({ block: 'center' })
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    )
    await clickRect(exportRect)
    const exportFile = await waitForFile(
      DOWNLOAD_DIR,
      20000,
      (name) => name.startsWith('notice-presets-') && !downloadsBefore.has(name)
    )
    let exportedJson = null
    try {
      exportedJson = exportFile ? JSON.parse(fs.readFileSync(exportFile, 'utf8')) : null
    } catch {}
    assert(
      exportedJson !== null &&
        exportedJson.format === 'file-share-notice-presets' &&
        exportedJson.version === 1 &&
        exportedJson.presets.length === 2 &&
        exportedJson.presets.map((item) => item.name).join(',') === `${presetB},${presetA}`,
      '点「导出」触发浏览器真实下载（带格式版本号，顺序与列表一致）',
      JSON.stringify(
        exportedJson && {
          format: exportedJson.format,
          version: exportedJson.version,
          names: exportedJson.presets.map((item) => item.name)
        }
      )
    )

    await page('Page.navigate', { url: `${BASE}/admin/settings` })
    let limitShown = null
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      limitShown = await evaluate(
        page,
        `(() => {
          const input = document.querySelector('.preset-limit-input input')
          return input
            ? {
                value: input.value,
                max: input.getAttribute('max'),
                ariaMax: input.getAttribute('aria-valuemax')
              }
            : null
        })()`
      )
      if (limitShown) break
    }
    assert(
      limitShown !== null &&
        limitShown.value === '10' &&
        (limitShown.max === '50' || limitShown.ariaMax === '50'),
      '站点设置提供公告预设上限输入（默认 10 / 硬上限 50）',
      JSON.stringify(limitShown)
    )
    // antd 的步进按钮平时宽度为 0，悬停才展开：先真实悬停再点，否则点到的是 1px 细条。
    const limitInputRect = await evaluate(
      page,
      `(() => {
        const input = document.querySelector('.preset-limit-input input')
        if (!input) return null
        input.scrollIntoView({ block: 'center' })
        const r = input.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    )
    if (limitInputRect) {
      await page('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: limitInputRect.x,
        y: limitInputRect.y,
        button: 'left'
      })
      await sleep(300)
    }
    const decreaseRect = await evaluate(
      page,
      `(() => {
        const node = document.querySelector('.preset-limit-input .ant-input-number-handler-down')
        if (!node) return null
        node.scrollIntoView({ block: 'center' })
        const r = node.getBoundingClientRect()
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          width: Math.round(r.width)
        }
      })()`
    )
    const decreaseClicked = await clickRect(decreaseRect)
    assert(
      decreaseRect !== null && decreaseRect.width >= 20,
      '预设上限输入框的步进按钮悬停后展开为可点区域',
      JSON.stringify(decreaseRect)
    )
    const saveLimitRect = await evaluate(
      page,
      `(() => {
        const input = document.querySelector('.preset-limit-input')
        const compact = input && input.closest('.ant-space-compact')
        const button = compact && compact.querySelector('button')
        if (!button) return null
        button.scrollIntoView({ block: 'center' })
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    )
    await clickRect(saveLimitRect)
    let limitAfterSave = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      limitAfterSave = await (await fetch(`${BASE}/api/settings`)).json()
      if (limitAfterSave.presetLimit === 9) break
    }
    assert(
      decreaseClicked === true && limitAfterSave.presetLimit === 9,
      '在站点设置里调低上限并保存后立即生效（10 → 9，预设列表上限同步）',
      JSON.stringify({ decreased: decreaseClicked, limit: limitAfterSave && limitAfterSave.presetLimit })
    )
    const limitedList = await presetsApi()
    assert(limitedList.limit === 9, '预设接口上限随站点设置同步（9）', String(limitedList.limit))
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ presetLimit: 0 })
    })

    console.log('\n[E2E-12] 多公告：双槽位渲染与时间窗到点下线（真实浏览器）')
    const adminJson = (pathname, options = {}) =>
      fetch(`${BASE}${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY, ...(options.headers || {}) }
      }).then((res) => res.json())
    const createNoticeApi = (payload) => adminJson('/api/admin/notices', { method: 'POST', body: JSON.stringify(payload) })
    const updateNoticeApi = (id, payload) =>
      adminJson(`/api/admin/notices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) })
    const deleteNoticeApi = (id) =>
      adminJson(`/api/admin/notices/${encodeURIComponent(id)}`, { method: 'DELETE' })

    const noticesNow = await adminJson('/api/admin/notices')
    for (const entry of noticesNow.notices || []) await deleteNoticeApi(entry.id)

    const topEntry = await createNoticeApi({
      title: 'E2E 顶部公告',
      content: '顶部槽位公告内容',
      display: 'bar',
      position: 'top',
      priority: 50,
      enabled: true
    })
    const bottomEntry = await createNoticeApi({
      title: 'E2E 底部公告',
      content: '底部槽位公告内容',
      display: 'bar',
      position: 'bottom',
      priority: 90,
      enabled: true
    })
    assert(
      Boolean(topEntry.notice && topEntry.notice.id) &&
        Boolean(bottomEntry.notice && bottomEntry.notice.id) &&
        topEntry.notice.id !== bottomEntry.notice.id,
      '管理接口创建两条不同槽位的公告',
      JSON.stringify({ top: topEntry.notice && topEntry.notice.id, bottom: bottomEntry.notice && bottomEntry.notice.id })
    )

    const probeBars = () =>
      evaluate(
        page,
        `(() => [...document.querySelectorAll('.notice-bar-alert')].map((bar) => {
          const content = bar.querySelector('.notice-bar-content')
          const title = bar.querySelector('.notice-bar-title')
          return { cls: bar.className, text: content ? content.innerText : '', title: title ? title.innerText : '' }
        }))()`
      )

    await page('Page.navigate', { url: `${BASE}/` })
    let bars = []
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      bars = await probeBars()
      if (bars.length >= 2) break
    }
    assert(
      bars.length === 2 &&
        bars.some((b) => b.text === '顶部槽位公告内容') &&
        bars.some((b) => b.text === '底部槽位公告内容'),
      '上下两个槽位同时渲染各自槽位优先级最高的公告',
      JSON.stringify(bars)
    )

    const futureStart = Date.now() + 3600_000
    await updateNoticeApi(topEntry.notice.id, {
      ...topEntry.notice,
      startAt: futureStart,
      rev: topEntry.notice.rev
    })
    await page('Page.navigate', { url: `${BASE}/` })
    let barsAfter = []
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      barsAfter = await probeBars()
      if (barsAfter.length === 1 && barsAfter[0].text === '底部槽位公告内容') break
    }
    assert(
      barsAfter.length === 1 && barsAfter[0].text === '底部槽位公告内容',
      '把顶部公告的 startAt 设为未来后刷新，只剩底部那条（到点自动上下线）',
      JSON.stringify(barsAfter)
    )

    await page('Page.navigate', { url: `${BASE}/admin` })
    let listRows = []
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      listRows = await evaluate(
        page,
        `(() => [...document.querySelectorAll('.notice-row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim()))()`
      )
      if (listRows.length >= 2) break
    }
    assert(
      listRows.length >= 2 &&
        listRows.some((text) => text.includes('E2E 顶部公告')) &&
        listRows.some((text) => text.includes('未到生效时间')) &&
        listRows.some((text) => text.includes('生效中')),
      '管理端公告列表展示全部公告及其生效状态',
      JSON.stringify(listRows)
    )

    const editClicked = await evaluate(
      page,
      `(() => {
        const row = [...document.querySelectorAll('.notice-row')].find((item) => item.innerText.includes('E2E 顶部公告'))
        const button = row && [...row.querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, '').includes('编辑'))
        if (!button) return null
        button.click()
        return true
      })()`
    )
    let editTitle = ''
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      editTitle = await evaluate(
        page,
        `(() => { const input = document.querySelector('input[placeholder^="公告标题"]'); return input ? input.value : '' })()`
      )
      if (editTitle === 'E2E 顶部公告') break
    }
    assert(
      editClicked === true && editTitle === 'E2E 顶部公告',
      '点击「编辑」把该条公告载入下方表单',
      JSON.stringify({ editClicked, editTitle })
    )

    await clickButtonByText(page, '新建公告')
    let createMode = null
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      createMode = await evaluate(
        page,
        `(() => { const input = document.querySelector('input[placeholder^="公告标题"]'); return { title: input ? input.value : '', divider: document.body.innerText.includes('新建公告') } })()`
      )
      if (createMode && createMode.title === '') break
    }
    assert(
      createMode !== null && createMode.title === '' && createMode.divider === true,
      '点击「新建公告」清空表单回到新增模式',
      JSON.stringify(createMode)
    )

    for (const entry of [topEntry.notice, bottomEntry.notice]) {
      if (entry && entry.id) await deleteNoticeApi(entry.id)
    }

    console.log('\n[E2E-13] 公告样式扩展：字号/圆角/不透明度与纵向行数（真实浏览器）')
    const longVertical =
      '这是用于验证纵向行数上限的公告内容，长度足以换行到多行：第一行说明维护时间，第二行说明影响范围，第三行说明替代方案与联系方式，第四行是收尾感慨。'
    const styleNotice = await adminJson('/api/admin/notices', {
      method: 'POST',
      body: JSON.stringify({
        title: '样式扩展公告',
        content: longVertical,
        display: 'bar',
        position: 'top',
        scroll: 'up',
        maxLines: 3,
        fontSize: 18,
        radius: 10,
        opacity: 70,
        enabled: true
      })
    })
    const probeStyled = () =>
      evaluate(
        page,
        `(() => {
          const bar = document.querySelector('.notice-bar-alert')
          const viewport = document.querySelector('.notice-bar-viewport')
          if (!bar || !viewport) return null
          const cs = getComputedStyle(bar)
          const vcs = getComputedStyle(viewport)
          return {
            fontSize: cs.fontSize,
            radius: cs.borderRadius,
            opacity: cs.opacity,
            maxHeight: vcs.maxHeight,
            clipped: viewport.clientHeight
          }
        })()`
      )

    await page('Page.navigate', { url: `${BASE}/` })
    let styled3 = null
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      styled3 = await probeStyled()
      if (styled3 && styled3.maxHeight !== 'none') break
    }
    assert(
      styled3 !== null &&
        styled3.fontSize === '18px' &&
        styled3.radius === '10px' &&
        styled3.opacity === '0.7',
      '字号/圆角/不透明度按配置落到公告条（计算样式）',
      JSON.stringify(styled3)
    )
    assert(
      styled3 !== null && styled3.maxHeight === '72px' && styled3.clipped > 24,
      '纵向行数上限 3 行 ⇒ 视口高 72px（24px × 行数）',
      JSON.stringify(styled3)
    )

    await adminJson(`/api/admin/notices/${encodeURIComponent(styleNotice.notice.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...styleNotice.notice, maxLines: 1, rev: styleNotice.notice.rev })
    })
    await page('Page.navigate', { url: `${BASE}/` })
    let styled1 = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      styled1 = await probeStyled()
      if (styled1 && styled1.maxHeight === '24px') break
    }
    assert(
      styled1 !== null && styled1.maxHeight === '24px' && styled1.clipped <= 24,
      '行数改回 1 行 ⇒ 视口高 24px（默认行为不回退）',
      JSON.stringify(styled1)
    )

    await deleteNoticeApi(styleNotice.notice.id)

    console.log('\n[E2E-14] 会话配额卡片与预设满替换（真实浏览器）')
    const quotaShare = await upload(crypto.randomBytes(2048), 'e2e-配额.bin', 'application/octet-stream')
    await fetch(`${BASE}/api/download/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: quotaShare.code })
    })
    await fetch(`${BASE}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'e2e-配额上传.bin', size: 262144, mime: 'text/plain', expiresIn: '1', maxDownloads: '3' })
    })
    await page('Page.navigate', { url: `${BASE}/admin` })
    let quotaCard = null
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      quotaCard = await evaluate(
        page,
        `(() => {
          const card = [...document.querySelectorAll('.ant-card')].find((c) => {
            const title = c.querySelector('.ant-card-head-title')
            return title && title.innerText.trim() === '会话配额'
          })
          if (!card) return null
          return { rows: [...card.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim()) }
        })()`
      )
      // 表格在 stats 落地前会先渲染「当前没有在途会话」空态行，因此要等到真实出口行出现再断言，
      // 否则会与首帧（stats 仍为 null）竞态失败。
      if (quotaCard && quotaCard.rows.some((row) => /127\.0\.0\.1/.test(row))) break
    }
    assert(
      quotaCard !== null && quotaCard.rows.some((row) => /127\.0\.0\.1/.test(row)),
      '仪表盘「会话配额」卡片按出口列出在途会话与临时空间用量',
      JSON.stringify(quotaCard)
    )

    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ presetLimit: 1 })
    })
    const presetsBeforeReplace = await adminJson('/api/admin/notice/presets')
    for (const preset of presetsBeforeReplace.presets || []) {
      await fetch(`${BASE}/api/admin/notice/presets/${encodeURIComponent(preset.id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
    const seededPreset = await adminJson('/api/admin/notice/presets', {
      method: 'POST',
      body: JSON.stringify({ name: 'E2E 待替换预设', notice: { enabled: true, content: '替换前的预设' } })
    })
    assert(
      Boolean(seededPreset.preset && seededPreset.preset.id),
      '预设上限调为 1 并预置一条预设',
      JSON.stringify(seededPreset.preset && seededPreset.preset.name)
    )

    const clickAt = async (rect) => {
      if (!rect) return false
      await page('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      await page('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      return true
    }
    const rectOf = (selector) =>
      evaluate(
        page,
        `(() => {
          const node = document.querySelector(${JSON.stringify(selector)})
          if (!node) return null
          node.scrollIntoView({ block: 'center' })
          const r = node.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`
      )

    await page('Page.navigate', { url: `${BASE}/admin` })
    for (let i = 0; i < 80; i++) {
      await sleep(200)
      const ready = await evaluate(page, `document.querySelectorAll('.notice-preset-row').length >= 1`)
      if (ready) break
    }
    await evaluate(
      page,
      `(() => {
        const input = document.querySelector('input[placeholder^="预设名称"]')
        if (!input) throw new Error('预设名称输入框不存在')
        input.scrollIntoView({ block: 'center' })
        input.focus()
        return true
      })()`
    )
    await page('Input.insertText', { text: 'E2E 替换后预设' })
    await clickButtonByText(page, '保存为预设')
    let replaceModalShown = false
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      replaceModalShown = await evaluate(
        page,
        `Boolean(document.querySelector('.notice-preset-replace'))`
      )
      if (replaceModalShown) break
    }
    assert(
      replaceModalShown === true,
      '达上限时保存按钮仍可用，点后弹出「选择要替换的预设」弹窗',
      String(replaceModalShown)
    )

    await clickAt(await rectOf('.notice-preset-replace .ant-select-selector'))
    let optionPicked = false
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      optionPicked = await evaluate(
        page,
        `(() => {
          const option = document.querySelector('.ant-select-item-option')
          if (!option) return false
          option.click()
          return true
        })()`
      )
      if (optionPicked) break
    }
    let okEnabled = false
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      okEnabled = await evaluate(
        page,
        `(() => {
          const ok = document.querySelector('.ant-modal-footer .ant-btn-primary')
          return Boolean(ok) && !ok.disabled
        })()`
      )
      if (okEnabled) break
    }
    const okClicked = await evaluate(
      page,
      `(() => {
        const ok = document.querySelector('.ant-modal-footer .ant-btn-primary')
        if (!ok) return false
        ok.click()
        return true
      })()`
    )
    let replacedList = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      replacedList = await adminJson('/api/admin/notice/presets')
      const names = (replacedList.presets || []).map((preset) => preset.name)
      if (names.length === 1 && names[0] === 'E2E 替换后预设') break
    }
    assert(
      optionPicked === true &&
        okEnabled === true &&
        okClicked === true &&
        (replacedList.presets || []).length === 1 &&
        replacedList.presets[0].name === 'E2E 替换后预设',
      '替换后总数仍为上限值，且列表中是新的预设',
      JSON.stringify({
        optionPicked,
        okEnabled,
        names: (replacedList.presets || []).map((preset) => preset.name)
      })
    )
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ presetLimit: 0 })
    })

    console.log('\n[E2E-15] 关于 / 反馈闭环 / 页脚备案 / 手机菜单（真实浏览器）')
    await adminJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        beian: '粤ICP备2024000000号',
        gongan: '粤公网安备 44030402000000号'
      })
    })

    await page('Page.navigate', { url: `${BASE}/about` })
    let aboutText = ''
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      aboutText = await evaluate(page, `document.body.innerText`)
      if (aboutText.includes('如何使用') && aboutText.includes('开源地址')) break
    }
    assert(
      aboutText.includes('关于') &&
        aboutText.includes('如何使用') &&
        aboutText.includes('https://github.com/3446744308/filework'),
      '「关于」页渲染服务说明、使用步骤与开源地址',
      aboutText.replace(/\s+/g, ' ').slice(0, 120)
    )
    assert(
      aboutText.includes('粤ICP备2024000000号') && aboutText.includes('粤公网安备 44030402000000号'),
      '页脚展示后台配置的 ICP / 公安备案号',
      aboutText.replace(/\s+/g, ' ').slice(-160)
    )
    let footerIcons = null
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      footerIcons = await evaluate(
        page,
        `(() => {
          const footer = document.querySelector('.site-footer')
          if (!footer) return null
          const icons = [...footer.querySelectorAll('.site-footer-icon')].map((img) => ({
            src: img.getAttribute('src'),
            loaded: img.complete && img.naturalWidth > 0
          }))
          return { icons }
        })()`
      )
      if (footerIcons && footerIcons.icons.length === 2 && footerIcons.icons.every((i) => i.loaded)) break
    }
    assert(
      footerIcons !== null &&
        footerIcons.icons.length === 2 &&
        footerIcons.icons.every((i) => i.loaded) &&
        footerIcons.icons[0].src === '/icons/icp.webp' &&
        footerIcons.icons[1].src === '/icons/gonganbeian.png',
      '备案图标实际加载成功（web/public/icons 已随构建发布）',
      JSON.stringify(footerIcons && footerIcons.icons)
    )

    await page('Page.navigate', { url: `${BASE}/feedback` })
    let feedbackFormReady = false
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      feedbackFormReady = await evaluate(
        page,
        `Boolean(document.querySelector('textarea')) && Boolean([...document.querySelectorAll('button')].find((b) => b.innerText.includes('提交反馈')))`
      )
      if (feedbackFormReady) break
    }
    assert(feedbackFormReady === true, '「反馈」页渲染出类型 / 内容表单与提交按钮', String(feedbackFormReady))

    await evaluate(
      page,
      `(() => { const t = document.querySelector('textarea'); t.scrollIntoView({ block: 'center' }); t.focus(); return true })()`
    )
    await page('Input.insertText', { text: 'E2E 反馈：手机端菜单与页脚备案可见性检查' })
    await clickButtonByText(page, '提交反馈')
    let feedbackCode = ''
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      feedbackCode = await evaluate(
        page,
        `(() => {
          const modal = document.querySelector('.ant-modal-wrap')
          const matched = modal && modal.innerText.match(/FB-\\d{8}/)
          return matched ? matched[0] : ''
        })()`
      )
      if (feedbackCode) break
    }
    assert(
      /^FB-\d{8}$/.test(feedbackCode),
      '提交反馈后弹窗给出反馈号（FB- + 8 位数字）',
      feedbackCode || '(未拿到反馈号)'
    )

    await page('Page.navigate', { url: `${BASE}/feedback-query?code=${encodeURIComponent(feedbackCode)}` })
    let queryState = null
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      queryState = await evaluate(
        page,
        `(() => {
          const box = document.querySelector('.feedback-query-result')
          if (!box) return null
          return {
            text: box.innerText.replace(/\\s+/g, ' ').trim(),
            steps: document.querySelectorAll('.ant-steps-item').length
          }
        })()`
      )
      if (queryState && queryState.steps >= 3) break
    }
    assert(
      queryState !== null &&
        queryState.steps >= 3 &&
        queryState.text.includes('等待中') &&
        queryState.text.includes('E2E 反馈：手机端菜单与页脚备案可见性检查'),
      '「查询反馈」页凭反馈号展示处理进度与反馈原文',
      JSON.stringify(queryState && queryState.text.slice(0, 160))
    )

    const feedbackList = await adminJson('/api/admin/feedback')
    const feedbackItem = (feedbackList.list || []).find((item) => item.code === feedbackCode)
    assert(
      Boolean(feedbackItem),
      '管理端反馈列表可检索到该反馈号',
      JSON.stringify((feedbackList.list || []).map((item) => item.code))
    )
    const replied = await adminJson(`/api/admin/feedback/${encodeURIComponent(feedbackItem.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'done', reply: 'E2E：问题已处理完毕' })
    })
    assert(
      replied.ok === true && replied.feedback.status === 'done',
      '管理端回复并置为已完成',
      JSON.stringify(replied.feedback && replied.feedback.status)
    )

    await page('Page.navigate', { url: `${BASE}/feedback-query?code=${encodeURIComponent(feedbackCode)}` })
    let replyText = ''
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      replyText = await evaluate(
        page,
        `(() => { const box = document.querySelector('.feedback-query-reply'); return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '' })()`
      )
      if (replyText.includes('E2E：问题已处理完毕')) break
    }
    assert(
      replyText.includes('官方回复') && replyText.includes('E2E：问题已处理完毕'),
      '用户侧重载后能看到官方回复区块',
      replyText || '(未渲染)'
    )

    await page('Page.navigate', { url: `${BASE}/admin/feedback` })
    let feedbackRow = ''
    for (let i = 0; i < 100; i++) {
      await sleep(200)
      feedbackRow = await evaluate(
        page,
        `(() => {
          const row = [...document.querySelectorAll('.ant-table-tbody tr')].find((tr) => tr.innerText.includes(${JSON.stringify(feedbackCode)}))
          return row ? row.innerText.replace(/\\s+/g, ' ').trim() : ''
        })()`
      )
      if (feedbackRow) break
    }
    assert(
      feedbackRow.includes(feedbackCode) && feedbackRow.includes('已完成'),
      '管理端「反馈管理」表格渲染该反馈号与已完成状态',
      feedbackRow || '(未渲染)'
    )

    await page('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    })
    await page('Page.navigate', { url: `${BASE}/` })
    let mobileHeader = null
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      mobileHeader = await evaluate(
        page,
        `(() => {
          const menu = document.querySelector('.site-header-menu')
          const burger = document.querySelector('.site-header-burger')
          if (!menu || !burger) return null
          return {
            menuDisplay: getComputedStyle(menu).display,
            burgerDisplay: getComputedStyle(burger).display,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          }
        })()`
      )
      if (mobileHeader) break
    }
    assert(
      mobileHeader !== null &&
        mobileHeader.menuDisplay === 'none' &&
        mobileHeader.burgerDisplay !== 'none' &&
        mobileHeader.overflowX <= 0,
      '窄屏（390px）隐藏横向菜单、显示汉堡按钮且页面不横向溢出',
      JSON.stringify(mobileHeader)
    )

    await evaluate(page, `document.querySelector('.site-header-burger').click()`)
    let drawerTop = ''
    for (let i = 0; i < 60; i++) {
      await sleep(150)
      drawerTop = await evaluate(
        page,
        `(() => { const drawer = document.querySelector('.mobile-drawer-menu'); return drawer ? drawer.innerText.replace(/\\s+/g, ' ').trim() : '' })()`
      )
      if (drawerTop.includes('其他')) break
    }
    assert(
      drawerTop.includes('上传文件') && drawerTop.includes('输入取件码') && drawerTop.includes('其他'),
      '汉堡按钮拉出抽屉菜单，含上传 / 取件与「其他」折叠组',
      drawerTop || '(未渲染)'
    )

    const submenuOpened = await evaluate(
      page,
      `(() => {
        const title = [...document.querySelectorAll('.mobile-drawer-menu .ant-menu-submenu-title')].find((node) => node.innerText.includes('其他'))
        if (!title) return false
        title.click()
        return true
      })()`
    )
    let drawerChildren = ''
    for (let i = 0; i < 60; i++) {
      await sleep(150)
      drawerChildren = await evaluate(
        page,
        `(() => { const drawer = document.querySelector('.mobile-drawer-menu'); return drawer ? drawer.innerText.replace(/\\s+/g, ' ').trim() : '' })()`
      )
      if (drawerChildren.includes('查询反馈')) break
    }
    assert(
      submenuOpened === true &&
        drawerChildren.includes('关于') &&
        drawerChildren.includes('反馈') &&
        drawerChildren.includes('查询反馈'),
      '展开「其他」后抽屉中出现关于 / 反馈 / 查询反馈三个入口',
      drawerChildren || '(未渲染)'
    )

    await evaluate(
      page,
      `(() => { const close = document.querySelector('.ant-drawer-close'); if (close) close.click(); return true })()`
    )
    await page('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })

    console.log('\n[E2E-16] 取件码输入常驻页面（不再弹窗，填满仍自动查询）')
    await adminJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ displayMode: 'simple' })
    })
    await page('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    await page('Page.navigate', { url: `${BASE}/d` })
    let retrieveForm = null
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      retrieveForm = await evaluate(
        page,
        `(() => {
          const form = document.querySelector('.retrieve-form')
          if (!form) return null
          const otp = form.querySelector('.ant-otp')
          const card = form.closest('.ant-card')
          const rect = form.getBoundingClientRect()
          return {
            inCard: Boolean(card),
            cellCount: form.querySelectorAll('.ant-otp-input').length,
            visible: rect.width > 0 && rect.height > 0 && getComputedStyle(form).display !== 'none',
            tip: form.innerText.replace(/\\s+/g, ' ').trim(),
            hasQueryButton: Boolean([...form.querySelectorAll('button')].find((b) => b.innerText.includes('查询'))),
            otpRendered: Boolean(otp)
          }
        })()`
      )
      if (retrieveForm && retrieveForm.cellCount === 6) break
    }
    assert(
      retrieveForm !== null &&
        retrieveForm.inCard &&
        retrieveForm.visible &&
        retrieveForm.otpRendered &&
        retrieveForm.cellCount === 6 &&
        retrieveForm.hasQueryButton &&
        retrieveForm.tip.includes('填满后自动查询'),
      '无取件码的 /d 页直接内联渲染 6 格输入区（在卡片内、可见、带查询按钮）',
      JSON.stringify(retrieveForm)
    )

    const modalsWithoutCode = await evaluate(
      page,
      `({ wraps: document.querySelectorAll('.ant-modal-wrap').length, visible: [...document.querySelectorAll('.ant-modal-wrap')].filter((n) => getComputedStyle(n).display !== 'none').length })`
    )
    assert(
      modalsWithoutCode.wraps === 0 && modalsWithoutCode.visible === 0,
      '进入 /d 不再自动弹出取件码弹窗（DOM 中没有 modal）',
      JSON.stringify(modalsWithoutCode)
    )

    const inlineShare = await upload(crypto.randomBytes(1024), 'e2e-取件码输入.bin', 'application/octet-stream')
    const codeForInline = inlineShare.code
    await evaluate(
      page,
      `(() => { const cell = document.querySelector('.retrieve-form .ant-otp-input'); cell.focus(); return true })()`
    )
    await page('Input.insertText', { text: codeForInline })
    let inlineState = null
    for (let i = 0; i < 100; i++) {
      await sleep(150)
      inlineState = await evaluate(
        page,
        `({
          path: location.pathname,
          cells: [...document.querySelectorAll('.retrieve-form .ant-otp-input')].map((n) => n.value).join(''),
          result: Boolean(document.querySelector('.retrieve-result')),
          modals: document.querySelectorAll('.ant-modal-wrap').length
        })`
      )
      if (inlineState.path === '/d/${codeForInline}' && inlineState.result) break
    }
    assert(
      inlineState.path === `/d/${codeForInline}` &&
        inlineState.cells === codeForInline &&
        inlineState.result === true &&
        inlineState.modals === 0,
      '填满 6 位立即自动查询并跳转 /d/<码>，全程无弹窗',
      JSON.stringify(inlineState)
    )

    await page('Page.navigate', { url: `${BASE}/d/000000` })
    let errorState = null
    for (let i = 0; i < 80; i++) {
      await sleep(150)
      errorState = await evaluate(
        page,
        `(() => {
          const alert = document.querySelector('.ant-alert')
          if (!alert) return null
          return {
            text: alert.innerText.replace(/\\s+/g, ' ').trim(),
            formVisible: Boolean(document.querySelector('.retrieve-form')),
            modals: document.querySelectorAll('.ant-modal-wrap').length
          }
        })()`
      )
      if (errorState) break
    }
    assert(
      errorState !== null &&
        errorState.formVisible === true &&
        errorState.modals === 0 &&
        errorState.text.length > 0,
      '取件码无效时错误提示与输入区同屏，无需再点按钮弹窗',
      JSON.stringify(errorState)
    )

    console.log(
      `\n结果: ${passed} 通过, ${failed} 失败（health=${health.ok ? 'ok' : 'no'}，UA=${userAgent}）`
    )
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close')
    } catch {}
    try {
      if (cdp) cdp.ws.close()
    } catch {}
    try {
      if (chrome) chrome.kill()
    } catch {}
    server.kill('SIGTERM')
    await sleep(800)
    for (const dir of [DATA_DIR, PROFILE_DIR, DOWNLOAD_DIR]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}

run()
  .then(() => process.exit(failed > 0 ? 1 : 0))
  .catch((err) => {
    console.error('浏览器 E2E 异常:', err)
    process.exit(1)
  })
