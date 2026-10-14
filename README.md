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
| 传输优化 | 自适应单元容器（内容定界切分 + 单元级去重 + raw/gzip/brotli 择优）+ 应用层分片会话 | 磁盘与带宽双降：存储态编码直接上线、浏览器自动解压，下载分片由服务端自适应计划 |
| 密码哈希 | Node.js crypto（SHA-256） |

## 传输协议

| 场景 | 协议 / 方法 | 说明 |
|---|---|---|
| 上传文件 | HTTP `POST` /api/upload | `multipart/form-data`，单文件字段名 `file`，附带 `expiresIn`、`maxDownloads`、`note`、`customCode`、`password` 等表单字段 |
| 查询分享信息 | HTTP `GET` /api/info | Query 参数 `code`，返回 JSON（含 `hasPassword` 布尔） |
| 验证取件密码 | HTTP `POST` /api/verify-password | JSON body `{ code, password }`，服务端 SHA-256 常量时间比对，错误返回 403 |
| 下载文件 | HTTP `GET` /api/download | Query 参数 `code`（及设密时的 `password`），响应 `Content-Disposition: attachment` 文件流 |
| 分片上传 | HTTP `POST/PUT` /api/upload/init、/api/upload/part、/api/upload/complete | 大文件按分片 3 路并行上传（分片大小 `TRANSFER_PART_SIZE`，默认 4MB） |
| 分片下载 | HTTP `POST` /api/download/session、`GET` /api/download/part、`POST` /api/download/end | 会话制并行分片（并发 2~8 自适应），一次下载只消耗 1 次；分片范围由服务端自适应计划下发 |
| 传输压缩 | HTTP `Content-Encoding` 协商 | 分片按客户端 `Accept-Encoding` 直发存储态 gzip/brotli（0 拷贝重编码），浏览器网络层自动解压；未声明支持时发原始字节 |
| 意见反馈 | HTTP `POST` /api/feedback、`GET` /api/feedback/query | 提交后返回反馈号（`FB-` + 8 位数字），凭号查询处理进度；管理端可回复与删除 |
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
npm test            # 接口/存储/传输压缩对抗用例（自启自停服务器）
npm run e2e         # 真实浏览器验证（headless Chrome + CDP，无 Chrome 时自动跳过）
```

## 配置

复制 `.env.example` 为 `.env` 后修改（生产环境务必设置 `ADMIN_KEY`）：

```bash
PORT=3000
ADMIN_KEY=你的管理密钥
MAX_FILE_SIZE=104857600
TRANSFER_PART_SIZE=4194304
```

## 使用说明

| 页面 | 地址 | 说明 |
|---|---|---|
| 上传（寄件） | `/` | 拖入文件，选择有效期与下载次数，可选自定义取件码与取件密码（高级设置），获得取件码与取件二维码；成功页可在管理后台切换为「快递面单」回执样式（含面单号）；管理员配置的公告会在此页弹窗展示；可压缩文件自动写入自适应单元容器（去重 + 多编解码择优，管理端可关），>1MB 文件自动分片并行上传 |
| 取件 | `/d/取件码` 或首页输入取件码 | 输入 6 位取件码即可下载；若分享设有取件密码，需先输入密码验证；>1MB 文件自动并行分片下载，进度区实时显示速率与「传输压缩已省百分比」，由浏览器自动解压 |
| 关于 | `/about` | 服务说明、使用步骤、主要特性与开源地址 |
| 反馈 | `/feedback` | 提交问题反馈 / 功能建议，成功后生成反馈号（`FB-` + 8 位数字），可复制保存 |
| 查询反馈 | `/feedback-query` | 输入反馈号查看处理进度与官方回复 |
| 管理 | `/admin` | 输入管理密钥：配置首页公告、站点名称/Logo/备案号、上传上限、禁止类型、显示模式、自定义取件码开关、存储压缩开关；仪表盘展示实际占用与压缩节省；查看/删除所有有效分享；反馈管理页可改状态、回复（含回复模板）与删除（导航栏不显示此入口，需直接输入地址） |

页脚展示站点配置里的 ICP 备案号与公安备案号（均支持留空隐藏）。数据保存在 `data/` 目录，分享失效后文件自动删除。

开发规范与 API 契约见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；App / 第三方开发者请看 [docs/API.md](docs/API.md)（完整 HTTP 接口文档，含请求/响应示例与 curl）。
