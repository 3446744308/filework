import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Result,
  Spin,
  Typography
} from 'antd'
import { DownloadOutlined, EyeOutlined } from '@ant-design/icons'
import Plyr from 'plyr'
import 'plyr/dist/plyr.css'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { formatBytes, formatTime, previewKind, timeLeft } from '../utils.js'
import { useSettings, logoUrlOf } from '../hooks/useSettings.js'
import PickupWaybill from '../components/PickupWaybill.jsx'

const { Paragraph, Text } = Typography

const PLYR_OPTIONS = {
  controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
  settings: ['speed'],
  speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
  i18n: {
    restart: '重新播放',
    rewind: '快退 {seektime} 秒',
    play: '播放',
    pause: '暂停',
    fastForward: '快进 {seektime} 秒',
    seek: '进度',
    seekLabel: '{currentTime} / {duration}',
    played: '已播放',
    buffered: '已缓冲',
    currentTime: '当前时间',
    duration: '总时长',
    volume: '音量',
    mute: '静音',
    unmute: '取消静音',
    download: '下载',
    enterFullscreen: '进入全屏',
    exitFullscreen: '退出全屏',
    frameTitle: '{title} 播放器',
    settings: '设置',
    menuBack: '返回',
    speed: '倍速',
    normal: '正常',
    quality: '清晰度',
    loop: '循环',
    start: '开始',
    end: '结束',
    all: '全部',
    reset: '重置',
    disabled: '关闭',
    enabled: '开启'
  }
}

