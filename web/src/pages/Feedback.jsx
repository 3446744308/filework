import React, { useState } from 'react'
import { App as AntApp, Button, Card, Form, Input, Modal, Select, Typography } from 'antd'
import { SendOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { copyText } from '../utils.js'

const { Title, Paragraph, Text } = Typography

const FEEDBACK_TYPES = [
  { value: 'bug', label: '问题反馈（Bug）' },
  { value: 'feature', label: '功能建议' },
  { value: 'other', label: '其他' }
]

export default function Feedback() {
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [successCode, setSuccessCode] = useState('')

  const onFinish = async (values) => {
    setSubmitting(true)
    try {
      const data = await api.feedback({
        type: values.type,
        contact: values.contact || '',
        content: values.content
      })
      setSuccessCode(data.code)
      form.resetFields()
    } catch (err) {
      message.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page page-compact-bottom">
      <Card>
        <Title level={3}>意见反馈</Title>
        <Paragraph type="secondary">
          提交后会生成一个<b>反馈号</b>（格式如 FB-12345678），请妥善保存——通过「其他 → 查询反馈」随时查看处理进度；留下联系方式便于回访。
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

      <Modal
        title="反馈提交成功"
        open={Boolean(successCode)}
        onCancel={() => setSuccessCode('')}
        footer={[
          <Button key="query" type="primary" onClick={() => navigate(`/feedback-query?code=${successCode}`)}>
            去查询进度
          </Button>,
          <Button
            key="copy"
            onClick={async () => {
              const ok = await copyText(successCode)
              message[ok ? 'success' : 'warning'](ok ? '反馈号已复制' : '复制失败')
            }}
          >
            复制反馈号
          </Button>,
          <Button key="close" onClick={() => setSuccessCode('')}>
            关闭
          </Button>
        ]}
      >
        <Paragraph>
          你的反馈已收到，反馈号为：
          <br />
          <Text strong style={{ fontSize: 28, letterSpacing: 4, userSelect: 'all' }}>
            {successCode}
          </Text>
        </Paragraph>
        <Paragraph type="warning">请妥善保存反馈号，凭此号可在「其他 → 查询反馈」中查看处理状态。</Paragraph>
      </Modal>
    </div>
  )
}
