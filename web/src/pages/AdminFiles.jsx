import React, { useEffect, useMemo, useState } from 'react'
import { App as AntApp, Button, Card, Input, Popconfirm, Progress, Select, Space, Table, Tag, Typography } from 'antd'
import {
  ClearOutlined,
  CopyOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SearchOutlined
} from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout, useAuthorized } from '../hooks/useAdminAuth.js'
import AdminShell from '../components/AdminShell.jsx'
import { copyText, formatBytes, formatTime, timeLeft } from '../utils.js'

export default function AdminFiles() {
  const { message } = AntApp.useApp()
  const authorized = useAuthorized()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedKeys, setSelectedKeys] = useState([])

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
      const data = await api.adminList(getAdminKey())
      setList(data.list)
    } catch (err) {
      handleAuthError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!authorized) return
    loadList()
  }, [authorized])

  const remove = async (code) => {
    try {
      await api.adminDelete(code, getAdminKey())
      setList((prev) => prev.filter((item) => item.code !== code))
      setSelectedKeys((prev) => prev.filter((k) => k !== code))
      message.success(`已销毁 ${code}`)
    } catch (err) {
      handleAuthError(err)
    }
  }

  const batchRemove = async () => {
    const targets = [...selectedKeys]
    let done = 0
    for (const code of targets) {
      try {
        await api.adminDelete(code, getAdminKey())
        done++
      } catch (err) {
        if (err.status === 401) {
          handleAuthError(err)
          return
        }
        message.error(`${code}: ${err.message}`)
      }
    }
    setSelectedKeys([])
    message.success(`已删除 ${done} 个分享`)
    loadList()
  }

  const clearInvalid = async () => {
    try {
      const data = await api.adminClearExpired(getAdminKey())
      message.success(`已清空 ${data.removed} 条已失效记录`)
      setSelectedKeys([])
      loadList()
    } catch (err) {
      handleAuthError(err)
    }
  }

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return list.filter((item) => {
      if (statusFilter === 'active' && item.status !== 'active') return false
      if (statusFilter === 'invalid' && item.status === 'active') return false
      if (!q) return true
      return (
        item.code.includes(q) ||
        item.filename.toLowerCase().includes(q) ||
        (item.note || '').toLowerCase().includes(q)
      )
    })
  }, [list, keyword, statusFilter])

  const invalidCount = list.filter((item) => item.status !== 'active').length
  const activeCount = list.length - invalidCount

  const columns = [
    {
      title: '取件码',
      dataIndex: 'code',
      width: 130,
      render: (code) => (
        <Space>
          <Typography.Text strong>{code}</Typography.Text>
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={async () => {
              const ok = await copyText(`${window.location.origin}/d/${code}`)
              message[ok ? 'success' : 'warning'](ok ? '链接已复制' : '复制失败')
            }}
          />
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 92,
      render: (status) =>
        status === 'active' ? (
          <Tag color="success">生效中</Tag>
        ) : (
          <Tag color="default">已失效</Tag>
        )
    },
    {
      title: '文件名',
      dataIndex: 'filename',
      ellipsis: true,
      render: (name) => (
        <Typography.Text style={{ maxWidth: 220 }} ellipsis={{ tooltip: name }}>
          {name}
        </Typography.Text>
      )
    },
    {
      title: '备注',
      dataIndex: 'note',
      ellipsis: true,
      render: (note) =>
        note ? (
          <Typography.Text style={{ maxWidth: 180 }} ellipsis={{ tooltip: note }}>
            {note}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        )
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: 100,
      render: (size) => formatBytes(size)
    },
    {
      title: '下载进度',
      key: 'downloads',
      width: 140,
      render: (_, row) => (
        <Progress
          percent={Math.round((row.downloads / row.maxDownloads) * 100)}
          size="small"
          format={() => `${row.downloads}/${row.maxDownloads}`}
        />
      )
    },
    {
      title: '有效期至',
      dataIndex: 'expiresAt',
      width: 170,
      render: (ts, row) => (
        <div>
          <div>{formatTime(ts)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.status === 'active'
              ? `剩余 ${timeLeft(ts)}`
              : row.status === 'expired'
                ? '已过期'
                : '次数用尽'}
          </Typography.Text>
        </div>
      )
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      responsive: ['lg'],
      render: (ts) => formatTime(ts)
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_, row) => (
        <Popconfirm
          title={
            row.status === 'active'
              ? `销毁 ${row.code}？文件与记录将被删除`
              : `删除记录 ${row.code}？`
          }
          onConfirm={() => remove(row.code)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      )
    }
  ]

  return (
    <AdminShell>
      <Card>
        <div className="admin-toolbar">
          <Typography.Title level={4} style={{ margin: 0 }}>
            文件管理
            <Typography.Text type="secondary" style={{ fontSize: 14, marginLeft: 8, fontWeight: 400 }}>
              共 {filtered.length} 条 · 生效中 {activeCount} 条
            </Typography.Text>
          </Typography.Title>
          <Space wrap>
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 120 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '生效中' },
                { value: 'invalid', label: '已失效' }
              ]}
            />
            <Input
              placeholder="取件码 / 文件名 / 备注"
              allowClear
              prefix={<SearchOutlined />}
              style={{ width: 220 }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            {selectedKeys.length > 0 && (
              <Popconfirm
                title={`删除选中的 ${selectedKeys.length} 个分享？`}
                onConfirm={batchRemove}
              >
                <Button danger icon={<DeleteOutlined />}>
                  删除选中 {selectedKeys.length}
                </Button>
              </Popconfirm>
            )}
            {invalidCount > 0 && (
              <Popconfirm
                title={`清空 ${invalidCount} 条已失效记录？`}
                description="仅删除失效记录，生效中的分享不受影响"
                onConfirm={clearInvalid}
              >
                <Button danger icon={<ClearOutlined />}>
                  清空已失效
                </Button>
              </Popconfirm>
            )}
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadList}>
              刷新
            </Button>
          </Space>
        </div>

        <Table
          rowKey="code"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys)
          }}
          pagination={{
            defaultPageSize: 20,
            pageSizeOptions: [10, 20, 50, 100],
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`
          }}
          locale={{ emptyText: keyword || statusFilter !== 'all' ? '无匹配记录' : '暂无寄件记录' }}
          size="middle"
        />
      </Card>
    </AdminShell>
  )
}
