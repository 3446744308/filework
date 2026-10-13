import React, { useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Col, Input, Radio, Row, Space, Statistic, Switch, Typography } from 'antd'
import {
  CloudUploadOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  FileOutlined,
  ReloadOutlined,
  SaveOutlined
} from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout, useAuthorized } from '../hooks/useAdminAuth.js'
import AdminShell from '../components/AdminShell.jsx'
import { formatBytes } from '../utils.js'

export default function Admin() {
  const { message } = AntApp.useApp()
  const authorized = useAuthorized()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [noticeForm, setNoticeForm] = useState({
    enabled: false,
    title: '',
    content: '',
    display: 'modal'
  })
  const [noticeLoading, setNoticeLoading] = useState(false)
  const [noticeSaving, setNoticeSaving] = useState(false)

  const handleAuthError = (err) => {
    if (err.status === 401) {
      message.error('管理密钥已失效，请重新登录')
      logout()
    } else {
      message.error(err.message)
    }
  }

  const loadStats = async () => {
    setLoading(true)
    try {
      setStats(await api.adminStats(getAdminKey()))
    } catch (err) {
      handleAuthError(err)
    } finally {
      setLoading(false)
    }
  }

  const loadNotice = async () => {
    setNoticeLoading(true)
    try {
      const n = await api.notice()
      setNoticeForm({
        enabled: Boolean(n.enabled),
        title: n.title || '',
        content: n.content || '',
        display: n.display || 'modal'
      })
    } catch (err) {
      handleAuthError(err)
    } finally {
      setNoticeLoading(false)
    }
  }

  useEffect(() => {
    if (!authorized) return
    loadStats()
    loadNotice()
  }, [authorized])

  const saveNotice = async () => {
    if (noticeForm.enabled && !noticeForm.content.trim()) {
      message.warning('请先填写公告内容')
      return
    }
    setNoticeSaving(true)
    try {
      const data = await api.saveNotice(noticeForm, getAdminKey())
      setNoticeForm({
        enabled: data.notice.enabled,
        title: data.notice.title,
        content: data.notice.content,
        display: data.notice.display
      })
      message.success('公告已保存')
    } catch (err) {
      handleAuthError(err)
    } finally {
      setNoticeSaving(false)
    }
  }

  const dashboard = [
    {
      title: '有效文件',
      value: stats ? stats.fileCount : '-',
      unit: '个',
      icon: <FileOutlined />,
      color: '#1677ff'
    },
    {
      title: '总大小',
      value: stats ? formatBytes(stats.totalSize) : '-',
      icon: <DatabaseOutlined />,
      color: '#52c41a'
    },
    {
      title: '累计下载',
      value: stats ? stats.totalDownloads : '-',
      unit: '次',
      icon: <DownloadOutlined />,
      color: '#fa8c16'
    },
    {
      title: '累计上传',
      value: stats ? stats.totalUploads : '-',
      unit: '个',
      icon: <CloudUploadOutlined />,
      color: '#722ed1'
    }
  ]

  return (
    <AdminShell>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {dashboard.map((item) => (
          <Col xs={12} md={6} key={item.title}>
            <Card styles={{ body: { padding: 20 } }} style={{ height: '100%' }}>
              <Statistic
                title={item.title}
                value={item.value}
                suffix={item.unit}
                prefix={<span style={{ color: item.color }}>{item.icon}</span>}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title="公告设置"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadStats} loading={loading}>
              刷新统计
            </Button>
            <Button icon={<ReloadOutlined />} onClick={loadNotice} loading={noticeLoading}>
              重置
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Switch
              checked={noticeForm.enabled}
              onChange={(checked) => setNoticeForm((f) => ({ ...f, enabled: checked }))}
              checkedChildren="开启"
              unCheckedChildren="关闭"
            />
            <Typography.Text type="secondary">
              开启后，访客进入首页会自动弹出此公告
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>显示方式：</Typography.Text>
            <Radio.Group
              value={noticeForm.display}
              onChange={(e) => setNoticeForm((f) => ({ ...f, display: e.target.value }))}
              optionType="button"
              options={[
                { label: '弹窗', value: 'modal' },
                { label: '顶部公告条', value: 'bar' },
                { label: '弹窗 + 公告条', value: 'both' }
              ]}
            />
          </Space>
          <Input
            placeholder="公告标题（可选，默认显示“公告”）"
            maxLength={100}
            showCount
            value={noticeForm.title}
            onChange={(e) => setNoticeForm((f) => ({ ...f, title: e.target.value }))}
          />
          <Input.TextArea
            rows={4}
            maxLength={2000}
            showCount
            placeholder="公告内容（填写内容后才可开启，支持换行）"
            value={noticeForm.content}
            onChange={(e) => setNoticeForm((f) => ({ ...f, content: e.target.value }))}
          />
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={noticeSaving}
            onClick={saveNotice}
          >
            保存公告
          </Button>
        </Space>
      </Card>
    </AdminShell>
  )
}
