import React, { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  App as AntApp,
  Button,
  Card,
  Col,
  ColorPicker,
  DatePicker,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ClearOutlined,
  CloudUploadOutlined,
  CompressOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout, useAuthorized } from '../hooks/useAdminAuth.js'
import AdminShell from '../components/AdminShell.jsx'
import { NoticeBarView } from '../components/NoticeBar.jsx'
import { formatBytes, formatTime } from '../utils.js'

const DISPLAY_OPTIONS = [
  { label: '弹窗', value: 'modal' },
  { label: '公告条', value: 'bar' },
  { label: '弹窗 + 公告条', value: 'both' }
]
const POSITION_OPTIONS = [
  { label: '顶部', value: 'top' },
  { label: '底部', value: 'bottom' },
  { label: '悬浮顶部', value: 'fixed-top' },
  { label: '悬浮底部', value: 'fixed-bottom' }
]
const SCROLL_OPTIONS = [
  { label: '不滚动', value: 'none' },
  { label: '右→左', value: 'left' },
  { label: '左→右', value: 'right' },
  { label: '纵向上', value: 'up' },
  { label: '纵向往返', value: 'bounce' }
]

function optionLabel(options, value) {
  const found = options.find((item) => item.value === value)
  return found ? found.label : value
}

const BOTTOM_SLOT = ['bottom', 'fixed-bottom']

function slotOf(position) {
  return BOTTOM_SLOT.includes(position) ? 'bottom' : 'top'
}

// 表单携带条目级 rev（并发乐观锁）：回传自己读到的版本，服务端不一致时返回 409。
function noticeToForm(notice, rev) {
  const source = notice || {}
  const version = Math.floor(Number(rev))
  const startAt = Number(source.startAt)
  const endAt = Number(source.endAt)
  return {
    id: source.id || '',
    enabled: Boolean(source.enabled),
    title: source.title || '',
    content: source.content || '',
    display: source.display || 'modal',
    position: source.position || 'top',
    scroll: source.scroll || 'left',
    scrollFill: Boolean(source.scrollFill),
    bgColor: source.bgColor || '',
    textColor: source.textColor || '',
    fontSize: Number.isFinite(Number(source.fontSize)) ? Number(source.fontSize) : 0,
    radius: Number.isFinite(Number(source.radius)) ? Number(source.radius) : 0,
    opacity: Number.isFinite(Number(source.opacity)) ? Number(source.opacity) : 0,
    maxLines: [1, 2, 3].includes(Math.round(Number(source.maxLines)))
      ? Math.round(Number(source.maxLines))
      : 1,
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 50,
    startAt: Number.isFinite(startAt) && startAt > 0 ? startAt : null,
    endAt: Number.isFinite(endAt) && endAt > 0 ? endAt : null,
    rev: Number.isFinite(version) && version > 0 ? version : 1
  }
}

const emptyNoticeForm = () => noticeToForm({}, 0)

function noticeWindowText(entry) {
  if (!entry.startAt && !entry.endAt) return '不限时间'
  return `${entry.startAt ? formatTime(entry.startAt) : '立即'} ~ ${entry.endAt ? formatTime(entry.endAt) : '不限'}`
}

function noticeStatusOf(entry, now = Date.now()) {
  if (!entry.enabled || !entry.content) return { text: '已停用', color: 'default' }
  if (entry.startAt && now < entry.startAt) return { text: '未到生效时间', color: 'blue' }
  if (entry.endAt && now >= entry.endAt) return { text: '已过期', color: 'red' }
  return { text: '生效中', color: 'green' }
}

