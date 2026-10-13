import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntApp,
  Button,
  Card,
  Collapse,
  Divider,
  Input,
  Modal,
  Progress,
  Result,
  Select,
  Space,
  Steps,
  Typography,
  Upload as AntUpload
} from 'antd'
import {
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileWordOutlined,
  FileZipOutlined,
  InboxOutlined,
  LinkOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import qrcode from 'qrcode-generator'
import { api } from '../api.js'
import { useSettings, logoUrlOf } from '../hooks/useSettings.js'
import WaybillReceipt from '../components/WaybillReceipt.jsx'
import { copyText, formatBytes, formatSpeed, formatTime, timeLeft } from '../utils.js'

const { Text, Paragraph } = Typography

function QrCode({ text }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const quiet = 4
    const count = qr.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }
    }
    return { size: count + quiet * 2, path: d }
  }, [text])

  return (
    <svg
      className="qr-svg"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="取件二维码"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

const EXPIRE_OPTIONS = [
  { value: 1, label: '1 小时' },
  { value: 24, label: '1 天' },
  { value: 72, label: '3 天' },
  { value: 168, label: '7 天' }
]

const COUNT_OPTIONS = [
  { value: 1, label: '1 次' },
  { value: 3, label: '3 次' },
  { value: 5, label: '5 次' },
  { value: 10, label: '10 次' }
]

const STEP_ITEMS = [
  { title: '上传文件' },
  { title: '填写收件信息' },
  { title: '发件回执' }
]

function fileIconOf(name) {
  const ext = (name || '').split('.').pop().toLowerCase()
  if (['doc', 'docx'].includes(ext)) return <FileWordOutlined />
  if (['xls', 'xlsx', 'csv'].includes(ext)) return <FileExcelOutlined />
  if (['ppt', 'pptx'].includes(ext)) return <FilePptOutlined />
  if (ext === 'pdf') return <FilePdfOutlined />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext))
    return <FileImageOutlined />
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <FileZipOutlined />
  return <FileOutlined />
}

function SelectedFileCard({ file, onRemove, disabled }) {
  return (
    <div className="selected-file">
      <div className="selected-file-head">
        <span className="selected-file-title">已选择文件（1）</span>
        <span className="selected-file-total">总大小：{formatBytes(file.size)}</span>
      </div>
      <div className="selected-file-item">
        <span className="selected-file-icon">{fileIconOf(file.name)}</span>
        <div className="selected-file-info">
          <div className="selected-file-name" title={file.name}>
            {file.name}
          </div>
          <div className="selected-file-size">{formatBytes(file.size)}</div>
        </div>
        {onRemove && (
          <Button
            type="text"
            danger
            className="selected-file-remove"
            icon={<DeleteOutlined />}
            disabled={disabled}
            onClick={onRemove}
          />
        )}
      </div>
    </div>
  )
}

