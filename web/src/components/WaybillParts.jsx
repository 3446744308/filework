import React, { useMemo } from 'react'
import {
  ClockCircleOutlined,
  DownloadOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons'
import qrcode from 'qrcode-generator'

export function QrCode({ text }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const quiet = 4
    const count = qr.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }
    }
    return { size: count + quiet * 2, path: d }
  }, [text])

  return (
    <svg
      className="waybill-qr-svg"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="取件二维码"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

export function Barcode({ value }) {
  const { bars, width } = useMemo(() => {
    const list = []
    let x = 2
    for (const ch of value) {
      const d = Number(ch) || 0
      const pattern = [1 + (d % 3), 1 + ((d >> 1) % 3), 1 + ((d * 3) % 4), 2]
      pattern.forEach((w, i) => {
        list.push({ x, w, dark: i % 2 === 0 })
        x += w
      })
      x += 1
    }
    return { bars: list, width: x + 2 }
  }, [value])

  return (
    <svg
      className="waybill-barcode-svg"
      viewBox={`0 0 ${width} 40`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`条码 ${value}`}
    >
      {bars.map((bar, i) =>
        bar.dark ? <rect key={i} x={bar.x} y={0} width={bar.w} height={40} fill="#111" /> : null
      )}
    </svg>
  )
}

export const FEATURES = [
  { icon: <SafetyCertificateOutlined />, title: '安全可靠', desc: '文件加密存储，安全传输' },
  { icon: <ClockCircleOutlined />, title: '时效保障', desc: '文件限时有效，及时取件' },
  { icon: <DownloadOutlined />, title: '便捷取件', desc: '多种方式取件，操作简单' },
  { icon: <QuestionCircleOutlined />, title: '专业支持', desc: '遇到问题，联系客服' }
]