function presetSummary(notice) {
  return [
    optionLabel(DISPLAY_OPTIONS, notice.display),
    optionLabel(POSITION_OPTIONS, notice.position),
    optionLabel(SCROLL_OPTIONS, notice.scroll),
    notice.scrollFill ? '自动填满滚动' : null,
    notice.bgColor ? `底色 ${notice.bgColor}` : '默认底色',
    notice.textColor ? `字色 ${notice.textColor}` : '默认字色',
    Number(notice.fontSize) > 0 ? `字号 ${notice.fontSize}px` : null,
    Number(notice.radius) > 0 ? `圆角 ${notice.radius}px` : null,
    Number(notice.opacity) > 0 ? `不透明 ${notice.opacity}%` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function Admin() {
  const { message } = AntApp.useApp()
  const authorized = useAuthorized()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [notices, setNotices] = useState([])
  const [noticesRev, setNoticesRev] = useState(1)
  const [noticeLimit, setNoticeLimit] = useState(20)
  const [noticeForm, setNoticeForm] = useState(emptyNoticeForm)
  const [noticeLoading, setNoticeLoading] = useState(false)
  const [noticeSaving, setNoticeSaving] = useState(false)
  const [noticeBusy, setNoticeBusy] = useState('')
  const [presets, setPresets] = useState([])
  const [presetLimit, setPresetLimit] = useState(10)
  const [presetName, setPresetName] = useState('')
  const [presetGroup, setPresetGroup] = useState('')
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetBusy, setPresetBusy] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState('')
  const [previewMetrics, setPreviewMetrics] = useState(null)
  const importInputRef = useRef(null)
  const importModeRef = useRef('merge')

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

  // prefill：首次进入管理端时把最高优先级的公告载入表单（与旧版「直接编辑当前公告」行为一致）；
  // 其余刷新（保存/切换/删除后）不覆盖用户正在编辑的内容。
  const loadNotices = async ({ prefill = false } = {}) => {
    setNoticeLoading(true)
    try {
      const data = await api.adminNotices(getAdminKey())
      const list = data.notices || []
      setNotices(list)
      setNoticesRev(Number.isFinite(Number(data.rev)) ? Number(data.rev) : 1)
      setNoticeLimit(Number.isFinite(Number(data.limit)) ? Number(data.limit) : 20)
      if (prefill && list.length > 0) setNoticeForm(noticeToForm(list[0], list[0].rev))
    } catch (err) {
      handleAuthError(err)
    } finally {
      setNoticeLoading(false)
    }
  }

  const loadPresets = async () => {
    try {
      const data = await api.noticePresets(getAdminKey())
      setPresets(data.presets || [])
      setPresetLimit(data.limit || 10)
    } catch (err) {
      handleAuthError(err)
    }
  }

  useEffect(() => {
    if (!authorized) return
    loadStats()
    loadNotices({ prefill: true })
    loadPresets()
  }, [authorized])

  const formPayload = () => ({ ...noticeForm, enabled: Boolean(noticeForm.enabled) })

  // 达上限时不再禁用按钮，而是弹「选择要替换的预设」（服务端零改动：先删后建）。
  const savePreset = async ({ replaceId } = {}) => {
    setPresetSaving(true)
    try {
      const payload = { name: presetName.trim(), group: presetGroup.trim(), notice: formPayload() }
      if (replaceId) await api.deleteNoticePreset(replaceId, getAdminKey())
      await api.createNoticePreset(payload, getAdminKey())
      setPresetName('')
      setReplaceOpen(false)
      setReplaceTarget('')
      await loadPresets()
      message.success(replaceId ? '已替换所选预设' : '已保存预设')
    } catch (err) {
      if (err.status === 409) {
        if (replaceId) {
          message.warning('所选预设已被其他管理端修改，请重新选择')
          await loadPresets()
        } else {
          setReplaceOpen(true)
          message.warning('预设数量已达上限，请选择要替换的预设')
        }
      } else {
        handleAuthError(err)
      }
    } finally {
      setPresetSaving(false)
    }
  }

  const applyPresetToForm = (preset) => {
    setNoticeForm((f) => ({ ...noticeToForm(preset.notice, f.rev), id: f.id }))
    setPresetName(preset.name)
    message.success(`已套用「${preset.name}」，确认后点保存公告生效`)
  }

  const movePreset = async (preset, delta) => {
    const ids = presets.map((item) => item.id)
    const index = ids.indexOf(preset.id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= ids.length) return
    const next = [...ids]
    ;[next[index], next[target]] = [next[target], next[index]]
    setPresetBusy(preset.id)
    try {
      const data = await api.reorderNoticePresets(next, getAdminKey())
      setPresets(data.presets || [])
    } catch (err) {
      handleAuthError(err)
    } finally {
      setPresetBusy('')
    }
  }

  const exportPresets = async () => {
    try {
      const blob = await api.exportNoticePresets(getAdminKey())
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `notice-presets-${dayjs().format('YYYYMMDD-HHmmss')}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      message.success('预设已导出')
    } catch (err) {
      handleAuthError(err)
    }
  }

  const pickImportFile = (mode) => {
    importModeRef.current = mode
    const input = importInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onImportFile = async (event) => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const payload = Array.isArray(parsed) ? { presets: parsed } : parsed
      const data = await api.importNoticePresets(
        { ...payload, mode: importModeRef.current },
        getAdminKey()
      )
      setPresets(data.presets || [])
      if (data.limit) setPresetLimit(data.limit)
      message.success(
        `导入完成：新增 ${data.imported} 个${data.skipped ? `，${data.skipped} 个因超出上限被跳过` : ''}`
      )
    } catch (err) {
      if (err instanceof SyntaxError) message.error('导入失败：文件不是有效的 JSON')
      else handleAuthError(err)
    }
  }

  const overwritePreset = async (preset) => {
    setPresetBusy(preset.id)
    try {
      await api.updateNoticePreset(
        preset.id,
        { group: preset.group || '', notice: formPayload(), rev: preset.rev },
        getAdminKey()
      )
      await loadPresets()
      message.success(`已用当前表单覆盖「${preset.name}」`)
    } catch (err) {
      if (err.status === 409) {
        message.warning(err.message)
        await loadPresets()
      } else {
        handleAuthError(err)
      }
    } finally {
      setPresetBusy('')
    }
  }

  const activatePreset = async (preset) => {
    setPresetBusy(preset.id)
    try {
      const target = noticeForm.id || 'default'
      const data = await api.applyNoticePreset(preset.id, getAdminKey(), noticesRev, target)
      setNoticeForm(noticeToForm(data.notice, data.notice.rev))
      await loadNotices()
      await loadPresets()
      message.success(`「${preset.name}」已启用为当前公告`)
    } catch (err) {
      handleAuthError(err)
    } finally {
      setPresetBusy('')
    }
  }

  const removePreset = async (preset) => {
    setPresetBusy(preset.id)
    try {
      await api.deleteNoticePreset(preset.id, getAdminKey())
      await loadPresets()
      message.success(`已删除「${preset.name}」`)
    } catch (err) {
      handleAuthError(err)
    } finally {
      setPresetBusy('')
    }
  }

  const saveNotice = async () => {
    if (noticeForm.enabled && !noticeForm.content.trim()) {
      message.warning('请先填写公告内容')
      return
    }
    setNoticeSaving(true)
    try {
      const payload = formPayload()
      const data = noticeForm.id
        ? await api.updateNotice(noticeForm.id, { ...payload, rev: noticeForm.rev }, getAdminKey())
        : await api.createNotice(payload, getAdminKey())
      setNoticeForm(noticeToForm(data.notice, data.notice.rev))
      await loadNotices()
      message.success('公告已保存')
    } catch (err) {
      if (err.status === 409) {
        message.warning(err.message)
        await loadNotices()
      } else {
        handleAuthError(err)
      }
    } finally {
      setNoticeSaving(false)
    }
  }

  const newNotice = () => {
    setNoticeForm(emptyNoticeForm())
  }

  const editNotice = (entry) => {
    setNoticeForm(noticeToForm(entry, entry.rev))
  }

  const writeNotice = async (entry, patch, success) => {
    setNoticeBusy(entry.id)
    try {
      const data = await api.updateNotice(
        entry.id,
        { ...entry, ...patch, rev: entry.rev },
        getAdminKey()
      )
      await loadNotices()
      setNoticeForm((f) => (f.id === entry.id ? noticeToForm(data.notice, data.notice.rev) : f))
      if (success) message.success(success)
    } catch (err) {
      if (err.status === 409) {
        message.warning(err.message)
        await loadNotices()
      } else {
        handleAuthError(err)
      }
    } finally {
      setNoticeBusy('')
    }
  }

  const toggleNotice = (entry) => writeNotice(entry, { enabled: !entry.enabled })

  const moveNotice = (entry, delta) => {
    const next = Math.max(0, Math.min(100, (Number(entry.priority) || 0) + delta))
    if (next === entry.priority) return
    writeNotice(entry, { priority: next })
  }

  const removeNotice = async (entry) => {
    setNoticeBusy(entry.id)
    try {
      await api.deleteNotice(entry.id, getAdminKey())
      if (noticeForm.id === entry.id) setNoticeForm(emptyNoticeForm())
      await loadNotices()
      message.success('公告已删除')
    } catch (err) {
      handleAuthError(err)
    } finally {
      setNoticeBusy('')
    }
  }

  const exportTransfer = async () => {
    setExporting(true)
    try {
      const blob = await api.exportTransferStats(getAdminKey())
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `transfer-stats-${dayjs().format('YYYYMMDD-HHmmss')}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      message.success('传输明细已导出')
    } catch (err) {
      handleAuthError(err)
    } finally {
      setExporting(false)
    }
  }

  const resetTransfer = async () => {
    setResetting(true)
    try {
      await api.resetTransferStats(getAdminKey())
      message.success('传输统计已清零')
      await loadStats()
    } catch (err) {
      handleAuthError(err)
    } finally {
      setResetting(false)
    }
  }

  // 分组只影响展示：按全局 order 升序遍历，按分组首次出现顺序聚合（未分组紧随其出现位置）。
  const presetGroups = []
  for (const preset of presets) {
    const key = preset.group || ''
    let bucket = presetGroups.find((item) => item.key === key)
    if (!bucket) {
      bucket = { key, items: [] }
      presetGroups.push(bucket)
    }
    bucket.items.push({ preset, index: presets.indexOf(preset) })
  }

  const quota = stats && stats.sessionQuota ? stats.sessionQuota : null
  const quotaLimits = {
    upload: quota ? quota.maxUploadSessionsPerIp : 0,
    download: quota ? quota.maxDownloadSessionsPerIp : 0,
    tmp: quota ? quota.maxTmpBytesPerIp : 0
  }
  const quotaRows = quota && Array.isArray(quota.topIps) ? quota.topIps : []
  const ratioText = (value, limit, text) =>
    limit > 0 && value / limit >= 0.8 ? <Typography.Text type="danger">{text}</Typography.Text> : text
  const quotaColumns = [
    { title: '出口 IP', dataIndex: 'ip', render: (value) => value || '（未知 / 旧会话）' },
    {
      title: '上传会话',
      dataIndex: 'uploadSessions',
      width: 120,
      render: (value) => ratioText(value, quotaLimits.upload, `${value} / ${quotaLimits.upload}`)
    },
    {
      title: '下载会话',
      dataIndex: 'downloadSessions',
      width: 120,
      render: (value) => ratioText(value, quotaLimits.download, `${value} / ${quotaLimits.download}`)
    },
    {
      title: '待处理临时空间',
      dataIndex: 'tmpBytes',
      width: 220,
      render: (value) =>
        ratioText(value, quotaLimits.tmp, `${formatBytes(value)} / ${formatBytes(quotaLimits.tmp)}`)
    }
  ]

  const transferOriginal = stats ? stats.transferOriginalBytes || 0 : 0
  const transferSaved = stats ? stats.transferSavedBytes || 0 : 0
  const transferPercent = transferOriginal > 0 ? Math.round((transferSaved / transferOriginal) * 100) : 0
  const transferToday = stats && stats.transferToday ? stats.transferToday : null
  const transferDayColumns = [
    { title: '日期', dataIndex: 'date', width: 130 },
    { title: '原始字节', dataIndex: 'originalBytes', width: 120, render: (value) => formatBytes(value) },
    { title: '线上字节', dataIndex: 'wireBytes', width: 120, render: (value) => formatBytes(value) },
    { title: '节省', dataIndex: 'savedBytes', width: 120, render: (value) => formatBytes(value) },
    {
      title: '省比例',
      key: 'percent',
      render: (_, row) =>
        row.originalBytes > 0 ? `${Math.round((row.savedBytes / row.originalBytes) * 100)}%` : '—'
    }
  ]

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
    },
    {
      title: '实际占用',
      value: stats ? formatBytes(stats.totalStoredSize ?? stats.totalSize) : '-',
      icon: <DatabaseOutlined />,
      color: '#13c2c2'
    },
    {
      title: '压缩节省',
      value: stats ? formatBytes(stats.savedBytes ?? 0) : '-',
      icon: <CompressOutlined />,
      color: '#eb2f96'
    },
    {
      title: '传输节省',
      value: stats ? formatBytes(transferSaved) : '-',
      icon: <ThunderboltOutlined />,
      color: '#fa541c',
      desc: stats ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            {`线上 ${formatBytes(stats.transferWireBytes ?? 0)} / 原始 ${formatBytes(transferOriginal)}${
              transferOriginal > 0 ? ` · 省 ${transferPercent}%` : ''
            }`}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            {transferToday && transferToday.originalBytes > 0
              ? `今日 ${formatBytes(transferToday.savedBytes)}（线上 ${formatBytes(transferToday.wireBytes)} / 原始 ${formatBytes(transferToday.originalBytes)}）`
              : '今日暂无传输'}
          </Typography.Text>
        </>
      ) : null
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
              {item.desc && <div style={{ marginTop: 4 }}>{item.desc}</div>}
            </Card>
          </Col>
        ))}
      </Row>

      <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 16, fontSize: 12 }}>
        {'传输节省按分片下载链路累计（大于 1MB 的文件与浏览器并行下载），同一会话内重复取片只计一次；单流导航下载与浏览器实际落盘字节不计入。按日明细保留最近 30 天，按文件明细随分享销毁一并清理。导出 CSV 为全量归档（30 天 + 全部文件条目）；清零会重置累计传输节省并清空全部明细，不影响上传/下载次数。'}
      </Typography.Paragraph>

      <Card
        title="近 7 日传输节省"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button icon={<DownloadOutlined />} loading={exporting} onClick={exportTransfer}>
              导出 CSV
            </Button>
            <Popconfirm
              title="清零传输统计？"
              description="将重置累计传输节省并清空按日/按文件明细，不影响上传/下载次数；建议先导出归档。此操作不可撤销。"
              okText="确认清零"
              okButtonProps={{ danger: true }}
              onConfirm={resetTransfer}
            >
              <Button danger icon={<ClearOutlined />} loading={resetting}>
                清零
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="date"
          pagination={false}
          columns={transferDayColumns}
          dataSource={stats && Array.isArray(stats.transferDays) ? stats.transferDays : []}
          locale={{ emptyText: '暂无传输记录' }}
        />
        {stats && stats.transferResetAt > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`上次清零：${formatTime(stats.transferResetAt)}（第 ${stats.transferResetCount} 次），此后重新累计`}
          </Typography.Text>
        )}
      </Card>

      <Card title="会话配额" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {`上限：上传会话 ${quotaLimits.upload} 个 / 下载会话 ${quotaLimits.download} 个 / 待处理临时空间 ${formatBytes(
              quotaLimits.tmp
            )}（同一出口（NAT）下多个用户共享配额；带 uploadId 的续传不占新名额）`}
          </Typography.Text>
          <Table
            size="small"
            rowKey="ip"
            pagination={false}
            columns={quotaColumns}
            dataSource={quotaRows}
            locale={{ emptyText: '当前没有在途会话' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            出现 429「同时上传/下载的任务过多」时先看这里：用量达到上限 80% 的行会标红，即受影响出口；会话完成或过期后名额即时释放。
          </Typography.Text>
        </Space>
      </Card>

      <Card
        title="公告设置"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadStats} loading={loading}>
              刷新统计
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                loadNotices()
                setNoticeForm(emptyNoticeForm())
              }}
              loading={noticeLoading}
            >
              重置
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text strong>公告列表（{notices.length}/{noticeLimit}）</Typography.Text>
            <Button className="notice-add" size="small" icon={<PlusOutlined />} onClick={newNotice}>
              新建公告
            </Button>
            <Typography.Text type="secondary">
              同一槽位（上/下）只显示优先级最高的一条；时间窗为「生效时间 ≤ 现在 &lt; 失效时间」，到点自动上下线
            </Typography.Text>
          </Space>
          {notices.length === 0 && (
            <Typography.Text type="secondary">暂无公告，点「新建公告」开始</Typography.Text>
          )}
          {notices.map((entry) => {
            const status = noticeStatusOf(entry)
            return (
              <Space key={entry.id} wrap className="notice-row">
                <Tag color={status.color}>{status.text}</Tag>
                <Button
                  size="small"
                  aria-label="提高优先级"
                  icon={<ArrowUpOutlined />}
                  disabled={noticeBusy === entry.id || Number(entry.priority) >= 100}
                  onClick={() => moveNotice(entry, 10)}
                />
                <Button
                  size="small"
                  aria-label="降低优先级"
                  icon={<ArrowDownOutlined />}
                  disabled={noticeBusy === entry.id || Number(entry.priority) <= 0}
                  onClick={() => moveNotice(entry, -10)}
                />
                <Typography.Text strong>{entry.title || '（无标题）'}</Typography.Text>
                <Typography.Text type="secondary">{`优先级 ${entry.priority} · ${optionLabel(
                  DISPLAY_OPTIONS,
                  entry.display
                )} · ${optionLabel(POSITION_OPTIONS, entry.position)}（${slotOf(entry.position)} 槽）`}</Typography.Text>
                <Typography.Text type="secondary" className="notice-window">
                  {noticeWindowText(entry)}
                </Typography.Text>
                <Typography.Text type="secondary">{`v${entry.rev}`}</Typography.Text>
                <Button
                  size="small"
                  className="notice-edit"
                  disabled={noticeBusy === entry.id}
                  onClick={() => editNotice(entry)}
                >
                  编辑
                </Button>
                <Switch
                  size="small"
                  checkedChildren="开"
                  unCheckedChildren="关"
                  aria-label="切换启用状态"
                  checked={Boolean(entry.enabled)}
                  disabled={noticeBusy === entry.id}
                  onChange={() => toggleNotice(entry)}
                />
                <Popconfirm
                  title={`删除公告「${entry.title || '（无标题）'}」？`}
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => removeNotice(entry)}
                >
                  <Button
                    size="small"
                    danger
                    aria-label="删除公告"
                    icon={<DeleteOutlined />}
                    disabled={noticeBusy === entry.id}
                  />
                </Popconfirm>
              </Space>
            )
          })}
          <Divider style={{ margin: '4px 0' }}>
            {noticeForm.id ? `编辑公告：${noticeForm.title || noticeForm.id}` : '新建公告'}
          </Divider>
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
              options={DISPLAY_OPTIONS}
            />
          </Space>
          <Space wrap>
            <Typography.Text>公告条位置：</Typography.Text>
            <Radio.Group
              value={noticeForm.position}
              onChange={(e) => setNoticeForm((f) => ({ ...f, position: e.target.value }))}
              optionType="button"
              options={POSITION_OPTIONS}
            />
          </Space>
          <Space wrap>
            <Typography.Text>滚动方式：</Typography.Text>
            <Radio.Group
              value={noticeForm.scroll}
              onChange={(e) => setNoticeForm((f) => ({ ...f, scroll: e.target.value }))}
              optionType="button"
              options={SCROLL_OPTIONS}
            />
          </Space>
          <Space wrap>
            <Typography.Text>内容不足时：</Typography.Text>
            <Switch
              className="notice-scroll-fill"
              checked={Boolean(noticeForm.scrollFill)}
              onChange={(checked) => setNoticeForm((f) => ({ ...f, scrollFill: checked }))}
              checkedChildren="自动填满滚动"
              unCheckedChildren="不滚动"
            />
            <Typography.Text type="secondary">
              关闭（默认）：内容未超出可视宽度就不滚；开启：内容不足时自动重复填满整条持续滚动。仅对横向滚动方式生效，纵向仍需 ≥2 行
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>优先级：</Typography.Text>
            <InputNumber
              min={0}
              max={100}
              value={noticeForm.priority}
              onChange={(value) =>
                setNoticeForm((f) => ({
                  ...f,
                  priority: Number.isFinite(Number(value)) ? Number(value) : 50
                }))
              }
            />
            <Typography.Text type="secondary">0~100，越大越优先；同槽位只下发最高优先级的一条</Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>生效时间：</Typography.Text>
            <DatePicker.RangePicker
              className="notice-window-picker"
              showTime
              allowEmpty={[true, true]}
              value={[
                noticeForm.startAt ? dayjs(noticeForm.startAt) : null,
                noticeForm.endAt ? dayjs(noticeForm.endAt) : null
              ]}
              onChange={(range) =>
                setNoticeForm((f) => ({
                  ...f,
                  startAt: range && range[0] ? range[0].valueOf() : null,
                  endAt: range && range[1] ? range[1].valueOf() : null
                }))
              }
            />
            <Typography.Text type="secondary">留空 = 立即生效 / 不限失效</Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>背景色：</Typography.Text>
            <ColorPicker
              value={noticeForm.bgColor || null}
              allowClear
              showText
              onChange={(value) =>
                setNoticeForm((f) => ({ ...f, bgColor: value ? value.toHexString() : '' }))
              }
              onClear={() => setNoticeForm((f) => ({ ...f, bgColor: '' }))}
            />
            <Typography.Text>文字色：</Typography.Text>
            <ColorPicker
              value={noticeForm.textColor || null}
              allowClear
              showText
              onChange={(value) =>
                setNoticeForm((f) => ({ ...f, textColor: value ? value.toHexString() : '' }))
              }
              onClear={() => setNoticeForm((f) => ({ ...f, textColor: '' }))}
            />
            <Typography.Text type="secondary">
              不选则跟随默认主题；位置与滚动仅对公告条生效，配色同时作用于公告条与弹窗
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>纵向行数：</Typography.Text>
            <Radio.Group
              value={noticeForm.maxLines}
              onChange={(e) => setNoticeForm((f) => ({ ...f, maxLines: Number(e.target.value) }))}
              optionType="button"
              options={[1, 2, 3].map((value) => ({ label: `${value} 行`, value }))}
            />
            <Typography.Text type="secondary">
              仅对纵向滚动生效：显示到第 N 行后开始滚动（超出才滚，与「内容不足时」开关无关）
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text>字号：</Typography.Text>
            <InputNumber
              className="notice-font-size"
              min={12}
              max={24}
              value={noticeForm.fontSize > 0 ? noticeForm.fontSize : null}
              placeholder="默认"
              onChange={(value) =>
                setNoticeForm((f) => ({ ...f, fontSize: Number.isFinite(Number(value)) ? Number(value) : 0 }))
              }
            />
            <Typography.Text>圆角：</Typography.Text>
            <InputNumber
              className="notice-radius"
              min={0}
              max={16}
              value={noticeForm.radius > 0 ? noticeForm.radius : null}
              placeholder="默认"
              onChange={(value) =>
                setNoticeForm((f) => ({ ...f, radius: Number.isFinite(Number(value)) ? Number(value) : 0 }))
              }
            />
            <Typography.Text>不透明度：</Typography.Text>
            <InputNumber
              className="notice-opacity"
              min={50}
              max={100}
              value={noticeForm.opacity > 0 ? noticeForm.opacity : null}
              placeholder="默认"
              onChange={(value) =>
                setNoticeForm((f) => ({ ...f, opacity: Number.isFinite(Number(value)) ? Number(value) : 0 }))
              }
            />
            <Typography.Text type="secondary">
              留空 = 跟随默认主题（字号 12~24px / 圆角 0~16px / 不透明度 50~100%）
            </Typography.Text>
          </Space>
          <div className="notice-preview-wrap">
            <div className="notice-preview-bar">
              <NoticeBarView notice={noticeForm} preview onMetrics={setPreviewMetrics} />
            </div>
            <Typography.Text type="secondary">
              实时预览：{previewMetrics ? previewMetrics.reason : '—'}
            </Typography.Text>
          </div>
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
          <Divider style={{ margin: '4px 0' }}>
            公告预设（{presets.length}/{presetLimit}，上限可在站点设置中调整）
          </Divider>
          <Space wrap>
            <Input
              placeholder="预设名称（可留空，默认取公告标题）"
              maxLength={50}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              style={{ width: 260 }}
            />
            <Input
              className="notice-preset-group"
              placeholder="分组（可选，≤20 字）"
              maxLength={20}
              value={presetGroup}
              onChange={(e) => setPresetGroup(e.target.value)}
              style={{ width: 180 }}
            />
            <Button
              icon={<SaveOutlined />}
              loading={presetSaving}
              onClick={() => savePreset()}
            >
              保存为预设
            </Button>
            <Button
              className="notice-preset-export"
              icon={<DownloadOutlined />}
              disabled={presets.length === 0}
              onClick={exportPresets}
            >
              导出
            </Button>
            <Button
              className="notice-preset-import"
              icon={<UploadOutlined />}
              onClick={() => pickImportFile('merge')}
            >
              导入（合并）
            </Button>
            <Popconfirm
              title="导入并替换全部预设？"
              description="当前全部预设会被清空，只保留导入文件中的内容；建议先导出备份。"
              okText="选择文件"
              cancelText="取消"
              onConfirm={() => pickImportFile('replace')}
            >
              <Button danger icon={<UploadOutlined />}>
                导入（替换）
              </Button>
            </Popconfirm>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="notice-preset-import-file"
              style={{ display: 'none' }}
              onChange={onImportFile}
            />
            <Typography.Text type="secondary">
              预设保存当前表单的全部字段（内容/显示方式/位置/滚动/配色/字号行数）；「套用」仅回填表单，「启用」会立即上线并有审计记录
              {presets.length >= presetLimit ? '；已达上限，保存时需要选择替换目标' : ''}
            </Typography.Text>
          </Space>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {presets.length === 0 && (
              <Typography.Text type="secondary">暂无预设，可先把上面表单调好再保存</Typography.Text>
            )}
            {presetGroups.map((bucket) => (
              <Space key={bucket.key || '__ungrouped'} direction="vertical" size={0} style={{ width: '100%' }}>
                {bucket.key && (
                  <Typography.Text strong className="notice-preset-group-title">
                    {bucket.key}
                  </Typography.Text>
                )}
                {bucket.items.map(({ preset, index }) => (
              <Space key={preset.id} wrap className="notice-preset-row">
                <Button
                  size="small"
                  aria-label="上移"
                  icon={<ArrowUpOutlined />}
                  disabled={index === 0 || presetBusy === preset.id}
                  onClick={() => movePreset(preset, -1)}
                />
                <Button
                  size="small"
                  aria-label="下移"
                  icon={<ArrowDownOutlined />}
                  disabled={index === presets.length - 1 || presetBusy === preset.id}
                  onClick={() => movePreset(preset, 1)}
                />
                <Typography.Text strong>{preset.name}</Typography.Text>
                <Typography.Text type="secondary">{presetSummary(preset.notice)}</Typography.Text>
                {preset.appliedAt > 0 && (
                  <Typography.Text type="secondary" className="notice-preset-audit">
                    {`上次启用 ${formatTime(preset.appliedAt)} · ${preset.appliedBy || '未知标识'} · 共 ${preset.appliedCount} 次`}
                  </Typography.Text>
                )}
                <Button size="small" onClick={() => applyPresetToForm(preset)}>
                  套用
                </Button>
                <Button
                  size="small"
                  type="primary"
                  loading={presetBusy === preset.id}
                  onClick={() => activatePreset(preset)}
                >
                  启用
                </Button>
                <Button size="small" onClick={() => overwritePreset(preset)}>
                  覆盖
                </Button>
                <Popconfirm
                  title={`删除预设「${preset.name}」？`}
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => removePreset(preset)}
                >
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
                ))}
              </Space>
            ))}
          </Space>
        </Space>
      </Card>

      <Modal
        title="预设已满，选择要替换的预设"
        open={replaceOpen}
        okText="替换"
        cancelText="取消"
        confirmLoading={presetSaving}
        okButtonProps={{ disabled: !replaceTarget }}
        onOk={() => savePreset({ replaceId: replaceTarget })}
        onCancel={() => {
          setReplaceOpen(false)
          setReplaceTarget('')
        }}
      >
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {`当前预设数量已达上限（${presets.length}/${presetLimit}）。替换会先删除所选预设，再保存当前表单内容。`}
          </Typography.Text>
          <Select
            className="notice-preset-replace"
            style={{ width: '100%' }}
            placeholder="选择要替换的预设"
            value={replaceTarget || undefined}
            onChange={setReplaceTarget}
            options={presets.map((preset) => ({
              value: preset.id,
              label: `${preset.group ? `${preset.group} / ` : ''}${preset.name}`
            }))}
          />
        </Space>
      </Modal>
    </AdminShell>
  )
}