export default function Retrieve() {
  const { code: routeCode } = useParams()
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const settings = useSettings()
  const [input, setInput] = useState(routeCode || '')
  const [modalOpen, setModalOpen] = useState(false)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [password, setPassword] = useState('')
  const [previewData, setPreviewData] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const playerRef = useRef(null)

  const attachVideo = useCallback((node) => {
    if (playerRef.current) {
      playerRef.current.destroy()
      playerRef.current = null
    }
    if (node) playerRef.current = new Plyr(node, PLYR_OPTIONS)
  }, [])

  const load = useCallback(async (code) => {
    if (!code) {
      setInfo(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setInfo(null)
    setPassword('')
    try {
      const data = await api.info(code)
      setInfo(data)
    } catch (err) {
      setError(
        err.status === 429
          ? { text: err.message, type: 'warning' }
          : { text: err.message, type: 'error' }
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setInput(routeCode || '')
    load(routeCode)
    if (!routeCode) setModalOpen(true)
  }, [routeCode, load])

  useEffect(() => {
    return () => {
      if (previewData?.url) URL.revokeObjectURL(previewData.url)
    }
  }, [previewData])

  const openModal = () => {
    setInput('')
    setModalOpen(true)
  }

  const submit = (codeArg) => {
    const code = (typeof codeArg === 'string' ? codeArg : input).trim()
    if (!/^\d{6}$/.test(code)) {
      message.warning('请输入 6 位数字取件码')
      return
    }
    setModalOpen(false)
    navigate(`/d/${code}`)
  }

  const download = async () => {
    if (!info) return
    if (info.hasPassword && !password.trim()) {
      message.warning('请输入取件密码')
      return
    }
    setDownloading(true)
    try {
      await api.info(info.code)
      if (info.hasPassword) {
        await api.verifyPassword(info.code, password.trim())
      }
      window.location.href = api.downloadUrl(info.code, info.hasPassword ? password.trim() : '')
    } catch (err) {
      if (err.status === 403) message.error(err.message)
      else message.error(err.message)
      await load(info.code)
    } finally {
      setTimeout(() => setDownloading(false), 1000)
    }
  }

  const remaining =
    info && info.maxDownloads > 0 ? Math.max(info.maxDownloads - info.downloads, 0) : 0
  const previewAllowed = settings?.previewEnabled !== false
  const previewKindNow = previewAllowed && info ? previewKind(info.mime, info.filename, info.size) : null
  const textLines = useMemo(
    () => (previewData?.kind === 'text' && previewData.text != null ? previewData.text.split('\n') : []),
    [previewData]
  )

  const confirmPreview = () => {
    if (!info || !previewKindNow) return
    if (info.hasPassword && !password.trim()) {
      message.warning('请输入取件密码')
      return
    }
    Modal.confirm({
      title: '预览将消耗 1 次下载次数',
      content: `文件「${info.filename}」（${formatBytes(info.size)}），当前剩余 ${remaining} 次，确定预览？`,
      okText: '开始预览',
      cancelText: '取消',
      onOk: doPreview
    })
  }

  const doPreview = async () => {
    if (!info) return
    setPreviewing(true)
    try {
      if (info.hasPassword) await api.verifyPassword(info.code, password.trim())
      const blob = await api.preview(info.code, info.hasPassword ? password.trim() : '')
      const kind = previewKind(info.mime, info.filename, info.size)
      const url = URL.createObjectURL(blob)
      const text = kind === 'text' ? await blob.text() : null
      setPreviewData({ kind, url, text })
      const fresh = await api.info(info.code)
      setInfo(fresh)
    } catch (err) {
      message.error(err.message)
      if (err.status === 404 || err.status === 403) await load(info.code)
    } finally {
      setPreviewing(false)
    }
  }

  const closePreview = () => setPreviewData(null)

  const isWaybill = settings?.displayMode === 'waybill'
  const showWaybill = isWaybill && Boolean(info)
  const shareUrl = info ? `${window.location.origin}/d/${info.code}` : ''

  return (
    <div className={showWaybill ? 'page page-wide' : 'page'}>
      <Card>
        {!showWaybill && (
          <>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              取件 · 下载文件
            </Typography.Title>
            <Paragraph type="secondary">
              输入 6 位取件码即可下载文件，无需登录；文件在有效期或下载次数耗尽后自动销毁。
            </Paragraph>
          </>
        )}

        {loading && (
          <div className="retrieve-body">
            <div className="retrieve-center">
              <Spin />
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="retrieve-body">
            <div className="retrieve-center">
              <Alert type={error.type} showIcon message={error.text} />
              <Button type="primary" onClick={openModal}>
                重新输入取件码
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && info && showWaybill && (
          <PickupWaybill
            info={info}
            shareUrl={shareUrl}
            siteName={settings?.siteName || ''}
            logoUrl={logoUrlOf(settings)}
            downloading={downloading}
            password={password}
            onPasswordChange={setPassword}
            onDownload={download}
            previewKind={previewKindNow}
            previewing={previewing}
            onPreview={confirmPreview}
            onChangeCode={openModal}
          />
        )}

        {!loading && !error && info && !isWaybill && (
          <Result
            className="retrieve-result"
            status="success"
            title="文件已就绪"
            subTitle={info.filename}
            extra={
              <div className="result-hero">
                <div className="stat-row">
                  <div className="stat-item">
                    <div className="stat-label">文件大小</div>
                    <div className="stat-value">{formatBytes(info.size)}</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-label">剩余下载</div>
                    <div className="stat-value">
                      {remaining} / {info.maxDownloads} 次
                    </div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-label">有效期</div>
                    <div className="stat-value">剩余 {timeLeft(info.expiresAt)}</div>
                  </div>
                </div>
              </div>
            }
          >
            <div className="result-details">
              {info.note ? (
                <Text type="secondary" className="retrieve-tip">
                  备注：{info.note}
                </Text>
              ) : null}
              {info.hasPassword && (
                <div className="retrieve-password">
                  <Text type="secondary">该文件已设置取件密码：</Text>
                  <Input.Password
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入取件密码"
                    maxLength={64}
                    style={{ width: 240 }}
                    onPressEnter={download}
                  />
                </div>
              )}
              <div className="retrieve-actions">
                <Button
                  type="primary"
                  size="large"
                  icon={<DownloadOutlined />}
                  loading={downloading}
                  onClick={download}
                >
                  {info.hasPassword ? '验证密码并下载' : '下载文件'}
                </Button>
                {previewKindNow && (
                  <Button
                    size="large"
                    icon={<EyeOutlined />}
                    loading={previewing}
                    onClick={confirmPreview}
                  >
                    预览文件
                  </Button>
                )}
              </div>
              <Text type="secondary" className="retrieve-tip">
                有效期至 {formatTime(info.expiresAt)} · 下载或预览每次消耗 1 次次数，次数用尽或过期后文件自动销毁
              </Text>
              <Button type="link" size="small" onClick={openModal}>
                换个取件码
              </Button>
            </div>
          </Result>
        )}

        {!loading && !error && !info && (
          <div className="retrieve-body">
            <div className="retrieve-center">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="请输入取件码开始取件"
                extra={
                  <Button type="primary" onClick={openModal}>
                    输入取件码
                  </Button>
                }
              />
            </div>
          </div>
        )}
      </Card>

      <Modal
        title="输入取件码"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => submit()}
        okText="确定"
        cancelText="取消"
        width={420}
        destroyOnHidden
      >
        <div
          className="retrieve-form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit()
          }}
        >
          <Input.OTP
            className="code-input"
            length={6}
            size="large"
            value={input}
            autoFocus
            formatter={(str) => str.toUpperCase()}
            onInput={(cells) => {
              const next = cells.map((c) => c || ' ').join('')
              setInput(next)
              if (/^\d{6}$/.test(next)) submit(next)
            }}
          />
          <Text type="secondary" className="retrieve-tip">
            输入 6 位数字取件码，填满后自动查询
          </Text>
        </div>
      </Modal>

      <Modal
        title={info ? `预览 · ${info.filename}` : '预览'}
        open={Boolean(previewData)}
        onCancel={closePreview}
        footer={null}
        width={previewData?.kind === 'text' ? 880 : 760}
        destroyOnHidden
      >
        {previewData?.kind === 'image' && (
          <img className="preview-image" src={previewData.url} alt={info?.filename || '预览'} />
        )}
        {previewData?.kind === 'video' && (
          <div className="preview-video-wrap">
            <video ref={attachVideo} className="preview-video" src={previewData.url} playsInline />
          </div>
        )}
        {previewData?.kind === 'text' && (
          <div className="preview-text-wrap">
            <div className="preview-text-head">
              <span className="preview-text-dots">
                <i className="preview-dot preview-dot-r" />
                <i className="preview-dot preview-dot-y" />
                <i className="preview-dot preview-dot-g" />
              </span>
              <span className="preview-text-name">{info?.filename}</span>
              <span className="preview-text-meta">
                {textLines.length} 行 · {formatBytes(info?.size)}
              </span>
            </div>
            {textLines.length <= 5000 ? (
              <div className="preview-text preview-text-lines">
                {textLines.map((line, i) => (
                  <div className="preview-line" key={i}>
                    <span className="preview-line-no">{i + 1}</span>
                    <span className="preview-line-text">{line === '' ? ' ' : line}</span>
                  </div>
                ))}
              </div>
            ) : (
              <pre className="preview-text preview-text-plain">{previewData.text}</pre>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
