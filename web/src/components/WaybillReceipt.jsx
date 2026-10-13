import React, { useEffect, useState } from 'react'
import { Button } from 'antd'
import { CopyOutlined, InboxOutlined } from '@ant-design/icons'
import { api } from '../api.js'
import { formatBytes, formatDateTimeTz, waybillNoOf, deviceSummary } from '../utils.js'
import { QrCode, Barcode, FEATURES } from './WaybillParts.jsx'

export default function WaybillReceipt({ info, shareUrl, siteName, logoUrl, onCopy }) {
  const waybillNo = waybillNoOf(info.createdAt, info.code)
  const sender = deviceSummary()
  const brand = siteName || '文件驿站'
  const [publicIp, setPublicIp] = useState(info.clientIp || '')

  useEffect(() => {
    let alive = true
    api
      .publicIp()
      .then((data) => {
        if (alive && data?.ip) setPublicIp(data.ip)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const senderIp = publicIp || info.clientIp || '—'

  return (
    <div className="waybill-print">
      <div className="waybill-card">
        <div className="waybill-head">
          <div className="waybill-brand">
            {logoUrl ? (
              <img className="waybill-logo" src={logoUrl} alt="" />
            ) : (
              <span className="waybill-brand-icon">
                <InboxOutlined />
              </span>
            )}
            <span className="waybill-brand-name">{brand} · 发件回执</span>
          </div>
          <div className="waybill-head-meta">
            <span>
              发件时间：<b>{formatDateTimeTz(info.createdAt)}</b>
            </span>
            <span>
              面单号：<b className="waybill-no">{waybillNo}</b>
            </span>
          </div>
          <div className="waybill-qr">
            <QrCode text={shareUrl} />
            <span className="waybill-qr-caption">扫码查看收件页</span>
          </div>
        </div>

        <div className="waybill-barcode">
          <Barcode value={waybillNo} />
          <div className="waybill-code-digits">{waybillNo}</div>
        </div>

        <div className="waybill-cols">
          <div className="waybill-col">
            <div className="waybill-col-tag">寄件方</div>
            <div className="waybill-col-main">文件发送方（您）</div>
            <div className="waybill-row">
              <span className="waybill-label">寄件时间：</span>
              <span>{formatDateTimeTz(info.createdAt)}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">IP / 地址：</span>
              <span>{senderIp}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">设备信息：</span>
              <span>{sender}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">文件备注：</span>
              <span className="waybill-filename">{info.note || '无'}</span>
            </div>
          </div>

          <div className="waybill-col">
            <div className="waybill-col-tag">收件方</div>
            <div className="waybill-row">
              <span className="waybill-label">取件码：</span>
              <b className="waybill-code">{info.code}</b>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">取件地址：</span>
              <span className="waybill-link-row">
                <a href={shareUrl} className="waybill-link">
                  {shareUrl}
                </a>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => onCopy(shareUrl, '取件链接已复制')}
                />
              </span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">有效期至：</span>
              <span>{formatDateTimeTz(info.expiresAt)}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">取件提醒：</span>
              <span>对方可凭取件码或二维码取件</span>
            </div>
          </div>

          <div className="waybill-col">
            <div className="waybill-col-tag">文件信息</div>
            <div className="waybill-row">
              <span className="waybill-label">文件名称：</span>
              <span className="waybill-filename">{info.filename}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">文件大小：</span>
              <span>{formatBytes(info.size)}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">最大下载次数：</span>
              <span>{info.maxDownloads} 次</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">已下载次数：</span>
              <span>{info.downloads || 0} 次</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">上传方式：</span>
              <span>网页上传</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">存储位置：</span>
              <span>服务器存储</span>
            </div>
          </div>
        </div>

        <div className="waybill-features">
          {FEATURES.map((f) => (
            <div className="waybill-feature" key={f.title}>
              <span className="waybill-feature-icon">{f.icon}</span>
              <div className="waybill-feature-text">
                <div className="waybill-feature-title">{f.title}</div>
                <div className="waybill-feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="waybill-thanks">感谢使用{brand}</div>
    </div>
  )
}

