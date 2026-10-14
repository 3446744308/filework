import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3999
const ADMIN_KEY = 'test-admin-key'
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = path.join(rootDir, 'data-test')

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

async function req(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, options)
  let body = null
  const type = res.headers.get('content-type') || ''
  if (type.includes('application/json')) body = await res.json()
  return { res, body }
}

async function waitForServer(base = BASE) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function uploadForm(content, fields = {}, filename = '测试文件.txt') {
  const form = new FormData()
  form.append('file', new Blob([content]), filename)
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  return form
}

// 压缩已改为后台任务（backlog B1-2）：`/api/upload*` 的 201 只代表文件已落位并标 pending，
// 「压不压、压到多少」随后才回写元数据。测试统一用这个助手等任务落定再校验最终形态。
async function settleCompression(code, base = BASE) {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${base}/api/upload/job?code=${code}`)
    if (res.status === 404) return null
    if (res.ok) {
      const body = await res.json()
      if (body.finished && body.compressionState !== 'pending') return body
    }
    await new Promise((r) => setTimeout(r, 30))
  }
  return null
}

// 把落定后的压缩结论合并回上传响应，让「最终形态」断言不受后台化影响。
async function mergeCompression(body, base = BASE) {
  if (!body || !body.code) return body
  const settled = await settleCompression(body.code, base)
  if (settled) {
    body.compressed = settled.compressed
    body.storedSize = settled.storedSize
    body.compressionState = settled.compressionState
  }
  return body
}

async function upload(content, fields = {}, filename) {
  const { res, body } = await req('/api/upload', { method: 'POST', body: uploadForm(content, fields, filename) })
  if (res.status === 201) await mergeCompression(body)
  return { status: res.status, body }
}

async function run() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_KEY,
      DATA_DIR,
      MAX_FILE_SIZE: '1048576',
      RATE_LIMIT_MISSES: '5',
      UPLOAD_LIMIT_PER_MINUTE: '1000',
      TRANSFER_PART_SIZE: '262144',
      UNIT_TARGET_COUNT: '8',
      UNIT_MIN_SIZE: '65536',
      UNIT_MAX_SIZE: '262144',
      UNIT_MAX_COUNT: '64',
      COMPRESS_CODECS: 'br,gzip',
      MAX_NOTICES: '5'
    }
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (d) => process.stderr.write(d))

  const alive = await waitForServer()
  if (!alive) {
    console.error('服务器启动失败')
    server.kill()
    process.exit(1)
  }

  const health0 = await req('/api/health')
  assert(
    health0.res.status === 200 &&
      health0.body.ok === true &&
      Array.isArray(health0.body.features) &&
      health0.body.features.includes('blockedExts'),
    '健康检查返回 features 功能标记（部署自检）',
    JSON.stringify(health0.body)
  )
  assert(
    [
      'compression',
      'chunkedUpload',
      'parallelDownload',
      'downloadSession',
      'transferCompression',
      'adaptiveChunking',
      'unitDedup',
      'multiCodec',
      'transferStats',
      'codecToggle',
      'sessionQuota',
      'multiNotice'
    ].every((f) => health0.body.features.includes(f)),
    '健康检查包含传输优化功能标记',
    JSON.stringify(health0.body.features)
  )

  console.log('\n[1] 上传与查询')
  const content = 'hello file locker 12345'
  const up1 = await upload(content, { expiresIn: '24', maxDownloads: '3', note: '这是备注' })
  assert(up1.status === 201, '上传成功返回 201', `实际 ${up1.status}: ${JSON.stringify(up1.body)}`)
  const code1 = up1.body && up1.body.code
  assert(/^\d{6}$/.test(code1 || ''), '返回 6 位数字取件码', `实际 ${code1}`)
  assert(
    up1.body && up1.body.note === '这是备注',
    '上传响应包含 note',
    JSON.stringify(up1.body && up1.body.note)
  )

  const info1 = await req(`/api/info?code=${code1}`)
  assert(info1.res.status === 200, 'info 查询成功')
  assert(info1.body && info1.body.filename === '测试文件.txt', 'info 中文文件名正确', JSON.stringify(info1.body))
  assert(info1.body && info1.body.note === '这是备注', 'info 返回 note', JSON.stringify(info1.body && info1.body.note))
  assert(info1.body && info1.body.maxDownloads === 3 && info1.body.downloads === 0, 'info 次数正确', JSON.stringify(info1.body))

  const badFormat = await req('/api/info?code=abc')
  assert(badFormat.res.status === 400, '非法取件码返回 400', `实际 ${badFormat.res.status}`)

  const notExist = await req('/api/info?code=999999')
  assert(notExist.res.status === 404 && notExist.body.error.includes('不存在'), '不存在的码返回 404')

  console.log('\n[2] 下载与次数消耗')
  const dl1 = await fetch(`${BASE}/api/download?code=${code1}`)
  const dl1Text = await dl1.text()
  assert(dl1.status === 200, '第 1 次下载成功', `实际 ${dl1.status}`)
  assert(dl1Text === content, '下载内容与上传一致', JSON.stringify(dl1Text))
  assert(
    (dl1.headers.get('content-disposition') || '').includes('attachment'),
    '响应为附件下载',
    dl1.headers.get('content-disposition')
  )
  assert(
    (dl1.headers.get('content-disposition') || '').includes("filename*=UTF-8''"),
    '下载文件名按 UTF-8 编码',
    dl1.headers.get('content-disposition')
  )

  const info2 = await req(`/api/info?code=${code1}`)
  assert(info2.body && info2.body.downloads === 1, '已下载次数为 1', JSON.stringify(info2.body))

  const dl2 = await fetch(`${BASE}/api/download?code=${code1}`)
  assert(dl2.status === 200, '第 2 次下载成功', `实际 ${dl2.status}`)

  const dl3 = await fetch(`${BASE}/api/download?code=${code1}`)
  assert(dl3.status === 200, '第 3 次（最后一次）下载成功', `实际 ${dl3.status}`)

  const info3 = await req(`/api/info?code=${code1}`)
  assert(info3.res.status === 404 && info3.body.error.includes('取走'), '次数耗尽后码失效', JSON.stringify(info3.body))

  const dlAfter = await fetch(`${BASE}/api/download?code=${code1}`)
  assert(dlAfter.status === 404, '次数耗尽后下载返回 404', `实际 ${dlAfter.status}`)

  console.log('\n[3] 过期销毁')
  const up2 = await upload('expire me', { expiresIn: '24', maxDownloads: '5' })
  const code2 = up2.body.code
  const metaFile = path.join(DATA_DIR, 'meta', `${code2}.json`)
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.expiresAt = Date.now() - 1000
  fs.writeFileSync(metaFile, JSON.stringify(meta))
  const infoExpired = await req(`/api/info?code=${code2}`)
  assert(infoExpired.res.status === 404 && infoExpired.body.error.includes('过期'), '过期分享返回 404', JSON.stringify(infoExpired.body))
  assert(!fs.existsSync(metaFile), '过期分享元数据已删除')
  assert(!fs.existsSync(path.join(DATA_DIR, 'files', code2)), '过期分享文件已删除')

  console.log('\n[4] 文件大小限制')
  const big = await upload('x'.repeat(2 * 1024 * 1024), { expiresIn: '24', maxDownloads: '1' })
  assert(big.status === 413, '超限文件返回 413', `实际 ${big.status}`)

  console.log('\n[5] 管理接口')
  const pingNoKey = await req('/api/admin/ping')
  assert(pingNoKey.res.status === 401, 'ping 无密钥返回 401', `实际 ${pingNoKey.res.status}`)
  const pingOk = await req('/api/admin/ping', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(pingOk.res.status === 200 && pingOk.body.ok === true, 'ping 正确密钥返回 200')
  const noKey = await req('/api/admin/list')
  assert(noKey.res.status === 401, '无密钥返回 401', `实际 ${noKey.res.status}`)
  const wrongKey = await req('/api/admin/list', { headers: { 'x-admin-key': 'wrong' } })
  assert(wrongKey.res.status === 401, '错误密钥返回 401', `实际 ${wrongKey.res.status}`)

  const up3 = await upload('admin delete me', { expiresIn: '1', maxDownloads: '1' })
  const code3 = up3.body.code
  const list = await req('/api/admin/list', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(list.res.status === 200, '正确密钥返回 200')
  assert(list.body.list.some((i) => i.code === code3), '列表包含新上传的分享', JSON.stringify(list.body.list))

  const del = await req(`/api/admin/${code3}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })
  assert(del.res.status === 200 && del.body.ok === true, '管理员删除成功')
  const infoDeleted = await req(`/api/info?code=${code3}`)
  assert(infoDeleted.res.status === 404, '删除后取件码失效', `实际 ${infoDeleted.res.status}`)

  console.log('\n[6] 公告配置')
  const n0 = await req('/api/notice')
  assert(n0.res.status === 200 && n0.body.enabled === false, '默认公告为关闭', JSON.stringify(n0.body))

  const putNoKey = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, content: 'no key' })
  })
  assert(putNoKey.res.status === 401, '无密钥修改公告返回 401', `实际 ${putNoKey.res.status}`)

  const putOk = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, title: '开服公告', content: '本周日凌晨 2 点维护', display: 'bar' })
  })
  assert(putOk.res.status === 200 && putOk.body.notice.enabled === true, '管理员保存公告', JSON.stringify(putOk.body))

  const n1 = await req('/api/notice')
  assert(
    n1.body && n1.body.enabled === true && n1.body.title === '开服公告' && n1.body.content === '本周日凌晨 2 点维护',
    '公告内容读取正确',
    JSON.stringify(n1.body)
  )
  assert(n1.body.display === 'bar', '公告显示方式保存为 bar', JSON.stringify(n1.body))

  const putBadDisplay = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, title: '开服公告', content: '本周日凌晨 2 点维护', display: 'hacker' })
  })
  assert(putBadDisplay.body.notice.display === 'modal', '非法显示方式回退 modal', JSON.stringify(putBadDisplay.body))

  const putEmpty = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, title: '空公告', content: '' })
  })
  assert(
    putEmpty.res.status === 200 && putEmpty.body.notice.enabled === false,
    '内容为空时自动关闭公告',
    JSON.stringify(putEmpty.body)
  )

  const putStyled = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      enabled: true,
      title: '样式公告',
      content: '公告条样式与位置',
      display: 'both',
      position: 'fixed-bottom',
      scroll: 'up',
      scrollFill: true,
      bgColor: '#ABC',
      textColor: 'rgb(1,2,3)'
    })
  })
  assert(
    putStyled.body.notice.position === 'fixed-bottom' && putStyled.body.notice.scroll === 'up',
    '公告位置与滚动方式保存成功',
    JSON.stringify(putStyled.body.notice)
  )
  assert(
    putStyled.body.notice.bgColor === '#aabbcc',
    '三位十六进制背景色补全为小写六位',
    putStyled.body.notice.bgColor
  )
  assert(
    putStyled.body.notice.textColor === '',
    '非十六进制文字色归零（回退默认主题）',
    putStyled.body.notice.textColor
  )

  const n2 = await req('/api/notice')
  assert(
    n2.body.position === 'fixed-bottom' &&
      n2.body.scroll === 'up' &&
      n2.body.scrollFill === true &&
      n2.body.bgColor === '#aabbcc' &&
      n2.body.display === 'both',
    '样式字段（含自动填满开关）落盘并可公开读取',
    JSON.stringify(n2.body)
  )

  const putBadStyle = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      enabled: true,
      title: '样式公告',
      content: '非法样式回落',
      position: 'sideways',
      scroll: 'spin',
      bgColor: '#12345',
      textColor: 'blue'
    })
  })
  assert(
    putBadStyle.body.notice.position === 'top' &&
      putBadStyle.body.notice.scroll === 'left' &&
      putBadStyle.body.notice.bgColor === '' &&
      putBadStyle.body.notice.textColor === '',
    '非法位置/滚动/颜色一律回落默认值',
    JSON.stringify(putBadStyle.body.notice)
  )
  assert(
    putBadStyle.body.notice.scrollFill === false,
    '未传自动填满开关时回落关闭',
    String(putBadStyle.body.notice.scrollFill)
  )

  fs.rmSync(path.join(DATA_DIR, 'notices.json'), { force: true })
  fs.writeFileSync(
    path.join(DATA_DIR, 'notice.json'),
    JSON.stringify({ enabled: true, title: '旧公告', content: '只有旧字段', display: 'bar' })
  )
  const legacyNotice = await req('/api/notice')
  assert(
    legacyNotice.body.content === '只有旧字段' &&
      legacyNotice.body.display === 'bar' &&
      legacyNotice.body.position === 'top' &&
      legacyNotice.body.scroll === 'left' &&
      legacyNotice.body.scrollFill === false &&
      legacyNotice.body.bgColor === '' &&
      legacyNotice.body.textColor === '' &&
      legacyNotice.body.id === 'default',
    '旧 notice.json 自动迁移为数组并补齐样式字段默认值',
    JSON.stringify(legacyNotice.body)
  )
  const migratedFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notices.json'), 'utf8'))
  assert(
    migratedFile.version === 2 &&
      Array.isArray(migratedFile.notices) &&
      migratedFile.notices.length === 1 &&
      migratedFile.notices[0].id === 'default' &&
      fs.existsSync(path.join(DATA_DIR, 'notice.json')),
    '迁移写出 notices.json（v2 单元素数组）且保留旧文件作回滚证据',
    JSON.stringify({ version: migratedFile.version, count: migratedFile.notices.length })
  )

  console.log('\n[7] 统计仪表盘')
  const sNoKey = await req('/api/admin/stats')
  assert(sNoKey.res.status === 401, '无密钥查看统计返回 401', `实际 ${sNoKey.res.status}`)

  const s0 = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(s0.res.status === 200 && typeof s0.body.fileCount === 'number', '统计接口可用', JSON.stringify(s0.body))
  assert(
    typeof s0.body.transferOriginalBytes === 'number' &&
      typeof s0.body.transferWireBytes === 'number' &&
      typeof s0.body.transferSavedBytes === 'number',
    '统计包含传输节省字段（原始/线上/节省字节）',
    JSON.stringify({
      original: s0.body.transferOriginalBytes,
      wire: s0.body.transferWireBytes,
      saved: s0.body.transferSavedBytes
    })
  )

  const upStat = await upload('stats test file', { expiresIn: '1', maxDownloads: '3' })
  const statCode = upStat.body.code
  const s1 = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(s1.body.fileCount === s0.body.fileCount + 1, '上传后文件数 +1', JSON.stringify([s0.body, s1.body]))
  assert(s1.body.totalUploads === s0.body.totalUploads + 1, '累计上传 +1', JSON.stringify([s0.body, s1.body]))
  assert(s1.body.totalSize === s0.body.totalSize + upStat.body.size, '总大小正确累加', JSON.stringify([s0.body, s1.body]))

  const statDl = await fetch(`${BASE}/api/download?code=${statCode}`)
  assert(statDl.status === 200, '统计用例下载成功', `实际 ${statDl.status}`)
  const s2 = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(s2.body.totalDownloads === s1.body.totalDownloads + 1, '累计下载 +1', JSON.stringify([s1.body, s2.body]))
  assert(s2.body.activeDownloads === s1.body.activeDownloads + 1, '有效下载次数 +1', JSON.stringify([s1.body, s2.body]))
  assert(s2.body.fileCount === s1.body.fileCount, '下载不改变文件数')

  const delStat = await req(`/api/admin/${statCode}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(delStat.res.status === 200, '清理统计用例分享')
  const s3 = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(s3.body.fileCount === s2.body.fileCount - 1, '删除后文件数 -1', JSON.stringify([s2.body, s3.body]))

  console.log('\n[7b] 取件密码')
  const pwUp = await upload('password protected', {
    expiresIn: '1',
    maxDownloads: '3',
    password: 'secret123'
  })
  assert(pwUp.status === 201 && pwUp.body.hasPassword === true, '上传带密码返回 hasPassword', JSON.stringify(pwUp.body && pwUp.body.hasPassword))
  assert(
    pwUp.body && !('password' in pwUp.body) && typeof pwUp.body.password === 'undefined',
    '上传响应不泄露密码字段',
    JSON.stringify(pwUp.body && pwUp.body.password)
  )
  const pwInfo = await req(`/api/info?code=${pwUp.body.code}`)
  assert(
    pwInfo.res.status === 200 && pwInfo.body.hasPassword === true,
    'info 返回 hasPassword',
    JSON.stringify(pwInfo.body && pwInfo.body.hasPassword)
  )
  assert(
    pwInfo.body && typeof pwInfo.body.password === 'undefined',
    'info 不返回密码哈希',
    JSON.stringify(pwInfo.body && pwInfo.body.password)
  )
  const pwVerifyOk = await req('/api/verify-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pwUp.body.code, password: 'secret123' })
  })
  assert(pwVerifyOk.res.status === 200 && pwVerifyOk.body.ok === true, '正确密码验证通过', JSON.stringify(pwVerifyOk.body))
  const pwVerifyBad = await req('/api/verify-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pwUp.body.code, password: 'wrong' })
  })
  assert(pwVerifyBad.res.status === 403, '错误密码返回 403', `实际 ${pwVerifyBad.res.status}`)
  const pwDlNo = await req(`/api/download?code=${pwUp.body.code}`)
  assert(pwDlNo.res.status === 403, '无密码下载返回 403', `实际 ${pwDlNo.res.status}`)
  const pwDlBad = await req(`/api/download?code=${pwUp.body.code}&password=wrong`)
  assert(pwDlBad.res.status === 403, '错误密码下载返回 403', `实际 ${pwDlBad.res.status}`)
  const pwDlOk = await fetch(`${BASE}/api/download?code=${pwUp.body.code}&password=secret123`)
  assert(pwDlOk.status === 200, '正确密码下载成功', `实际 ${pwDlOk.status}`)
  await pwDlOk.arrayBuffer()
  const pwUp2 = await upload('no password share', { expiresIn: '1', maxDownloads: '1' })
  assert(pwUp2.status === 201 && pwUp2.body.hasPassword === false, '无密码上传 hasPassword=false', JSON.stringify(pwUp2.body && pwUp2.body.hasPassword))
  for (const c of [pwUp, pwUp2]) {
    if (c.body && c.body.code) {
      await req(`/api/admin/${c.body.code}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
  }

  console.log('\n[9] 静态页面（需已执行 npm run build）')
  const hasDist = fs.existsSync(path.join(rootDir, 'web', 'dist', 'index.html'))
  if (hasDist) {
    const home = await fetch(`${BASE}/`)
    const html = await home.text()
    assert(home.status === 200 && html.includes('<div id="root">'), '首页返回 SPA')
    const page = await fetch(`${BASE}/d/123456`)
    assert(page.status === 200, '取件页路由回退到 SPA')
    const filesPage = await fetch(`${BASE}/admin/files`)
    assert(filesPage.status === 200, '文件管理页路由回退到 SPA')
  } else {
    console.log('  - 跳过（web/dist 不存在）')
  }

  console.log('\n[10] 站点设置')
  const setNoKey = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ siteName: 'Hacker' })
  })
  assert(setNoKey.res.status === 401, '无密钥修改设置返回 401', `实际 ${setNoKey.res.status}`)

  const setDefault = await req('/api/settings')
  assert(
    setDefault.res.status === 200 && setDefault.body.siteName === '' && setDefault.body.hasLogo === false,
    '默认设置：空名称、无 logo',
    JSON.stringify(setDefault.body)
  )

  const putName = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '我的驿站' })
  })
  assert(
    putName.res.status === 200 && putName.body.ok && putName.body.settings.siteName === '我的驿站',
    '保存站点名称',
    JSON.stringify(putName.body)
  )

  const setRead = await req('/api/settings')
  assert(setRead.body.siteName === '我的驿站', '站点名称读回', JSON.stringify(setRead.body))

  const longName = '站'.repeat(80)
  const putLong = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: longName })
  })
  assert(
    putLong.body.settings.siteName.length <= 50,
    '超长名称截断为 50',
    String(putLong.body.settings.siteName.length)
  )

  const logoMissing = await req('/api/logo')
  assert(logoMissing.res.status === 404, '未设置 logo 返回 404', `实际 ${logoMissing.res.status}`)

  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082',
    'hex'
  )
  const logoForm = new FormData()
  logoForm.append('logo', new Blob([pngBytes], { type: 'image/png' }), 'logo.png')
  const putLogo = await req('/api/settings/logo', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: logoForm
  })
  assert(
    putLogo.res.status === 200 && putLogo.body.ok && putLogo.body.settings.hasLogo === true,
    '上传 logo',
    JSON.stringify(putLogo.body)
  )

  const logoRes = await fetch(`${BASE}/api/logo`)
  const logoType = logoRes.headers.get('content-type') || ''
  const logoSize = (await logoRes.arrayBuffer()).byteLength
  assert(
    logoRes.status === 200 && logoType.includes('image/') && logoSize > 0,
    '公开读取 logo',
    `${logoRes.status} ${logoType} ${logoSize}`
  )

  const badLogoForm = new FormData()
  badLogoForm.append('logo', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'evil.txt')
  const putBadLogo = await req('/api/settings/logo', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: badLogoForm
  })
  assert(putBadLogo.res.status === 400, '非图片类型 logo 拒绝', `实际 ${putBadLogo.res.status}`)

  const delLogo = await req('/api/settings/logo', {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(delLogo.body.ok && delLogo.body.settings.hasLogo === false, '删除 logo', JSON.stringify(delLogo.body))
  const logoGone = await req('/api/logo')
  assert(logoGone.res.status === 404, '删除后 logo 返回 404', `实际 ${logoGone.res.status}`)

  await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '' })
  })

  console.log('\n[11] 上传大小上限')
  const lim0 = await req('/api/settings')
  assert(
    lim0.res.status === 200 && lim0.body.maxFileSize > 0 && lim0.body.maxFileSize === lim0.body.maxFileSizeCap,
    '默认上限等于环境变量 MAX_FILE_SIZE',
    JSON.stringify(lim0.body)
  )

  const putLim = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', maxFileSize: 1048576 })
  })
  assert(
    putLim.res.status === 200 && putLim.body.settings.maxFileSize === 1048576,
    '保存 1MB 上限',
    JSON.stringify(putLim.body)
  )

  const over = await upload('x'.repeat(Math.ceil(1.5 * 1024 * 1024)), { expiresIn: '1', maxDownloads: '3' })
  assert(over.status === 413, '超过上限返回 413', `实际 ${over.status} ${JSON.stringify(over.body)}`)

  const small = await upload('within limit', { expiresIn: '1', maxDownloads: '3' })
  assert(small.status === 201, '限内文件正常上传', `实际 ${small.status}`)
  if (small.body && small.body.code) {
    await req(`/api/admin/${small.body.code}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
  }

  const putHuge = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', maxFileSize: 1024 * 1024 * 1024 })
  })
  assert(
    putHuge.body.settings.maxFileSize === lim0.body.maxFileSizeCap,
    '超过环境上限时截断为 MAX_FILE_SIZE',
    JSON.stringify(putHuge.body)
  )

  const putBadLimit = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', maxFileSize: -5 })
  })
  assert(
    putBadLimit.body.settings.maxFileSize === lim0.body.maxFileSizeCap,
    '非法上限恢复为默认值',
    JSON.stringify(putBadLimit.body)
  )

  const limReset = await req('/api/settings')
  assert(
    limReset.body.maxFileSize === lim0.body.maxFileSizeCap,
    '恢复默认后生效上限 = 环境变量值',
    JSON.stringify(limReset.body)
  )

  console.log('\n[12] 禁止上传文件类型')
  const blk0 = await req('/api/settings')
  assert(
    Array.isArray(blk0.body.blockedExts) && blk0.body.blockedExts.length === 0,
    '默认无禁止类型',
    JSON.stringify(blk0.body)
  )

  const putBlk = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', blockedExts: ['PHP', '.exe', ' js ', 'bad;rm', 'php', 'a-b'] })
  })
  assert(
    JSON.stringify(putBlk.body.settings.blockedExts) === '["php","exe","js"]',
    '黑名单规范化（小写/去点/过滤非法/去重）',
    JSON.stringify(putBlk.body)
  )

  const phpForm = new FormData()
  phpForm.append('file', new Blob([Buffer.from('<?php echo 1;')], { type: 'application/x-php' }), 'bad.php')
  const phpUp = await req('/api/upload', { method: 'POST', body: phpForm })
  assert(phpUp.res.status === 400, '禁止类型上传返回 400', `实际 ${phpUp.res.status} ${JSON.stringify(phpUp.body)}`)

  const txtUp = await upload('allowed file', { expiresIn: '1', maxDownloads: '3' })
  assert(txtUp.status === 201, '未禁止类型正常上传', `实际 ${txtUp.status}`)
  if (txtUp.body && txtUp.body.code) {
    await req(`/api/admin/${txtUp.body.code}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
  }

  const putBadBlk = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', blockedExts: 'php' })
  })
  assert(
    Array.isArray(putBadBlk.body.settings.blockedExts) && putBadBlk.body.settings.blockedExts.length === 0,
    '非数组黑名单回退为空',
    JSON.stringify(putBadBlk.body)
  )

  await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ siteName: '', blockedExts: [] })
  })

  console.log('\n[13] 发件显示模式与面单字段')
  const dm0 = await req('/api/settings')
  assert(dm0.body.displayMode === 'simple', '默认显示模式为简约版', JSON.stringify(dm0.body.displayMode))

  const cce0 = await req('/api/settings')
  assert(
    cce0.res.status === 200 && cce0.body.customCodeEnabled === true,
    '默认开启自定义取件码',
    JSON.stringify(cce0.body.customCodeEnabled)
  )
  const putCceOff = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ customCodeEnabled: false })
  })
  assert(
    putCceOff.res.status === 200 && putCceOff.body.settings.customCodeEnabled === false,
    '关闭自定义取件码',
    JSON.stringify(putCceOff.body.settings && putCceOff.body.settings.customCodeEnabled)
  )
  const cceOffUpload = await upload('custom code disabled', {
    expiresIn: '1',
    maxDownloads: '1',
    customCode: '888002'
  })
  assert(
    cceOffUpload.status === 201 && cceOffUpload.body.code !== '888002',
    '关闭时忽略 customCode 并随机生成',
    JSON.stringify(cceOffUpload.body)
  )
  if (cceOffUpload.body && cceOffUpload.body.code) {
    await req(`/api/admin/${cceOffUpload.body.code}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
  }
  await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ customCodeEnabled: true })
  })

  const putDm = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ displayMode: 'waybill' })
  })
  assert(
    putDm.res.status === 200 && putDm.body.settings.displayMode === 'waybill',
    '保存快递面单显示模式',
    JSON.stringify(putDm.body.settings.displayMode)
  )

  const dmRead = await req('/api/settings')
  assert(dmRead.body.displayMode === 'waybill', '显示模式读回', dmRead.body.displayMode)

  const putBadDm = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ displayMode: 'hacker' })
  })
  assert(
    putBadDm.body.settings.displayMode === 'simple',
    '非法显示模式回退简约版',
    putBadDm.body.settings.displayMode
  )

  const wbUp = await upload('waybill field check', { expiresIn: '1', maxDownloads: '1' })
  assert(wbUp.status === 201, '面单字段：上传成功', `实际 ${wbUp.status}`)
  assert(
    wbUp.body && typeof wbUp.body.clientIp === 'string' && wbUp.body.clientIp.length > 0,
    '上传响应包含 clientIp',
    JSON.stringify(wbUp.body && wbUp.body.clientIp)
  )
  assert(
    wbUp.body && typeof wbUp.body.createdAt === 'number' && typeof wbUp.body.code === 'string',
    '上传响应含 createdAt 与 code（可拼面单号）',
    JSON.stringify(wbUp.body)
  )

  if (wbUp.body && wbUp.body.code) {
    await req(`/api/admin/${wbUp.body.code}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
  }

  console.log('\n[14] 自定义取件码')
  const cc1 = await upload('custom code 1', { expiresIn: '1', maxDownloads: '1', customCode: '888001' })
  assert(cc1.status === 201 && cc1.body.code === '888001', '自定义取件码生效', JSON.stringify(cc1.body))
  const cc2 = await upload('custom code 2', { expiresIn: '1', maxDownloads: '1', customCode: '888001' })
  assert(cc2.status === 409, '占用的自定义码返回 409', `实际 ${cc2.status}`)
  const cc3 = await upload('custom code 3', { expiresIn: '1', maxDownloads: '1', customCode: '12345' })
  assert(cc3.status === 201 && cc3.body.code !== '12345', '非法自定义码回退随机生成', JSON.stringify(cc3.body))
  for (const c of [cc1, cc3]) {
    if (c.body && c.body.code) {
      await req(`/api/admin/${c.body.code}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
  }

  await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ displayMode: 'simple' })
  })

  console.log('\n[16] 公网 IP 查询')
  const ipRes = await req('/api/ip')
  assert(
    ipRes.res.status === 200 && typeof ipRes.body.ip === 'string' && ipRes.body.ip.length > 0,
    '/api/ip 返回 ip 字段',
    JSON.stringify(ipRes.body)
  )

  console.log('\n[17] 压缩存储')
  const zText = 'A'.repeat(512 * 1024)
  const zUp = await upload(zText, { expiresIn: '1', maxDownloads: '3' })
  assert(zUp.status === 201, '可压缩文件上传成功', `${zUp.status} ${JSON.stringify(zUp.body)}`)
  assert(
    zUp.body.compressed === true && zUp.body.storedSize < zUp.body.size * 0.3,
    '压缩收益 ≥70%',
    JSON.stringify({ size: zUp.body.size, storedSize: zUp.body.storedSize })
  )
  const zMeta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta', `${zUp.body.code}.json`), 'utf8'))
  assert(
    zMeta.compression === 'units-v2' &&
      Array.isArray(zMeta.units) &&
      zMeta.units.length > 0 &&
      zMeta.units.reduce((sum, unit) => sum + unit.r, 0) === zUp.body.size,
    '容器元数据（compression/units 覆盖原始大小）',
    JSON.stringify({ compression: zMeta.compression, units: zMeta.units && zMeta.units.length })
  )
  const zDl = await fetch(`${BASE}/api/download?code=${zUp.body.code}`)
  const zDlText = await zDl.text()
  assert(zDl.status === 200 && zDlText === zText, '压缩文件下载逐字节一致', `${zDl.status} ${zDlText.length}`)
  assert(
    Number(zDl.headers.get('content-length')) === zUp.body.size,
    '压缩下载 Content-Length = 原始大小',
    zDl.headers.get('content-length')
  )
  const zList = await req('/api/admin/list', { headers: { 'x-admin-key': ADMIN_KEY } })
  const zItem = zList.body.list.find((i) => i.code === zUp.body.code)
  assert(
    zItem && zItem.storedSize === zUp.body.storedSize && zItem.compressed === true,
    '管理列表含 storedSize/compressed',
    JSON.stringify(zItem && { storedSize: zItem.storedSize, compressed: zItem.compressed })
  )
  const statsZ = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    typeof statsZ.body.totalStoredSize === 'number' &&
      statsZ.body.savedBytes >= zUp.body.size - zUp.body.storedSize,
    '统计包含存储节省（totalStoredSize/savedBytes）',
    JSON.stringify({ totalStoredSize: statsZ.body.totalStoredSize, savedBytes: statsZ.body.savedBytes })
  )

  const rndBuf = crypto.randomBytes(100 * 1024)
  const rndUp = await upload(rndBuf, { expiresIn: '1', maxDownloads: '3' })
  assert(
    rndUp.status === 201 && rndUp.body.compressed === false && rndUp.body.storedSize === rndUp.body.size,
    '不可压缩内容回退存原文件',
    JSON.stringify({ compressed: rndUp.body.compressed, size: rndUp.body.size, storedSize: rndUp.body.storedSize })
  )
  const rndDl = await fetch(`${BASE}/api/download?code=${rndUp.body.code}`)
  const rndDlBuf = Buffer.from(await rndDl.arrayBuffer())
  assert(
    rndDl.status === 200 && Buffer.compare(rndDlBuf, rndBuf) === 0,
    '未压缩文件下载逐字节一致',
    `${rndDl.status} ${rndDlBuf.length}`
  )

  const putOff = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ compressionEnabled: false })
  })
  assert(
    putOff.res.status === 200 && putOff.body.settings.compressionEnabled === false,
    '关闭压缩开关',
    JSON.stringify(putOff.body.settings && putOff.body.settings.compressionEnabled)
  )
  const offUp = await upload('B'.repeat(300 * 1024), { expiresIn: '1', maxDownloads: '3' })
  assert(
    offUp.status === 201 && offUp.body.compressed === false && offUp.body.storedSize === offUp.body.size,
    '关闭压缩后不再压缩',
    JSON.stringify({ compressed: offUp.body.compressed, storedSize: offUp.body.storedSize })
  )
  const setReadZ = await req('/api/settings')
  assert(setReadZ.body.compressionEnabled === false, '设置接口返回压缩开关', JSON.stringify(setReadZ.body.compressionEnabled))
  const putOn = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ compressionEnabled: true })
  })
  assert(putOn.body.settings.compressionEnabled === true, '恢复压缩开关', JSON.stringify(putOn.body.settings))

  console.log('\n[18] 分片并行上传')
  const partSize = 262144
  const fullBuf = Buffer.from('分片并行传输内容测试'.repeat(20000))
  const initRes = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: '分片说明.txt',
      size: fullBuf.length,
      mime: 'text/plain',
      expiresIn: '1',
      maxDownloads: '3',
      note: '分片上传'
    })
  })
  assert(
    initRes.res.status === 200 && initRes.body.partSize === partSize && initRes.body.totalParts === 3,
    'init 返回会话与分片参数',
    JSON.stringify(initRes.body)
  )
  const uploadId = initRes.body.uploadId
  const putPart = async (index, bodyBuf) => {
    const start = index * partSize
    const end = Math.min(start + partSize, fullBuf.length)
    const res = await fetch(`${BASE}/api/upload/part?uploadId=${uploadId}&index=${index}`, {
      method: 'PUT',
      body: bodyBuf || fullBuf.subarray(start, end)
    })
    let body = null
    try {
      body = await res.json()
    } catch {}
    return { res, body }
  }
  const p1 = await putPart(1)
  assert(p1.res.status === 200 && p1.body.received === 1, '乱序上传第 2 片', `实际 ${p1.res.status}`)
  const p0 = await putPart(0)
  const p2 = await putPart(2)
  assert(p0.res.status === 200 && p2.res.status === 200 && p2.body.received === 3, '分片全部到达', `实际 ${p0.res.status}/${p2.res.status}`)

  const badSession = await fetch(`${BASE}/api/upload/part?uploadId=deadbeef&index=0`, {
    method: 'PUT',
    body: fullBuf.subarray(0, 100)
  })
  assert(badSession.status === 404, '未知上传会话返回 404', `实际 ${badSession.status}`)
  const badIndex = await putPart(99)
  assert(badIndex.res.status === 400, '非法分片序号返回 400', `实际 ${badIndex.res.status}`)
  const shortPart = await putPart(0, fullBuf.subarray(0, 100))
  assert(shortPart.res.status === 400, '分片大小不符返回 400', `实际 ${shortPart.res.status}`)
  const bigPart = await fetch(`${BASE}/api/upload/part?uploadId=${uploadId}&index=0`, {
    method: 'PUT',
    body: fullBuf.subarray(0, partSize + 1)
  })
  assert(bigPart.status === 413, '超限分片返回 413', `实际 ${bigPart.status}`)
  await putPart(0)

  const init2 = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: '未完成.txt', size: 200000, mime: 'text/plain', expiresIn: '1', maxDownloads: '1' })
  })
  const early = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: init2.body.uploadId })
  })
  assert(early.res.status === 400, '分片不完整 complete 返回 400', JSON.stringify(early.body))

  const done = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId })
  })
  assert(done.res.status === 201, '分片上传 complete 返回 201', `${done.res.status} ${JSON.stringify(done.body)}`)
  assert(
    done.body.compressionState === 'pending',
    '分片上传 complete 立即返回且标 compressionState=pending（压缩后台化）',
    JSON.stringify(done.body.compressionState)
  )
  await mergeCompression(done.body)
  assert(done.body.compressed === true, '分片上传同样启用压缩', JSON.stringify(done.body.compressed))
  const doneDl = await fetch(`${BASE}/api/download?code=${done.body.code}`)
  const doneDlBuf = Buffer.from(await doneDl.arrayBuffer())
  assert(
    doneDl.status === 200 && Buffer.compare(doneDlBuf, fullBuf) === 0,
    '分片上传内容下载逐字节一致',
    `${doneDl.status} ${doneDlBuf.length}`
  )

  const ccTaken = await upload('custom occupy', { expiresIn: '1', maxDownloads: '1', customCode: '888020' })
  assert(ccTaken.status === 201, '自定义码占位成功')
  const ccInitDup = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: '冲突.txt', size: 1000, mime: 'text/plain', customCode: '888020' })
  })
  assert(ccInitDup.res.status === 409, 'init 自定义码冲突返回 409', `实际 ${ccInitDup.res.status}`)

  const raceBuf = Buffer.from('抢占测试'.repeat(1000))
  const raceInit = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: '抢占.txt',
      size: raceBuf.length,
      mime: 'text/plain',
      expiresIn: '1',
      maxDownloads: '1',
      customCode: '888021'
    })
  })
  assert(raceInit.res.status === 200, 'init 自定义码可用', JSON.stringify(raceInit.body))
  await fetch(`${BASE}/api/upload/part?uploadId=${raceInit.body.uploadId}&index=0`, {
    method: 'PUT',
    body: raceBuf
  })
  const raceOccupy = await upload('occupy 888021', { expiresIn: '1', maxDownloads: '1', customCode: '888021' })
  assert(raceOccupy.status === 201, '竞争前抢占自定义码', `实际 ${raceOccupy.status}`)
  const raceDone = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: raceInit.body.uploadId })
  })
  assert(raceDone.res.status === 409, 'complete 时自定义码已占用返回 409', `${raceDone.res.status} ${JSON.stringify(raceDone.body)}`)

  console.log('\n[19] 分片并行下载与会话保护')
  const dlText = '并行下载会话内容'.repeat(30000)
  const dlUp = await upload(dlText, { expiresIn: '1', maxDownloads: '3' })
  const sessRes = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dlUp.body.code })
  })
  assert(
    sessRes.res.status === 200 && typeof sessRes.body.token === 'string' && sessRes.body.partSize === partSize,
    '创建下载会话',
    JSON.stringify(sessRes.body)
  )
  const token = sessRes.body.token
  const infoS1 = await req(`/api/info?code=${dlUp.body.code}`)
  assert(infoS1.body.downloads === 1, '会话创建消费 1 次', JSON.stringify(infoS1.body.downloads))

  const ranges = [
    [0, 262144],
    [262144, 524288],
    [524288, dlUp.body.size]
  ]
  const partResponses = await Promise.all(
    ranges.map(([s, e]) => fetch(`${BASE}/api/download/part?token=${token}&start=${s}&end=${e}`))
  )
  const partBufParts = await Promise.all(partResponses.map((r) => r.arrayBuffer()))
  const assembled = Buffer.concat(partBufParts.map((b) => Buffer.from(b)))
  assert(
    partResponses.every((r) => r.status === 200) && Buffer.compare(assembled, Buffer.from(dlText)) === 0,
    '并发分片拼接逐字节一致',
    JSON.stringify(partResponses.map((r) => r.status))
  )
  const infoS2 = await req(`/api/info?code=${dlUp.body.code}`)
  assert(infoS2.body.downloads === 1, '分片请求不重复计数', JSON.stringify(infoS2.body.downloads))

  const badTokenRes = await fetch(`${BASE}/api/download/part?token=deadbeef&start=0&end=100`)
  assert(badTokenRes.status === 404, '无效会话 token 返回 404', `实际 ${badTokenRes.status}`)
  const badRangeRes = await fetch(`${BASE}/api/download/part?token=${token}&start=0&end=99999999`)
  assert(badRangeRes.status === 400, '越界范围返回 400', `实际 ${badRangeRes.status}`)
  const bigRangeRes = await fetch(`${BASE}/api/download/part?token=${token}&start=0&end=${partSize + 1}`)
  assert(bigRangeRes.status === 400, '超分片上限返回 400', `实际 ${bigRangeRes.status}`)

  const oneText = '会话保护测试'.repeat(1000)
  const oneUp = await upload(oneText, { expiresIn: '1', maxDownloads: '1' })
  const oneSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: oneUp.body.code })
  })
  assert(oneSess.res.status === 200, 'maxDownloads=1 创建会话', `实际 ${oneSess.res.status}`)
  const oneInfo = await req(`/api/info?code=${oneUp.body.code}`)
  assert(oneInfo.res.status === 404, '会话已耗尽计数（info 404）', `实际 ${oneInfo.res.status}`)
  const onePart = await fetch(`${BASE}/api/download/part?token=${oneSess.body.token}&start=0&end=5000`)
  const onePartBuf = Buffer.from(await onePart.arrayBuffer())
  assert(
    onePart.status === 200 && Buffer.compare(onePartBuf, Buffer.from(oneText).subarray(0, 5000)) === 0,
    '会话保护：耗尽后文件未被删除，分片仍可取',
    `实际 ${onePart.status}`
  )
  const endRes = await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: oneSess.body.token })
  })
  assert(endRes.res.status === 200 && endRes.body.ok === true, '结束下载会话', JSON.stringify(endRes.body))
  assert(!fs.existsSync(path.join(DATA_DIR, 'files', oneUp.body.code)), '会话结束后已耗尽分享文件被回收')
  assert(!fs.existsSync(path.join(DATA_DIR, 'meta', `${oneUp.body.code}.json`)), '会话结束后已耗尽分享元数据被回收')

  const pwSessUp = await upload('密码会话内容', { expiresIn: '1', maxDownloads: '2', password: 's3cret' })
  const pwSessBad = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pwSessUp.body.code, password: 'wrong' })
  })
  assert(pwSessBad.res.status === 403, '会话创建密码错误返回 403', `实际 ${pwSessBad.res.status}`)
  const pwSessOk = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pwSessUp.body.code, password: 's3cret' })
  })
  assert(pwSessOk.res.status === 200 && pwSessOk.body.token.length > 0, '正确密码创建会话', `实际 ${pwSessOk.res.status}`)

  for (const item of [zUp, rndUp, offUp, done, ccTaken, raceOccupy, dlUp, pwSessUp]) {
    if (item.body && item.body.code) {
      await req(`/api/admin/${item.body.code}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
  }

  console.log('\n[20] 自适应单元切分与编解码（纯函数对抗）')
  const unitsMod = await import('../server/units.js')
  const codecMod = await import('../server/codec.js')
  const testUnitCfg = { unitTargetCount: 8, unitMinSize: 65536, unitMaxSize: 262144, unitMaxCount: 64 }
  const prodUnitCfg = { unitTargetCount: 32, unitMinSize: 262144, unitMaxSize: 8388608, unitMaxCount: 256 }

  let planBounded = true
  let planCovers = true
  for (const size of [1, 65536, 65537, 262144, 1048576, 5 * 1024 * 1024, 300 * 1024 * 1024]) {
    for (const cfg of [testUnitCfg, prodUnitCfg]) {
      const plan = unitsMod.chunkPlan(size, cfg)
      if (!(plan.count >= 1 && plan.count <= cfg.unitMaxCount)) planBounded = false
      const ranges = unitsMod.uniformRanges(size, plan.unit)
      if (ranges.length !== plan.count) planCovers = false
      if (ranges[0][0] !== 0 || ranges[ranges.length - 1][1] !== size) planCovers = false
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] !== ranges[i - 1][1]) planCovers = false
      }
    }
  }
  assert(planBounded, '自适应分片：片数恒落在 [1, unitMaxCount]')
  assert(planCovers, '自适应分片：均匀计划无缝覆盖 [0, size)')

  const cdcCorpus = [
    { name: 'random', buf: crypto.randomBytes(700 * 1024) },
    { name: 'zeros', buf: Buffer.alloc(700 * 1024) },
    { name: 'repeated', buf: Buffer.from(('BLOCK-'.repeat(700) + 'tail').repeat(160)) },
    { name: 'text', buf: Buffer.from('第 123456 号取件码已就绪，请及时取件\n'.repeat(16000)) }
  ]
  let cdcSame = true
  let cdcCover = true
  let cdcBounds = true
  let cdcCap = true
  for (const item of cdcCorpus) {
    const opts = {
      ...unitsMod.chunkBounds(item.buf.length, testUnitCfg),
      maxCount: testUnitCfg.unitMaxCount
    }
    const fromBuffer = unitsMod.chunkRanges(item.buf, opts)
    if (!fromBuffer) {
      cdcCap = false
      continue
    }
    const probe = path.join(DATA_DIR, `cdc-${item.name}.bin`)
    fs.writeFileSync(probe, item.buf)
    const probeFd = fs.openSync(probe, 'r')
    const fromFile = unitsMod.chunkFile(probeFd, item.buf.length, opts)
    fs.closeSync(probeFd)
    fs.unlinkSync(probe)
    if (JSON.stringify(fromBuffer) !== JSON.stringify(fromFile)) cdcSame = false
    if (fromBuffer[0][0] !== 0 || fromBuffer[fromBuffer.length - 1][1] !== item.buf.length) {
      cdcCover = false
    }
    for (let i = 0; i < fromBuffer.length; i++) {
      const length = fromBuffer[i][1] - fromBuffer[i][0]
      if (i > 0 && fromBuffer[i][0] !== fromBuffer[i - 1][1]) cdcCover = false
      if (length > opts.max) cdcBounds = false
      if (i < fromBuffer.length - 1 && length < Math.min(opts.min, item.buf.length)) cdcBounds = false
    }
    if (fromBuffer.length > testUnitCfg.unitMaxCount) cdcCap = false
  }
  assert(cdcSame, 'CDC 流式与内存切分结果一致（两套实现互证）')
  assert(cdcCover, 'CDC 切分无缝覆盖全文')
  assert(cdcBounds, 'CDC 单元长度落在 [min, max] 内')
  assert(cdcCap, 'CDC 片数不超过上限')
  assert(
    unitsMod.chunkRanges(crypto.randomBytes(8192), { min: 64, avg: 128, max: 256, maxCount: 2 }) === null,
    '片数超上限时返回 null（上层回退均匀切分）'
  )
  assert(
    unitsMod.unitsCoverage([{ o: 0, c: 4, r: 10 }, { o: 4, c: 2, r: 5 }], 15) === true &&
      unitsMod.unitsCoverage([{ o: 0, c: 4, r: 10 }], 15) === false &&
      unitsMod.unitsCoverage([{ o: 0, c: 4, r: 10 }, { o: 4, c: 0, r: 5 }], 15) === false &&
      unitsMod.unitsCoverage([], 15) === false,
    'unitsCoverage 接受合法单元表、拒绝残缺/零长度/空表'
  )
  assert(
    JSON.stringify(unitsMod.unitRanges([{ o: 0, c: 3, r: 4 }, { o: 3, c: 9, r: 6 }])) === '[[0,4],[4,10]]',
    'unitRanges 由原始尺寸前缀和推导分片范围'
  )

  let codecRound = true
  let codecNeverGrows = true
  let codecMargin = true
  for (const item of cdcCorpus) {
    const encoded = await codecMod.encodeUnit(item.buf, ['br', 'gzip'])
    if (encoded.buffer.length > item.buf.length) codecNeverGrows = false
    const back = await codecMod.decodePayload(encoded.codec, encoded.buffer)
    if (Buffer.compare(back, item.buf) !== 0) codecRound = false
    const gz = await codecMod.gzipBuffer(item.buf)
    const br = await codecMod.brotliBuffer(item.buf)
    if (encoded.codec === 'g' && br.length < gz.length * 0.96) codecMargin = false
    if (encoded.codec === 'b' && !(br.length < gz.length * 0.96)) codecMargin = false
    if (encoded.codec === 'r' && Math.min(gz.length, br.length) < item.buf.length) codecNeverGrows = false
  }
  assert(codecRound, '单元编解码往返逐字节一致')
  assert(codecNeverGrows, '单元编码永不膨胀（raw/gzip/brotli 取最小）')
  assert(codecMargin, 'brotli 仅在明显更优（<96%）时采用，保证 gzip 直传可用')

  const negotiation = [
    ['br, gzip', 'b', 'br', true],
    ['gzip, deflate', 'b', 'gzip', false],
    ['gzip, deflate', 'g', 'gzip', true],
    ['br', 'g', 'br', false],
    ['br', 'b', 'br', true],
    ['identity', 'g', '', false],
    ['deflate', 'b', '', false],
    ['gzip;q=0, *;q=0', 'g', '', false],
    ['*', 'g', 'gzip', true],
    ['x-gzip', 'g', 'gzip', true],
    ['', 'g', '', false],
    [undefined, 'g', '', false],
    [null, 'b', '', false]
  ]
  let negotiationOk = true
  for (const [header, stored, encoding, passthrough] of negotiation) {
    const planned = codecMod.planTransferCodec(stored, codecMod.parseAcceptEncoding(header))
    if (planned.encoding !== encoding || planned.passthrough !== passthrough) {
      negotiationOk = false
      console.log(
        `      · header=${String(header)} stored=${stored} => ${JSON.stringify(planned)} 期望 ${encoding}/${passthrough}`
      )
    }
  }
  assert(negotiationOk, 'Accept-Encoding 协商矩阵（含 q=0 / 通配 / 缺省 / 别名）')

  console.log('\n[21] 传输压缩与编码协商（HTTP）')
  const wireBlock = 'TRANSFER-COMPRESSION-BLOCK '.repeat(2000)
  const wireChunks = []
  for (let i = 0; i < 3; i++) {
    wireChunks.push(`#块 ${i} ${crypto.randomBytes(8).toString('hex')}\n`, wireBlock)
  }
  const wireBuf = Buffer.from(wireChunks.join(''))
  const wireUp = await upload(wireBuf, { expiresIn: '1', maxDownloads: '3' })
  assert(
    wireUp.status === 201 && wireUp.body.compressed === true && wireUp.body.storedSize < wireUp.body.size,
    '可压缩文件写入单元容器（storedSize < size）',
    `${wireUp.status} ${JSON.stringify(wireUp.body)}`
  )
  const wireMeta = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'meta', `${wireUp.body.code}.json`), 'utf8')
  )
  const wireUnits = wireMeta.units
  const wireRanges = []
  let wireCursor = 0
  for (const unit of wireUnits) {
    wireRanges.push([wireCursor, wireCursor + unit.r])
    wireCursor += unit.r
  }
  assert(
    wireMeta.compression === 'units-v2' &&
      wireUnits.length > 1 &&
      wireCursor === wireUp.body.size &&
      wireUnits.every(
        (unit, i) => unit.o >= 0 && unit.c > 0 && unit.r === wireRanges[i][1] - wireRanges[i][0]
      ),
    '单元容器：多单元、顺序偏移、原始尺寸完整覆盖',
    JSON.stringify({ units: wireUnits.length, cursor: wireCursor, size: wireUp.body.size })
  )

  const wireSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: wireUp.body.code })
  })
  assert(wireSess.res.status === 200, '创建下载会话', JSON.stringify(wireSess.body))
  const wireToken = wireSess.body.token
  assert(
    wireSess.body.compressed === true &&
      wireSess.body.unitCount === wireUnits.length &&
      Array.isArray(wireSess.body.units) &&
      wireSess.body.units.every(([s, e], i) => s === wireRanges[i][0] && e === wireRanges[i][1]),
    '会话返回服务端自适应单元计划（与服务端容器一致）',
    JSON.stringify(wireSess.body.units)
  )
  assert(
    wireSess.body.parallel >= 2 && wireSess.body.parallel <= 8,
    '会话返回建议并发（2~8）',
    String(wireSess.body.parallel)
  )

  const profiles = [
    { name: 'gzip/deflate', accept: 'gzip, deflate', compressed: true },
    { name: 'br/gzip', accept: 'br, gzip', compressed: true },
    { name: 'identity', accept: 'identity', compressed: false },
    { name: '仅 deflate', accept: 'deflate', compressed: false },
    { name: 'gzip 被拒', accept: 'gzip;q=0, *;q=0', compressed: false }
  ]
  let profileBytesOk = true
  let profileEncodingOk = true
  let profileIssues = 0
  let profileStoreOk = { gzip: false, br: false }
  let wireTotal = 0
  for (const profile of profiles) {
    const headers = profile.accept === undefined ? {} : { 'accept-encoding': profile.accept }
    const responses = await Promise.all(
      wireSess.body.units.map((_, i) =>
        fetch(`${BASE}/api/download/part?token=${wireToken}&index=${i}`, { headers })
      )
    )
    const bodies = await Promise.all(responses.map((res) => res.arrayBuffer()))
    const assembled = Buffer.concat(bodies.map((body) => Buffer.from(body)))
    if (responses.some((res) => res.status !== 200) || Buffer.compare(assembled, wireBuf) !== 0) {
      profileBytesOk = false
      console.log(
        `      · ${profile.name} 状态=${responses.map((res) => res.status).join(',')} 长度=${assembled.length}/${wireBuf.length}`
      )
    }
    const applied = responses.map((res) => res.headers.get('content-encoding') || '')
    if (profile.compressed && !applied.some((value) => value !== '')) {
      profileEncodingOk = false
      profileIssues += 1
      console.log(`      · ${profile.name} 未启用任何 Content-Encoding`)
    }
    if (!profile.compressed && applied.some((value) => value !== '')) {
      profileEncodingOk = false
      profileIssues += 1
      console.log(`      · ${profile.name} 在未声明支持时仍然压缩：${applied.join(',')}`)
    }
    if (profile.accept === 'gzip, deflate' || profile.accept === 'br, gzip') {
      const allowBr = profile.accept === 'br, gzip'
      wireUnits.forEach((unit, i) => {
        const expected = unit.z === 'r' ? '' : allowBr && unit.z === 'b' ? 'br' : 'gzip'
        if (applied[i] !== expected) {
          profileEncodingOk = false
          console.log(
            `      · ${profile.name} 分片 ${i} 存储=${unit.z} 实际=${applied[i] || 'none'} 期望=${expected || 'none'}`
          )
        }
        const mode = responses[i].headers.get('x-transfer-mode')
        if (mode === 'store' && unit.z !== 'r') {
          if (allowBr && unit.z === 'b') profileStoreOk.br = true
          if (unit.z === 'g') profileStoreOk.gzip = true
        }
      })
    }
    if (profile.accept === 'gzip, deflate') {
      wireTotal = responses.reduce(
        (sum, res) => sum + Number(res.headers.get('content-length') || 0),
        0
      )
    }
  }
  assert(profileBytesOk, '五种客户端编码画像下并发取片均逐字节一致（浏览器自动解压语义）')
  assert(
    profileEncodingOk,
    '逐分片编码决策正确：存储态直传 / br→gzip 重编码 / 不支持时原样',
    String(profileIssues)
  )
  assert(
    profileStoreOk.br,
    '存在 0 拷贝直传分片（brotli 存储态直发）',
    JSON.stringify(profileStoreOk)
  )

  const httpMod = await import('node:http')
  const noHeaderPart = await new Promise((resolve, reject) => {
    const request = httpMod.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: `/api/download/part?token=${wireToken}&index=0`,
        method: 'GET'
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            encoding: res.headers['content-encoding'] || '',
            mode: res.headers['x-transfer-mode'] || '',
            body: Buffer.concat(chunks)
          })
        )
      }
    )
    request.on('error', reject)
    request.end()
  })
  assert(
    noHeaderPart.status === 200 &&
      noHeaderPart.encoding === '' &&
      noHeaderPart.mode === 'raw' &&
      Buffer.compare(
        noHeaderPart.body,
        wireBuf.subarray(wireRanges[0][0], wireRanges[0][1])
      ) === 0,
    '无 Accept-Encoding 头时原样输出、不做压缩协商',
    JSON.stringify({
      status: noHeaderPart.status,
      encoding: noHeaderPart.encoding,
      mode: noHeaderPart.mode,
      length: noHeaderPart.body.length
    })
  )
  assert(
    wireTotal > 0 && wireTotal < wireBuf.length * 0.6,
    '传输压缩确实省带宽（线上字节 < 60% 原始）',
    JSON.stringify({
      wireTotal,
      raw: wireBuf.length,
      saved: `${(100 - (wireTotal / wireBuf.length) * 100).toFixed(1)}%`
    })
  )

  const rangeProfile = [0, 1]
  const rangeResponses = await Promise.all(
    rangeProfile.map((i) =>
      fetch(
        `${BASE}/api/download/part?token=${wireToken}&start=${wireRanges[i][0]}&end=${wireRanges[i][1]}`,
        { headers: { 'accept-encoding': 'gzip, deflate' } }
      )
    )
  )
  const rangeBodies = await Promise.all(rangeResponses.map((res) => res.arrayBuffer()))
  const rangeAssembled = Buffer.concat(rangeBodies.map((body) => Buffer.from(body)))
  assert(
    rangeResponses.every((res) => res.status === 200) &&
      Buffer.compare(rangeAssembled, wireBuf.subarray(0, wireRanges[1][1])) === 0 &&
      rangeResponses.every((res) => (res.headers.get('content-encoding') || '') === 'gzip'),
    '旧式 start/end 范围请求也能享受传输压缩且逐字节一致',
    JSON.stringify(rangeResponses.map((res) => res.headers.get('content-encoding')))
  )

  const idxOver = await fetch(`${BASE}/api/download/part?token=${wireToken}&index=${wireUnits.length}`)
  const idxNeg = await fetch(`${BASE}/api/download/part?token=${wireToken}&index=-1`)
  const idxNan = await fetch(`${BASE}/api/download/part?token=${wireToken}&index=abc`)
  const idxFloat = await fetch(`${BASE}/api/download/part?token=${wireToken}&index=0.5`)
  assert(
    idxOver.status === 400 && idxNeg.status === 400 && idxNan.status === 400 && idxFloat.status === 400,
    '越界/负数/非数字/小数分片序号均返回 400',
    [idxOver.status, idxNeg.status, idxNan.status, idxFloat.status].join(',')
  )

  const zeroBuf = Buffer.alloc(700 * 1024, 0)
  const zeroUp = await upload(zeroBuf, { expiresIn: '1', maxDownloads: '3' })
  const zeroMeta = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'meta', `${zeroUp.body.code}.json`), 'utf8')
  )
  const zeroDedup = zeroMeta.units.filter((unit) => unit.d !== undefined).length
  assert(
    zeroUp.status === 201 &&
      zeroMeta.units.length > 1 &&
      zeroDedup === zeroMeta.units.length - 1 &&
      zeroUp.body.storedSize < zeroUp.body.size,
    '单元级去重：重复内容只存一份（去重片数 = 片数 - 1）',
    JSON.stringify({ units: zeroMeta.units.length, dedup: zeroDedup, storedSize: zeroUp.body.storedSize })
  )
  assert(
    zeroMeta.units
      .filter((unit) => unit.d !== undefined)
      .every((unit) => {
        const source = zeroMeta.units[unit.d]
        return unit.o === source.o && unit.c === source.c && unit.r === source.r && unit.z === source.z
      }),
    '去重单元指向同一份存储载荷（偏移/长度/编码一致）'
  )
  const zeroSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: zeroUp.body.code })
  })
  const zeroParts = await Promise.all(
    zeroSess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${zeroSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const zeroAssembled = Buffer.concat(
    (await Promise.all(zeroParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    zeroParts.every((res) => res.status === 200) && Buffer.compare(zeroAssembled, zeroBuf) === 0,
    '去重单元经并行分片下载逐字节一致',
    `${zeroParts.map((res) => res.status).join(',')} ${zeroAssembled.length}/${zeroBuf.length}`
  )
  const zeroNav = await fetch(`${BASE}/api/download?code=${zeroUp.body.code}`)
  const zeroNavBuf = Buffer.from(await zeroNav.arrayBuffer())
  assert(
    zeroNav.status === 200 && Buffer.compare(zeroNavBuf, zeroBuf) === 0,
    '去重文件导航下载逐字节一致'
  )

  const randomBuf = crypto.randomBytes(600 * 1024)
  const randomUp = await upload(randomBuf, { expiresIn: '1', maxDownloads: '2' })
  const randomSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: randomUp.body.code })
  })
  assert(
    randomUp.body.compressed === false &&
      randomSess.body.compressed === false &&
      randomSess.body.unitCount === randomSess.body.units.length &&
      randomSess.body.units.length >= 2 &&
      randomSess.body.units[0][0] === 0 &&
      randomSess.body.units[randomSess.body.units.length - 1][1] === randomBuf.length,
    '未压缩文件同样返回自适应分片计划',
    JSON.stringify({ units: randomSess.body && randomSess.body.units && randomSess.body.units.length })
  )
  const randomParts = await Promise.all(
    randomSess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${randomSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const randomAssembled = Buffer.concat(
    (await Promise.all(randomParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    randomParts.every((res) => res.status === 200) &&
      randomParts.every((res) => (res.headers.get('content-encoding') || '') === '') &&
      Buffer.compare(randomAssembled, randomBuf) === 0,
    '未压缩文件分片既不加 Content-Encoding 也逐字节一致',
    `${randomParts.map((res) => res.status).join(',')} ${randomAssembled.length}/${randomBuf.length}`
  )

  console.log('\n[22] 损坏容器与截断文件的降级（对抗）')
  const dmgUp = await upload(wireBuf, { expiresIn: '1', maxDownloads: '3' })
  const dmgMetaPath = path.join(DATA_DIR, 'meta', `${dmgUp.body.code}.json`)
  const dmgBackup = fs.readFileSync(dmgMetaPath, 'utf8')
  const dmgMeta = JSON.parse(dmgBackup)
  dmgMeta.units[0].r += 1
  fs.writeFileSync(dmgMetaPath, JSON.stringify(dmgMeta))
  const dmgSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dmgUp.body.code })
  })
  const dmgNav = await fetch(`${BASE}/api/download?code=${dmgUp.body.code}`)
  assert(
    dmgSess.res.status === 500 && dmgNav.status === 500,
    '单元表不覆盖原始大小时拒绝服务（会话与导航均 500）',
    `${dmgSess.res.status}/${dmgNav.status}`
  )
  fs.writeFileSync(dmgMetaPath, dmgBackup)
  const dmgFixed = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dmgUp.body.code })
  })
  assert(dmgFixed.res.status === 200, '元数据修复后立即恢复', String(dmgFixed.res.status))

  const cutUp = await upload(wireBuf, { expiresIn: '1', maxDownloads: '3' })
  const cutPath = path.join(DATA_DIR, 'files', cutUp.body.code)
  const cutStored = fs.statSync(cutPath).size
  fs.truncateSync(cutPath, Math.max(1, cutStored - 4096))
  const cutSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: cutUp.body.code })
  })
  const cutPart = await fetch(
    `${BASE}/api/download/part?token=${cutSess.body.token}&index=0`,
    { headers: { 'accept-encoding': 'gzip, deflate' } }
  )
  const cutRange = await fetch(
    `${BASE}/api/download/part?token=${cutSess.body.token}&start=0&end=1000`,
    { headers: { 'accept-encoding': 'identity' } }
  )
  assert(
    cutPart.status === 500 && cutRange.status === 500,
    '文件体被截断时拒绝输出可疑分片（任意取片方式）',
    `${cutPart.status}/${cutRange.status}`
  )

  console.log('\n[23] 旧容器（gzip-blocks）向后兼容')
  const zlibMod = await import('node:zlib')
  const legacyCode = '777001'
  const legacyText = Buffer.from('旧容器兼容测试内容 '.repeat(9000))
  const legacyBlocks = []
  const legacyPath = path.join(DATA_DIR, 'files', legacyCode)
  fs.writeFileSync(legacyPath, Buffer.alloc(0))
  let legacyOffset = 0
  for (let start = 0; start < legacyText.length; start += 65536) {
    const raw = legacyText.subarray(start, Math.min(start + 65536, legacyText.length))
    const packed = zlibMod.gzipSync(raw)
    fs.appendFileSync(legacyPath, packed)
    legacyBlocks.push({ o: legacyOffset, c: packed.length, r: raw.length, z: 1 })
    legacyOffset += packed.length
  }
  fs.writeFileSync(
    path.join(DATA_DIR, 'meta', `${legacyCode}.json`),
    JSON.stringify({
      code: legacyCode,
      filename: '旧容器.txt',
      size: legacyText.length,
      mime: 'text/plain',
      note: '',
      password: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      maxDownloads: 5,
      downloads: 0,
      compression: 'gzip-blocks',
      storedSize: legacyOffset,
      blocks: legacyBlocks
    })
  )
  const legacyNav = await fetch(`${BASE}/api/download?code=${legacyCode}`)
  const legacyNavBuf = Buffer.from(await legacyNav.arrayBuffer())
  assert(
    legacyNav.status === 200 && Buffer.compare(legacyNavBuf, legacyText) === 0,
    '旧容器文件导航下载逐字节一致',
    `${legacyNav.status} ${legacyNavBuf.length}/${legacyText.length}`
  )
  const legacySess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: legacyCode })
  })
  assert(
    legacySess.res.status === 200 &&
      legacySess.body.compressed === true &&
      legacySess.body.units.length === legacyBlocks.length,
    '旧容器按块升级为分片计划',
    JSON.stringify(legacySess.body && legacySess.body.units)
  )
  const legacyParts = await Promise.all(
    legacySess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${legacySess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const legacyAssembled = Buffer.concat(
    (await Promise.all(legacyParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    legacyParts.every((res) => res.status === 200) &&
      legacyParts.every((res) => (res.headers.get('content-encoding') || '') === 'gzip') &&
      legacyParts.every((res) => res.headers.get('x-transfer-mode') === 'store') &&
      Buffer.compare(legacyAssembled, legacyText) === 0,
    '旧容器分片走存储态 gzip 直传（0 拷贝）且逐字节一致',
    `${legacyParts.map((res) => res.status).join(',')} ${legacyAssembled.length}/${legacyText.length}`
  )

  for (const item of [wireUp, zeroUp, randomUp, dmgUp, cutUp]) {
    if (item.body && item.body.code) {
      await req(`/api/admin/${item.body.code}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
  }
  await req(`/api/admin/${legacyCode}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })

  console.log('\n[24] 传输节省落库与编码候选开关')
  const tsBuf = Buffer.from(('TRANSFER-SAVINGS-LINE '.repeat(40) + '\n').repeat(400))
  const tsUp = await upload(tsBuf, { expiresIn: '1', maxDownloads: '3' })
  assert(
    tsUp.status === 201 && tsUp.body.compressed === true,
    '传输统计用例文件已写入单元容器',
    `${tsUp.status} ${JSON.stringify(tsUp.body && tsUp.body.compressed)}`
  )
  const tsBefore = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const tsSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: tsUp.body.code })
  })
  const tsParts = await Promise.all(
    tsSess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${tsSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const tsAssembled = Buffer.concat(
    (await Promise.all(tsParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    tsParts.every((res) => res.status === 200) && Buffer.compare(tsAssembled, tsBuf) === 0,
    '传输统计用例分片下载逐字节一致',
    `${tsParts.map((res) => res.status).join(',')} ${tsAssembled.length}/${tsBuf.length}`
  )
  const tsWireSum = tsParts.reduce((sum, res) => sum + Number(res.headers.get('content-length') || 0), 0)
  const tsAfter = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const wireDelta = tsAfter.body.transferWireBytes - tsBefore.body.transferWireBytes
  const originalDelta = tsAfter.body.transferOriginalBytes - tsBefore.body.transferOriginalBytes
  assert(
    originalDelta === tsBuf.length,
    '原始字节按分片计划累计（= 文件大小）',
    `${originalDelta} vs ${tsBuf.length}`
  )
  assert(
    wireDelta === tsWireSum && wireDelta > 0 && wireDelta < tsBuf.length,
    '线上字节按实际响应 Content-Length 累计（小于原始）',
    JSON.stringify({ wireDelta, tsWireSum, raw: tsBuf.length })
  )
  assert(
    tsAfter.body.transferSavedBytes - tsBefore.body.transferSavedBytes === originalDelta - wireDelta,
    '传输节省 = 原始 − 线上',
    JSON.stringify({
      before: tsBefore.body.transferSavedBytes,
      after: tsAfter.body.transferSavedBytes
    })
  )

  await Promise.all([
    fetch(`${BASE}/api/download/part?token=${tsSess.body.token}&index=0`, {
      headers: { 'accept-encoding': 'gzip, deflate' }
    }),
    fetch(`${BASE}/api/download/part?token=${tsSess.body.token}&index=1`, {
      headers: { 'accept-encoding': 'br, gzip' }
    })
  ])
  await fetch(`${BASE}/api/download/part?token=${tsSess.body.token}&index=${tsSess.body.units.length}`)
  const tsRepeat = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    tsRepeat.body.transferWireBytes === tsAfter.body.transferWireBytes &&
      tsRepeat.body.transferOriginalBytes === tsAfter.body.transferOriginalBytes,
    '同一会话重复取片与非法序号均不重复累计',
    JSON.stringify({
      wire: tsRepeat.body.transferWireBytes - tsAfter.body.transferWireBytes,
      original: tsRepeat.body.transferOriginalBytes - tsAfter.body.transferOriginalBytes
    })
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tsSess.body.token })
  })

  const statsFile = path.join(DATA_DIR, 'stats.json')
  const diskStats = () => {
    try {
      return JSON.parse(fs.readFileSync(statsFile, 'utf8'))
    } catch {
      return null
    }
  }
  const lagDisk = diskStats()
  assert(
    lagDisk !== null &&
      lagDisk.transferOriginalBytes <= tsRepeat.body.transferOriginalBytes &&
      lagDisk.transferWireBytes <= tsRepeat.body.transferWireBytes,
    '聚合窗口内磁盘计数可滞后于接口读数（不会超前）',
    JSON.stringify({
      disk: lagDisk && [lagDisk.transferOriginalBytes, lagDisk.transferWireBytes],
      api: [tsRepeat.body.transferOriginalBytes, tsRepeat.body.transferWireBytes]
    })
  )
  let converged = false
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const now = diskStats()
    if (
      now &&
      now.transferOriginalBytes === tsRepeat.body.transferOriginalBytes &&
      now.transferWireBytes === tsRepeat.body.transferWireBytes
    ) {
      converged = true
      break
    }
  }
  assert(
    converged,
    '定时刷盘在 4s 内把聚合增量落盘（磁盘 = 接口读数）',
    JSON.stringify({ disk: diskStats(), api: [tsRepeat.body.transferOriginalBytes, tsRepeat.body.transferWireBytes] })
  )

  const codecsDefault = await req('/api/settings')
  assert(
    codecsDefault.body.compressionCodecs === 'br,gzip' && codecsDefault.body.compressionCodecCap === 'br,gzip',
    '设置接口返回编码候选与 env 上限',
    JSON.stringify({
      codecs: codecsDefault.body.compressionCodecs,
      cap: codecsDefault.body.compressionCodecCap
    })
  )
  const putGzipOnly = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ compressionCodecs: 'gzip' })
  })
  assert(
    putGzipOnly.res.status === 200 && putGzipOnly.body.settings.compressionCodecs === 'gzip',
    '关闭 brotli 候选（仅 gzip）',
    JSON.stringify(putGzipOnly.body.settings && putGzipOnly.body.settings.compressionCodecs)
  )
  const gzOnlyUp = await upload(tsBuf, { expiresIn: '1', maxDownloads: '3' })
  const gzOnlyMeta = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'meta', `${gzOnlyUp.body.code}.json`), 'utf8')
  )
  assert(
    gzOnlyUp.body.compressed === true &&
      gzOnlyMeta.units.length > 1 &&
      gzOnlyMeta.units.every((unit) => unit.z !== 'b') &&
      gzOnlyMeta.units.some((unit) => unit.z === 'g'),
    '仅 gzip 候选时不产生 brotli 单元（仍压缩）',
    JSON.stringify({ units: gzOnlyMeta.units.map((unit) => unit.z).join('') })
  )
  const putBadCodecs = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ compressionCodecs: 'zstd,snappy' })
  })
  assert(
    putBadCodecs.res.status === 200 && putBadCodecs.body.settings.compressionCodecs === 'gzip',
    '非法编码候选回退为 gzip',
    JSON.stringify(putBadCodecs.body.settings && putBadCodecs.body.settings.compressionCodecs)
  )
  const putBackCodecs = await req('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ compressionCodecs: 'br,gzip' })
  })
  assert(
    putBackCodecs.body.settings.compressionCodecs === 'br,gzip',
    '恢复 brotli + gzip 双试',
    JSON.stringify(putBackCodecs.body.settings && putBackCodecs.body.settings.compressionCodecs)
  )
  const backUp = await upload(tsBuf, { expiresIn: '1', maxDownloads: '3' })
  assert(
    backUp.body.compressed === true && backUp.body.storedSize < backUp.body.size,
    '恢复候选后仍正常压缩',
    JSON.stringify({ compressed: backUp.body.compressed, storedSize: backUp.body.storedSize })
  )

  console.log('\n[24c] 传输节省的按日/按文件维度')
  const dimBefore = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const dimBuf = Buffer.from(('DIMENSION-STATS-LINE '.repeat(30) + '\n').repeat(600))
  const dimUp = await upload(dimBuf, { expiresIn: '1', maxDownloads: '3' })
  const dimSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dimUp.body.code })
  })
  const dimParts = await Promise.all(
    dimSess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${dimSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const dimWire = dimParts.reduce((sum, res) => sum + Number(res.headers.get('content-length') || 0), 0)
  const dimAfter = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const todayDelta = dimAfter.body.transferToday.originalBytes - dimBefore.body.transferToday.originalBytes
  assert(
    typeof dimAfter.body.transferToday === 'object' &&
      /^\d{4}-\d{2}-\d{2}$/.test(dimAfter.body.transferToday.date) &&
      todayDelta === dimBuf.length,
    '按日维度：今日桶累计原始字节（= 本次文件大小）',
    JSON.stringify({ date: dimAfter.body.transferToday.date, todayDelta, size: dimBuf.length })
  )
  const todayInDays = (dimAfter.body.transferDays || []).find(
    (day) => day.date === dimAfter.body.transferToday.date
  )
  assert(
    Array.isArray(dimAfter.body.transferDays) &&
      dimAfter.body.transferDays.length <= 7 &&
      dimAfter.body.transferDays[0].date === dimAfter.body.transferToday.date &&
      todayInDays.savedBytes === todayInDays.originalBytes - todayInDays.wireBytes,
    '按日维度：近 7 日列表首项为今日且节省值自洽',
    JSON.stringify(dimAfter.body.transferDays)
  )
  const dimDelta = todayInDays.originalBytes - dimBefore.body.transferToday.originalBytes
  assert(
    dimDelta === dimBuf.length && todayInDays.wireBytes - dimBefore.body.transferToday.wireBytes === dimWire,
    '按日维度：线上字节来自实际响应 Content-Length 之和',
    JSON.stringify({ dimDelta, dimWire })
  )
  const dimList = await req('/api/admin/list', { headers: { 'x-admin-key': ADMIN_KEY } })
  const dimItem = dimList.body.list.find((item) => item.code === dimUp.body.code)
  assert(
    dimItem &&
      dimItem.transfer.originalBytes === dimBuf.length &&
      dimItem.transfer.wireBytes === dimWire &&
      dimItem.transfer.savedBytes === dimBuf.length - dimWire &&
      dimItem.transfer.parts === dimSess.body.units.length,
    '按文件维度：管理列表单项字节与分片数正确',
    JSON.stringify(dimItem && dimItem.transfer)
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: dimSess.body.token })
  })
  await req(`/api/admin/${dimUp.body.code}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })
  const dimListAfter = await req('/api/admin/list', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    !dimListAfter.body.list.some((item) => item.code === dimUp.body.code),
    '分享销毁后不再出现（按文件维度随之失效）'
  )

  console.log('\n[24d] 传输明细导出与清零')
  const expName = '明细, "导出".txt'
  const expBuf = Buffer.from(('EXPORT-CSV-LINE '.repeat(60) + '\n').repeat(200))
  const expUp = await upload(expBuf, { expiresIn: '1', maxDownloads: '3' }, expName)
  assert(
    expUp.status === 201 && expUp.body.filename === expName,
    '导出用例文件已上传（文件名含逗号与引号）',
    `${expUp.status} ${JSON.stringify(expUp.body && expUp.body.filename)}`
  )
  const exportNoKey = await req('/api/admin/stats/export')
  assert(exportNoKey.res.status === 401, '未带管理密钥不可导出', String(exportNoKey.res.status))

  const expSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: expUp.body.code })
  })
  const expParts = await Promise.all(
    expSess.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${expSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'gzip, deflate' }
      })
    )
  )
  const expAssembled = Buffer.concat(
    (await Promise.all(expParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  const expWire = expParts.reduce((sum, res) => sum + Number(res.headers.get('content-length') || 0), 0)
  assert(
    expParts.every((res) => res.status === 200) && Buffer.compare(expAssembled, expBuf) === 0,
    '导出用例分片下载逐字节一致',
    `${expParts.map((res) => res.status).join(',')} ${expAssembled.length}/${expBuf.length}`
  )

  const expStats = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const expRes = await req('/api/admin/stats/export', { headers: { 'x-admin-key': ADMIN_KEY } })
  const expType = expRes.res.headers.get('content-type') || ''
  const expDisp = expRes.res.headers.get('content-disposition') || ''
  const expRaw = Buffer.from(await expRes.res.arrayBuffer())
  const expCsv = expRaw.toString('utf8')
  assert(
    expRes.res.status === 200 &&
      expType.includes('text/csv') &&
      expDisp.includes('attachment') &&
      /transfer-stats-\d{8}-\d{6}\.csv/.test(expDisp),
    '导出响应为 CSV 附件（带时间戳文件名）',
    `${expRes.res.status} ${expType} ${expDisp}`
  )
  assert(
    expRaw[0] === 0xef && expRaw[1] === 0xbb && expRaw[2] === 0xbf,
    'CSV 带 UTF-8 BOM（Excel 直开不乱码）',
    [...expRaw.slice(0, 4)].map((b) => b.toString(16)).join(' ')
  )
  const expLines = expCsv.replace(/^\uFEFF/, '').split('\r\n')
  assert(
    expLines[0] === '维度,标识,文件名,原始字节,线上字节,节省字节,片数',
    'CSV 表头固定',
    expLines[0]
  )
  const dayLine = expLines.find((line) => line.startsWith(`按日,${expStats.body.transferToday.date},`))
  const dayCells = dayLine ? dayLine.split(',') : []
  assert(
    dayCells.length === 7 &&
      Number(dayCells[3]) === expStats.body.transferToday.originalBytes &&
      Number(dayCells[4]) === expStats.body.transferToday.wireBytes &&
      Number(dayCells[6]) === expStats.body.transferToday.parts,
    '按日行与接口今日桶一致（导出为全量保留而非仅近 7 日）',
    dayLine || '(缺今日行)'
  )
  const fileLine = expLines.find((line) => line.startsWith(`按文件,${expUp.body.code},`))
  assert(
    fileLine ===
      `按文件,${expUp.body.code},"明细, ""导出"".txt",${expBuf.length},${expWire},${expBuf.length - expWire},${expSess.body.units.length}`,
    '按文件行含正确字节与 RFC 4180 转义文件名',
    fileLine || '(缺文件行)'
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: expSess.body.token })
  })

  const resetNoKey = await req('/api/admin/stats/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  })
  const resetNoConfirm = await req('/api/admin/stats/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({})
  })
  assert(
    resetNoKey.res.status === 401 && resetNoConfirm.res.status === 400,
    '清零需要管理密钥与显式 confirm',
    `${resetNoKey.res.status}/${resetNoConfirm.res.status}`
  )
  const preReset = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const resetRes = await req('/api/admin/stats/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ confirm: true })
  })
  const postReset = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    resetRes.res.status === 200 &&
      resetRes.body.ok === true &&
      resetRes.body.resetAt > 0 &&
      resetRes.body.resetCount === 1,
    '清零返回审计信息（resetAt / resetCount）',
    JSON.stringify(resetRes.body)
  )
  assert(
    postReset.body.transferOriginalBytes === 0 &&
      postReset.body.transferWireBytes === 0 &&
      postReset.body.transferSavedBytes === 0 &&
      postReset.body.transferToday.originalBytes === 0 &&
      postReset.body.transferToday.parts === 0 &&
      postReset.body.transferDays.length === 0,
    '清零后累计与全部明细归零',
    JSON.stringify({
      totals: [postReset.body.transferOriginalBytes, postReset.body.transferWireBytes],
      days: postReset.body.transferDays.length
    })
  )
  assert(
    postReset.body.transferResetAt === resetRes.body.resetAt &&
      postReset.body.transferResetCount === resetRes.body.resetCount,
    '审计字段经只读接口可见',
    JSON.stringify({ at: postReset.body.transferResetAt, count: postReset.body.transferResetCount })
  )
  assert(
    postReset.body.totalUploads === preReset.body.totalUploads &&
      postReset.body.totalDownloads === preReset.body.totalDownloads &&
      postReset.body.fileCount === preReset.body.fileCount,
    '清零不影响上传/下载次数与文件数',
    JSON.stringify({
      uploads: [preReset.body.totalUploads, postReset.body.totalUploads],
      downloads: [preReset.body.totalDownloads, postReset.body.totalDownloads]
    })
  )
  const postResetList = await req('/api/admin/list', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    postResetList.body.list.every(
      (item) =>
        item.transfer.originalBytes === 0 &&
        item.transfer.wireBytes === 0 &&
        item.transfer.parts === 0
    ),
    '清零后按文件列全部归零',
    JSON.stringify(postResetList.body.list.map((item) => item.transfer.originalBytes))
  )
  const resetDiskCounters = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
  const resetDiskTransfer = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'transfer-stats.json'), 'utf8'))
  assert(
    resetDiskCounters.transferOriginalBytes === 0 &&
      resetDiskCounters.transferWireBytes === 0 &&
      Object.keys(resetDiskTransfer.days).length === 0 &&
      Object.keys(resetDiskTransfer.files).length === 0 &&
      resetDiskTransfer.resetAt === resetRes.body.resetAt &&
      resetDiskTransfer.resetCount === 1,
    '清零即时落盘（站点计数与维度文件）',
    JSON.stringify({ counters: resetDiskCounters, transfer: resetDiskTransfer })
  )
  const emptyExport = await req('/api/admin/stats/export', { headers: { 'x-admin-key': ADMIN_KEY } })
  const emptyCsv = Buffer.from(await emptyExport.res.arrayBuffer()).toString('utf8').replace(/^\uFEFF/, '')
  assert(
    emptyCsv.trim() === '维度,标识,文件名,原始字节,线上字节,节省字节,片数',
    '清零后导出仅剩表头',
    JSON.stringify(emptyCsv.slice(0, 80))
  )
  const resumeSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: expUp.body.code })
  })
  const resumePart = await fetch(`${BASE}/api/download/part?token=${resumeSess.body.token}&index=0`)
  const resumeBuf = Buffer.from(await resumePart.arrayBuffer())
  const resumeAfter = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    resumePart.status === 200 &&
      resumeAfter.body.transferToday.parts === 1 &&
      resumeAfter.body.transferToday.originalBytes === resumeBuf.length &&
      resumeAfter.body.transferDays.length === 1,
    '清零只重置历史：此后传输从零重新累计',
    JSON.stringify({ today: resumeAfter.body.transferToday, days: resumeAfter.body.transferDays.length })
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resumeSess.body.token })
  })

  console.log('\n[26] 断点续传（上传会话持久化 + 下载会话续传）')
  const resumeName = '断点续传用例.txt'
  const resumeUploadBuf = Buffer.from(('RESUME-LINE '.repeat(40) + '\n').repeat(1400))
  const resumeInit = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: resumeName,
      size: resumeUploadBuf.length,
      mime: 'text/plain',
      expiresIn: '1',
      maxDownloads: '3'
    })
  })
  const resumeId = resumeInit.body.uploadId
  const resumePartSize = resumeInit.body.partSize
  const putResumePart = (index) => {
    const start = index * resumePartSize
    const end = Math.min(start + resumePartSize, resumeUploadBuf.length)
    return fetch(`${BASE}/api/upload/part?uploadId=${resumeId}&index=${index}`, {
      method: 'PUT',
      body: resumeUploadBuf.subarray(start, end)
    })
  }
  assert(
    resumeInit.res.status === 200 && resumeInit.body.resumed === false && resumeInit.body.totalParts === 3,
    '新上传会话：返回计划且 resumed=false',
    JSON.stringify(resumeInit.body)
  )
  const put0 = await putResumePart(0)
  const put2 = await putResumePart(2)
  const uploadStatus = await req(`/api/upload/status?uploadId=${resumeId}`)
  assert(
    put0.status === 200 &&
      put2.status === 200 &&
      uploadStatus.res.status === 200 &&
      uploadStatus.body.received.join(',') === '0,2' &&
      uploadStatus.body.size === resumeUploadBuf.length &&
      uploadStatus.body.partSize === resumePartSize &&
      uploadStatus.body.totalParts === 3,
    'upload/status 返回乱序收片后的位图与计划',
    JSON.stringify(uploadStatus.body)
  )
  const resumeAgain = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: resumeId, filename: resumeName, size: resumeUploadBuf.length })
  })
  assert(
    resumeAgain.res.status === 200 &&
      resumeAgain.body.uploadId === resumeId &&
      resumeAgain.body.resumed === true &&
      resumeAgain.body.received.join(',') === '0,2',
    'init 带 uploadId 复用会话并返回同一位图（不新建）',
    JSON.stringify(resumeAgain.body)
  )
  const resumeMismatch = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: resumeId, filename: '其他文件.bin', size: resumeUploadBuf.length })
  })
  assert(resumeMismatch.res.status === 409, 'init 与会话元数据不匹配返回 409', String(resumeMismatch.res.status))
  const resumeMetaPath = path.join(DATA_DIR, 'tmp', `${resumeId}.json`)
  const resumeMeta = JSON.parse(fs.readFileSync(resumeMetaPath, 'utf8'))
  assert(
    resumeMeta.received.join(',') === '0,2' &&
      resumeMeta.totalParts === 3 &&
      resumeMeta.size === resumeUploadBuf.length,
    '位图随收片原子落盘（tmp/<uploadId>.json）',
    JSON.stringify({ received: resumeMeta.received, totalParts: resumeMeta.totalParts })
  )
  const put0Again = await putResumePart(0)
  const uploadAgain = await req(`/api/upload/status?uploadId=${resumeId}`)
  assert(
    put0Again.status === 200 && uploadAgain.body.received.join(',') === '0,2',
    '重复上传已收分片是幂等覆盖（位图不变）',
    JSON.stringify(uploadAgain.body.received)
  )
  await putResumePart(1)
  const resumeDone = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: resumeId })
  })
  assert(
    resumeDone.res.status === 201,
    '补齐全部分片后 complete 成功',
    `${resumeDone.res.status} ${JSON.stringify(resumeDone.body && resumeDone.body.error)}`
  )
  assert(
    !fs.existsSync(resumeMetaPath) && !fs.existsSync(resumeMetaPath.replace(/\.json$/, '.bin')),
    'complete 后位图与分片体被清理'
  )
  const resumeSess2 = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: resumeDone.body.code })
  })
  const resumeParts = await Promise.all(
    resumeSess2.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${resumeSess2.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'identity' }
      })
    )
  )
  const resumeBytes = Buffer.concat(
    (await Promise.all(resumeParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    resumeParts.every((res) => res.status === 200) && Buffer.compare(resumeBytes, resumeUploadBuf) === 0,
    '续传完成后内容逐字节一致',
    `${resumeBytes.length}/${resumeUploadBuf.length}`
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resumeSess2.body.token })
  })

  const pwInit = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: '密码续传.bin',
      size: 1000,
      mime: 'application/octet-stream',
      expiresIn: '1',
      maxDownloads: '1',
      password: 'secret-123'
    })
  })
  const pwMetaPath = path.join(DATA_DIR, 'tmp', `${pwInit.body.uploadId}.json`)
  const pwMetaText = fs.readFileSync(pwMetaPath, 'utf8')
  const pwHash = crypto.createHash('sha256').update('secret-123').digest('hex')
  assert(
    !pwMetaText.includes('secret-123') && JSON.parse(pwMetaText).fields.passwordHash === pwHash,
    '上传会话落盘不含明文密码（仅 SHA-256）',
    pwMetaText.slice(0, 120)
  )
  fs.rmSync(pwMetaPath, { force: true })
  fs.rmSync(pwMetaPath.replace(/\.json$/, '.bin'), { force: true })
  const unknownStatus = await req('/api/upload/status?uploadId=deadbeefdeadbeefdeadbeef')
  assert(unknownStatus.res.status === 404, '伪造 uploadId 返回 404', String(unknownStatus.res.status))

  const probeTmp = path.join(DATA_DIR, 'resume-probe')
  fs.rmSync(probeTmp, { recursive: true, force: true })
  fs.mkdirSync(probeTmp, { recursive: true })
  const liveId = 'a1b2c3d4e5f60718293a4b5c'
  const deadId = 'ffffffffffffffffffffffff'
  const orphanId = '112233445566778899aabbcc'
  const probeFields = {
    filename: 'x.bin',
    mime: 'application/octet-stream',
    expiresIn: 1,
    maxDownloads: 1,
    note: '',
    customCode: '',
    passwordHash: ''
  }
  fs.writeFileSync(path.join(probeTmp, `${liveId}.bin`), Buffer.alloc(1000))
  fs.writeFileSync(
    path.join(probeTmp, `${liveId}.json`),
    JSON.stringify({
      version: 1,
      uploadId: liveId,
      partSize: 524288,
      totalParts: 3,
      size: 1200000,
      fields: probeFields,
      received: [0],
      expiresAt: Date.now() + 600000
    })
  )
  fs.writeFileSync(path.join(probeTmp, `${deadId}.bin`), Buffer.alloc(10))
  fs.writeFileSync(
    path.join(probeTmp, `${deadId}.json`),
    JSON.stringify({
      version: 1,
      uploadId: deadId,
      partSize: 524288,
      totalParts: 1,
      size: 100,
      fields: probeFields,
      received: [],
      expiresAt: Date.now() - 1000
    })
  )
  fs.writeFileSync(path.join(probeTmp, `${orphanId}.bin`), Buffer.alloc(5))
  fs.writeFileSync(path.join(probeTmp, 'stray.tmp'), 'x')
  const sessionsMod = await import('../server/sessions.js')
  const restoredCount = sessionsMod.restoreUploadSessions(probeTmp)
  const restoredSession = sessionsMod.getUploadSession(liveId)
  assert(
    restoredCount === 1 &&
      restoredSession &&
      [...restoredSession.received].join(',') === '0' &&
      restoredSession.size === 1200000 &&
      restoredSession.fields.filename === 'x.bin',
    '启动恢复：仅未过期且文件成对的会话被恢复（位图保留）',
    JSON.stringify({ count: restoredCount, received: restoredSession && [...restoredSession.received] })
  )
  assert(
    sessionsMod.getUploadSession(deadId) === null && sessionsMod.getUploadSession(orphanId) === null,
    '过期会话与孤儿分片不恢复',
    JSON.stringify({
      dead: Boolean(sessionsMod.getUploadSession(deadId)),
      orphan: Boolean(sessionsMod.getUploadSession(orphanId))
    })
  )
  const probeFiles = fs.readdirSync(probeTmp).sort().join(',')
  assert(
    probeFiles === `${liveId}.bin,${liveId}.json`,
    '启动恢复清理过期/孤儿/临时文件，仅保留有效会话',
    probeFiles
  )

  const dlStatsBefore = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const dlSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: resumeDone.body.code })
  })
  const dlStatus = await req(`/api/download/status?token=${dlSess.body.token}`)
  const dlStatsMid = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    dlStatus.res.status === 200 &&
      dlStatus.body.token === dlSess.body.token &&
      JSON.stringify(dlStatus.body.units) === JSON.stringify(dlSess.body.units) &&
      dlStatus.body.unitCount === dlSess.body.unitCount,
    'download/status 返回与新建会话一致的计划（同一 token）',
    JSON.stringify({ statusUnits: dlStatus.body.unitCount, sessionUnits: dlSess.body.unitCount })
  )
  assert(
    dlStatsMid.body.totalDownloads === dlStatsBefore.body.totalDownloads + 1,
    'download/status 不重复消费下载次数',
    JSON.stringify({ before: dlStatsBefore.body.totalDownloads, mid: dlStatsMid.body.totalDownloads })
  )
  const dlParts = await Promise.all(
    dlStatus.body.units.map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${dlStatus.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'identity' }
      })
    )
  )
  const dlBytes = Buffer.concat(
    (await Promise.all(dlParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    dlParts.every((res) => res.status === 200) && Buffer.compare(dlBytes, resumeUploadBuf) === 0,
    '用续用 token 取完全部分片逐字节一致',
    `${dlBytes.length}/${resumeUploadBuf.length}`
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: dlSess.body.token })
  })
  const dlStatusAfter = await req(`/api/download/status?token=${dlSess.body.token}`)
  const dlFake = await req('/api/download/status?token=deadbeefdeadbeef')
  assert(
    dlStatusAfter.res.status === 404 && dlFake.res.status === 404,
    'end 后续传 token 与伪造 token 均 404',
    `${dlStatusAfter.res.status}/${dlFake.res.status}`
  )

  console.log('\n[27] 公告预设（服务端 JSON，最多 10 个）')
  const presetsNoKey = await req('/api/admin/notice/presets')
  assert(presetsNoKey.res.status === 401, '无密钥读取预设返回 401', `实际 ${presetsNoKey.res.status}`)

  const fillDefault = await req('/api/notice')
  assert(
    fillDefault.body.scrollFill === false,
    '公告默认不开启自动填满滚动（保留“未超出不滚”行为）',
    String(fillDefault.body.scrollFill)
  )

  const presets0 = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    presets0.res.status === 200 &&
      Array.isArray(presets0.body.presets) &&
      presets0.body.presets.length === 0 &&
      presets0.body.limit === 10,
    '初始预设列表为空且上限为 10',
    JSON.stringify(presets0.body)
  )

  const presetNotice = {
    enabled: true,
    title: '维护预设',
    content: '预设内容：本周日凌晨维护',
    display: 'both',
    position: 'fixed-top',
    scroll: 'right',
    bgColor: '#0A0',
    textColor: '#fff'
  }
  const createdPreset = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ notice: presetNotice })
  })
  assert(createdPreset.res.status === 201, '保存预设返回 201', JSON.stringify(createdPreset.body))
  const presetId = createdPreset.body.preset.id
  assert(
    createdPreset.body.preset.name === '维护预设' &&
      createdPreset.body.preset.notice.position === 'fixed-top' &&
      createdPreset.body.preset.notice.bgColor === '#00aa00' &&
      createdPreset.body.preset.notice.scroll === 'right',
    '名称留空时取公告标题，样式字段按公告口径归一化',
    JSON.stringify(createdPreset.body.preset)
  )
  assert(
    !('updatedAt' in createdPreset.body.preset.notice),
    '预设内的公告不携带 updatedAt（启用时才盖新时间）',
    JSON.stringify(createdPreset.body.preset.notice)
  )

  const listedPresets = await req('/api/admin/notice/presets', {
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(
    listedPresets.body.presets.length === 1 && listedPresets.body.presets[0].id === presetId,
    '预设可读回且 id 稳定',
    JSON.stringify(listedPresets.body.presets)
  )

  const overwritten = await req(`/api/admin/notice/presets/${presetId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      name: '维护预设（深色）',
      notice: { ...presetNotice, bgColor: '#112233' }
    })
  })
  assert(
    overwritten.res.status === 200 &&
      overwritten.body.preset.name === '维护预设（深色）' &&
      overwritten.body.preset.notice.bgColor === '#112233' &&
      overwritten.body.preset.createdAt === createdPreset.body.preset.createdAt,
    '覆盖预设可改名称与内容（创建时间不变）',
    JSON.stringify(overwritten.body.preset)
  )

  const appliedPreset = await req(`/api/admin/notice/presets/${presetId}/apply`, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(
    appliedPreset.res.status === 200 &&
      appliedPreset.body.notice.content === presetNotice.content &&
      appliedPreset.body.notice.position === 'fixed-top' &&
      appliedPreset.body.notice.bgColor === '#112233' &&
      appliedPreset.body.notice.updatedAt > 0,
    '启用预设即成为当前公告并刷新 updatedAt',
    JSON.stringify(appliedPreset.body.notice)
  )
  const noticeAfterApply = await req('/api/notice')
  assert(
    noticeAfterApply.body.content === presetNotice.content &&
      noticeAfterApply.body.position === 'fixed-top' &&
      noticeAfterApply.body.updatedAt === appliedPreset.body.notice.updatedAt,
    '启用后的公告对访客立即可见',
    JSON.stringify(noticeAfterApply.body)
  )

  const missingApply = await req('/api/admin/notice/presets/deadbeef/apply', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  const missingOverwrite = await req('/api/admin/notice/presets/deadbeef', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: '不存在' })
  })
  assert(
    missingApply.res.status === 404 && missingOverwrite.res.status === 404,
    '不存在的预设 id：启用/覆盖均 404',
    `${missingApply.res.status}/${missingOverwrite.res.status}`
  )

  let fillFailed = null
  for (let i = 1; i < 10; i++) {
    const filled = await req('/api/admin/notice/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ name: `批量预设 ${i}`, notice: { ...presetNotice, title: `批量 ${i}` } })
    })
    if (filled.res.status !== 201) fillFailed = filled
  }
  const fullList = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    fillFailed === null && fullList.body.presets.length === 10,
    '可保存到上限 10 个',
    fillFailed ? JSON.stringify(fillFailed.body) : String(fullList.body.presets.length)
  )

  const overflowPreset = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: '第 11 个', notice: presetNotice })
  })
  const listAfterOverflow = await req('/api/admin/notice/presets', {
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(
    overflowPreset.res.status === 409 &&
      /上限/.test(overflowPreset.body.error || '') &&
      listAfterOverflow.body.presets.length === 10,
    '第 11 个被拒绝（409）且既有预设不丢失',
    `${overflowPreset.res.status} ${JSON.stringify(overflowPreset.body)}/${listAfterOverflow.body.presets.length}`
  )

  const deletedPreset = await req(`/api/admin/notice/presets/${presetId}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  const deletedAgain = await req(`/api/admin/notice/presets/${presetId}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  const listAfterDelete = await req('/api/admin/notice/presets', {
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(
    deletedPreset.res.status === 200 &&
      deletedAgain.res.status === 404 &&
      listAfterDelete.body.presets.length === 9,
    '删除预设生效（重复删除 404）',
    `${deletedPreset.res.status}/${deletedAgain.res.status}/${listAfterDelete.body.presets.length}`
  )

  const longNamePreset = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: 'x'.repeat(80), notice: presetNotice })
  })
  assert(
    longNamePreset.body.preset.name.length === 50,
    '预设名称最长 50 字符',
    String(longNamePreset.body.preset.name.length)
  )

  const legacyPresets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notice-presets.json'), 'utf8'))
  assert(
    legacyPresets.version === 1 && legacyPresets.presets.length === 10,
    '预设落盘为单例 JSON（version + presets）',
    JSON.stringify(Object.keys(legacyPresets))
  )

  console.log('\n[24b] 统计写入批量聚合（隔离探针）')
  const probeDir = path.join(DATA_DIR, 'stats-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  process.env.DATA_DIR = probeDir
  const statsMod = await import('../server/stats.js')
  const probeFile = path.join(probeDir, 'stats.json')
  const probeDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(probeFile, 'utf8'))
    } catch {
      return null
    }
  }
  assert(
    statsMod.readCounters().transferOriginalBytes === 0 && probeDisk() === null,
    '隔离探针：独立数据目录、初始无落盘、配置在导入时生效',
    JSON.stringify({ read: statsMod.readCounters().transferOriginalBytes, disk: probeDisk() })
  )
  for (let i = 0; i < 10; i++) statsMod.recordTransfer({ originalBytes: 1000, wireBytes: 100 })
  assert(
    probeDisk() === null && statsMod.readCounters().transferWireBytes === 1000,
    '未达阈值不落盘，但读取端已合并未落盘增量',
    JSON.stringify({ disk: probeDisk(), merged: statsMod.readCounters().transferWireBytes })
  )
  for (let i = 0; i < 22; i++) statsMod.recordTransfer({ originalBytes: 1000, wireBytes: 100 })
  assert(
    probeDisk() !== null &&
      probeDisk().transferOriginalBytes === 32000 &&
      probeDisk().transferWireBytes === 3200,
    '达到阈值（32 片）立即刷盘一次',
    JSON.stringify(probeDisk())
  )
  statsMod.recordTransfer({ originalBytes: 1000, wireBytes: 100 })
  assert(
    probeDisk().transferOriginalBytes === 32000 && statsMod.readCounters().transferOriginalBytes === 33000,
    '阈值刷盘后余量留在内存，读取端仍为最新值',
    JSON.stringify({ disk: probeDisk().transferOriginalBytes, merged: statsMod.readCounters().transferOriginalBytes })
  )
  assert(
    statsMod.flushCounters() === true &&
      probeDisk().transferOriginalBytes === 33000 &&
      probeDisk().transferWireBytes === 3300,
    '显式刷盘（优雅退出路径）落盘余量',
    JSON.stringify(probeDisk())
  )
  assert(statsMod.flushCounters() === false, '无增量时刷盘为空操作')

  const transferFile = path.join(probeDir, 'transfer-stats.json')
  const readTransferProbe = () => {
    try {
      return JSON.parse(fs.readFileSync(transferFile, 'utf8'))
    } catch {
      return null
    }
  }
  const todayKey = statsMod.dayKey(Date.now())
  const oldKey = statsMod.dayKey(Date.now() - 40 * 86400000)
  const futureKey = statsMod.dayKey(Date.now() + 86400000)
  fs.mkdirSync(path.join(probeDir, 'meta'), { recursive: true })
  fs.writeFileSync(
    transferFile,
    JSON.stringify({
      version: 1,
      days: {
        [oldKey]: { originalBytes: 111, wireBytes: 11, parts: 1 },
        [futureKey]: { originalBytes: 222, wireBytes: 22, parts: 1 }
      },
      files: {
        keepme: { originalBytes: 5, wireBytes: 1, parts: 1, updatedAt: 1 },
        dropme: { originalBytes: 6, wireBytes: 1, parts: 1, updatedAt: 2 }
      },
      updatedAt: 0
    })
  )
  statsMod.forgetFileStat('dropme')
  statsMod.recordTransfer({ originalBytes: 1000, wireBytes: 100, code: 'keepme' })
  const mergedProbe = statsMod.readTransferStats()
  assert(
    mergedProbe.days[todayKey].originalBytes === 1000 &&
      mergedProbe.files.keepme.originalBytes === 1005 &&
      mergedProbe.files.dropme === undefined,
    '合并读：锁定的删除项先于刷盘从读数中消失',
    JSON.stringify({ days: mergedProbe.days[todayKey], keep: mergedProbe.files.keepme, drop: mergedProbe.files.dropme })
  )
  assert(statsMod.flushCounters() === true, '维度与站点计数共用一次刷盘')
  const flushedProbe = readTransferProbe()
  assert(
    flushedProbe &&
      flushedProbe.days[oldKey] === undefined &&
      flushedProbe.days[futureKey] !== undefined &&
      flushedProbe.days[todayKey].originalBytes === 1000 &&
      flushedProbe.files.dropme === undefined &&
      flushedProbe.files.keepme.originalBytes === 1005,
    '刷盘时裁掉超出保留窗口的日期并落盘锁定删除项',
    JSON.stringify({ days: Object.keys(flushedProbe.days).sort(), files: Object.keys(flushedProbe.files) })
  )
  statsMod.recordTransfer({ originalBytes: 700, wireBytes: 70, code: 'keepme' })
  statsMod.recordUpload()
  const afterUploadRead = statsMod.readTransferStats()
  assert(
    probeDisk().transferOriginalBytes === 34700 &&
      probeDisk().transferWireBytes === 3470 &&
      probeDisk().totalUploads === 1 &&
      afterUploadRead.days[todayKey].originalBytes === 1700 &&
      afterUploadRead.files.keepme.originalBytes === 1705,
    '上传/下载计数写盘不吞掉尚未刷盘的维度增量',
    JSON.stringify({
      disk: [probeDisk().transferOriginalBytes, probeDisk().totalUploads],
      day: afterUploadRead.days[todayKey],
      file: afterUploadRead.files.keepme
    })
  )
  const flushKept = statsMod.flushCounters()
  const keptProbe = readTransferProbe()
  assert(
    flushKept === true &&
      keptProbe.days[todayKey].originalBytes === 1700 &&
      keptProbe.files.keepme.originalBytes === 1705,
    '维度增量随后续刷盘落盘（计数器已先行写盘）',
    JSON.stringify({ flush: flushKept, day: keptProbe && keptProbe.days[todayKey] })
  )
  const overflow = { version: 1, days: {}, files: {}, updatedAt: 0 }
  for (let i = 0; i < 2001; i++) {
    overflow.files[`f${String(i).padStart(4, '0')}`] = {
      originalBytes: 10,
      wireBytes: 1,
      parts: 1,
      updatedAt: i
    }
  }
  fs.writeFileSync(transferFile, JSON.stringify(overflow))
  statsMod.recordTransfer({ originalBytes: 10, wireBytes: 1, code: 'f2000' })
  statsMod.flushCounters()
  const capped = readTransferProbe()
  assert(
    Object.keys(capped.files).length === 2000 &&
      capped.files.f0000 === undefined &&
      capped.files.f2000 !== undefined,
    '文件维度条目数封顶（超出时按最后更新时间淘汰最旧）',
    JSON.stringify({ count: Object.keys(capped.files).length, oldest: capped.files.f0000, newest: capped.files.f2000 })
  )

  for (const item of [tsUp, gzOnlyUp, backUp, expUp, resumeDone]) {
    if (item.body && item.body.code) {
      await req(`/api/admin/${item.body.code}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY }
      })
    }
  }

  console.log('\n[28] 会话与临时空间配额（隔离端口，防会话放大）')
  const QUOTA_PORT = 3998
  const QUOTA_BASE = `http://127.0.0.1:${QUOTA_PORT}`
  const QUOTA_DIR = path.join(rootDir, 'data-test-quota')
  fs.rmSync(QUOTA_DIR, { recursive: true, force: true })
  const quotaServer = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(QUOTA_PORT),
      ADMIN_KEY,
      DATA_DIR: QUOTA_DIR,
      MAX_FILE_SIZE: '2097152',
      MAX_UPLOAD_SESSIONS_PER_IP: '2',
      MAX_DOWNLOAD_SESSIONS_PER_IP: '1',
      MAX_TMP_BYTES_PER_IP: '1048576',
      RATE_LIMIT_MISSES: '1000',
      UPLOAD_LIMIT_PER_MINUTE: '1000',
      TRANSFER_PART_SIZE: '262144'
    }
  })
  quotaServer.stdout.on('data', () => {})
  quotaServer.stderr.on('data', (d) => process.stderr.write(d))
  const quotaAlive = await waitForServer(QUOTA_BASE)
  assert(quotaAlive, '配额探针服务器启动（受限配置）', String(quotaAlive))

  const qReq = async (pathname, options = {}) => {
    const res = await fetch(`${QUOTA_BASE}${pathname}`, options)
    let body = null
    const type = res.headers.get('content-type') || ''
    if (type.includes('application/json')) body = await res.json()
    return { res, body }
  }
  const qJson = (pathname, payload) =>
    qReq(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  const qInit = (filename, size) =>
    qJson('/api/upload/init', { filename, size, mime: 'text/plain', expiresIn: '1', maxDownloads: '3' })

  if (quotaAlive) {
    const overBytes = await qInit('配额大文件.bin', 1572864)
    assert(
      overBytes.res.status === 429 && /配额/.test(String(overBytes.body && overBytes.body.error)),
      '待处理临时空间将超限时拒绝新上传会话（429 + 空间提示）',
      `${overBytes.res.status} ${JSON.stringify(overBytes.body)}`
    )

    const quotaA = await qInit('配额A.bin', 102400)
    const quotaB = await qInit('配额B.bin', 102400)
    assert(
      quotaA.res.status === 200 && quotaB.res.status === 200,
      '配额内可并行建立多个上传会话',
      `${quotaA.res.status}/${quotaB.res.status}`
    )

    const overCount = await qInit('配额C.bin', 102400)
    assert(
      overCount.res.status === 429 && /过多/.test(String(overCount.body && overCount.body.error)),
      '达到每 IP 上传会话数上限时拒绝新会话（429）',
      `${overCount.res.status} ${JSON.stringify(overCount.body)}`
    )

    const quotaResume = await qJson('/api/upload/init', {
      uploadId: quotaA.body.uploadId,
      filename: '配额A.bin',
      size: 102400
    })
    assert(
      quotaResume.res.status === 200 && quotaResume.body.resumed === true,
      '续传复用已有会话不受配额限制（不新建会话）',
      `${quotaResume.res.status} ${JSON.stringify(quotaResume.body)}`
    )

    const afterResume = await qInit('配额D.bin', 102400)
    const metaFile = path.join(QUOTA_DIR, 'tmp', `${quotaA.body.uploadId}.json`)
    const quotaMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    assert(
      afterResume.res.status === 429 && /127\.0\.0\.1$/.test(String(quotaMeta.ip)),
      '续传不重复计入配额，且会话位图落盘记录归属 IP',
      `${afterResume.res.status} ${JSON.stringify({ ip: quotaMeta.ip })}`
    )

    const quotaBytes = crypto.randomBytes(102400)
    const quotaPart = await fetch(
      `${QUOTA_BASE}/api/upload/part?uploadId=${quotaA.body.uploadId}&index=0`,
      { method: 'PUT', body: quotaBytes }
    )
    const quotaDone = await qJson('/api/upload/complete', { uploadId: quotaA.body.uploadId })
    assert(
      quotaPart.status === 200 && quotaDone.res.status === 201,
      '配额受限时仍可完整收片并提交',
      `${quotaPart.status}/${quotaDone.res.status} ${JSON.stringify(quotaDone.body && quotaDone.body.error)}`
    )

    const afterRelease = await qInit('配额E.bin', 102400)
    assert(
      afterRelease.res.status === 200,
      '会话完成后名额与临时空间即时释放',
      `${afterRelease.res.status} ${JSON.stringify(afterRelease.body)}`
    )

    const shareForm = new FormData()
    shareForm.append('file', new Blob([crypto.randomBytes(2048)]), '配额分享.bin')
    shareForm.append('expiresIn', '1')
    shareForm.append('maxDownloads', '3')
    const quotaShare = await qReq('/api/upload', { method: 'POST', body: shareForm })
    assert(quotaShare.res.status === 201, '配额探针：普通上传建立可下载分享', String(quotaShare.res.status))
    const quotaCode = quotaShare.body && quotaShare.body.code

    const firstSession = await qJson('/api/download/session', { code: quotaCode })
    const secondSession = await qJson('/api/download/session', { code: quotaCode })
    assert(
      firstSession.res.status === 200 &&
        secondSession.res.status === 429 &&
        /下载过多/.test(String(secondSession.body && secondSession.body.error)),
      '达到每 IP 下载会话上限时拒绝新会话（429）',
      `${firstSession.res.status}/${secondSession.res.status}`
    )

    const quotaInfo = await qReq(`/api/info?code=${quotaCode}`)
    assert(
      quotaInfo.body && quotaInfo.body.downloads === 1,
      '被配额拒绝的下载不消耗取件次数',
      JSON.stringify(quotaInfo.body)
    )

    await qJson('/api/download/end', { token: firstSession.body.token })
    const thirdSession = await qJson('/api/download/session', { code: quotaCode })
    assert(
      thirdSession.res.status === 200,
      '下载会话结束后名额释放，可再次取件',
      String(thirdSession.res.status)
    )
    await qJson('/api/download/end', { token: thirdSession.body.token })
  }

  quotaServer.kill('SIGTERM')
  fs.rmSync(QUOTA_DIR, { recursive: true, force: true })

  console.log('\n[29] 公告预设：上限可配置 / 使用审计 / 并发冲突 / 导入导出与排序')
  const presetsNow = () => req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  const putSettings = (payload) =>
    req('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify(payload)
    })
  const createPresetReq = (name) =>
    req('/api/admin/notice/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ name, notice: presetNotice })
    })

  const settingsBefore = await req('/api/settings')
  assert(
    settingsBefore.body.presetLimit === 10 && settingsBefore.body.presetLimitCap === 50,
    '站点设置暴露预设上限与硬上限（默认 10 / 上限 50）',
    JSON.stringify({ limit: settingsBefore.body.presetLimit, cap: settingsBefore.body.presetLimitCap })
  )

  const raised = await putSettings({ presetLimit: 12 })
  const listRaised = await presetsNow()
  const eleventh = await createPresetReq('第 11 个（上限已放宽）')
  assert(
    raised.body.settings.presetLimit === 12 && listRaised.body.limit === 12 && eleventh.res.status === 201,
    '上限调到 12 后第 11 个预设可保存（上限可配置生效）',
    `${raised.body.settings.presetLimit}/${listRaised.body.limit}/${eleventh.res.status}`
  )

  const lowered = await putSettings({ presetLimit: 5 })
  const listLowered = await presetsNow()
  const overLowered = await createPresetReq('调低上限后的新增')
  assert(
    lowered.body.settings.presetLimit === 5 &&
      listLowered.body.limit === 5 &&
      listLowered.body.presets.length === 11 &&
      overLowered.res.status === 409 &&
      /站点设置/.test(String(overLowered.body.error || '')),
    '调低上限到 5 不删除既有 11 个预设，仅拦住新增（409 并提示可调整）',
    `${listLowered.body.limit}/${listLowered.body.presets.length}/${overLowered.res.status}`
  )

  const clamped = await putSettings({ presetLimit: 999 })
  const resetLimit = await putSettings({ presetLimit: 0 })
  assert(
    clamped.body.settings.presetLimit === 50 && resetLimit.body.settings.presetLimit === 10,
    '上限钳制到 MAX_NOTICE_PRESETS（50），传 0 回到默认 10',
    `${clamped.body.settings.presetLimit}/${resetLimit.body.settings.presetLimit}`
  )

  const auditTarget = (await presetsNow()).body.presets[0]
  const applyFirst = await req(`/api/admin/notice/presets/${auditTarget.id}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: '{}'
  })
  const auditListed = (await presetsNow()).body.presets.find((p) => p.id === auditTarget.id)
  assert(
    applyFirst.res.status === 200 &&
      applyFirst.body.preset.appliedCount === (auditTarget.appliedCount || 0) + 1 &&
      applyFirst.body.preset.appliedAt > 0 &&
      /^key:[0-9a-f]{8}$/.test(String(applyFirst.body.preset.appliedBy)),
    '启用预设写入审计（appliedAt + 管理密钥指纹 + 累计次数）',
    JSON.stringify(applyFirst.body.preset && {
      at: applyFirst.body.preset.appliedAt,
      by: applyFirst.body.preset.appliedBy,
      count: applyFirst.body.preset.appliedCount
    })
  )
  assert(
    auditListed &&
      auditListed.appliedCount === applyFirst.body.preset.appliedCount &&
      auditListed.appliedBy === applyFirst.body.preset.appliedBy,
    '审计信息随预设落盘并可读回',
    JSON.stringify(auditListed && { count: auditListed.appliedCount, by: auditListed.appliedBy })
  )

  const noticeBefore = await req('/api/notice')
  const noticeRev = noticeBefore.body.rev
  const noticeSaved = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ ...noticeBefore.body, content: '并发冲突用例：第一次写入' })
  })
  const noticeStale = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ ...noticeBefore.body, content: '并发冲突用例：过期写入' })
  })
  const noticeAfterStale = await req('/api/notice')
  const noticeNoRev = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ content: '并发冲突用例：不带版本号' })
  })
  assert(
    Number.isInteger(noticeRev) &&
      noticeRev > 0 &&
      noticeSaved.res.status === 200 &&
      noticeSaved.body.notice.rev === noticeRev + 1 &&
      noticeStale.res.status === 409 &&
      /已被其他管理端修改/.test(String(noticeStale.body.error || '')) &&
      noticeAfterStale.body.content === '并发冲突用例：第一次写入' &&
      noticeNoRev.res.status === 200,
    '公告乐观锁：旧版本号 409 且不覆盖内容，不带版本号向后兼容',
    `${noticeRev}→${noticeSaved.body.notice.rev}/${noticeStale.res.status}/${noticeAfterStale.body.content}/${noticeNoRev.res.status}`
  )

  const conflictTarget = (await presetsNow()).body.presets[0]
  const presetUpdated = await req(`/api/admin/notice/presets/${conflictTarget.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ notice: presetNotice, rev: conflictTarget.rev })
  })
  const presetStale = await req(`/api/admin/notice/presets/${conflictTarget.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ notice: presetNotice, rev: conflictTarget.rev })
  })
  assert(
    presetUpdated.res.status === 200 &&
      presetUpdated.body.preset.rev === conflictTarget.rev + 1 &&
      presetStale.res.status === 409,
    '预设乐观锁：同一 rev 重复覆盖返回 409',
    `${presetUpdated.body.preset.rev}/${presetStale.res.status}`
  )

  const applyStale = await req(`/api/admin/notice/presets/${conflictTarget.id}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ noticeRev })
  })
  const afterApplyStale = (await presetsNow()).body.presets.find((p) => p.id === conflictTarget.id)
  assert(
    applyStale.res.status === 409 &&
      /已被其他管理端修改/.test(String(applyStale.body.error || '')) &&
      afterApplyStale.appliedCount === conflictTarget.appliedCount,
    '启用预设时公告版本已过期同样 409，且不写入审计',
    `${applyStale.res.status}/${afterApplyStale.appliedCount}`
  )

  const exportedRes = await fetch(`${BASE}/api/admin/notice/presets/export`, {
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  const exported = await exportedRes.json()
  assert(
    exportedRes.status === 200 &&
      /attachment; filename="notice-presets-\d{8}-\d{6}\.json"/.test(
        String(exportedRes.headers.get('content-disposition') || '')
      ) &&
      exported.format === 'file-share-notice-presets' &&
      exported.version === 1 &&
      exported.count === 11 &&
      exported.presets.length === 11 &&
      exported.presets.every(
        (item) => item.name && item.notice && !('id' in item) && !('rev' in item) && !('appliedAt' in item)
      ),
    '导出预设为带格式版本号的 JSON（不含 id / rev / 审计字段）',
    JSON.stringify({ format: exported.format, version: exported.version, count: exported.count })
  )

  const orderIds = (await presetsNow()).body.presets.map((preset) => preset.id)
  const reordered = await req('/api/admin/notice/presets/order', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ ids: [...orderIds].reverse() })
  })
  const orderList = await presetsNow()
  const badOrder = await req('/api/admin/notice/presets/order', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ ids: ['not-a-preset-id'] })
  })
  assert(
    reordered.res.status === 200 &&
      orderList.body.presets[0].id === orderIds[orderIds.length - 1] &&
      orderList.body.presets.map((preset) => preset.order).join(',') ===
        orderList.body.presets.map((_, index) => index + 1).join(','),
    '排序接口按传入顺序重排并落 order（1..n）',
    JSON.stringify(orderList.body.presets.map((preset) => preset.order))
  )
  assert(badOrder.res.status === 400, '排序列表与现有预设不匹配返回 400', String(badOrder.res.status))

  await putSettings({ presetLimit: 20 })
  const existingName = (await presetsNow()).body.presets[0].name
  const mergeImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      format: exported.format,
      version: exported.version,
      mode: 'merge',
      presets: [
        { name: '导入新增', notice: presetNotice },
        { name: existingName, notice: presetNotice }
      ]
    })
  })
  const mergedList = await presetsNow()
  assert(
    mergeImport.res.status === 200 &&
      mergeImport.body.imported === 2 &&
      mergedList.body.presets.length === 13 &&
      mergedList.body.presets.some((preset) => preset.name === `${existingName}（2）`),
    '合并导入重名自动加序号（（2）），不覆盖现有预设',
    JSON.stringify({ imported: mergeImport.body.imported, total: mergedList.body.presets.length })
  )

  const bulkImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      mode: 'merge',
      presets: Array.from({ length: 12 }, (_, index) => ({ name: `批导入 ${index + 1}`, notice: presetNotice }))
    })
  })
  const afterBulk = await presetsNow()
  assert(
    bulkImport.res.status === 200 &&
      bulkImport.body.imported === 7 &&
      bulkImport.body.skipped === 5 &&
      afterBulk.body.presets.length === 20,
    '导入受上限约束：装满即跳过并如实回报 imported/skipped',
    JSON.stringify({ imported: bulkImport.body.imported, skipped: bulkImport.body.skipped, total: afterBulk.body.presets.length })
  )

  const replaceImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      format: 'file-share-notice-presets',
      version: 1,
      mode: 'replace',
      presets: [{ name: '替换后的唯一预设', notice: presetNotice }]
    })
  })
  const replacedList = await presetsNow()
  assert(
    replaceImport.res.status === 200 &&
      replaceImport.body.imported === 1 &&
      replacedList.body.presets.length === 1 &&
      replacedList.body.presets[0].name === '替换后的唯一预设' &&
      replacedList.body.presets[0].order === 1,
    '替换导入先清空再写入，order 重新从 1 开始',
    JSON.stringify({ imported: replaceImport.body.imported, total: replacedList.body.presets.length })
  )

  const badFormatImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ format: 'other-format', presets: [{ name: 'x', notice: presetNotice }] })
  })
  const emptyImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ presets: [] })
  })
  const badEntryImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ presets: ['nope'] })
  })
  const futureVersionImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ version: 99, presets: [{ name: 'x', notice: presetNotice }] })
  })
  assert(
    badFormatImport.res.status === 400 &&
      emptyImport.res.status === 400 &&
      badEntryImport.res.status === 400 &&
      futureVersionImport.res.status === 400,
    '导入校验：格式不匹配 / 空内容 / 条目非法 / 版本过高均 400',
    [badFormatImport, emptyImport, badEntryImport, futureVersionImport].map((r) => r.res.status).join(',')
  )

  await putSettings({ presetLimit: 0 })
  const restoredSettings = await req('/api/settings')
  assert(restoredSettings.body.presetLimit === 10, '收尾：预设上限回到默认 10', String(restoredSettings.body.presetLimit))

  console.log('\n[31] 多公告：优先级仲裁 / 时间窗 / 槽位分发 / 上限 / 镜像')
  const nHeaders = { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY }
  const listNotices = () => req('/api/admin/notices', { headers: { 'x-admin-key': ADMIN_KEY } })
  const createNotice = (payload) =>
    req('/api/admin/notices', { method: 'POST', headers: nHeaders, body: JSON.stringify(payload) })
  const updateNotice = (id, payload) =>
    req(`/api/admin/notices/${id}`, { method: 'PUT', headers: nHeaders, body: JSON.stringify(payload) })
  const deleteNotice = (id) =>
    req(`/api/admin/notices/${id}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })

  const noticesNoKey = await req('/api/admin/notices')
  assert(noticesNoKey.res.status === 401, '无密钥读取公告列表返回 401', `实际 ${noticesNoKey.res.status}`)

  for (const entry of (await listNotices()).body.notices) await deleteNotice(entry.id)
  const clearedNotices = await listNotices()
  assert(
    clearedNotices.res.status === 200 &&
      clearedNotices.body.notices.length === 0 &&
      clearedNotices.body.limit === 5,
    '清空后列表为空且回传上限（MAX_NOTICES=5）',
    JSON.stringify({ count: clearedNotices.body.notices.length, limit: clearedNotices.body.limit })
  )

  const topNotice = await createNotice({
    title: '维护公告',
    content: '顶部维护',
    display: 'bar',
    position: 'top',
    priority: 50,
    enabled: true
  })
  const bottomNotice = await createNotice({
    title: '活动公告',
    content: '底部活动',
    display: 'bar',
    position: 'bottom',
    priority: 90,
    enabled: true
  })
  assert(
    topNotice.res.status === 201 &&
      bottomNotice.res.status === 201 &&
      topNotice.body.notice.id &&
      bottomNotice.body.notice.id !== topNotice.body.notice.id,
    '新增两条公告各自分配独立 id',
    `${topNotice.res.status}/${bottomNotice.res.status}`
  )

  const publicNotices = await req('/api/notice')
  assert(
    publicNotices.body.title === '活动公告' &&
      publicNotices.body.notices.length === 2 &&
      Number.isInteger(publicNotices.body.rev),
    '顶层为最高优先级胜者，notices[] 含全部有效项且顶层带文件级 rev',
    JSON.stringify({ title: publicNotices.body.title, count: publicNotices.body.notices.length })
  )
  assert(
    publicNotices.body.notices.map((n) => n.priority).join(',') === '90,50',
    'notices[] 按仲裁序（priority desc）排序',
    JSON.stringify(publicNotices.body.notices.map((n) => n.priority))
  )
  const topSlotPick = publicNotices.body.notices.find((n) => n.position === 'top')
  const bottomSlotPick = publicNotices.body.notices.find((n) => n.position === 'bottom')
  assert(
    topSlotPick && topSlotPick.title === '维护公告' && bottomSlotPick && bottomSlotPick.title === '活动公告',
    '两个槽位各有归属公告（前端按槽位取第一条）',
    JSON.stringify({ top: topSlotPick && topSlotPick.title, bottom: bottomSlotPick && bottomSlotPick.title })
  )

  const sameSlotLower = await createNotice({
    title: '同槽位次要公告',
    content: '同槽位次要',
    display: 'bar',
    position: 'fixed-top',
    priority: 10,
    enabled: true
  })
  const afterSameSlot = await req('/api/notice')
  const topSlotAll = afterSameSlot.body.notices.filter((n) => ['top', 'fixed-top'].includes(n.position))
  assert(
    sameSlotLower.res.status === 201 && topSlotAll.length === 2 && topSlotAll[0].title === '维护公告',
    '同槽位多条时由优先级决定谁被展示（数组仍返回全部有效项）',
    JSON.stringify(topSlotAll.map((n) => `${n.title}:${n.priority}`))
  )

  const winStart = Date.now()
  const windowed = await createNotice({
    title: '短窗公告',
    content: '短窗生效',
    display: 'bar',
    position: 'fixed-bottom',
    priority: 100,
    enabled: true,
    startAt: winStart - 1000,
    endAt: winStart + 1500
  })
  const inWindow = await req('/api/notice')
  await new Promise((r) => setTimeout(r, 1800))
  const outOfWindow = await req('/api/notice')
  assert(
    windowed.res.status === 201 && inWindow.body.notices.some((n) => n.title === '短窗公告'),
    '时间窗内公告生效（startAt 已过、endAt 未到）',
    JSON.stringify(inWindow.body.notices.map((n) => n.title))
  )
  assert(
    !outOfWindow.body.notices.some((n) => n.title === '短窗公告'),
    'endAt 到点时无需重启/定时器，下次请求即下线（请求时求值）',
    JSON.stringify(outOfWindow.body.notices.map((n) => n.title))
  )

  const futureNotice = await createNotice({
    title: '未到点公告',
    content: '未来生效',
    display: 'bar',
    position: 'top',
    priority: 100,
    enabled: true,
    startAt: Date.now() + 3600_000
  })
  const afterFuture = await req('/api/notice')
  assert(
    futureNotice.res.status === 201 &&
      !afterFuture.body.notices.some((n) => n.title === '未到点公告') &&
      !afterFuture.body.notices.some((n) => n.title === '未到点公告'),
    'startAt 在未来的公告不展示且不泄露到 notices[]',
    JSON.stringify(afterFuture.body.notices.map((n) => n.title))
  )

  const healthNotice = (await req('/api/health')).body.notice
  assert(
    healthNotice &&
      healthNotice.total === (await listNotices()).body.notices.length &&
      healthNotice.active === afterFuture.body.notices.length &&
      typeof healthNotice.winnerId === 'string',
    '健康检查暴露公告统计（total/active/winnerId/nextChangeAt）',
    JSON.stringify(healthNotice)
  )

  for (let i = 0; i < 5; i++) {
    const filler = await createNotice({
      title: `限量公告 ${i + 1}`,
      content: '占位',
      display: 'bar',
      position: 'top',
      priority: 1,
      enabled: true
    })
    if (filler.res.status !== 201) break
  }
  const atLimit = await listNotices()
  const overLimit = await createNotice({
    title: '超限公告',
    content: '超限',
    display: 'bar',
    position: 'top',
    priority: 1,
    enabled: true
  })
  assert(
    atLimit.body.notices.length === 5 &&
      overLimit.res.status === 409 &&
      /上限/.test(String(overLimit.body && overLimit.body.error)),
    '达到 MAX_NOTICES 后新增返回 409 且列表不变',
    JSON.stringify({ count: atLimit.body.notices.length, status: overLimit.res.status })
  )

  const revTarget = (await listNotices()).body.notices[0]
  const revOk = await updateNotice(revTarget.id, { ...revTarget, title: '改一次', rev: revTarget.rev })
  const revStale = await updateNotice(revTarget.id, { ...revTarget, title: '过期写入', rev: revTarget.rev })
  const afterRevStale = await listNotices()
  assert(
    revOk.res.status === 200 &&
      revOk.body.notice.rev === revTarget.rev + 1 &&
      revStale.res.status === 409 &&
      afterRevStale.body.notices.find((n) => n.id === revTarget.id).title === '改一次',
    '条目级乐观锁：旧 rev 写入 409 且不覆盖',
    `${revOk.res.status}/${revStale.res.status}/${afterRevStale.body.notices.find((n) => n.id === revTarget.id).title}`
  )

  for (const entry of (await listNotices()).body.notices) {
    await updateNotice(entry.id, { ...entry, enabled: false, rev: entry.rev })
  }
  const allDisabled = await req('/api/notice')
  const mirror = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notice.json'), 'utf8'))
  assert(
    allDisabled.res.status === 200 && allDisabled.body.enabled === false && allDisabled.body.notices.length === 0,
    '全部停用后顶层回到旧形状（enabled:false + notices:[]，HTTP 200）',
    JSON.stringify({ enabled: allDisabled.body.enabled, count: allDisabled.body.notices.length })
  )
  assert(
    mirror && mirror.enabled === false && Number.isInteger(mirror.rev),
    '写穿镜像 notice.json 同步为当前胜者/关闭态（老构建回滚可读）',
    JSON.stringify({ enabled: mirror.enabled, rev: mirror.rev })
  )

  for (const entry of (await listNotices()).body.notices) await deleteNotice(entry.id)
  const deleteMissing = await deleteNotice('deadbeef')
  assert(
    (await listNotices()).body.notices.length === 0 && deleteMissing.res.status === 404,
    '删除公告后列表清空，删不存在的 id 返回 404',
    String(deleteMissing.res.status)
  )

  console.log('\n[32] 公告样式扩展：字号 / 圆角 / 不透明度')
  const styledNotice = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      enabled: true,
      title: '样式扩展',
      content: '字号圆角不透明度',
      display: 'bar',
      position: 'top',
      fontSize: 16,
      radius: 8,
      opacity: 80
    })
  })
  assert(
    styledNotice.res.status === 200 &&
      styledNotice.body.notice.fontSize === 16 &&
      styledNotice.body.notice.radius === 8 &&
      styledNotice.body.notice.opacity === 80,
    '字号/圆角/不透明度落盘并可公开读取',
    JSON.stringify(styledNotice.body.notice)
  )
  const badStyleNumbers = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      enabled: true,
      content: '非法数值回落',
      fontSize: 99,
      radius: -5,
      opacity: 20
    })
  })
  assert(
    badStyleNumbers.body.notice.fontSize === 0 &&
      badStyleNumbers.body.notice.radius === 0 &&
      badStyleNumbers.body.notice.opacity === 0,
    '超出范围/非法的字号、圆角、不透明度一律回落 0（默认主题）',
    JSON.stringify(badStyleNumbers.body.notice)
  )

  const floatStyle = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, content: '小数取整', fontSize: 14.6, radius: '6', opacity: '100' })
  })
  assert(
    floatStyle.body.notice.fontSize === 15 &&
      floatStyle.body.notice.radius === 6 &&
      floatStyle.body.notice.opacity === 100,
    '字号四舍五入取整，字符串数值可接受，边界值 100 合法',
    JSON.stringify(floatStyle.body.notice)
  )

  const lineStyle = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, content: '行数配置', maxLines: 3 })
  })
  const badLines = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, content: '行数非法', maxLines: 9 })
  })
  const defaultLines = await req('/api/notice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ enabled: true, content: '未传行数' })
  })
  assert(
    lineStyle.body.notice.maxLines === 3 &&
      badLines.body.notice.maxLines === 1 &&
      defaultLines.body.notice.maxLines === 1,
    '纵向行数上限：1/2/3 合法，非法与缺省都回落 1 行（旧行为）',
    JSON.stringify({
      ok: lineStyle.body.notice.maxLines,
      bad: badLines.body.notice.maxLines,
      missing: defaultLines.body.notice.maxLines
    })
  )

  await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      mode: 'replace',
      presets: [
        {
          name: '样式预设',
          notice: { enabled: true, content: '预设带样式', display: 'bar', fontSize: 20, radius: 12, opacity: 60 }
        }
      ]
    })
  })
  const stylePresetList = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  const stylePreset = stylePresetList.body.presets[0]
  const styleApplied = await req(`/api/admin/notice/presets/${stylePreset.id}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ noticeId: 'default' })
  })
  assert(
    stylePreset.notice.fontSize === 20 &&
      stylePreset.notice.radius === 12 &&
      stylePreset.notice.opacity === 60 &&
      styleApplied.res.status === 200 &&
      styleApplied.body.notice.fontSize === 20,
    '预设快照自动携带样式数值，启用后落到目标公告',
    JSON.stringify({ preset: stylePreset.notice, applied: styleApplied.body.notice.fontSize })
  )
  console.log('\n[33] 预设分组：归一化 / 导出导入携带 / 旧数据兼容')
  const groupCreate = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: '分组预设', group: ' 运维中心 ', notice: { enabled: true, content: '分组内容' } })
  })
  assert(
    groupCreate.res.status === 201 && groupCreate.body.preset.group === '运维中心',
    '预设分组保存并去除首尾空白',
    JSON.stringify(groupCreate.body.preset && groupCreate.body.preset.group)
  )

  const longGroup = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: '超长分组', group: 'x'.repeat(40), notice: { enabled: true, content: '超长' } })
  })
  assert(
    longGroup.res.status === 201 && longGroup.body.preset.group.length === 20,
    '分组名截断到 20 字符',
    String(longGroup.body.preset && longGroup.body.preset.group.length)
  )

  const ungrouped = await req('/api/admin/notice/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: '无分组预设', notice: { enabled: true, content: '未分组' } })
  })
  const listWithGroups = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    ungrouped.res.status === 201 &&
      ungrouped.body.preset.group === '' &&
      listWithGroups.body.presets.some((preset) => preset.group === '运维中心'),
    '未传分组的预设回落空分组',
    JSON.stringify(listWithGroups.body.presets.map((preset) => preset.group))
  )

  const groupExport = await req('/api/admin/notice/presets/export', {
    headers: { 'x-admin-key': ADMIN_KEY }
  })
  assert(
    groupExport.res.status === 200 &&
      groupExport.body.presets.some((preset) => preset.group === '运维中心') &&
      groupExport.body.presets.every((preset) => !('id' in preset) && !('rev' in preset)),
    '导出携带 group 且仍不含 id/rev',
    JSON.stringify(groupExport.body.presets.map((preset) => preset.group))
  )

  const groupImport = await req('/api/admin/notice/presets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      mode: 'replace',
      presets: [{ name: '导入分组预设', group: '活动', notice: { enabled: true, content: '导入' } }]
    })
  })
  const afterGroupImport = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    groupImport.res.status === 200 && afterGroupImport.body.presets[0].group === '活动',
    '导入携带分组并可读回',
    JSON.stringify(afterGroupImport.body.presets.map((preset) => preset.group))
  )

  const presetsFile = path.join(DATA_DIR, 'notice-presets.json')
  const legacyPresetStore = JSON.parse(fs.readFileSync(presetsFile, 'utf8'))
  for (const preset of legacyPresetStore.presets) delete preset.group
  fs.writeFileSync(presetsFile, JSON.stringify(legacyPresetStore))
  const afterLegacyPresets = await req('/api/admin/notice/presets', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    afterLegacyPresets.body.presets.length > 0 &&
      afterLegacyPresets.body.presets.every((preset) => preset.group === ''),
    '旧版无 group 的预设文件读入后统一为空分组（无需迁移脚本）',
    JSON.stringify(afterLegacyPresets.body.presets.map((preset) => preset.group))
  )

  console.log('\n[34] 会话配额运维可见性（/api/admin/stats.sessionQuota）')
  const quotaShareUpload = await upload(
    crypto.randomBytes(2048),
    { expiresIn: 1, maxDownloads: 3 },
    '配额可见性.bin'
  )
  const quotaShareCode = quotaShareUpload.body && quotaShareUpload.body.code
  const quotaUploadInit = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: '可见性上传.bin',
      size: 1048576,
      mime: 'text/plain',
      expiresIn: '1',
      maxDownloads: '3'
    })
  })
  const quotaDownloadInit = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: quotaShareCode })
  })
  const findQuotaBucket = (stats) =>
    ((stats.body && stats.body.sessionQuota && stats.body.sessionQuota.topIps) || []).find((row) =>
      /127\.0\.0\.1$/.test(row.ip)
    )
  const quotaStats = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const quotaBucket = findQuotaBucket(quotaStats)
  assert(
    quotaUploadInit.res.status === 200 &&
      quotaDownloadInit.res.status === 200 &&
      quotaBucket &&
      quotaBucket.uploadSessions >= 1 &&
      quotaBucket.tmpBytes >= 1048576 &&
      quotaBucket.downloadSessions >= 1,
    '按 IP 汇总在途会话与临时空间用量（与配额判定同源）',
    JSON.stringify(quotaBucket)
  )
  assert(
    quotaStats.body.sessionQuota.maxUploadSessionsPerIp === 8 &&
      quotaStats.body.sessionQuota.maxDownloadSessionsPerIp === 32 &&
      typeof quotaStats.body.sessionQuota.maxTmpBytesPerIp === 'number' &&
      Array.isArray(quotaStats.body.sessionQuota.topIps),
    '回传当前配额上限与出口列表',
    JSON.stringify({
      upload: quotaStats.body.sessionQuota.maxUploadSessionsPerIp,
      download: quotaStats.body.sessionQuota.maxDownloadSessionsPerIp,
      rows: quotaStats.body.sessionQuota.topIps.length
    })
  )

  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: quotaDownloadInit.body.token })
  })
  for (let index = 0; index < 4; index++) {
    await fetch(`${BASE}/api/upload/part?uploadId=${quotaUploadInit.body.uploadId}&index=${index}`, {
      method: 'PUT',
      body: crypto.randomBytes(262144)
    })
  }
  const quotaUploadDone = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: quotaUploadInit.body.uploadId })
  })
  const quotaStatsAfter = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  const quotaBucketAfter = findQuotaBucket(quotaStatsAfter)
  const afterDownloads = quotaBucketAfter ? quotaBucketAfter.downloadSessions : 0
  const afterTmp = quotaBucketAfter ? quotaBucketAfter.tmpBytes : 0
  assert(
    quotaUploadDone.res.status === 201 &&
      Boolean(quotaBucket) &&
      afterDownloads < quotaBucket.downloadSessions &&
      afterTmp < quotaBucket.tmpBytes,
    '下载会话结束与上传完成后，该 IP 的用量即时下降（名额即时释放）',
    JSON.stringify({ before: quotaBucket, after: quotaBucketAfter })
  )

  console.log('\n[36] 压缩后台任务化（B1-2）')
  const bgText = 'Z'.repeat(700 * 1024)
  const bgRaw = await req('/api/upload', {
    method: 'POST',
    body: uploadForm(bgText, { expiresIn: '1', maxDownloads: '3' }, '后台压缩.txt')
  })
  const bgCode = bgRaw.body && bgRaw.body.code
  assert(
    bgRaw.res.status === 201 &&
      bgRaw.body.compressionState === 'pending' &&
      bgRaw.body.storedSize === bgRaw.body.size &&
      bgRaw.body.compressed === false,
    '201 立即返回：标 pending、storedSize=原始大小、尚未宣称压缩',
    JSON.stringify({
      state: bgRaw.body && bgRaw.body.compressionState,
      storedSize: bgRaw.body && bgRaw.body.storedSize,
      size: bgRaw.body && bgRaw.body.size
    })
  )
  const bgInfo = await req(`/api/info?code=${bgCode}`)
  assert(bgInfo.res.status === 200, 'pending 期间分享即可查询（meta 已落盘）', `${bgInfo.res.status}`)
  const bgJob = await settleCompression(bgCode)
  assert(
    bgJob && bgJob.finished === true && bgJob.compressionState === '' && bgJob.compressed === true,
    '任务落定后压缩生效（job done + compressed）',
    JSON.stringify(bgJob)
  )
  const bgMeta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta', `${bgCode}.json`), 'utf8'))
  assert(
    bgMeta.compression === 'units-v2' &&
      bgMeta.compressionState === '' &&
      Array.isArray(bgMeta.units) &&
      bgMeta.units.length > 0,
    '元数据回写 compression/units 并清空 pending（边车已删）',
    JSON.stringify({ compression: bgMeta.compression, state: bgMeta.compressionState })
  )
  assert(
    !fs.existsSync(path.join(DATA_DIR, 'meta', `${bgCode}.packmeta`)) &&
      !fs.existsSync(path.join(DATA_DIR, 'files', `${bgCode}.pack`)),
    '落定后不残留边车与 .pack',
    '残留文件存在'
  )
  const bgHash = crypto.createHash('sha256')
  const bgDl = await fetch(`${BASE}/api/download?code=${bgCode}`)
  const bgBuf = Buffer.from(await bgDl.arrayBuffer())
  bgHash.update(Buffer.from(bgText))
  assert(
    bgDl.status === 200 && crypto.createHash('sha256').update(bgBuf).digest('hex') === bgHash.digest('hex'),
    '后台压缩后下载逐字节一致（SHA-256 对照）',
    `${bgDl.status} ${bgBuf.length}/${Buffer.byteLength(bgText)}`
  )

  const bgRandBuf = crypto.randomBytes(400 * 1024)
  const bgRandUp = await upload(bgRandBuf, { expiresIn: '1', maxDownloads: '2' }, '后台随机.bin')
  const bgRandJob = await settleCompression(bgRandUp.body.code)
  assert(
    bgRandUp.body.compressed === false &&
      bgRandUp.body.storedSize === bgRandUp.body.size &&
      bgRandJob &&
      bgRandJob.status === 'done',
    '无压缩收益时任务正常结束并回退未压缩（不丢文件）',
    JSON.stringify({ compressed: bgRandUp.body.compressed, job: bgRandJob && bgRandJob.status })
  )

  // pending 窗口内建立会话：必须等落定再发计划，否则同一 index 会指向不同字节。
  const bgGateText = 'G'.repeat(700 * 1024)
  const bgGateUp = await req('/api/upload', {
    method: 'POST',
    body: uploadForm(bgGateText, { expiresIn: '1', maxDownloads: '3' }, '门控.txt')
  })
  const bgGateCode = bgGateUp.body && bgGateUp.body.code
  const bgSess = await req('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: bgGateCode })
  })
  assert(
    bgGateUp.body.compressionState === 'pending' && bgSess.res.status === 200 && bgSess.body.compressed === true,
    'pending 窗口内建立下载会话会先等落定（不发出会漂移的分片计划）',
    JSON.stringify({ state: bgGateUp.body && bgGateUp.body.compressionState, sess: bgSess.res.status })
  )
  const bgGateParts = await Promise.all(
    (bgSess.body.units || []).map((_, i) =>
      fetch(`${BASE}/api/download/part?token=${bgSess.body.token}&index=${i}`, {
        headers: { 'accept-encoding': 'identity' }
      })
    )
  )
  const bgGateBuf = Buffer.concat(
    (await Promise.all(bgGateParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    bgGateParts.length > 0 &&
      bgGateParts.every((res) => res.status === 200) &&
      bgGateBuf.toString() === bgGateText,
    'pending 期间建立的会话取片内容逐字节一致',
    `${bgGateBuf.length}/${Buffer.byteLength(bgGateText)}`
  )
  await req('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: bgSess.body.token })
  })

  const bgJobMissing = await req('/api/upload/job')
  const bgJobBad = await req('/api/upload/job?uploadId=not-a-real-id')
  const bgJobUnknown = await req('/api/upload/job?code=000000')
  assert(
    bgJobMissing.res.status === 400 && bgJobBad.res.status === 400 && bgJobUnknown.res.status === 404,
    '任务查询接口：缺参/非法 400、不存在 404',
    JSON.stringify({ missing: bgJobMissing.res.status, bad: bgJobBad.res.status, unknown: bgJobUnknown.res.status })
  )

  const bgBatch = await Promise.all(
    [0, 1, 2].map((i) =>
      req('/api/upload', {
        method: 'POST',
        body: uploadForm('Q'.repeat(800 * 1024), { expiresIn: '1', maxDownloads: '2' }, `排队${i}.txt`)
      })
    )
  )
  let sawQueue = false
  for (let i = 0; i < 60; i++) {
    const health = await req('/api/health')
    const queue = health.body.compressQueue || {}
    if ((queue.pending || 0) + (queue.running || 0) > 0) {
      sawQueue = true
      break
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  assert(
    bgBatch.every((r) => r.res.status === 201 && r.body.compressionState === 'pending'),
    '并发上传全部立即返回 pending（由串行队列排队）',
    JSON.stringify(bgBatch.map((r) => r.body && r.body.compressionState))
  )
  assert(sawQueue, '/api/health 的 compressQueue 在压缩窗口内计数非零', '未观测到非零计数')
  const bgBatchSettled = await Promise.all(bgBatch.map((r) => settleCompression(r.body.code)))
  assert(
    bgBatchSettled.every((job) => job && job.compressed === true),
    '排队任务全部落定为压缩（队列串行推进）',
    JSON.stringify(bgBatchSettled.map((job) => job && job.compressed))
  )

  console.log('\n[30] 上传分片数超限时向上放宽 partSize（隔离端口）')
  const PART_PORT = 3997
  const PART_BASE = `http://127.0.0.1:${PART_PORT}`
  const PART_DIR = path.join(rootDir, 'data-test-partsize')
  fs.rmSync(PART_DIR, { recursive: true, force: true })
  const partServer = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PART_PORT),
      ADMIN_KEY,
      DATA_DIR: PART_DIR,
      MAX_FILE_SIZE: '4194304',
      RATE_LIMIT_MISSES: '1000',
      UPLOAD_LIMIT_PER_MINUTE: '1000',
      TRANSFER_PART_SIZE: '1024'
    }
  })
  partServer.stdout.on('data', () => {})
  partServer.stderr.on('data', (d) => process.stderr.write(d))
  const partAlive = await waitForServer(PART_BASE)
  assert(partAlive, '分片探针服务器启动（TRANSFER_PART_SIZE=1024）', String(partAlive))

  const pJson = (pathname, payload) =>
    fetch(`${PART_BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  const pInit = async (filename, size) => {
    const res = await pJson('/api/upload/init', {
      filename,
      size,
      mime: 'application/octet-stream',
      expiresIn: '1',
      maxDownloads: '3'
    })
    return { res, body: await res.json() }
  }

  if (partAlive) {
    const exact = await pInit('刚好1024片.bin', 1048576)
    assert(
      exact.res.status === 200 && exact.body.partSize === 1024 && exact.body.totalParts === 1024,
      '未超限时不改变分片大小（默认行为零变化）',
      `${exact.res.status} ${JSON.stringify(exact.body)}`
    )

    const widened = await pInit('需要放宽.bin', 2097152)
    assert(
      widened.res.status === 200 &&
        widened.body.partSize === 2048 &&
        widened.body.totalParts === 1024,
      '分片数将超限时向上翻倍 partSize，而非直接拒绝',
      `${widened.res.status} ${JSON.stringify(widened.body)}`
    )

    const wideUploadId = widened.body.uploadId
    const widePart = await fetch(`${PART_BASE}/api/upload/part?uploadId=${wideUploadId}&index=0`, {
      method: 'PUT',
      body: crypto.randomBytes(2048)
    })
    assert(
      widePart.status === 200,
      '放宽后的会话接受 2048 字节分片（分片体上限随会话 partSize）',
      String(widePart.status)
    )

    const oversized = await fetch(`${PART_BASE}/api/upload/part?uploadId=${exact.body.uploadId}&index=0`, {
      method: 'PUT',
      body: crypto.randomBytes(4096)
    })
    assert(
      oversized.status === 413,
      '未放宽的会话仍拒绝超出 partSize 的分片（413）',
      String(oversized.status)
    )

    const resumed = await fetch(`${PART_BASE}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: wideUploadId, filename: '需要放宽.bin', size: 2097152 })
    })
    const resumedBody = await resumed.json()
    assert(
      resumed.status === 200 &&
        resumedBody.partSize === 2048 &&
        resumedBody.totalParts === 1024 &&
        resumedBody.resumed === true,
      '续传复用已放宽的 partSize（不重算）',
      `${resumed.status} ${JSON.stringify(resumedBody)}`
    )

    const statusWide = await fetch(`${PART_BASE}/api/upload/status?uploadId=${wideUploadId}`)
    const statusBody = await statusWide.json()
    assert(
      statusWide.status === 200 && statusBody.partSize === 2048 && statusBody.totalParts === 1024,
      'upload/status 回传放宽后的 partSize/totalParts',
      JSON.stringify({ partSize: statusBody.partSize, totalParts: statusBody.totalParts })
    )
  }

  partServer.kill('SIGTERM')
  fs.rmSync(PART_DIR, { recursive: true, force: true })

  console.log('\n[35] 统计 WAL：崩溃零丢失（隔离端口，STATS_WAL=on）')
  const WAL_PORT = 3996
  const WAL_BASE = `http://127.0.0.1:${WAL_PORT}`
  const WAL_DIR = path.join(rootDir, 'data-test-wal')
  const WAL_META = path.join(WAL_DIR, 'transfer-stats.wal')
  const walEnv = {
    ...process.env,
    PORT: String(WAL_PORT),
    ADMIN_KEY,
    DATA_DIR: WAL_DIR,
    MAX_FILE_SIZE: '8388608',
    RATE_LIMIT_MISSES: '1000',
    UPLOAD_LIMIT_PER_MINUTE: '1000',
    TRANSFER_PART_SIZE: '262144',
    STATS_WAL: 'on'
  }
  const spawnWal = () => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: walEnv
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', (d) => process.stderr.write(d))
    return child
  }
  const wReq = async (pathname, options = {}) => {
    const res = await fetch(`${WAL_BASE}${pathname}`, options)
    let body = null
    const type = res.headers.get('content-type') || ''
    if (type.includes('application/json')) body = await res.json()
    return { res, body }
  }

  fs.rmSync(WAL_DIR, { recursive: true, force: true })
  let walServer = spawnWal()
  let walAlive = await waitForServer(WAL_BASE)
  assert(walAlive, 'WAL 探针服务器启动（STATS_WAL=on）', String(walAlive))

  if (walAlive) {
    const walForm = new FormData()
    walForm.append('file', new Blob([Buffer.from('可压缩日志内容。'.repeat(45000))]), 'wal-test.log')
    walForm.append('expiresIn', '1')
    walForm.append('maxDownloads', '3')
    const walUpload = await wReq('/api/upload', { method: 'POST', body: walForm })
    const walCode = walUpload.body && walUpload.body.code
    const walSession = await wReq('/api/download/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: walCode })
    })
    const walUnits = Number(walSession.body && walSession.body.unitCount) || 1
    for (let i = 0; i < walUnits; i++) {
      await wReq(`/api/download/part?token=${walSession.body.token}&index=${i}`)
    }
    const walBefore = await wReq('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
    const walDiskBefore = JSON.parse(fs.readFileSync(path.join(WAL_DIR, 'stats.json'), 'utf8'))
    assert(
      walBefore.body.transferWireBytes > 0 &&
        walDiskBefore.transferWireBytes === 0 &&
        fs.existsSync(WAL_META) &&
        fs.statSync(WAL_META).size > 0,
      '开启 WAL 后记账先落追加日志，刷盘窗口内磁盘计数仍为 0（可验证崩溃场景）',
      JSON.stringify({
        wire: walBefore.body.transferWireBytes,
        disk: walDiskBefore.transferWireBytes,
        walBytes: fs.existsSync(WAL_META) ? fs.statSync(WAL_META).size : 0
      })
    )

    walServer.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 900))
    walServer = spawnWal()
    walAlive = await waitForServer(WAL_BASE)
    const walAfterCrash = await wReq('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
    assert(
      walAlive &&
        walAfterCrash.body.transferWireBytes === walBefore.body.transferWireBytes &&
        walAfterCrash.body.transferSavedBytes > 0,
      'SIGKILL 后重启：重放 WAL 补齐未刷盘记账（零丢失）',
      JSON.stringify({
        before: walBefore.body.transferWireBytes,
        after: walAfterCrash.body.transferWireBytes
      })
    )

    walServer.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 900))
    walServer = spawnWal()
    walAlive = await waitForServer(WAL_BASE)
    const walAfterSecond = await wReq('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
    const walDiskAfter = JSON.parse(fs.readFileSync(path.join(WAL_DIR, 'stats.json'), 'utf8'))
    assert(
      walAlive &&
        walAfterSecond.body.transferWireBytes === walBefore.body.transferWireBytes &&
        Number(walDiskAfter.walOffset) > 0,
      '再次重启不重复累加（刷盘写入的偏移水位线生效）',
      JSON.stringify({
        wire: walAfterSecond.body.transferWireBytes,
        offset: walDiskAfter.walOffset
      })
    )

    walServer.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  fs.rmSync(WAL_DIR, { recursive: true, force: true })

  console.log('\n[37] 压缩崩溃恢复（启动修复：边车优先，否则回退未压缩）')
  const CRASH_PORT = 3996
  const CRASH_BASE = `http://127.0.0.1:${CRASH_PORT}`
  const CRASH_DIR = path.join(rootDir, 'data-test-pending')
  fs.rmSync(CRASH_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(CRASH_DIR, 'files'), { recursive: true })
  fs.mkdirSync(path.join(CRASH_DIR, 'meta'), { recursive: true })
  const crashText = 'C'.repeat(300 * 1024)
  const crashRaw = Buffer.from(crashText)
  const crashGz = zlib.gzipSync(crashRaw)
  const crashSidecar = JSON.stringify({
    format: 'units-v2',
    storedSize: crashGz.length,
    units: [{ o: 0, c: crashGz.length, r: crashRaw.length, z: 1 }],
    dedup: 0
  })
  const pendingMeta = (code) =>
    JSON.stringify({
      code,
      filename: '崩溃恢复.txt',
      size: crashRaw.length,
      mime: 'text/plain',
      note: '',
      password: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      maxDownloads: 3,
      downloads: 0,
      compression: '',
      compressionState: 'pending',
      storedSize: crashRaw.length
    })
  // ① 改名已发生、元数据未回写：文件已是容器，边车必须被采用。
  fs.writeFileSync(path.join(CRASH_DIR, 'files', '123456'), crashGz)
  fs.writeFileSync(path.join(CRASH_DIR, 'meta', '123456.json'), pendingMeta('123456'))
  fs.writeFileSync(path.join(CRASH_DIR, 'meta', '123456.packmeta'), crashSidecar)
  // ② 改名未发生：文件仍是原始字节，边车必须被丢弃（否则会把原文件当容器）。
  fs.writeFileSync(path.join(CRASH_DIR, 'files', '654321'), crashRaw)
  fs.writeFileSync(path.join(CRASH_DIR, 'meta', '654321.json'), pendingMeta('654321'))
  fs.writeFileSync(path.join(CRASH_DIR, 'meta', '654321.packmeta'), crashSidecar)
  fs.writeFileSync(path.join(CRASH_DIR, 'files', '654321.pack'), crashGz)
  const crashServer = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(CRASH_PORT),
      ADMIN_KEY,
      DATA_DIR: CRASH_DIR,
      MAX_FILE_SIZE: '10485760',
      RATE_LIMIT_MISSES: '1000',
      UPLOAD_LIMIT_PER_MINUTE: '1000'
    }
  })
  crashServer.stdout.on('data', () => {})
  crashServer.stderr.on('data', () => {})
  const crashAlive = await waitForServer(CRASH_BASE)
  const metaApplied = JSON.parse(fs.readFileSync(path.join(CRASH_DIR, 'meta', '123456.json'), 'utf8'))
  const metaRolled = JSON.parse(fs.readFileSync(path.join(CRASH_DIR, 'meta', '654321.json'), 'utf8'))
  assert(
    crashAlive &&
      metaApplied.compression === 'units-v2' &&
      metaApplied.compressionState === '' &&
      metaApplied.storedSize === crashGz.length,
    '改名已发生：启动按边车补齐元数据（compression/units/storedSize）',
    JSON.stringify({ compression: metaApplied.compression, state: metaApplied.compressionState })
  )
  assert(
    metaRolled.compression === '' &&
      metaRolled.compressionState === '' &&
      metaRolled.storedSize === crashRaw.length,
    '改名未发生：丢弃边车回退为未压缩（不把原文件当容器）',
    JSON.stringify({ compression: metaRolled.compression, state: metaRolled.compressionState })
  )
  assert(
    !fs.existsSync(path.join(CRASH_DIR, 'meta', '123456.packmeta')) &&
      !fs.existsSync(path.join(CRASH_DIR, 'meta', '654321.packmeta')) &&
      !fs.existsSync(path.join(CRASH_DIR, 'files', '654321.pack')),
    '修复后不残留边车与 .pack',
    '残留文件存在'
  )
  const crashDlA = Buffer.from(await (await fetch(`${CRASH_BASE}/api/download?code=123456`)).arrayBuffer())
  const crashDlB = Buffer.from(await (await fetch(`${CRASH_BASE}/api/download?code=654321`)).arrayBuffer())
  assert(
    crashDlA.equals(crashRaw) && crashDlB.equals(crashRaw),
    '两种崩溃残局下载均逐字节一致',
    JSON.stringify({ applied: crashDlA.length, rolled: crashDlB.length })
  )
  // ③ 真杀进程：压缩途中 SIGKILL，重启后文件仍可下载且逐字节一致。
  const killLine = `杀死压缩测试行 ${'x'.repeat(180)}\n`
  const killText = killLine.repeat(Math.ceil((8 * 1024 * 1024) / killLine.length))
  const killForm = new FormData()
  killForm.append('file', new Blob([killText], { type: 'text/plain' }), '杀掉压缩.txt')
  killForm.append('expiresIn', '1')
  killForm.append('maxDownloads', '3')
  const killRes = await fetch(`${CRASH_BASE}/api/upload`, { method: 'POST', body: killForm })
  const killBody = await killRes.json()
  await new Promise((resolve) => setTimeout(resolve, 60))
  crashServer.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const crashServer2 = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(CRASH_PORT), ADMIN_KEY, DATA_DIR: CRASH_DIR, MAX_FILE_SIZE: '10485760', RATE_LIMIT_MISSES: '1000', UPLOAD_LIMIT_PER_MINUTE: '1000' }
  })
  crashServer2.stdout.on('data', () => {})
  crashServer2.stderr.on('data', () => {})
  const crashAlive2 = await waitForServer(CRASH_BASE)
  const killMeta = JSON.parse(fs.readFileSync(path.join(CRASH_DIR, 'meta', `${killBody.code}.json`), 'utf8'))
  const killDl = Buffer.from(await (await fetch(`${CRASH_BASE}/api/download?code=${killBody.code}`)).arrayBuffer())
  assert(
    crashAlive2 &&
      killRes.status === 201 &&
      killMeta.compressionState === '' &&
      killDl.equals(Buffer.from(killText)),
    'SIGKILL 打断压缩后重启：元数据已收尾且文件逐字节一致（零丢失）',
    JSON.stringify({ state: killMeta.compressionState, bytes: killDl.length, expected: Buffer.byteLength(killText) })
  )
  crashServer2.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
  fs.rmSync(CRASH_DIR, { recursive: true, force: true })

  console.log('\n[38] 跨文件去重（CAS 清单化容器，隔离端口）')
  // 开关关闭时零行为变化：主服务器的对象目录必须始终为空。
  let mainObjects = []
  try {
    mainObjects = fs.readdirSync(path.join(DATA_DIR, 'objects'))
  } catch {}
  assert(
    mainObjects.length === 0,
    'CROSS_FILE_DEDUP=off 时不写任何对象（对象目录为空）',
    JSON.stringify(mainObjects)
  )

  const DEDUP_PORT = 3995
  const DEDUP_BASE = `http://127.0.0.1:${DEDUP_PORT}`
  const DEDUP_DIR = path.join(rootDir, 'data-test-dedup')
  fs.rmSync(DEDUP_DIR, { recursive: true, force: true })
  const dedupServer = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(DEDUP_PORT),
      ADMIN_KEY,
      DATA_DIR: DEDUP_DIR,
      CROSS_FILE_DEDUP: 'on',
      // 宽限期设成 1ms 但周期拉长：避免周期 GC 在打包过程中误删「已写、清单未落」的对象，
      // 回收改用「重启触发启动 GC」验证（启动 + 周期两条路径同一实现）。
      DEDUP_GC_GRACE_MS: '1',
      DEDUP_GC_INTERVAL_MS: '3600000',
      MAX_FILE_SIZE: '1048576',
      RATE_LIMIT_MISSES: '1000',
      UPLOAD_LIMIT_PER_MINUTE: '1000',
      TRANSFER_PART_SIZE: '262144',
      UNIT_TARGET_COUNT: '8',
      UNIT_MIN_SIZE: '65536',
      UNIT_MAX_SIZE: '131072',
      UNIT_MAX_COUNT: '64',
      COMPRESS_CODECS: 'br,gzip'
    }
  })
  dedupServer.stdout.on('data', () => {})
  dedupServer.stderr.on('data', () => {})
  const dedupAlive = await waitForServer(DEDUP_BASE)
  const dedupReq = async (pathname, options = {}) => {
    const res = await fetch(`${DEDUP_BASE}${pathname}`, options)
    let body = null
    try {
      body = await res.json()
    } catch {}
    return { res, body }
  }
  const dedupUpload = async (content, fields = {}, filename = '去重.txt') => {
    const res = await fetch(`${DEDUP_BASE}/api/upload`, {
      method: 'POST',
      body: uploadForm(content, fields, filename)
    })
    const body = await res.json()
    if (res.status === 201) await mergeCompression(body, DEDUP_BASE)
    return { status: res.status, body }
  }
  const objectFiles = () => {
    const out = []
    let buckets = []
    try {
      buckets = fs.readdirSync(path.join(DEDUP_DIR, 'objects'))
    } catch {
      return out
    }
    for (const bucket of buckets) {
      let names = []
      try {
        names = fs.readdirSync(path.join(DEDUP_DIR, 'objects', bucket))
      } catch {
        continue
      }
      for (const name of names) out.push(path.join(DEDUP_DIR, 'objects', bucket, name))
    }
    return out
  }
  const objectBytes = () => objectFiles().reduce((sum, file) => sum + fs.statSync(file).size, 0)

  assert(dedupAlive, '去重探针服务器启动（CROSS_FILE_DEDUP=on）')
  // 内容要「可压缩但每个单元不同」，否则同一文件内的重复单元会被单文件去重合并成一个对象。
  const dedupLines = []
  for (let i = 0; i < 8000; i++) {
    dedupLines.push(`第 ${i} 行 去重内容 ${'x'.repeat(48)} ${(i * 7919) % 100003}\n`)
  }
  const dedupText = dedupLines.join('')
  const dedupBuf = Buffer.from(dedupText)
  const dedupA = await dedupUpload(dedupText, { expiresIn: '1', maxDownloads: '5' }, '去重A.txt')
  const bytesAfterFirst = objectBytes()
  const objectsAfterFirst = objectFiles().length
  const dedupB = await dedupUpload(dedupText, { expiresIn: '1', maxDownloads: '5' }, '去重B.txt')
  assert(
    dedupA.status === 201 &&
      dedupA.body.compressed === true &&
      dedupB.status === 201 &&
      dedupB.body.compressed === true,
    '开关开启后两份相同内容均写入清单化容器',
    JSON.stringify({ a: dedupA.body && dedupA.body.compressed, b: dedupB.body && dedupB.body.compressed })
  )
  assert(
    objectsAfterFirst > 1 && objectFiles().length === objectsAfterFirst && objectBytes() === bytesAfterFirst,
    '第二份内容全部命中既有对象（磁盘不再增长）',
    JSON.stringify({ objects: objectsAfterFirst, now: objectFiles().length, bytes: bytesAfterFirst })
  )
  const metaA = JSON.parse(fs.readFileSync(path.join(DEDUP_DIR, 'meta', `${dedupA.body.code}.json`), 'utf8'))
  const metaB = JSON.parse(fs.readFileSync(path.join(DEDUP_DIR, 'meta', `${dedupB.body.code}.json`), 'utf8'))
  assert(
    metaA.compression === 'units-v3' &&
      metaA.storageVersion === 2 &&
      Array.isArray(metaA.units) &&
      metaA.units.length > 0 &&
      metaA.units.every((unit) => /^[0-9a-f]{64}$/.test(unit.h) && unit.o === undefined) &&
      metaA.units.reduce((sum, unit) => sum + unit.r, 0) === metaA.size,
    '清单格式：units-v3 + storageVersion=2，单元只有 h/c/r/z（无文件内偏移）',
    JSON.stringify({ compression: metaA.compression, units: metaA.units.length })
  )
  assert(
    !fs.existsSync(path.join(DEDUP_DIR, 'files', dedupA.body.code)) &&
      !fs.existsSync(path.join(DEDUP_DIR, 'files', dedupB.body.code)),
    '清单化容器不再生成 files/<code> 单文件',
    'files 目录下仍有文件'
  )
  assert(
    metaA.storedSize === metaB.storedSize && metaB.crossHits > 0,
    '第二份 storedSize 与首份一致且全部计为跨文件命中',
    JSON.stringify({ a: metaA.storedSize, b: metaB.storedSize, hits: metaB.crossHits })
  )

  const dedupDl = Buffer.from(
    await (await fetch(`${DEDUP_BASE}/api/download?code=${dedupA.body.code}`)).arrayBuffer()
  )
  assert(
    dedupDl.length === dedupBuf.length &&
      crypto.createHash('sha256').update(dedupDl).digest('hex') ===
        crypto.createHash('sha256').update(dedupBuf).digest('hex'),
    '清单化容器单请求下载逐字节一致',
    `${dedupDl.length}/${dedupBuf.length}`
  )
  const dedupSess = await dedupReq('/api/download/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dedupB.body.code })
  })
  const dedupPass = await fetch(
    `${DEDUP_BASE}/api/download/part?token=${dedupSess.body.token}&index=0`,
    { headers: { 'accept-encoding': 'br, gzip' } }
  )
  const dedupParts = await Promise.all(
    (dedupSess.body.units || []).map((_, index) =>
      fetch(`${DEDUP_BASE}/api/download/part?token=${dedupSess.body.token}&index=${index}`, {
        headers: { 'accept-encoding': 'identity' }
      })
    )
  )
  const dedupJoined = Buffer.concat(
    (await Promise.all(dedupParts.map((res) => res.arrayBuffer()))).map((body) => Buffer.from(body))
  )
  assert(
    dedupSess.res.status === 200 &&
      dedupSess.body.compressed === true &&
      dedupParts.length > 1 &&
      dedupParts.every((res) => res.status === 200) &&
      dedupJoined.length === dedupBuf.length &&
      Buffer.compare(dedupJoined, dedupBuf) === 0,
    '清单化容器分片下载逐字节一致（按对象逐片取载荷）',
    JSON.stringify({ parts: dedupParts.length, bytes: dedupJoined.length, passthrough: dedupPass.status })
  )
  await dedupReq('/api/download/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: dedupSess.body.token })
  })

  const dedupStats = await dedupReq('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(
    dedupStats.body.dedupCrossEnabled === true &&
      dedupStats.body.dedupCrossManifests === 2 &&
      dedupStats.body.dedupCrossRatio > 1.5 &&
      dedupStats.body.dedupCrossSavedBytes > 0,
    '统计暴露跨文件去重收益（对象数/字节数与比值 > 1.5）',
    JSON.stringify({
      objects: dedupStats.body.dedupCrossObjects,
      bytes: dedupStats.body.dedupCrossBytes,
      implied: dedupStats.body.dedupCrossImpliedBytes,
      ratio: dedupStats.body.dedupCrossRatio
    })
  )
  const dedupHealth = await dedupReq('/api/health')
  assert(
    dedupHealth.body.features.includes('crossFileDedup') &&
      dedupHealth.body.dedup.enabled === true &&
      dedupHealth.body.dedup.objects > 0,
    'health 暴露 dedup.{enabled,objects,bytes,lastGc}',
    JSON.stringify(dedupHealth.body.dedup)
  )

  // 删除一个分享不回收对象（引用计数由清单派生，另一份仍引用同一对象）。
  await dedupReq(`/api/admin/${dedupA.body.code}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(
    objectFiles().length === objectsAfterFirst,
    '删除一个分享后对象仍保留（另一份清单仍引用 + GC 是唯一删除路径）',
    JSON.stringify({ before: objectsAfterFirst, now: objectFiles().length })
  )
  await dedupReq(`/api/admin/${dedupB.body.code}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } })
  dedupServer.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const dedupServer2 = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(DEDUP_PORT),
      ADMIN_KEY,
      DATA_DIR: DEDUP_DIR,
      CROSS_FILE_DEDUP: 'on',
      DEDUP_GC_GRACE_MS: '1',
      DEDUP_GC_INTERVAL_MS: '3600000',
      MAX_FILE_SIZE: '1048576',
      RATE_LIMIT_MISSES: '1000',
      UPLOAD_LIMIT_PER_MINUTE: '1000'
    }
  })
  dedupServer2.stdout.on('data', () => {})
  dedupServer2.stderr.on('data', () => {})
  const dedupAlive2 = await waitForServer(DEDUP_BASE)
  const gcHealth = await dedupReq('/api/health')
  assert(
    dedupAlive2 && gcHealth.body.dedup.objects === 0 && gcHealth.body.dedup.lastGcRemoved > 0,
    '全部引用消失后由启动 GC 回收孤儿对象（lastGcRemoved > 0，对象目录清空）',
    JSON.stringify(gcHealth.body.dedup)
  )
  dedupServer2.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
  fs.rmSync(DEDUP_DIR, { recursive: true, force: true })

  console.log('\n[39] 反馈与备案（合并自同事版的公开反馈 / 反馈号查询 / 管理回复 / 页脚备案）')
  {
    const healthFb = await req('/api/health')
    assert(
      ['feedback', 'beian', 'gongan'].every((f) => healthFb.body.features.includes(f)),
      '健康检查包含 feedback / beian / gongan 标记',
      JSON.stringify(healthFb.body.features)
    )

    const setInit = await req('/api/settings')
    assert(
      setInit.body.beian === '' && setInit.body.gongan === '',
      '默认无备案号（页脚不渲染备案行）',
      JSON.stringify(setInit.body)
    )

    const setBeian = await req('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ beian: '粤ICP备2024000000号', gongan: '粤公网安备 44030402000000号' })
    })
    assert(
      setBeian.res.status === 200 &&
        setBeian.body.settings.beian === '粤ICP备2024000000号' &&
        setBeian.body.settings.gongan === '粤公网安备 44030402000000号',
      '保存并公开回读备案号（页脚数据源）',
      JSON.stringify(setBeian.body.settings)
    )

    const setBeianLong = await req('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ beian: '备'.repeat(160) })
    })
    assert(
      setBeianLong.body.settings.beian.length === 100,
      '超长备案号截断为 100',
      String(setBeianLong.body.settings.beian.length)
    )

    const fbEmpty = await req('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bug', content: '   ' })
    })
    assert(fbEmpty.res.status === 400, '空内容提交反馈返回 400', `实际 ${fbEmpty.res.status}`)

    const fbBadType = await req('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'hacker', content: '非法类型应回退 other', contact: 'tester@example.com' })
    })
    assert(
      fbBadType.res.status === 201 && /^FB-\d{8}$/.test(fbBadType.body.code || ''),
      '提交反馈返回反馈号（FB- + 8 位数字）',
      JSON.stringify(fbBadType.body)
    )
    const fbId = fbBadType.body.id
    const fbCode = fbBadType.body.code
    assert(
      fs.existsSync(path.join(DATA_DIR, 'feedback', `${fbId}.json`)),
      '反馈以 data/feedback/<id>.json 落盘',
      fbId
    )

    const fbQuery = await req(`/api/feedback/query?code=${encodeURIComponent(fbCode)}`)
    assert(
      fbQuery.res.status === 200 &&
        fbQuery.body.code === fbCode &&
        fbQuery.body.type === 'other' &&
        fbQuery.body.status === 'pending' &&
        fbQuery.body.reply === '',
      '凭反馈号查询：待处理状态、内容可读、暂无回复',
      JSON.stringify(fbQuery.body)
    )

    const fbQueryLower = await req(`/api/feedback/query?code=${encodeURIComponent(fbCode.toLowerCase())}`)
    assert(fbQueryLower.res.status === 200, '反馈号大小写不敏感', `实际 ${fbQueryLower.res.status}`)

    const fbQueryBad = await req('/api/feedback/query?code=FB-123')
    assert(fbQueryBad.res.status === 400, '反馈号格式非法返回 400', `实际 ${fbQueryBad.res.status}`)

    const fbQueryMiss = await req('/api/feedback/query?code=FB-00000000')
    assert(fbQueryMiss.res.status === 404, '不存在的反馈号返回 404', `实际 ${fbQueryMiss.res.status}`)

    const fbListNoKey = await req('/api/admin/feedback')
    assert(fbListNoKey.res.status === 401, '无密钥读取反馈列表返回 401', `实际 ${fbListNoKey.res.status}`)

    const fbList = await req('/api/admin/feedback', { headers: { 'x-admin-key': ADMIN_KEY } })
    assert(
      fbList.res.status === 200 && fbList.body.list.some((item) => item.id === fbId),
      '管理端列表包含新提交的反馈',
      JSON.stringify(fbList.body.list.map((item) => item.id))
    )

    const fbStatusBad = await req(`/api/admin/feedback/${encodeURIComponent(fbId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ status: 'hacker' })
    })
    assert(fbStatusBad.res.status === 400, '非法状态返回 400', `实际 ${fbStatusBad.res.status}`)

    const fbDoneNoReply = await req(`/api/admin/feedback/${encodeURIComponent(fbId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ status: 'done' })
    })
    assert(
      fbDoneNoReply.res.status === 400 && /回复/.test(fbDoneNoReply.body.error || ''),
      '置为已完成必须填写回复内容',
      JSON.stringify(fbDoneNoReply.body)
    )

    const fbProcessing = await req(`/api/admin/feedback/${encodeURIComponent(fbId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ status: 'processing' })
    })
    assert(
      fbProcessing.res.status === 200 && fbProcessing.body.feedback.status === 'processing',
      '管理员可改为处理中',
      JSON.stringify(fbProcessing.body)
    )

    const fbDone = await req(`/api/admin/feedback/${encodeURIComponent(fbId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ status: 'done', reply: ' 已提交修复，下个版本发布 ' })
    })
    assert(
      fbDone.res.status === 200 &&
        fbDone.body.feedback.status === 'done' &&
        fbDone.body.feedback.reply === '已提交修复，下个版本发布',
      '管理员回复并置为已完成（回复去空白）',
      JSON.stringify(fbDone.body.feedback)
    )

    const fbQueryDone = await req(`/api/feedback/query?code=${encodeURIComponent(fbCode)}`)
    assert(
      fbQueryDone.res.status === 200 &&
        fbQueryDone.body.status === 'done' &&
        fbQueryDone.body.reply === '已提交修复，下个版本发布',
      '用户侧查询能看到官方回复',
      JSON.stringify(fbQueryDone.body)
    )

    const tpl0 = await req('/api/admin/feedback/templates', { headers: { 'x-admin-key': ADMIN_KEY } })
    assert(
      tpl0.res.status === 200 && Array.isArray(tpl0.body.templates) && tpl0.body.templates.length >= 1,
      '回复模板默认非空（开箱可用）',
      JSON.stringify(tpl0.body.templates)
    )

    const tplSave = await req('/api/admin/feedback/templates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ templates: ['模板一', '模板一', '  ', ' 模板二 '] })
    })
    assert(
      tplSave.res.status === 200 &&
        tplSave.body.templates.length === 2 &&
        tplSave.body.templates[0] === '模板一' &&
        tplSave.body.templates[1] === '模板二',
      '回复模板保存：去空、去重、去空白',
      JSON.stringify(tplSave.body.templates)
    )

    const tplCap = await req('/api/admin/feedback/templates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ templates: Array.from({ length: 30 }, (_, i) => `模板${i}`) })
    })
    assert(
      tplCap.body.templates.length === 20,
      '回复模板最多保留 20 条',
      String(tplCap.body.templates.length)
    )

    const fbDelete = await req(`/api/admin/feedback/${encodeURIComponent(fbId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
    assert(fbDelete.res.status === 200, '管理员删除反馈', `实际 ${fbDelete.res.status}`)

    const fbQueryDeleted = await req(`/api/feedback/query?code=${encodeURIComponent(fbCode)}`)
    assert(fbQueryDeleted.res.status === 404, '删除后凭反馈号查不到（404）', `实际 ${fbQueryDeleted.res.status}`)

    const fbDeleteTraverse = await req('/api/admin/feedback/..%2Fsettings', {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    })
    assert(
      fbDeleteTraverse.res.status === 400 || fbDeleteTraverse.res.status === 404,
      '反馈 ID 中的路径分隔符被拒绝（不越权删除其他文件）',
      `实际 ${fbDeleteTraverse.res.status}`
    )

    // 反馈号查询与取件码查询各自分桶：连续失败只耗尽 fbquery 桶，不影响正常取件。
    const fbSeed = await upload('分桶探针文件', { note: 'fbquery 分桶' }, 'bucket.txt')
    for (let i = 0; i < 4; i++) await req(`/api/feedback/query?code=FB-0000000${i}`)
    const infoAfterFbMiss = await req(`/api/info?code=${fbSeed.body.code}`)
    assert(
      infoAfterFbMiss.res.status === 200,
      '反馈号查询失败不挤占取件码失败桶（missGuard 按业务分桶）',
      `实际 ${infoAfterFbMiss.res.status}`
    )
  }

  console.log('\n[25] 失败限流（需最后执行：会占满本机 miss 桶 60s）')
  let limited = false
  for (let i = 0; i < 10; i++) {
    const r = await req('/api/info?code=000000')
    if (r.res.status === 429) {
      limited = true
      break
    }
  }
  assert(limited, '连续失败触发 429 限流')

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  server.kill('SIGTERM')
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})
