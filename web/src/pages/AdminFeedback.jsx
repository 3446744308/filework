import React, { useEffect, useMemo, useState } from 'react'
import { App as AntApp, Button, Card, Descriptions, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout, useAuthorized } from '../hooks/useAdminAuth.js'
import AdminShell from '../components/AdminShell.jsx'
import { formatTime } from '../utils.js'

const TYPE_LABELS = { bug: '问题反馈', feature: '功能建议', other: '其他' }
const TYPE_COLORS = { bug: 'red', feature: 'blue', other: 'default' }
const STATUS_OPTIONS = [
  { value: 'pending', label: '等待中' },
  { value: 'processing', label: '处理中' },
  { value: 'done', label: '已完成' }
]
const STATUS_FILTER_OPTIONS = [{ value: 'all', label: '全部状态' }, ...STATUS_OPTIONS]
const STATUS_META = {
  pending: { label: '等待中', color: 'orange' },
  processing: { label: '处理中', color: 'blue' },
  done: { label: '已完成', color: 'green' }
}

export default function AdminFeedback() {
  const { message } = AntApp.useApp()
  const authorized = useAuthorized()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')

  const handleAuthError = (err) => {
    if (err.status === 401) {
      message.error('管理密钥已失效，请重新登录')
      logout()
      return true
    }
    message.error(err.message)
    return false
  }

  const loadList = async () => {
    setLoading(true)
    try {
      const data = await api.adminFeedbackList(getAdminKey())
      setList(data.list)
    } catch (err) {
      handleAuthError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authorized) loadList()
  }, [authorized])

  const changeStatus = async (id, status) => {
    try {
      const data = await api.adminFeedbackStatus(id, status, getAdminKey())
      setList((prev) => prev.map((item) => (item.id === id ? data.feedback : item)))
      setDetail((prev) => (prev && prev.id === id ? data.feedback : prev))
      message.success('状态已更新')
    } catch (err) {
      handleAuthError(err)
    }
  }

  const remove = async (id) => {
    try {
      await api.adminFeedbackDelete(id, getAdminKey())
      setList((prev) => prev.filter((item) => item.id !== id))
      message.success('反馈已删除')
    } catch (err) {
      handleAuthError(err)
    }
  }

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return list
    return list.filter((item) => item.status === statusFilter)
  }, [list, statusFilter])

  const columns = [
    {
      title: '反馈号',
      dataIndex: 'code',
      width: 110,
      render: (c) => c || <Typography.Text type="secondary">—</Typography.Text>
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (t) => formatTime(t)
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t) => <Tag color={TYPE_COLORS[t] || 'default'}>{TYPE_LABELS[t] || t}</Tag>
    },
    {
      title: '联系方式',
      dataIndex: 'contact',
      width: 160,
      ellipsis: true,
      render: (c) => c || <Typography.Text type="secondary">未留</Typography.Text>
    },
    {
      title: '内容',
      dataIndex: 'content',
      ellipsis: true,
      render: (c) => (
        <Typography.Text style={{ maxWidth: 360 }} ellipsis={{ tooltip: c }}>
          {c}
        </Typography.Text>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (status) => (
        <Tag color={STATUS_META[status]?.color || 'default'}>
          {STATUS_META[status]?.label || status}
        </Tag>
      )
    },
    {
      title: '操作',
      width: 240,
      render: (_, item) => (
        <Space>
          <Select
            size="small"
            value={item.status}
            style={{ width: 100 }}
            options={STATUS_OPTIONS}
            onChange={(v) => changeStatus(item.id, v)}
          />
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(item)}>
            详情
          </Button>
          <Popconfirm title="删除这条反馈？" okText="删除" cancelText="取消" onConfirm={() => remove(item.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <AdminShell>
      <Card
        title="反馈管理"
        extra={
          <Space>
            <Select
              value={statusFilter}
              style={{ width: 120 }}
              options={STATUS_FILTER_OPTIONS}
              onChange={setStatusFilter}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadList}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 960 }}
        />
      </Card>
      <Modal
        title="反馈详情"
        open={Boolean(detail)}
        footer={null}
        width={640}
        onCancel={() => setDetail(null)}
      >
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="反馈 ID">{detail.id}</Descriptions.Item>
          {detail.code && <Descriptions.Item label="反馈号">{detail.code}</Descriptions.Item>}
            <Descriptions.Item label="提交时间">{formatTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{formatTime(detail.updatedAt)}</Descriptions.Item>
            <Descriptions.Item label="类型">
              <Tag color={TYPE_COLORS[detail.type] || 'default'}>
                {TYPE_LABELS[detail.type] || detail.type}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="联系方式">
              {detail.contact || <Typography.Text type="secondary">未留</Typography.Text>}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status]?.color || 'default'}>
                {STATUS_META[detail.status]?.label || detail.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="反馈内容">
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, maxHeight: 360, overflow: 'auto' }}>
                {detail.content}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </AdminShell>
  )
}
