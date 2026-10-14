import React, { useEffect, useMemo, useState } from 'react'
import {
  App as AntApp,
  Button,
  Card,
  Input,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import {
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

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (item) =>
        item.code.includes(q) ||
        item.filename.toLowerCase().includes(q) ||
        (item.note || '').toLowerCase().includes(q)
    )
  }, [list, keyword])

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
      title: '文件名',
      dataIndex: 'filename',
      ellipsis: true,
      render: (name, row) => (
        <Space size={4}>
          <Typography.Text style={{ maxWidth: 220 }} ellipsis={{ tooltip: name }}>
            {name}
          </Typography.Text>
          {row.compressionState === 'pending' && <Tag color="processing">压缩中</Tag>}
          {row.crossHashed && <Tag color="blue">跨文件去重</Tag>}
        </Space>
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
      title: '传输节省',
      key: 'transfer',
      width: 150,
      responsive: ['xl'],
      render: (_, row) => {
        const transfer = row.transfer || {}
        if (!transfer.originalBytes) return <Typography.Text type="secondary">—</Typography.Text>
        return (
          <div>
            <div>{formatBytes(transfer.savedBytes || 0)}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              线上 {formatBytes(transfer.wireBytes || 0)} / {formatBytes(transfer.originalBytes)}
            </Typography.Text>
          </div>
        )
      }
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
      render: (ts) => (
        <div>
          <div>{formatTime(ts)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            剩余 {timeLeft(ts)}
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
        <Popconfirm title={`销毁 ${row.code}？`} onConfirm={() => remove(row.code)}>
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
              共 {filtered.length} 个
            </Typography.Text>
          </Typography.Title>
          <Space wrap>
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
          locale={{ emptyText: keyword ? '无匹配分享' : '暂无有效分享' }}
          size="middle"
        />
      </Card>
    </AdminShell>
  )
}
