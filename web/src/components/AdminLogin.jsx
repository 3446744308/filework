import React, { useState } from 'react'
import { App as AntApp, Button, Input, Typography } from 'antd'
import {
  ClockCircleOutlined,
  KeyOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UserOutlined
} from '@ant-design/icons'

const HERO_FEATURES = [
  {
    icon: <UserOutlined />,
    title: '匿名免注册',
    desc: '上传与下载全程无需登录，凭取件码即可完成'
  },
  {
    icon: <KeyOutlined />,
    title: '6 位取件码',
    desc: '类快递柜体验，把取件码告诉对方就能取件'
  },
  {
    icon: <ClockCircleOutlined />,
    title: '自动销毁',
    desc: '有效期或下载次数耗尽，文件立即物理删除'
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '安全可控',
    desc: '防暴力破解限流，仪表盘与公告集中管控'
  }
]

export default function AdminLogin({ onLogin, checking }) {
  const { message } = AntApp.useApp()
  const [keyInput, setKeyInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const key = keyInput.trim()
    if (!key) {
      message.warning('请输入管理密钥')
      return
    }
    setSubmitting(true)
    try {
      await onLogin(key)
    } catch (err) {
      message.error(err.status === 401 ? '管理密钥错误，请重试' : err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const loading = checking || submitting

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-hero">
          <div className="hero-brand">文件驿站 · FILE SHARE</div>
          <div className="hero-title">
            像取快递一样
            <br />
            分享文件
          </div>
          <div className="hero-sub">匿名、安全、即用即走的文件中转站</div>
          <ul className="hero-features">
            {HERO_FEATURES.map((f) => (
              <li className="hero-feature" key={f.title}>
                <span className="hero-icon">{f.icon}</span>
                <span>
                  <span className="hero-feature-title">{f.title}</span>
                  <span className="hero-feature-desc">{f.desc}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="hero-foot">登录后可查看仪表盘、管理文件与配置首页公告</div>
        </div>

        <div className="login-form">
          <Typography.Title level={4} className="login-form-title">
            管理入口
          </Typography.Title>
          <Typography.Text type="secondary" className="login-form-tip">
            请输入服务端配置的管理密钥
          </Typography.Text>
          <Input.Password
            size="large"
            prefix={<LockOutlined />}
            placeholder="管理密钥"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onPressEnter={submit}
            allowClear
          />
          <Button
            type="primary"
            size="large"
            block
            icon={<SearchOutlined />}
            className="login-btn"
            loading={loading}
            onClick={submit}
          >
            进入管理后台
          </Button>
          <div className="login-hint">密钥在服务端 .env 的 ADMIN_KEY 中配置</div>
        </div>
      </div>
    </div>
  )
}
