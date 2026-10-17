import React, { useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Input, Popconfirm, Space, Typography, Upload } from 'antd'
import { CopyOutlined, DeleteOutlined, UploadOutlined } from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout } from '../hooks/useAdminAuth.js'
import { copyText, formatBytes, formatTime } from '../utils.js'
import AdminShell from '../components/AdminShell.jsx'

const APP_SLOTS = [
  {
    type: 'android',
    title: '移动端（Android）',
    desc: '上传打包好的 Android 安装包（.apk），供用户在手机端下载安装。'
  },
  {
    type: 'desktop',
    title: '桌面端（PC）',
    desc: '上传打包好的桌面端安装包（.exe / .msi / .dmg 等），供用户在电脑上下载安装。'
  }
]

export default function AdminApps() {
  const { message } = AntApp.useApp()
  const [apps, setApps] = useState(null)
  const [appUploading, setAppUploading] = useState('')

  const handleAuthError = (err) => {
    if (err.status === 401) {
      message.error('管理密钥已失效，请重新登录')
      logout()
    } else {
      message.error(err.message)
    }
  }

  useEffect(() => {
    api
      .apps()
      .then(setApps)
      .catch(() => {})
  }, [])

  const uploadAppFile = async (type, file) => {
    setAppUploading(type)
    try {
      await api.uploadApp(type, file, getAdminKey())
      message.success(`${type === 'android' ? '移动端' : '桌面端'}安装包已上传`)
      setApps(await api.apps())
    } catch (err) {
      handleAuthError(err)
    } finally {
      setAppUploading('')
    }
  }

  const removeAppFile = async (type) => {
    try {
      await api.removeApp(type, getAdminKey())
      message.success('安装包已删除')
      setApps(await api.apps())
    } catch (err) {
      handleAuthError(err)
    }
  }

  const appUrlOf = (type) => {
    const item = apps && apps[type]
    return item ? `${window.location.origin}${item.url}` : ''
  }

  const copyAppUrl = async (type) => {
    const ok = await copyText(appUrlOf(type))
    if (ok) message.success('直链已复制')
    else message.error('复制失败，请手动复制')
  }

  return (
    <AdminShell>
      <Card title="APP 设置">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {APP_SLOTS.map((slot) => {
            const item = apps && apps[slot.type]
            return (
              <div key={slot.type}>
                <Typography.Title level={5}>{slot.title}</Typography.Title>
                <Space wrap align="center">
                  <Upload
                    showUploadList={false}
                    beforeUpload={(file) => {
                      uploadAppFile(slot.type, file)
                      return false
                    }}
                  >
                    <Button icon={<UploadOutlined />} loading={appUploading === slot.type}>
                      {item ? '更换安装包' : '上传安装包'}
                    </Button>
                  </Upload>
                  {item && (
                    <Popconfirm
                      title="删除当前安装包？"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => removeAppFile(slot.type)}
                    >
                      <Button danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {slot.desc}
                </Typography.Paragraph>
                {item ? (
                  <div style={{ marginTop: 12 }}>
                    <Typography.Paragraph style={{ marginBottom: 8 }}>
                      {item.filename} · {formatBytes(item.size)} · {formatTime(item.uploadedAt)} 上传
                    </Typography.Paragraph>
                    <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
                      <Input readOnly value={appUrlOf(slot.type)} />
                      <Button icon={<CopyOutlined />} onClick={() => copyAppUrl(slot.type)}>
                        复制直链
                      </Button>
                    </Space.Compact>
                    <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                      永久有效的下载直链，可直接分发给用户。
                    </Typography.Paragraph>
                  </div>
                ) : (
                  <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                    暂未上传；上传后将生成永久有效的下载直链。
                  </Typography.Paragraph>
                )}
              </div>
            )
          })}
        </Space>
      </Card>
    </AdminShell>
  )
}
