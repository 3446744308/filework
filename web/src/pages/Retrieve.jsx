import React, { useCallback, useEffect, useState } from 'react'
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
import { DownloadOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { formatBytes, formatTime, timeLeft } from '../utils.js'
import { useSettings, logoUrlOf } from '../hooks/useSettings.js'
import PickupWaybill from '../components/PickupWaybill.jsx'

const { Paragraph, Text } = Typography

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
              <Button
                type="primary"
                size="large"
                icon={<DownloadOutlined />}
                loading={downloading}
                onClick={download}
              >
                {info.hasPassword ? '验证密码并下载' : '下载文件'}
              </Button>
              <Text type="secondary" className="retrieve-tip">
                有效期至 {formatTime(info.expiresAt)} · 下载成功消耗 1 次，次数用尽或过期后文件自动销毁
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
    </div>
  )
}
