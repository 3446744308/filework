import React, { useEffect, useState } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, Drawer, Layout, Menu, Result, Typography } from 'antd'
import {
  DownloadOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  MessageOutlined,
  MoreOutlined,
  SearchOutlined,
  SendOutlined
} from '@ant-design/icons'
import Upload from './pages/Upload.jsx'
import Retrieve from './pages/Retrieve.jsx'
import Admin from './pages/Admin.jsx'
import AdminFiles from './pages/AdminFiles.jsx'
import AdminSettings from './pages/AdminSettings.jsx'
import AdminFeedback from './pages/AdminFeedback.jsx'
import About from './pages/About.jsx'
import Feedback from './pages/Feedback.jsx'
import FeedbackQuery from './pages/FeedbackQuery.jsx'
import Changelog from './pages/Changelog.jsx'
import NoticeBar from './components/NoticeBar.jsx'
import { useSettings, logoUrlOf } from './hooks/useSettings.js'

const items = [
  {
    key: '/',
    label: (
      <Link to="/" className="menu-item-label">
        <SendOutlined />
        上传文件
      </Link>
    )
  },
  {
    key: '/d',
    label: (
      <Link to="/d" className="menu-item-label">
        <DownloadOutlined />
        输入取件码
      </Link>
    )
  },
  {
    key: 'more',
    label: (
      <span className="menu-item-label">
        <MoreOutlined />
        其他
      </span>
    ),
    children: [
      {
        key: '/about',
        label: (
          <Link to="/about" className="menu-item-label">
            <InfoCircleOutlined />
            关于
          </Link>
        )
      },
      {
        key: '/feedback',
        label: (
          <Link to="/feedback" className="menu-item-label">
            <MessageOutlined />
            反馈
          </Link>
        )
      },
      {
        key: '/feedback-query',
        label: (
          <Link to="/feedback-query" className="menu-item-label">
            <SearchOutlined />
            查询反馈
          </Link>
        )
      },
      {
        key: '/changelog',
        label: (
          <Link to="/changelog" className="menu-item-label">
            <HistoryOutlined />
            更新日志
          </Link>
        )
      }
    ]
  }
]

function matchSelected(pathname) {
  let selected = ''
  for (const item of items) {
    if (item.children) {
      for (const child of item.children) {
        if (pathname === child.key || pathname.startsWith(child.key + '/')) selected = child.key
      }
    } else if (item.key === '/' ? pathname === '/' : pathname.startsWith(item.key)) {
      selected = item.key
    }
  }
  return selected
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const settings = useSettings()
  const isAdmin = location.pathname.startsWith('/admin')
  const selected = matchSelected(location.pathname)
  const siteName = settings?.siteName || '文件驿站 · 匿名共享'
  const logoUrl = logoUrlOf(settings)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    document.title = settings?.siteName
      ? `${settings.siteName} · 匿名文件共享`
      : '文件驿站 · 匿名文件共享'
  }, [settings])

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  return (
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      {!isAdmin && (
        <>
          <header className="site-header">
            <span className="site-brand">
              {logoUrl && <img className="site-logo" src={logoUrl} alt="" />}
              <span className="site-title">{siteName}</span>
            </span>
            <Menu
              mode="horizontal"
              className="site-header-menu"
              selectedKeys={selected ? [selected] : []}
              items={items}
            />
            <Button
              className="site-header-burger"
              type="text"
              aria-label="打开菜单"
              icon={<MenuOutlined />}
              onClick={() => setDrawerOpen(true)}
            />
          </header>
          <Drawer
            placement="right"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            width={260}
            title={
              <span className="site-brand">
                {logoUrl && <img className="site-logo" src={logoUrl} alt="" />}
                <span className="site-title">{siteName}</span>
              </span>
            }
          >
            <Menu
              mode="inline"
              className="mobile-drawer-menu"
              selectedKeys={selected ? [selected] : []}
              items={items}
              onClick={() => setDrawerOpen(false)}
            />
          </Drawer>
          <NoticeBar />
        </>
      )}
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/d" element={<Retrieve />} />
        <Route path="/d/:code" element={<Retrieve />} />
        <Route path="/about" element={<About />} />
        <Route path="/feedback" element={<Feedback />} />
        <Route path="/feedback-query" element={<FeedbackQuery />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/files" element={<AdminFiles />} />
        <Route path="/admin/settings" element={<AdminSettings />} />
        <Route path="/admin/feedback" element={<AdminFeedback />} />
        <Route
          path="*"
          element={
            <div className="page page-compact-bottom page-404">
              <Card className="notfound-card">
                <Result
                  icon={<div className="notfound-hero">404</div>}
                  title="页面不存在"
                  subTitle="请检查链接是否输入正确，或从下方按钮返回"
                  extra={[
                    <Button key="back" onClick={() => navigate(-1)}>
                      返回上一页
                    </Button>,
                    <Button key="home" type="primary" onClick={() => navigate('/')}>
                      返回首页
                    </Button>
                  ]}
                />
              </Card>
            </div>
          }
        />
      </Routes>
      {!isAdmin && (
        <footer className="site-footer">
          {(settings?.beian || settings?.gongan) && (
            <div className="site-footer-row">
              {settings.beian && (
                <span className="site-footer-item">
                  <img className="site-footer-icon" src="/icons/icp.webp" alt="ICP 备案" />
                  {settings.beian}
                </span>
              )}
              {settings.gongan && (
                <span className="site-footer-item">
                  <img className="site-footer-icon" src="/icons/gonganbeian.png" alt="公安备案" />
                  {settings.gongan}
                </span>
              )}
            </div>
          )}
          <div className="site-footer-copy">
            © 2025-{Math.max(new Date().getFullYear(), 2026)} YayaLe, FanKunLe. All Rights Reserved.
          </div>
        </footer>
      )}
    </Layout>
  )
}
