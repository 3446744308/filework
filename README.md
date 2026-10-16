# 文件驿站 · 匿名文件共享

类快递驿站的匿名文件共享服务：**上传文件 → 得到 6 位取件码 → 对方输入取件码下载**。
无需注册登录，文件在有效期或下载次数耗尽后自动销毁。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端运行时 | Node.js ≥ 18（ES Modules） |
| 后端框架 | Express 4 |
| 文件上传解析 | Multer 2（multipart/form-data） |
| 前端框架 | React 18 + React Router 7 |
| UI 组件库 | Ant Design 5 + @ant-design/icons |
| 二维码 | qrcode-generator |
| 构建工具 | Vite 6 + @vitejs/plugin-react |
| 密码哈希 | Node.js crypto（SHA-256） |

## 传输协议

| 场景 | 协议 / 方法 | 说明 |
|---|---|---|
| 上传文件 | HTTP `POST` /api/upload | `multipart/form-data`，单文件字段名 `file`，附带 `expiresIn`、`maxDownloads`、`note`、`customCode`、`password` 等表单字段 |
| 查询分享信息 | HTTP `GET` /api/info | Query 参数 `code`，返回 JSON（含 `hasPassword` 布尔） |
| 验证取件密码 | HTTP `POST` /api/verify-password | JSON body `{ code, password }`，服务端 SHA-256 常量时间比对，错误返回 403 |
| 下载文件 | HTTP `GET` /api/download | Query 参数 `code`（及设密时的 `password`），响应 `Content-Disposition: attachment` 文件流 |
| 在线预览 | HTTP `GET` /api/preview | 与下载同参数，响应 `inline` 文件流；仅图片/视频/文本，每次预览同样消耗 1 次次数 |
| 管理接口 | HTTP `GET/PUT/DELETE` /api/admin/* | 请求头 `x-admin-key` 鉴权，JSON 响应 |
| 前端 SPA | HTTP `GET` / | Express 静态托管 `web/dist`，非 API 路径回退 `index.html` |

> 本服务默认走 HTTP；生产环境如需 HTTPS，建议在前面加 Nginx / Caddy 等反向代理终止 TLS。

## 快速开始

```bash
npm install          # 安装依赖
npm run build        # 构建前端
npm start            # 启动服务，默认 http://localhost:3000
```

开发模式（前端热更新）：

```bash
npm run dev          # 后端 :3000 + 前端 :5173（打开 http://localhost:5173）
```

运行自动化测试：

```bash
npm test
```

## 配置

复制 `.env.example` 为 `.env` 后修改（生产环境务必设置 `ADMIN_KEY`）：

```bash
PORT=3000
ADMIN_KEY=你的管理密钥
MAX_FILE_SIZE=104857600
```

## 使用说明

| 页面 | 地址 | 说明 |
|---|---|---|
| 上传（寄件） | `/` | 拖入文件，选择有效期与下载次数，可选自定义取件码与取件密码（高级设置），获得取件码与取件二维码；成功页可在管理后台切换为「快递面单」回执样式（含面单号）；管理员配置的公告会在此页弹窗展示 |
| 取件 | `/d/取件码` 或首页输入取件码 | 输入 6 位取件码即可下载；若分享设有取件密码，需先输入密码验证；图片/视频/文本文件可在下载按钮旁点击「预览」在线查看（每次预览同样消耗 1 次次数，点击前会弹窗确认） |
| 管理 | `/admin` | 输入管理密钥：配置首页公告、站点名称/Logo、上传上限、禁止类型、显示模式、自定义取件码开关；查看所有寄件记录（含「生效中 / 已失效」状态与筛选），可单条删除或一键清空已失效记录（导航栏不显示此入口，需直接输入地址） |

数据保存在 `data/` 目录；分享失效（过期或下载次数耗尽）后文件自动销毁，记录留存并标记为「已失效」，可在管理端清空。

开发规范与 API 契约见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

App / 第三方开发者请看 [docs/API.md](docs/API.md)（完整 HTTP 接口文档，含请求/响应示例与 curl）。
