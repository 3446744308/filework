import React, { useEffect, useState } from 'react'
import { Button, Input, Space } from 'antd'
import { DownloadOutlined, HomeOutlined, InboxOutlined } from '@ant-design/icons'
import { api } from '../api.js'
import { formatBytes, formatDateTimeTz, timeLeft, waybillNoOf } from '../utils.js'
import { QrCode, Barcode, FEATURES } from './WaybillParts.jsx'

export default function PickupWaybill({
  info,
  shareUrl,
  siteName,
  logoUrl,
  downloading,
  password,
  onPasswordChange,
  onDownload,
  onChangeCode,
  onGoHome
}) {
  const waybillNo = waybillNoOf(info.createdAt, info.code)
  const brand = siteName || '文件驿站'
  const remaining =
    info.maxDownloads > 0 ? Math.max(info.maxDownloads - info.downloads, 0) : 0

  useEffect(() => {
    const title = `${brand} · 取件回执`
    document.title = title
  }, [brand])

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
            <span className="waybill-brand-name">{brand} · 取件回执</span>
          </div>
          <div className="waybill-head-meta">
            <span>
              取件码：<b className="waybill-no">{info.code}</b>
            </span>
            <span>
              面单号：<b className="waybill-no">{waybillNo}</b>
            </span>
          </div>
          <div className="waybill-qr">
            <QrCode text={shareUrl} />
            <span className="waybill-qr-caption">扫码下载文件</span>
          </div>
        </div>

        <div className="waybill-barcode">
          <Barcode value={waybillNo} />
          <div className="waybill-code-digits">{waybillNo}</div>
        </div>

        <div className="waybill-cols">
          <div className="waybill-col">
            <div className="waybill-col-tag">取件码</div>
            <div className="waybill-col-main">
              <b className="waybill-code">{info.code}</b>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">有效期至：</span>
              <span>{formatDateTimeTz(info.expiresAt)}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">剩余时间：</span>
              <span>{timeLeft(info.expiresAt)}</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">取件提醒：</span>
              <span>点击下方按钮即可下载</span>
            </div>
            {info.hasPassword && (
              <div className="waybill-row">
                <span className="waybill-label">取件密码：</span>
                <Input.Password
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  placeholder="请输入取件密码"
                  maxLength={64}
                  size="small"
                  style={{ width: 160 }}
                  onPressEnter={onDownload}
                />
              </div>
            )}
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloading}
              onClick={onDownload}
              className="waybill-col-download"
            >
              {info.hasPassword ? '验证密码并下载' : '下载文件'}
            </Button>
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
            {info.note ? (
              <div className="waybill-row">
                <span className="waybill-label">文件备注：</span>
                <span className="waybill-filename">{info.note}</span>
              </div>
            ) : null}
            <div className="waybill-row">
              <span className="waybill-label">剩余下载：</span>
              <span>
                {remaining} / {info.maxDownloads} 次
              </span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">发件时间：</span>
              <span>{formatDateTimeTz(info.createdAt)}</span>
            </div>
          </div>

          <div className="waybill-col">
            <div className="waybill-col-tag">收件提醒</div>
            <div className="waybill-row">
              <span className="waybill-label">下载消耗：</span>
              <span>每次下载消耗 1 次次数</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">销毁规则：</span>
              <span>次数用尽或过期后文件自动销毁</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">文件安全：</span>
              <span>全程加密存储，请放心取件</span>
            </div>
            <div className="waybill-row">
              <span className="waybill-label">取件方式：</span>
              <span>点击下方下载按钮获取</span>
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

      <div className="waybill-thanks">下载成功后请及时保存文件</div>

      <div className="waybill-actions">
        <Space wrap>
          <Button onClick={onChangeCode}>换个取件码</Button>
          {onGoHome && (
            <Button icon={<HomeOutlined />} onClick={onGoHome}>
              返回首页
            </Button>
          )}
        </Space>
      </div>
    </div>
  )
}
