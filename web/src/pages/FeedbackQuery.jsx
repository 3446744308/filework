import React, { useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Input, Space, Steps, Tag, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { formatTime } from '../utils.js'

const { Title, Paragraph, Text } = Typography

const TYPE_LABELS = { bug: '问题反馈（Bug）', feature: '功能建议', other: '其他' }
const TYPE_COLORS = { bug: 'red', feature: 'blue', other: 'default' }
const STATUS_META = {
  pending: { label: '等待中', color: 'orange', step: 0 },
  processing: { label: '处理中', color: 'blue', step: 1 },
  done: { label: '已完成', color: 'green', step: 2 }
}

export default function FeedbackQuery() {
  const { message } = AntApp.useApp()
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState(searchParams.get('code') || '')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const query = async (value) => {
    let target = String(value ?? code).trim().toUpperCase()
    if (/^\d{8}$/.test(target)) target = `FB-${target}`
    if (!/^FB-\d{8}$/.test(target)) {
      message.warning('请输入反馈号（格式如 FB-12345678）')
      return
    }
    setCode(target)
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const data = await api.feedbackQuery(target)
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const init = searchParams.get('code')
    if (init) query(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const step = result ? (STATUS_META[result.status]?.step ?? 0) : 0

  return (
    <div className="page page-compact-bottom">
      <Card>
        <Title level={3}>查询反馈</Title>
        <Paragraph type="secondary">
          输入提交反馈时获得的反馈号（格式如 <Text code>FB-12345678</Text>），查看处理进度。
        </Paragraph>
        <Space.Compact style={{ width: '100%', maxWidth: 460 }}>
          <Input
            value={code}
            onChange={(e) => {
              const digits = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '')
              const num = digits.replace(/FB-?/g, '').replace(/\D/g, '').slice(0, 8)
              setCode(num ? `FB-${num}` : '')
            }}
            placeholder="请输入反馈号，如 FB-12345678"
            size="large"
            maxLength={11}
            onPressEnter={() => query()}
          />
          <Button type="primary" size="large" icon={<SearchOutlined />} loading={loading} onClick={() => query()}>
            查询
          </Button>
        </Space.Compact>

        {error && (
          <Paragraph type="danger" style={{ marginTop: 20 }}>
            {error}
          </Paragraph>
        )}

        {result && (
          <div className="feedback-query-result">
            <div className="feedback-query-head">
              <Space size={16} wrap>
                <Text strong style={{ fontSize: 20, letterSpacing: 2 }}>
                  {result.code}
                </Text>
                <Tag color={TYPE_COLORS[result.type] || 'default'}>{TYPE_LABELS[result.type] || result.type}</Tag>
              </Space>
              <Text type="secondary" style={{ fontSize: 13 }}>
                提交于 {formatTime(result.createdAt)} · 更新于 {formatTime(result.updatedAt)}
              </Text>
            </div>

            <Steps
              direction="vertical"
              current={step}
              status={result.status === 'done' ? 'finish' : 'process'}
              size="small"
              items={[
                {
                  title: '等待中',
                  description: (
                    <>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        {result.status === 'pending' ? '排队等待处理' : '已受理'}
                      </Text>
                      <div className="feedback-query-content">
                        <Text type="secondary" style={{ fontSize: 13 }}>反馈内容</Text>
                        <Paragraph
                          style={{ whiteSpace: 'pre-wrap', marginTop: 8, marginBottom: 0, maxHeight: 360, overflow: 'auto' }}
                        >
                          {result.content}
                        </Paragraph>
                      </div>
                    </>
                  )
                },
                {
                  title: '处理中',
                  description: result.status === 'processing' ? '正在跟进处理' : result.status === 'done' ? '已处理' : '待处理'
                },
                {
                  title: '已完成',
                  description: result.status === 'done' ? (
                    <>
                      <Text type="secondary" style={{ fontSize: 13 }}>感谢你的反馈</Text>
                      {result.reply && (
                        <div className="feedback-query-content feedback-query-reply">
                          <Text type="secondary" style={{ fontSize: 13 }}>官方回复</Text>
                          <Paragraph
                            style={{ whiteSpace: 'pre-wrap', marginTop: 8, marginBottom: 0, maxHeight: 240, overflow: 'auto' }}
                          >
                            {result.reply}
                          </Paragraph>
                        </div>
                      )}
                    </>
                  ) : '处理完成后更新'
                }
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
