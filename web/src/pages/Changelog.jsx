import React from 'react'
import { Card, Divider, Tag, Typography } from 'antd'

const { Title, Paragraph, Text } = Typography

const RELEASES = [
  {
    date: '2026-10-17',
    sections: [
      {
        label: '产品发布',
        items: [
          { text: 'APP 上线', contributor: 'leichen', url: 'https://github.com/beimu123321/' },
          { text: '桌面端上线', contributor: 'yayale', url: 'https://github.com/3446744308' }
        ]
      }
    ]
  },
  {
    date: '2026-10-16',
    sections: [
      {
        label: '新增功能',
        items: [
          '新增文件在线预览：图片 / 视频 / 文本可在取件页点击「预览文件」查看，预览与下载共用次数，点击前弹窗确认',
          '视频预览换用 Plyr 播放器：倍速、全屏、音量与渐变控件条美化',
          '文本预览器升级为编辑器风格：文件头条、行号、行高亮、长行横向滚动',
          '关于页新增「开源软件」致谢模块',
          '新增本更新日志页面'
        ]
      },
      {
        label: '优化改进',
        items: [
          { text: '存储优化', contributor: 'zhouweihang', url: 'https://github.com/zhouweihang' },
          '顶部菜单「其他」下拉箭头在桌面与移动端样式统一'
        ]
      }
    ]
  },
  {
    date: '2026-10-14',
    sections: [
      {
        label: '新增功能',
        items: [
          '反馈功能模块：提交意见建议，凭反馈号（FB-xxxxxxxx）随时查询处理进度与官方回复'
        ]
      }
    ]
  },
  {
    date: '2026-10-12',
    sections: [
      {
        label: '新增功能',
        items: [
          '自定义取件码：上传时可自行指定 6 位数字取件码',
          '取件密码：取件时需额外输入密码校验（SHA-256 哈希存储，服务端不存明文）'
        ]
      }
    ]
  },
  {
    date: null,
    sections: [
      {
        label: '新增功能',
        items: [
          '初始版本：匿名收发文件，6 位取件码，无需注册登录',
          '有效期（1/24/72/168 小时）与下载次数（1/3/5/10 次）可选',
          '分享二维码',
          '快递面单风格发件回执（可切换）、站点公告展示'
        ]
      }
    ]
  }
]

export default function Changelog() {
  return (
    <div className="page page-compact-bottom">
      <Card>
        <div className="log-wrap">
          <Title level={2} className="log-title">
            更新日志
          </Title>
          <Paragraph type="secondary" className="log-sub">
            记录每一次产品的改进与优化
          </Paragraph>
          <Divider />
          {RELEASES.map((release, index) => (
            <div className="log-release" key={release.date || 'initial'}>
              <div className="log-release-head">
                <Title level={4} className="log-date">
                  {release.date || '初始发布'}
                </Title>
                {index === 0 && <Tag color="blue">最新</Tag>}
              </div>
              {release.sections.map((section) => (
                <div className="log-group" key={section.label}>
                  <Text strong className="log-group-title">
                    {section.label}
                  </Text>
                  <ul className="log-list">
                    {section.items.map((item, i) => (
                      <li key={i}>
                        {typeof item === 'string' ? item : item.text}
                        {typeof item !== 'string' && (
                          <a className="log-contrib" href={item.url} target="_blank" rel="noreferrer">
                            贡献者 @{item.contributor}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {index < RELEASES.length - 1 && <Divider dashed className="log-sep" />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
