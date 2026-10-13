import React, { useEffect, useState } from 'react'
import { Menu } from 'antd'
import {
  DashboardOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SettingOutlined
} from '@ant-design/icons'
import { Link, useLocation } from 'react-router-dom'
import { useAdminAuth } from '../hooks/useAdminAuth.js'
import { useSettings, logoUrlOf } from '../hooks/useSettings.js'
import AdminLogin from './AdminLogin.jsx'

const MENU_ITEMS = [
  { key: '/admin', icon: <DashboardOutlined />, label: <Link to="/admin">仪表盘</Link> },
  {
    key: '/admin/files',
    icon: <FolderOpenOutlined />,
    label: <Link to="/admin/files">文件管理</Link>
  },
  {
    key: '/admin/feedback',
    icon: <MessageOutlined />,
    label: <Link to="/admin/feedback">反馈管理</Link>
  },
  {
    key: '/admin/settings',
    icon: <SettingOutlined />,
    label: <Link to="/admin/settings">设置</Link>
  }
]

export default function AdminShell({ children }) {
  const { authorized, checking, login, logout } = useAdminAuth()
  const settings = useSettings()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768)

  useEffect(() => {
    const onResize = () => setCollapsed(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!authorized) return <AdminLogin onLogin={login} checking={checking} />

  const selected = location.pathname.startsWith('/admin/files')
    ? '/admin/files'
    : location.pathname.startsWith('/admin/feedback')
      ? '/admin/feedback'
      : location.pathname.startsWith('/admin/settings')
        ? '/admin/settings'
        : '/admin'
  const sidebarLogo = logoUrlOf(settings)

  return (
    <div className="admin-layout">
      <aside className={`admin-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-head">
          <Link to="/admin" className="sidebar-brand">
            {sidebarLogo ? (
              <img className="sidebar-logo" src={sidebarLogo} alt="" />
            ) : (
              <SafetyCertificateOutlined />
            )}
            {!collapsed && (
              <span className="sidebar-brand-text">{settings?.siteName || '文件驿站'}</span>
            )}
          </Link>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-label="折叠菜单"
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>

        <Menu
          theme="dark"
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={[selected]}
          items={MENU_ITEMS}
          className="sidebar-menu"
        />

        <div className="sidebar-foot">
          <Link to="/" className="sidebar-foot-btn">
            <HomeOutlined />
            {!collapsed && <span>返回首页</span>}
          </Link>
          <button type="button" className="sidebar-foot-btn" onClick={logout}>
            <SafetyCertificateOutlined />
            {!collapsed && <span>退出登录</span>}
          </button>
        </div>
      </aside>

      <main className="admin-content">
        <div className="admin-inner">{children}</div>
      </main>
    </div>
  )
}
