import React from 'react'
import { Card, Typography } from 'antd'
import { useSettings } from '../hooks/useSettings.js'

const { Title, Paragraph, Text } = Typography

export default function About() {
  const settings = useSettings()
  const siteName = settings?.siteName || '文件驿站 · 匿名共享'

  return (
    <div className="page">
      <Card>
        <Title level={3}>关于 {siteName}</Title>
        <Paragraph>
          {siteName}
          是一个类「快递驿站」的匿名文件共享服务：上传文件后获得 6
          位取件码，对方无需注册登录，输入取件码即可下载。分享在有效期或下载次数任一耗尽后自动销毁，文件与元数据一并删除。
        </Paragraph>
        <Title level={5}>如何使用</Title>
        <Paragraph>
          ① 在首页拖入文件，选择有效期与下载次数（可选自定义取件码、取件密码与备注）；
          <br />
          ② 发件成功后获得取件码与二维码，把取件码或链接发给对方；
          <br />
          ③ 对方在「输入取件码」页面输入取件码（设密时需先验证密码）即可下载。
        </Paragraph>
        <Title level={5}>主要特性</Title>
        <Paragraph>
          · 无需注册登录，匿名收发
          <br />
          · 有效期 1/24/72/168 小时可选，下载次数 1/3/5/10 次可选
          <br />
          · 支持自定义 6 位取件码与取件密码（SHA-256 哈希存储）
          <br />
          · 取件码 / 分享链接 / 二维码多种分享方式
          <br />
          · 管理后台：公告、站点设置、文件管理
        </Paragraph>
        <Title level={5}>限制与说明</Title>
        <Paragraph type="secondary">
          单文件大小上限由站点管理员配置；部分文件类型可能被禁止上传；请勿用于违反法律法规的内容。本服务不提供回收站，分享失效后无法找回。
        </Paragraph>
        <Paragraph type="secondary">
          <Text type="secondary">发现 Bug 或有功能建议？欢迎在「其他 → 反馈」中告诉我们。</Text>
        </Paragraph>
      </Card>
    </div>
  )
}
