import React, { useEffect, useRef, useState } from 'react'
import { Alert } from 'antd'
import { api } from '../api.js'

const GAP = 64
const SPEED = 60
const VERTICAL_SPEED = 24
const LINE_HEIGHT = 24
const BOTTOM_SLOT = ['bottom', 'fixed-bottom']
const VERTICAL_SCROLLS = ['up', 'bounce']

let noticePromise = null

function loadNotice() {
  if (!noticePromise) {
    noticePromise = api.notice().catch(() => null)
  }
  return noticePromise
}

function slotOf(position) {
  return BOTTOM_SLOT.includes(position) ? 'bottom' : 'top'
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function readReducedMotion() {
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

// 无障碍：跟随系统「减少动态效果」偏好，滚动类公告自动降级为静态展示（保留省略与悬停展开）。
function useReducedMotion() {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    let query
    try {
      query = window.matchMedia(REDUCED_MOTION_QUERY)
    } catch {
      return undefined
    }
    const onChange = (event) => setReduced(event.matches)
    setReduced(query.matches)
    if (query.addEventListener) query.addEventListener('change', onChange)
    else query.addListener(onChange)
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', onChange)
      else query.removeListener(onChange)
    }
  }, [])
  return reduced
}

export function NoticeBarView({ notice, preview = false, onMetrics, onClose }) {
  const [metrics, setMetrics] = useState({
    scrolling: false,
    duration: 0,
    shift: 0,
    copies: 1,
    reason: '暂无内容'
  })
  const viewportRef = useRef(null)
  const itemRef = useRef(null)
  const metricsSinkRef = useRef(onMetrics)
  metricsSinkRef.current = onMetrics
  const reducedMotion = useReducedMotion()

  const scroll = notice?.scroll || 'left'
  const vertical = VERTICAL_SCROLLS.includes(scroll)
  const scrollFill = Boolean(notice?.scrollFill)
  const hasContent = Boolean(notice?.content)
  // 纵向视口高度 = 行数上限 × 行高；横向沿用 CSS 的单行高度。
  const maxLines = Math.min(3, Math.max(1, Math.round(Number(notice?.maxLines) || 1)))
  const viewportHeight = maxLines * LINE_HEIGHT

  useEffect(() => {
    if (!notice) return undefined
    const measure = () => {
      const view = viewportRef.current
      const item = itemRef.current
      if (!view || !item) return
      let next
      if (!hasContent) {
        next = { scrolling: false, duration: 0, shift: 0, copies: 1, reason: '暂无内容' }
      } else if (scroll === 'none') {
        next = { scrolling: false, duration: 0, shift: 0, copies: 1, reason: '静态不滚动' }
      } else if (reducedMotion) {
        next = {
          scrolling: false,
          duration: 0,
          shift: 0,
          copies: 1,
          reason: '系统已开启「减少动态效果」，降级为静态展示（悬停可见完整内容）'
        }
      } else if (vertical) {
        const extra = Math.max(0, item.scrollHeight - view.clientHeight)
        next =
          extra > 1
            ? {
                scrolling: true,
                duration: Math.max(4, Math.round(extra / VERTICAL_SPEED)),
                shift: extra,
                copies: scroll === 'up' ? 2 : 1,
                reason: '纵向滚动中'
              }
            : {
                scrolling: false,
                duration: 0,
                shift: 0,
                copies: 1,
                reason: `纵向需超过 ${maxLines} 行内容（换行或自动换行）才会滚动`
              }
      } else if (!scrollFill && item.scrollWidth <= view.clientWidth) {
        next = {
          scrolling: false,
          duration: 0,
          shift: 0,
          copies: 1,
          reason: '内容未超出可视宽度，不滚动（可开启「自动填满滚动」）'
        }
      } else {
        const unit = item.scrollWidth + GAP
        const perHalf = Math.max(1, Math.ceil(view.clientWidth / unit))
        const halfWidth = perHalf * unit
        next = {
          scrolling: true,
          duration: Math.max(6, Math.round(halfWidth / SPEED)),
          shift: 0,
          copies: 2 * perHalf,
          reason:
            perHalf > 1
              ? '横向滚动中（内容不足已自动重复填满）'
              : '横向滚动中'
        }
      }
      setMetrics(next)
      if (metricsSinkRef.current) metricsSinkRef.current(next)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [notice, scroll, scrollFill, vertical, hasContent, reducedMotion, maxLines])

  if (!notice) return null

  const position = notice.position || 'top'
  const fixed = !preview && position.startsWith('fixed-')
  const colors = {
    ...(notice.bgColor ? { background: notice.bgColor, borderColor: notice.bgColor } : null),
    ...(notice.textColor ? { color: notice.textColor } : null),
    ...(Number(notice.fontSize) > 0 ? { fontSize: `${Number(notice.fontSize)}px` } : null),
    ...(Number(notice.radius) > 0 ? { borderRadius: `${Number(notice.radius)}px` } : null),
    ...(Number(notice.opacity) > 0 && Number(notice.opacity) < 100
      ? { opacity: Number(notice.opacity) / 100 }
      : null)
  }
  const positionStyle = fixed
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        zIndex: 900,
        marginBottom: 0,
        ...(position === 'fixed-top' ? { top: 0 } : { bottom: 0 })
      }
    : { position: 'relative' }

  const fullText = notice.title ? `${notice.title}：${notice.content}` : notice.content
  const textNode = (
    <>
      {notice.title && <b className="notice-bar-title">{notice.title}</b>}
      <span className="notice-bar-content">{notice.content}</span>
    </>
  )
  const itemClass = vertical ? 'notice-bar-item notice-bar-item-block' : 'notice-bar-item'
  const marqueeClass = [
    'notice-bar-marquee',
    `notice-bar-marquee-${scroll}`,
    metrics.scrolling ? 'scrolling' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const copies = Math.max(1, metrics.copies)

  return (
    <Alert
      banner
      closable={!preview}
      type="info"
      showIcon
      className={`notice-bar-alert notice-bar-alert-${position}${preview ? ' notice-bar-alert-preview' : ''}`}
      style={{ ...positionStyle, ...colors }}
      onClose={preview ? undefined : onClose}
      message={
        <div
          className={`notice-bar-viewport${vertical ? ' notice-bar-viewport-vertical' : ''}`}
          style={vertical ? { maxHeight: `${viewportHeight}px` } : undefined}
          ref={viewportRef}
          title={fullText}
          role="status"
          aria-live="polite"
        >
          <span
            className={marqueeClass}
            style={{
              '--notice-duration': `${metrics.duration}s`,
              '--notice-shift': `${metrics.shift}px`,
              ...(notice.textColor ? { color: notice.textColor } : null)
            }}
          >
            {Array.from({ length: copies }, (_, index) => (
              <span
                key={index}
                className={itemClass}
                ref={index === 0 ? itemRef : undefined}
                aria-hidden={index > 0 ? 'true' : undefined}
              >
                {textNode}
              </span>
            ))}
          </span>
        </div>
      }
    />
  )
}

export default function NoticeBar({ slot = 'top' }) {
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    loadNotice().then((n) => {
      if (!n) return
      // notices 已按仲裁序（priority desc → updatedAt desc → id 升序）排序，
      // 因此每个槽位取「本槽位第一条」即该槽位的最高优先级公告；服务端未返回数组时回退单条。
      const pool = Array.isArray(n.notices) && n.notices.length > 0 ? n.notices : [n]
      const pick = pool.find(
        (item) =>
          item &&
          item.enabled &&
          item.content &&
          (item.display === 'bar' || item.display === 'both') &&
          slotOf(item.position) === slot
      )
      if (!pick) return
      try {
        if (localStorage.getItem(`notice-bar-closed-${pick.id}-${pick.updatedAt}`)) return
      } catch {}
      setNotice(pick)
    })
  }, [slot])

  if (!notice) return null

  const close = () => {
    try {
      localStorage.setItem(`notice-bar-closed-${notice.id}-${notice.updatedAt}`, '1')
    } catch {}
    setNotice(null)
  }

  return <NoticeBarView notice={notice} onClose={close} />
}