export default function Upload() {
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  const settings = useSettings()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(null)
  const [fileList, setFileList] = useState([])
  const [expiresIn, setExpiresIn] = useState(24)
  const [maxDownloads, setMaxDownloads] = useState(5)
  const [note, setNote] = useState('')
  const [customCode, setCustomCode] = useState('')
  const [password, setPassword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, loaded: 0, total: 0, speed: 0 })
  const speedRef = useRef({ lastLoaded: 0, lastTime: 0, speed: 0 })
  const [result, setResult] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    api
      .notice()
      .then((n) => {
        if (n.enabled && n.content && n.display !== 'bar') setNotice(n)
      })
      .catch(() => {})
  }, [])

  const beforeUpload = (f) => {
    setFile(f)
    setFileList([{ uid: '-1', name: f.name, size: f.size, status: 'done' }])
    return false
  }

  const clearFile = () => {
    setFile(null)
    setFileList([])
  }

  const resetAll = () => {
    setResult(null)
    setStep(0)
    clearFile()
    setNote('')
    setCustomCode('')
    setPassword('')
    setExpiresIn(24)
    setMaxDownloads(5)
  }

  const handleProgress = ({ percent, loaded, total }) => {
    const s = speedRef.current
    const now = performance.now()
    if (!s.lastTime) {
      s.lastLoaded = loaded
      s.lastTime = now
    } else {
      const dt = (now - s.lastTime) / 1000
      if (dt >= 0.25 && loaded >= s.lastLoaded) {
        const instant = (loaded - s.lastLoaded) / dt
        s.speed = s.speed > 0 ? s.speed * 0.6 + instant * 0.4 : instant
        s.lastLoaded = loaded
        s.lastTime = now
      }
    }
    setProgress({ percent, loaded, total, speed: s.speed })
  }

  const doUpload = async (code) => {
    speedRef.current = { lastLoaded: 0, lastTime: 0, speed: 0 }
    setProgress({ percent: 0, loaded: 0, total: 0, speed: 0 })
    setUploading(true)
    try {
      const data = await api.upload(file, {
        expiresIn,
        maxDownloads,
        note: note.trim(),
        customCode: code,
        password: password.trim(),
        onProgress: handleProgress
      })
      setResult(data)
      setStep(2)
      clearFile()
      setNote('')
      setCustomCode('')
      setPassword('')
    } catch (err) {
      if (err.status === 409 && code) {
        setUploading(false)
        Modal.confirm({
          title: '取件码已被占用',
          content: `取件码 ${code} 已被其他分享使用。是否同意系统自动生成一个取件码继续发件？`,
          okText: '同意自动生成',
          cancelText: '返回修改',
          onOk: () => doUpload('')
        })
        return
      }
      message.error(err.message)
      setStep(1)
    } finally {
      setUploading(false)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      message.warning('请先选择文件')
      setStep(0)
      return
    }
    const limit = settings?.maxFileSize || 0
    if (limit && file.size > limit) {
      message.error(`文件超过大小限制（最大 ${formatBytes(limit)}）`)
      return
    }
    const dot = file.name.lastIndexOf('.')
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    const blocked = settings?.blockedExts || []
    if (ext && blocked.includes(ext)) {
      message.error(`禁止上传 .${ext} 类型的文件`)
      setStep(0)
      return
    }
    const code = customCode.trim()
    if (code && !/^\d{6}$/.test(code)) {
      message.warning('自定义取件码必须是 6 位数字')
      return
    }
    await doUpload(code)
  }

  const shareUrl = result ? `${window.location.origin}/d/${result.code}` : ''

  const copy = async (text, tip) => {
    const ok = await copyText(text)
    if (ok) message.success(tip)
    else message.warning('复制失败，请手动复制')
  }

  if (result) {
    const isWaybill = settings?.displayMode === 'waybill'
    const siteName = settings?.siteName || ''
    const logoUrl = logoUrlOf(settings)

    if (isWaybill) {
      return (
        <div className="page page-wide">
          <Card>
            <Steps current={2} items={STEP_ITEMS} className="upload-steps" />
            <Result
              className="upload-result waybill-result"
              status="success"
              title="发件成功"
              subTitle="您的文件已成功发出，请将以下面单交给对方作为发件凭证"
            >
              <WaybillReceipt
                info={result}
                shareUrl={shareUrl}
                siteName={siteName}
                logoUrl={logoUrl}
                onCopy={copy}
              />
            </Result>
            <div className="upload-result-actions">
              <Button type="primary" icon={<CloudUploadOutlined />} onClick={resetAll}>
                继续发件
              </Button>
              <Button onClick={() => navigate('/')}>返回首页</Button>
            </div>
          </Card>
        </div>
      )
    }

    return (
      <div className="page">
        <Card>
          <Steps current={2} items={STEP_ITEMS} className="upload-steps" />
          <Result
            className="upload-result"
            status="success"
            title="上传成功"
            subTitle="请把取件码或二维码告诉对方，对方无需登录即可取件"
            extra={
              <div className="result-hero">
                <div className="result-code-row">
                  <div className="code-display">{result.code}</div>
                  <div className="result-qr">
                    <div className="result-qr-box">
                      <QrCode text={shareUrl} />
                    </div>
                    <Text type="secondary" className="result-qr-caption">
                      扫码进入取件页
                    </Text>
                  </div>
                </div>
                <div className="result-share">
                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<CopyOutlined />}
                      onClick={() => copy(result.code, '取件码已复制')}
                    >
                      复制取件码
                    </Button>
                    <Button icon={<LinkOutlined />} onClick={() => copy(shareUrl, '链接已复制')}>
                      复制分享链接
                    </Button>
                  </Space>
                  <Text type="secondary" copyable={{ text: shareUrl }}>
                    {shareUrl}
                  </Text>
                </div>
              </div>
            }
          >
            <div className="result-details">
              <Space size="large" wrap style={{ justifyContent: 'center' }}>
                <Text>
                  文件：{result.filename}（{formatBytes(result.size)}）
                </Text>
                <Text>最多下载 {result.maxDownloads} 次</Text>
                <Text>
                  有效期至 {formatTime(result.expiresAt)}（剩余 {timeLeft(result.expiresAt)}）
                </Text>
              </Space>
              {result.note ? (
                <Text type="secondary" className="retrieve-tip">
                  备注：{result.note}
                </Text>
              ) : null}
              <Space wrap style={{ justifyContent: 'center' }}>
                <Button type="primary" icon={<CloudUploadOutlined />} onClick={resetAll}>
                  继续上传
                </Button>
                <Button icon={<DownloadOutlined />} onClick={() => navigate(`/d/${result.code}`)}>
                  去取件页看看
                </Button>
              </Space>
            </div>
          </Result>
        </Card>
      </div>
    )
  }

  return (
    <>
      <Modal
        open={!!notice}
        title={notice?.title || '公告'}
        width={480}
        centered
        onCancel={() => setNotice(null)}
        footer={
          <Button type="primary" onClick={() => setNotice(null)}>
            我知道了
          </Button>
        }
      >
        <div className="notice-content">{notice?.content}</div>
      </Modal>
      <div className="page">
        <Card>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            寄件 · 上传文件
          </Typography.Title>
          <Paragraph type="secondary">
            上传后获得 6 位取件码，对方无需登录，输入取件码即可下载。文件在有效期或次数耗尽后自动销毁。
          </Paragraph>

          <Steps current={step} items={STEP_ITEMS} className="upload-steps" />

          {step === 0 && (
            <>
              <AntUpload.Dragger
                accept="*/*"
                maxCount={1}
                fileList={fileList}
                beforeUpload={beforeUpload}
                showUploadList={false}
                disabled={uploading}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">点击或拖拽文件到此处上传</p>
                <p className="ant-upload-hint">
                  单个文件，最大{' '}
                  {settings?.maxFileSize ? formatBytes(settings.maxFileSize) : '100MB'}
                  （以服务端配置为准）
                </p>
              </AntUpload.Dragger>

              {file && <SelectedFileCard file={file} onRemove={clearFile} disabled={uploading} />}

              <Button
                type="primary"
                size="large"
                disabled={!file}
                onClick={() => setStep(1)}
                block
                style={{ marginTop: 20 }}
              >
                下一步：填写收件信息
              </Button>
            </>
          )}

          {step === 1 && (
            <>
              {file && <SelectedFileCard file={file} />}

              <div className="info-form">
                <div className="info-form-row">
                  <Text>取件码有效期：</Text>
                  <Select
                    value={expiresIn}
                    onChange={setExpiresIn}
                    options={EXPIRE_OPTIONS}
                    style={{ width: 130 }}
                    disabled={uploading}
                  />
                </div>
                <div className="info-form-row">
                  <Text>最大下载次数：</Text>
                  <Select
                    value={maxDownloads}
                    onChange={setMaxDownloads}
                    options={COUNT_OPTIONS}
                    style={{ width: 130 }}
                    disabled={uploading}
                  />
                </div>
                <div className="info-form-row info-form-row-col">
                  <Text type="secondary">文件备注（选填）：</Text>
                  <Input.TextArea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="可填写备注说明，收件人可在取件页看到"
                    maxLength={200}
                    showCount
                    rows={2}
                    disabled={uploading}
                  />
                </div>
                <Collapse
                  className="info-form-advanced"
                  items={[
                    {
                      key: 'advanced',
                      label: '高级设置',
                      children: (
                        <>
                          {settings?.customCodeEnabled !== false && (
                            <>
                              <div className="info-form-row">
                                <Text>自定义取件码：</Text>
                                <Input
                                  value={customCode}
                                  onChange={(e) =>
                                    setCustomCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                                  }
                                  placeholder="留空自动生成"
                                  maxLength={6}
                                  style={{ width: 130 }}
                                  disabled={uploading}
                                />
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  选填 · 6 位数字，若被占用将询问是否自动生成
                                </Text>
                              </div>
                              <Divider style={{ margin: '10px 0' }} />
                            </>
                          )}
                          <div className="info-form-row">
                            <Text>取件密码：</Text>
                            <Input.Password
                              value={password}
                              onChange={(e) => setPassword(e.target.value.slice(0, 64))}
                              placeholder="留空不设密码"
                              maxLength={64}
                              style={{ width: 200 }}
                              disabled={uploading}
                            />
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              选填 · 收件人取件时需输入此密码
                            </Text>
                          </div>
                        </>
                      )
                    }
                  ]}
                />
              </div>

              {uploading && (
                <div className="upload-progress">
                  <div className="upload-progress-info">
                    <span className="upload-progress-file" title={file?.name}>
                      {file?.name}
                    </span>
                    <span className="upload-progress-meta">
                      {formatSpeed(progress.speed)} · {formatBytes(progress.loaded)} /{' '}
                      {formatBytes(progress.total)}
                    </span>
                  </div>
                  <Progress percent={progress.percent} status="active" />
                </div>
              )}

              <div className="step-actions">
                <Button size="large" disabled={uploading} onClick={() => setStep(0)}>
                  上一步
                </Button>
                <Button
                  type="primary"
                  size="large"
                  icon={<CloudUploadOutlined />}
                  loading={uploading}
                  disabled={!file}
                  onClick={handleUpload}
                  style={{ flex: 1 }}
                >
                  {uploading ? '上传中…' : '确认发件'}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  )
}
