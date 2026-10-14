import React, { useEffect, useState } from 'react'
import {
  App as AntApp,
  Button,
  Card,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
  Upload
} from 'antd'
import {
  DeleteOutlined,
  PictureOutlined,
  SaveOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { api } from '../api.js'
import { getAdminKey, logout } from '../hooks/useAdminAuth.js'
import { useSettings, logoUrlOf, refreshSettings } from '../hooks/useSettings.js'
import AdminShell from '../components/AdminShell.jsx'

const MAX_LOGO_SIZE = 2 * 1024 * 1024
const MB = 1024 * 1024

export default function AdminSettings() {
  const { message } = AntApp.useApp()
  const settings = useSettings()
  const [siteName, setSiteName] = useState('')
  const [beian, setBeian] = useState('')
  const [gongan, setGongan] = useState('')
  const [maxSizeMb, setMaxSizeMb] = useState(null)
  const [blockedExts, setBlockedExts] = useState([])
  const [displayMode, setDisplayMode] = useState('simple')
  const [customCodeEnabled, setCustomCodeEnabled] = useState(true)
  const [compressionEnabled, setCompressionEnabled] = useState(true)
  const [compressionCodecs, setCompressionCodecs] = useState('br,gzip')
  const [presetLimit, setPresetLimit] = useState(10)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (settings) {
      setSiteName(settings.siteName || '')
      setBeian(settings.beian || '')
      setGongan(settings.gongan || '')
      setMaxSizeMb(Math.max(1, Math.round(settings.maxFileSize / MB)))
      setBlockedExts(settings.blockedExts || [])
      setDisplayMode(settings.displayMode === 'waybill' ? 'waybill' : 'simple')
      setCustomCodeEnabled(settings.customCodeEnabled !== false)
      setCompressionEnabled(settings.compressionEnabled !== false)
      setCompressionCodecs(settings.compressionCodecs === 'gzip' ? 'gzip' : 'br,gzip')
      setPresetLimit(Math.max(1, Math.round(Number(settings.presetLimit) || 10)))
    }
  }, [settings])

  const handleAuthError = (err) => {
    if (err.status === 401) {
      message.error('管理密钥已失效，请重新登录')
      logout()
    } else {
      message.error(err.message)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const mb = Number(maxSizeMb)
      const maxFileSize = Number.isFinite(mb) && mb > 0 ? Math.round(mb) * MB : 0
      await api.saveSettings(
        {
          siteName,
          beian,
          gongan,
          maxFileSize,
          blockedExts,
          displayMode,
          customCodeEnabled,
          compressionEnabled,
          compressionCodecs,
          presetLimit
        },
        getAdminKey()
      )
      message.success('设置已保存')
      await refreshSettings()
    } catch (err) {
      handleAuthError(err)
    } finally {
      setSaving(false)
    }
  }

  const onChangeExts = (values) => {
    const cleaned = values
      .map((v) => String(v).trim().toLowerCase().replace(/^\.+/, ''))
      .filter((v) => /^[a-z0-9]{1,20}$/.test(v))
    setBlockedExts([...new Set(cleaned)])
  }

  const uploadLogo = async (file) => {
    if (file.size > MAX_LOGO_SIZE) {
      message.error('logo 不能超过 2MB')
      return
    }
    setUploading(true)
    try {
      await api.uploadLogo(file, getAdminKey())
      message.success('logo 已更新')
      await refreshSettings()
    } catch (err) {
      handleAuthError(err)
    } finally {
      setUploading(false)
    }
  }

  const removeLogo = async () => {
    try {
      await api.removeLogo(getAdminKey())
      message.success('logo 已删除')
      await refreshSettings()
    } catch (err) {
      handleAuthError(err)
    }
  }

  const logoUrl = logoUrlOf(settings)
  const capMb = Math.max(1, Math.floor((settings?.maxFileSizeCap || 100 * MB) / MB))
  const codecCap = settings?.compressionCodecCap || 'br,gzip'
  const brotliAllowed = codecCap.includes('br')
  const presetLimitCap = Math.max(1, Math.round(Number(settings?.presetLimitCap) || 50))

  return (
    <AdminShell>
      <Card title="站点设置">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={5}>站点名称</Typography.Title>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                maxLength={50}
                showCount
                placeholder="留空使用默认名称"
                onPressEnter={save}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              显示于页面顶部与浏览器标签页；留空则使用默认名称「文件驿站 · 匿名共享」。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>备案号（可选）</Typography.Title>
            <Space.Compact style={{ width: '100%', maxWidth: 480 }}>
              <Input
                value={beian}
                onChange={(e) => setBeian(e.target.value)}
                maxLength={100}
                showCount
                placeholder="如：粤ICP备2024000000号"
                onPressEnter={save}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              显示在公开页面底部；留空则不显示备案号。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>公安备案号（可选）</Typography.Title>
            <Space.Compact style={{ width: '100%', maxWidth: 480 }}>
              <Input
                value={gongan}
                onChange={(e) => setGongan(e.target.value)}
                maxLength={100}
                showCount
                placeholder="如：粤公网安备 44030402000000号"
                onPressEnter={save}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              显示在公开页面底部，与 ICP 备案号并排；留空则不显示公安备案号。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>Logo（可选）</Typography.Title>
            <Space wrap align="center">
              {logoUrl ? (
                <img className="logo-preview" src={logoUrl} alt="logo" />
              ) : (
                <div className="logo-preview logo-preview-empty">
                  <PictureOutlined />
                </div>
              )}
              <Upload
                showUploadList={false}
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon"
                beforeUpload={(file) => {
                  uploadLogo(file)
                  return false
                }}
              >
                <Button icon={<UploadOutlined />} loading={uploading}>
                  {logoUrl ? '更换 Logo' : '上传 Logo'}
                </Button>
              </Upload>
              {logoUrl && (
                <Popconfirm
                  title="删除当前 logo？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={removeLogo}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              )}
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              支持 PNG / JPG / WebP / SVG / GIF / ICO，不超过 2MB；不设置则不显示，使用默认图标。
            </Typography.Paragraph>
          </div>
          <div>
            <Typography.Title level={5}>上传大小上限（单文件）</Typography.Title>
            <Space.Compact style={{ width: '100%', maxWidth: 320 }}>
              <InputNumber
                min={1}
                max={capMb}
                precision={0}
                value={maxSizeMb}
                onChange={setMaxSizeMb}
                placeholder={`默认 ${capMb}`}
                style={{ width: '100%' }}
                suffix="MB"
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              允许范围 1–{capMb}MB，默认 {capMb}MB；上限由环境变量 MAX_FILE_SIZE
              决定，超出将被截断。上传页提示与预检会同步生效。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>禁止上传的文件类型</Typography.Title>
            <Select
              mode="tags"
              value={blockedExts}
              onChange={onChangeExts}
              tokenSeparators={[',', ' ', '，']}
              open={false}
              placeholder="输入后缀并回车，如 php、exe"
              style={{ width: '100%', maxWidth: 480 }}
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              不区分大小写，可输入 .php 或 php；多个用逗号/空格分隔。命中后缀的文件将在上传时被拒绝。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>发件成功显示模式</Typography.Title>
            <Space.Compact style={{ width: '100%', maxWidth: 320 }}>
              <Select
                value={displayMode}
                onChange={setDisplayMode}
                options={[
                  { value: 'simple', label: '简约版' },
                  { value: 'waybill', label: '快递面单' }
                ]}
                style={{ width: '100%' }}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              简约版：显示取件码与二维码；快递面单：显示仿物流发件回执（含面单号、条码、寄收与文件信息），支持打印下载与发送。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>自定义取件码</Typography.Title>
            <Space>
              <Switch checked={customCodeEnabled} onChange={setCustomCodeEnabled} />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              开启后，发件人在填写收件信息时可自定义 6 位数字取件码；关闭后发件页不再显示该输入框，且已提交的自定义码将被忽略并改为自动生成。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>公告预设上限</Typography.Title>
            <Space.Compact style={{ width: '100%', maxWidth: 320 }}>
              <InputNumber
                className="preset-limit-input"
                min={1}
                max={presetLimitCap}
                precision={0}
                value={presetLimit}
                onChange={setPresetLimit}
                placeholder="默认 10"
                style={{ width: '100%' }}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              管理端「公告设置」可保存的预设数量上限（单位：个），允许范围 1–{presetLimitCap}，默认 10；硬上限由环境变量 MAX_NOTICE_PRESETS
              决定。调低上限不会删除已有预设，只限制继续新增（超出部分的预设仍可套用/启用/删除）。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>存储压缩</Typography.Title>
            <Space>
              <Switch checked={compressionEnabled} onChange={setCompressionEnabled} />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              开启后，文本、文档等可压缩文件在上传完成时自动按自适应单元压缩存储（内容定界切分 + 逐单元取最小 + 单元级去重，通常可省 50%~95% 磁盘空间）；图片、音视频、压缩包等已压缩格式自动跳过，压缩无收益时保持原样；下载与取件流程不受影响。
            </Typography.Paragraph>
          </div>

          <div>
            <Typography.Title level={5}>压缩编码候选</Typography.Title>
            <Space wrap>
              <Radio.Group
                value={compressionCodecs}
                onChange={(e) => setCompressionCodecs(e.target.value)}
                optionType="button"
                options={[
                  { label: 'Brotli + gzip 双试（体积最优）', value: 'br,gzip', disabled: !brotliAllowed },
                  { label: '仅 gzip（CPU 更低）', value: 'gzip' }
                ]}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              双试：每个单元实测 gzip 与 brotli 后取更小者（文本通常再小 1%~3%，压缩 CPU 约翻倍）；仅 gzip：跳过 brotli 尝试，CPU 减半、体积略大，适合服务器 CPU 吃紧时降级。
              环境变量 COMPRESS_CODECS（当前 {codecCap}）是硬上限，为 gzip 时此项不可切换；仅影响此后新上传的文件，已存文件保持原编码。
            </Typography.Paragraph>
          </div>
        </Space>
      </Card>
    </AdminShell>
  )
}
