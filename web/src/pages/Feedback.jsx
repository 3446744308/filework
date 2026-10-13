import React, { useState } from 'react'
import { App as AntApp, Button, Card, Form, Input, Modal, Select, Typography } from 'antd'
import { SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

const { Title, Paragraph } = Typography

const FEEDBACK_TYPES = [
  { value: 'bug', label: '问题反馈（Bug）' },
  { value: 'feature', label: '功能建议' },
  { value: 'other', label: '其他' }
]

export default function Feedback() {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const onFinish = async (values) => {
    setSubmitting(true)
    try {
      const text = [
        '【意见反馈】',
        `时间：${dayjs().format('YYYY-MM-DD HH:mm')}`,
        `类型：${FEEDBACK_TYPES.find((t) => t.value === values.type)?.label || values.type}`,
        `联系方式：${values.contact || '（未留）'}`,
        '',
        values.content
      ].join('\n')
      let copied = false
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {}
      if (copied) {
        message.success('反馈内容已复制到剪贴板，请发送给管理员')
      } else {
        await navigator.clipboard?.writeText?.(text)
        message.warning('自动复制失败，请手动复制下方内容发送给管理员')
        Modal.info({
          title: '反馈内容（请复制发送给管理员）',
          content: <Input.TextArea value={text} autoSize={{ minRows: 6 }} readOnly />
        })
      }
      form.resetFields()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page page-compact-bottom">
      <Card>
        <Title level={3}>意见反馈</Title>
        <Paragraph type="secondary">
          提交后会将反馈内容复制到剪贴板，请发送给站点管理员（QQ / 微信 / 邮箱等任意渠道）。我们收到后会尽快处理。
        </Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ type: 'bug' }}>
          <Form.Item label="反馈类型" name="type" rules={[{ required: true, message: '请选择反馈类型' }]}>
            <Select options={FEEDBACK_TYPES} style={{ maxWidth: 320 }} />
          </Form.Item>
          <Form.Item
            label="联系方式（选填）"
            name="contact"
            rules={[{ max: 100, message: '联系方式最长 100 字符' }]}
          >
            <Input placeholder="QQ / 微信 / 邮箱，方便我们回访" maxLength={100} showCount />
          </Form.Item>
          <Form.Item
            label="反馈内容"
            name="content"
            rules={[
              { required: true, message: '请填写反馈内容' },
              { max: 2000, message: '内容最长 2000 字符' }
            ]}
          >
            <Input.TextArea rows={6} maxLength={2000} showCount placeholder="请描述遇到的问题或建议，可附上取件码、复现步骤等" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SendOutlined />} loading={submitting}>
            提交反馈
          </Button>
        </Form>
      </Card>
    </div>
  )
}
