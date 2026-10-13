import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function uploadForm(content, fields = {}) {
  const form = new FormData()
  form.append('file', new Blob([content]), '测试文件.txt')
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  return form
}

async function upload(content, fields = {}) {
  const { res, body } = await req('/api/upload', { method: 'POST', body: uploadForm(content, fields) })
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
      UPLOAD_LIMIT_PER_MINUTE: '1000'
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

  console.log('\n[7] 统计仪表盘')
  const sNoKey = await req('/api/admin/stats')
  assert(sNoKey.res.status === 401, '无密钥查看统计返回 401', `实际 ${sNoKey.res.status}`)

  const s0 = await req('/api/admin/stats', { headers: { 'x-admin-key': ADMIN_KEY } })
  assert(s0.res.status === 200 && typeof s0.body.fileCount === 'number', '统计接口可用', JSON.stringify(s0.body))

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

  console.log('\n[8] 失败限流')
  let limited = false
  for (let i = 0; i < 10; i++) {
    const r = await req('/api/info?code=000000')
    if (r.res.status === 429) {
      limited = true
      break
    }
  }
  assert(limited, '连续失败触发 429 限流')

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

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  server.kill('SIGTERM')
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})
