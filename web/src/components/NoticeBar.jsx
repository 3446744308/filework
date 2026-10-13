import React, { useEffect, useRef, useState } from 'react'
import { Alert } from 'antd'
import { api } from '../api.js'

const GAP = 64
const SPEED = 60

export default function NoticeBar() {
  const [notice, setNotice] = useState(null)
  const [scrolling, setScrolling] = useState(false)
  const [duration, setDuration] = useState(12)
  const viewportRef = useRef(null)
  const itemRef = useRef(null)

  useEffect(() => {
    api
      .notice()
      .then((n) => {
        if (!n.enabled || !n.content) return
        if (n.display !== 'bar' && n.display !== 'both') return
        if (localStorage.getItem(`notice-bar-closed-${n.updatedAt}`)) return
        setNotice(n)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const measure = () => {
      const view = viewportRef.current
      const item = itemRef.current
      if (!view || !item) return
      const overflow = item.scrollWidth > view.clientWidth
      setScrolling(overflow)
      if (overflow) {
        setDuration(Math.max(6, Math.round((item.scrollWidth + GAP) / SPEED)))
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [notice])

  if (!notice) return null

  const close = () => {
    try {
      localStorage.setItem(`notice-bar-closed-${notice.updatedAt}`, '1')
    } catch {}
    setNotice(null)
  }

  const fullText = notice.title ? `${notice.title}：${notice.content}` : notice.content
  const textNode = (
    <>
      {notice.title && <b className="notice-bar-title">{notice.title}</b>}
      <span className="notice-bar-content">{notice.content}</span>
    </>
  )

  return (
    <Alert
      banner
      closable
      type="info"
      showIcon
      className="notice-bar-alert"
      onClose={close}
      message={
        <div className="notice-bar-viewport" ref={viewportRef} title={fullText}>
          <span
            className={`notice-bar-marquee${scrolling ? ' scrolling' : ''}`}
            style={{ '--notice-duration': `${duration}s` }}
          >
            <span className="notice-bar-item" ref={itemRef}>
              {textNode}
            </span>
            {scrolling && (
              <span className="notice-bar-item" aria-hidden="true">
                {textNode}
              </span>
            )}
          </span>
        </div>
      }
    />
  )
}
