import React, { useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { Layout, Menu, Typography } from 'antd'
import Upload from './pages/Upload.jsx'
import Retrieve from './pages/Retrieve.jsx'
import Admin from './pages/Admin.jsx'
import AdminFiles from './pages/AdminFiles.jsx'
import AdminSettings from './pages/AdminSettings.jsx'
import NoticeBar from './components/NoticeBar.jsx'
import { useSettings, logoUrlOf } from './hooks/useSettings.js'

const items = [
  { key: '/', label: <Link to="/">上传文件</Link> },
  { key: '/d', label: <Link to="/d">输入取件码</Link> }
]

export default function App() {
  const location = useLocation()
  const settings = useSettings()
  const isAdmin = location.pathname.startsWith('/admin')
  const selected =
    items
      .map((i) => i.key)
      .filter((key) =>
        key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)
      )
      .pop() || ''
  const siteName = settings?.siteName || '文件驿站 · 匿名共享'
  const logoUrl = logoUrlOf(settings)

  useEffect(() => {
    document.title = settings?.siteName
      ? `${settings.siteName} · 匿名文件共享`
      : '文件驿站 · 匿名文件共享'
  }, [settings])

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
              selectedKeys={selected ? [selected] : []}
              items={items}
              style={{ flex: 1, borderBottom: 'none', background: 'transparent', minWidth: 0 }}
            />
          </header>
          <NoticeBar />
        </>
      )}
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/d" element={<Retrieve />} />
        <Route path="/d/:code" element={<Retrieve />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/files" element={<AdminFiles />} />
        <Route path="/admin/settings" element={<AdminSettings />} />
        <Route
          path="*"
          element={
            <div className="page">
              <Typography.Title level={3}>页面不存在</Typography.Title>
              <Link to="/">返回首页</Link>
            </div>
          }
        />
      </Routes>
      {!isAdmin && (settings?.beian || settings?.gongan) && (
        <footer className="site-footer">
          {settings.beian && <span>{settings.beian}</span>}
          {settings.gongan && <span>{settings.gongan}</span>}
        </footer>
      )}
    </Layout>
  )
}
