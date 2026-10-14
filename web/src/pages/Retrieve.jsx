import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Progress,
  Result,
  Spin,
  Typography
} from 'antd'
import { DownloadOutlined, HomeOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { parallelDownload } from '../downloader.js'
import { formatBytes, formatSpeed, formatTime, timeLeft } from '../utils.js'
import { useSettings, logoUrlOf } from '../hooks/useSettings.js'
import PickupWaybill from '../components/PickupWaybill.jsx'

const { Paragraph, Text } = Typography

const PARALLEL_MIN_SIZE = 1024 * 1024

export default function Retrieve() {
  const { code: routeCode } = useParams()
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const settings = useSettings()
  const [input, setInput] = useState(routeCode || '')
  const codeRef = useRef(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [dlProgress, setDlProgress] = useState({
    percent: 0,
    loaded: 0,
    total: 0,
    speed: 0,
    wire: 0,
    codec: ''
  })
  const speedRef = useRef({ lastLoaded: 0, lastTime: 0, speed: 0 })
  const resumedRef = useRef(false)
  const [password, setPassword] = useState('')

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
  }, [routeCode, load])

  useEffect(() => {
    if (!routeCode) codeRef.current?.focus()
  }, [routeCode])

  const focusCodeInput = () => {
    setInput('')
    codeRef.current?.focus()
  }

  const submit = (codeArg) => {
    const code = (typeof codeArg === 'string' ? codeArg : input).trim()
    if (!/^\d{6}$/.test(code)) {
      message.warning('请输入 6 位数字取件码')
      return
    }
    navigate(`/d/${code}`)
  }

  const handleDlProgress = ({ percent, loaded, total, wire = 0, codec = '', resumed = false }) => {
    if (resumed && !resumedRef.current) {
      resumedRef.current = true
      message.info('已续用上次未完成的下载会话（不重复消耗次数）')
    }
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
    setDlProgress({ percent, loaded, total, speed: s.speed, wire, codec })
  }

  const download = async () => {
    if (!info) return
    if (info.hasPassword && !password.trim()) {
      message.warning('请输入取件密码')
      return
    }
    if (info.size > PARALLEL_MIN_SIZE) {
      setDownloading(true)
      speedRef.current = { lastLoaded: 0, lastTime: 0, speed: 0 }
      resumedRef.current = false
      setDlProgress({ percent: 0, loaded: 0, total: info.size, speed: 0, wire: 0, codec: '' })
      try {
        await parallelDownload({
          code: info.code,
          password: info.hasPassword ? password.trim() : '',
          filename: info.filename,
          onProgress: handleDlProgress
        })
        message.success('下载完成')
      } catch (err) {
        if (err.name === 'AbortError') message.info('已取消下载')
        else message.error(err.message)
      } finally {
        setDownloading(false)
        await load(info.code)
      }
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
      message.error(err.message)
      await load(info.code)
    } finally {
      setTimeout(() => setDownloading(false), 1000)
    }
  }

  const remaining =
    info && info.maxDownloads > 0 ? Math.max(info.maxDownloads - info.downloads, 0) : 0
  const isWaybill = settings?.displayMode === 'waybill'
  const showWaybill = isWaybill && Boolean(info)
  const shareUrl = info ? `${window.location.origin}/d/${info.code}` : ''
  const showDlProgress = downloading && Boolean(info) && info.size > PARALLEL_MIN_SIZE
  const transferSaved =
    dlProgress.loaded > 0 && dlProgress.wire > 0
      ? Math.max(0, Math.round((1 - dlProgress.wire / dlProgress.loaded) * 100))
      : 0
  const dlProgressBlock = showDlProgress ? (
    <div className="download-progress">
      <Progress percent={dlProgress.percent} status="active" />
      <Text type="secondary">
        {formatSpeed(dlProgress.speed)} · {formatBytes(dlProgress.loaded)} /{' '}
        {formatBytes(dlProgress.total)}
      </Text>
      {transferSaved > 0 ? (
        <Text type="secondary">
          传输压缩 {dlProgress.codec === 'br' ? 'brotli' : dlProgress.codec} · 线上{' '}
          {formatBytes(dlProgress.wire)} · 已省 {transferSaved}%（浏览器自动解压）
        </Text>
      ) : null}
    </div>
  ) : null

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
            <div
              className="retrieve-form"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit()
              }}
            >
              <Input.OTP
                ref={codeRef}
                length={6}
                size="large"
                value={input}
                autoFocus={!routeCode}
                formatter={(str) => str.toUpperCase()}
                onInput={(cells) => {
                  const next = cells.map((c) => c || ' ').join('')
                  setInput(next)
                  if (/^\d{6}$/.test(next)) submit(next)
                }}
              />
              <div className="retrieve-form-actions">
                <Button type="primary" size="large" icon={<SearchOutlined />} block onClick={() => submit()}>
                  查询
                </Button>
              </div>
              <Text type="secondary" className="retrieve-tip">
                输入 6 位数字取件码，填满后自动查询
              </Text>
            </div>
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
              <Button type="primary" onClick={focusCodeInput}>
                重新输入取件码
              </Button>
              <Button icon={<HomeOutlined />} onClick={() => navigate('/')}>
                返回首页
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && info && showWaybill && (
          <>
            <PickupWaybill
              info={info}
              shareUrl={shareUrl}
              siteName={settings?.siteName || ''}
              logoUrl={logoUrlOf(settings)}
              downloading={downloading}
              password={password}
              onPasswordChange={setPassword}
              onDownload={download}
              onChangeCode={() => navigate('/d')}
              onGoHome={() => navigate('/')}
            />
            {dlProgressBlock}
          </>
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
              <Button
                type="primary"
                size="large"
                icon={<DownloadOutlined />}
                loading={downloading}
                onClick={download}
              >
                {info.hasPassword ? '验证密码并下载' : '下载文件'}
              </Button>
              {dlProgressBlock}
              <Text type="secondary" className="retrieve-tip">
                有效期至 {formatTime(info.expiresAt)} · 下载成功消耗 1 次，次数用尽或过期后文件自动销毁
              </Text>
              <Button type="link" size="small" onClick={focusCodeInput}>
                换个取件码
              </Button>
              <Button type="link" size="small" icon={<HomeOutlined />} onClick={() => navigate('/')}>
                返回首页
              </Button>
            </div>
          </Result>
        )}

        {!loading && !error && !info && (
          <div className="retrieve-body">
            <div className="retrieve-center">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="在上方输入 6 位取件码开始取件"
              />
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
