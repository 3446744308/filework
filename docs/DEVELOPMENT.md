# 文件匿名共享 · 统一开发文档

> 本文档是项目的**唯一开发规范来源**。所有开发、评审、部署行为均以此为准。

---

## 1. 项目概述

一个类"快递驿站"的文件匿名共享服务：

- **寄件（上传）**：上传者上传一个文件，系统生成 **6 位纯数字取件码**，同时给出分享链接。
- **取件（下载）**：取件人**无需注册登录**，只需输入取件码即可下载。
- **销毁**：分享在 `有效期` 或 `下载次数` **任一**先耗尽时自动销毁（文件与元数据一并删除）。
- **管理**：提供一个简单管理页，凭管理员密钥查看/删除所有有效分享。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Node.js ≥ 18 + Express 4 + Multer 2 | ESM 模块（`"type": "module"`） |
| 前端 | Vite 6 + React 18 + Ant Design 5 | 构建产物 `web/dist` 由后端静态托管 |
| 路由 | react-router-dom 7 | 前端页面路由 |
| 存储 | 本地文件系统 `data/` | 每个分享一个元数据 JSON + 一个文件体 |
| 二维码 | qrcode-generator 2.0 | 前端生成取件二维码（库自身无运行时依赖） |
| 依赖管理 | npm | 单 `package.json`，前后端依赖统一安装 |

## 3. 目录结构

```
文件共享/
├── package.json              # 唯一的包清单，所有命令入口
├── vite.config.js            # root=web，产物输出 web/dist，dev 代理 /api
├── .env.example              # 环境变量样例（复制为 .env 使用）
├── .gitignore
├── README.md                 # 面向使用者的快速上手
├── docs/
│   └── DEVELOPMENT.md        # 本文件：开发统一规范
├── server/                   # 后端（全部 ESM）
│   ├── index.js              # Express 入口：API + 静态托管 + SPA 回退
│   ├── config.js             # 读取 .env/环境变量，输出不可变配置对象
│   ├── store.js              # 存储层：取件码生成、读写、消费、删除
│   ├── cleanup.js            # 定时清理过期/耗尽的分享
│   ├── notice.js             # 公告读写（data/notice.json）
│   ├── stats.js              # 累计计数器（data/stats.json）
│   ├── settings.js           # 站点设置（data/settings.json + logo 文件读写删除）
│   └── rate-limit.js         # 内存限流（防暴力破解、防滥用）
├── web/                      # 前端源码
│   ├── index.html
│   └── src/
│       ├── main.jsx          # React 挂载入口
│       ├── App.jsx           # 路由 + 布局（/admin 路由不渲染公共菜单栏；header 显示 logo/站点名）
│       ├── api.js            # 所有 HTTP 请求统一封装
│       ├── utils.js          # 格式化时间/大小等纯函数
│       ├── hooks/
│       │   ├── useAdminAuth.js   # 管理端鉴权：模块级单例状态（订阅通知）；login 先调 /api/admin/ping 服务端验证，401 不放行；logout 全局可调
│       │   └── useSettings.js    # 站点设置缓存：模块级单例 + 订阅；refreshSettings() 通知全站刷新
│       ├── components/
│       │   ├── AdminShell.jsx    # 管理端外壳：左侧边栏（仪表盘/文件管理/设置菜单）+ 登录守卫
│       │   ├── AdminLogin.jsx    # 双栏登录页（左产品介绍 / 右密钥表单）
│       │   ├── NoticeBar.jsx     # 顶部公告条（display=bar/both 时显示，关闭记录 updatedAt 版本；内容超宽时无缝跑马灯滚动，悬停暂停，60px/s）
│       │   └── WaybillReceipt.jsx # 发件快递面单回执（displayMode=waybill 时渲染；面单号/条码/寄收信息/打印与发送）
│       └── pages/
│           ├── Upload.jsx        # 上传页（首页）+ 公告弹窗
│           ├── Retrieve.jsx      # 取件页 /d/:code
│           ├── Admin.jsx         # 仪表盘 + 公告设置 /admin
│           ├── AdminFiles.jsx    # 文件管理 /admin/files
│           └── AdminSettings.jsx # 站点设置（名称/Logo/大小上限/黑名单/显示模式）/admin/settings
├── scripts/
│   ├── dev.js                # 并行启动后端 + Vite（零依赖实现）
│   └── test.js               # 端到端自动化测试（自启/自停服务器）
└── data/                     # 运行时数据（.gitignore，勿提交）
    ├── meta/<code>.json      # 元数据
    ├── files/<code>          # 文件体（无扩展名）
    ├── notice.json           # 公告（单例）
    ├── stats.json            # 累计计数器（单例）
    ├── settings.json         # 站点设置（单例）
    ├── logo.<ext>            # 站点 logo 图片（可选）
    └── tmp/                  # 上传中转目录，启动时清空
```

## 4. 环境变量（`server/config.js` 统一读取）

复制 `.env.example` 为 `.env` 后修改。环境变量优先于 `.env` 文件。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_KEY` | 随机生成并打印到控制台 | 管理页密钥，**生产环境必须显式设置** |
| `DATA_DIR` | `<项目根>/data` | 数据目录 |
| `MAX_FILE_SIZE` | `104857600`（100MB） | 单文件大小上限（字节） |
| `DEFAULT_EXPIRE_HOURS` | `24` | 默认有效期（小时） |
| `DEFAULT_MAX_DOWNLOADS` | `5` | 默认最大下载次数 |
| `RATE_LIMIT_MISSES` | `10` | 每 IP 每分钟允许的取件失败次数 |
| `UPLOAD_LIMIT_PER_MINUTE` | `10` | 每 IP 每分钟允许的上传次数 |

> **规则**：新增配置项必须同时更新 `.env.example` 与本表。

## 5. 数据模型

`data/meta/<code>.json`：

```json
{
  "code": "832451",
  "filename": "报告.pdf",
  "size": 1048576,
  "mime": "application/pdf",
  "note": "选填备注",
  "createdAt": 1760000000000,
  "expiresAt": 1760086400000,
  "maxDownloads": 5,
  "downloads": 1
}
```

- 时间统一为 **Unix 毫秒时间戳**（number）。
- `downloads` 表示已成功取件次数；剩余次数 = `maxDownloads - downloads`。
- 文件体存于 `data/files/<code>`，**不暴露真实路径**给客户端。

`data/notice.json`（公告，单例）：

```json
{
  "enabled": true,
  "title": "维护通知",
  "content": "本周日凌晨 2 点服务维护……",
  "display": "modal",
  "updatedAt": 1760000000000
}
```

- `title` ≤ 100 字符（可为空，前端默认显示「公告」），`content` ≤ 2000 字符。
- `content` 为空时保存会强制 `enabled=false`（空公告不弹窗）。
- `display` 显示方式白名单：`modal`（弹窗，默认）/ `bar`（顶部公告条）/ `both`（两者），非法值回退 `modal`。

`data/stats.json`（累计计数器，单例）：

```json
{ "totalUploads": 120, "totalDownloads": 345, "updatedAt": 1760000000000 }
```

- 每次上传成功 `totalUploads +1`（`store.commitUpload`），每次成功下载 `totalDownloads +1`（`store.tryConsume`）。
- `fileCount`/`totalSize`/`activeDownloads` 由 `listAll()` 实时聚合，不落盘。

`data/settings.json`（站点设置，单例）：

```json
{ "siteName": "我的驿站", "beian": "粤ICP备2024000000号", "gongan": "粤公网安备 44030402000000号", "logo": ".png", "maxFileSize": 52428800, "blockedExts": ["php", "exe"], "displayMode": "simple", "customCodeEnabled": true, "updatedAt": 1760000000000 }
```

- `siteName` ≤ 50 字符，空字符串 = 使用默认名称（前端 fallback「文件驿站 · 匿名共享」）。
- `beian` 备案号 ≤ 100 字符，空字符串 = 不显示；非空时公开页（非 `/admin`）底部页脚展示。
- `gongan` 公安备案号 ≤ 100 字符，空字符串 = 不显示；非空时公开页底部页脚展示（与 ICP 备案号并排）。
- `logo` 为扩展名（含点，如 `.png`），图片实体存于 `data/logo.<ext>`；空 = 未设置，前端不显示 logo。
- `maxFileSize` 单文件大小上限（**字节**），`0` = 使用环境变量 `MAX_FILE_SIZE` 默认值；保存时钳制到 `[1MB, MAX_FILE_SIZE]`，生效值 = `min(存储值, MAX_FILE_SIZE)`（`effectiveMaxFileSize()`，env 值同时是硬上限与默认值）。
- `blockedExts` 禁止上传的后缀黑名单（数组）；保存/读取均经 `normalizeExts`：小写、去前导点、过滤非 `^[a-z0-9]{1,20}$` 项、去重、最多 100 项。
- `displayMode` 发件成功页显示模式：`simple`（简约版，取件码+二维码，默认）/ `waybill`（快递面单回执）；非法值回退 `simple`。
- `customCodeEnabled` 是否允许自定义取件码（布尔，默认 `true`）；关闭后发件页隐藏输入框，`POST /api/upload` 忽略 `customCode` 参数改为随机生成。
- logo 另有独立端点 `GET /api/logo` 公开读取，`hasLogo` 由「扩展名非空 + 文件存在」共同判定。

## 6. 核心业务规则（必须遵守）

1. **取件码**：`crypto.randomInt(100000, 1000000)` 生成 6 位数字（100000–999999，无前导零）；若 meta 或文件已存在则重试，最多 50 次。
2. **失效判定**：`now > expiresAt` **或** `downloads ≥ maxDownloads` 即失效，失效即**物理删除** meta 与文件。
3. **消费原子性**：`store.tryConsume(code)` 必须用**同步**读-改-写完成计数，成功返回最新 meta，失败返回失败原因（`not_found` / `expired` / `exhausted`）。
4. **限流**：
   - 取件查询/下载：每 IP 每分钟失败 `RATE_LIMIT_MISSES` 次 → 返回 429。
   - 上传：每 IP 每分钟最多 10 次 → 返回 429。
5. **错误信息**：所有 API 错误返回 JSON `{ "error": "<中文提示>" }`，HTTP 码语义：400 参数错误 / 401 密钥错误 / 404 码不存在或已失效 / 413 文件过大 / 429 限流 / 500 内部错误。
6. **管理鉴权**：请求头 `x-admin-key`，使用 `crypto.timingSafeEqual` 恒定时间比较（长度不等时直接判失败）。

## 7. API 契约

| 方法 | 路径 | 参数 | 成功响应 |
|---|---|---|---|
| `POST` | `/api/upload` | multipart：`file`（必填）、`expiresIn`（小时，白名单 1/24/72/168）、`maxDownloads`（白名单 1/3/5/10）、`note`（选填备注，最长 200）、`customCode`（选填自定义取件码，6 位数字；被占用返回 409，非法则忽略并随机生成）、`password`（选填取件密码，≤64；SHA-256 哈希入库，明文不落盘不回传）；大小上限取 `effectiveMaxFileSize()`，后缀命中 `blockedExts` 拒绝 | `201` `{ code, filename, size, mime, note, hasPassword, createdAt, expiresAt, maxDownloads, downloads, clientIp }`（`clientIp` 仅供发件面单展示，不入库、不出现在 `/api/info`；`note` 入库并在 `/api/info` 返回；`hasPassword` 布尔）；超限 `413` 含 MB 提示；禁用类型 `400`；自定义码冲突 `409` |
| `POST` | `/api/verify-password` | JSON `{ code, password }` | `200` `{ ok: true }` 或 `403` 密码错误 / `404` 取件码无效 |
| `GET` | `/api/info?code=832451` | `code` 6 位数字 | `200` 同上结构（`publicInfo`，含 `hasPassword`，不含密码） |
| `GET` | `/api/download?code=832451` | `code`；设密时需 `password` query | `200` 文件流，`Content-Disposition: attachment`；密码缺失/错误 `403` |
| `GET` | `/api/admin/ping` | 头 `x-admin-key` | `200` `{ ok: true }`（登录前置验证用，轻量） |
| `GET` | `/api/admin/list` | 头 `x-admin-key` | `200` `{ list: [...] }` |
| `GET` | `/api/admin/stats` | 头 `x-admin-key` | `200` `{ fileCount, totalSize, activeDownloads, totalUploads, totalDownloads }` |
| `DELETE` | `/api/admin/:code` | 头 `x-admin-key` | `200` `{ ok: true }` |
| `GET` | `/api/notice` | 无（公开） | `200` `{ enabled, title, content, display, updatedAt }` |
| `PUT` | `/api/notice` | 头 `x-admin-key`，JSON body `{ enabled, title, content, display }` | `200` `{ ok: true, notice }` |
| `GET` | `/api/settings` | 无（公开） | `200` `{ siteName, beian, gongan, hasLogo, maxFileSize, maxFileSizeCap, blockedExts, displayMode, customCodeEnabled, updatedAt }`（前两者为生效值与环境上限，单位字节） |
| `PUT` | `/api/settings` | 头 `x-admin-key`，JSON body `{ siteName, beian, gongan, maxFileSize, blockedExts, displayMode, customCodeEnabled }`（maxFileSize ≤0 表示恢复默认；displayMode ∈ simple/waybill；customCodeEnabled 布尔） | `200` `{ ok: true, settings }` |
| `POST` | `/api/settings/logo` | 头 `x-admin-key`，multipart `logo`（PNG/JPG/WebP/SVG/GIF/ICO，≤2MB） | `200` `{ ok: true, settings }`；非图片 400；超限 413 |
| `DELETE` | `/api/settings/logo` | 头 `x-admin-key` | `200` `{ ok: true, settings }` |
| `GET` | `/api/logo` | 无（公开） | `200` 图片流；未设置 404 |
| `GET` | `/api/ip` | 无（公开） | `200` `{ ip }`：服务端请求 `openapi.lddgo.net/.../GetIp`（3s 超时，60s 内存缓存）取公网 IP，失败回退 `req.ip`；面单「IP / 地址」优先展示此值 |
| `GET` | `/api/health` | 无 | `200` `{ ok: true, features: [...] }`（features 为已部署功能标记，用于快速自检服务器代码是否为新版本） |

## 8. 前端页面

| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | Upload | **三步发件流程**（antd `Steps`）：①**上传文件** = `Upload.Dragger` 单文件 + 自定义已选文件卡片（类型图标/名称/大小/删除），点「下一步」进入 ②**填写收件信息** = 已选文件展示 + 有效期/次数下拉 + **自定义取件码**（选填 6 位数字，受 `customCodeEnabled` 开关控制，被占用时 `Modal.confirm` 询问是否自动生成）+ 选填备注 `Input.TextArea`（≤200），「上一步」/「确认发件」（此时才真正 `POST /api/upload`，上传中显示进度条）；成功后 ③**发件回执** = 按 `settings.displayMode` 分支：**简约版** = antd `Result`（取件码与二维码、复制操作、文件信息）；**快递面单**（`WaybillReceipt`）= 品牌/发件时间/面单号/条码/三列虚线分栏/四格承诺/打印与发送（寄件方 IP 优先取 `/api/ip` 公网地址，失败回退 `clientIp`；寄件方「文件备注」展示 `note`）；回执页均有「继续发件/返回首页」；进入首页拉取 `/api/notice`；上传前按 `settings.maxFileSize` 与 `blockedExts` 预检 |
| `/d/:code` | Retrieve | 与发件页同构：`.page`（860px）宽卡片 + 左对齐 `Title`（取件 · 下载文件）/`Paragraph` 头部；取件码输入改为 `Modal` 弹窗（`destroyOnHidden`，`Input.OTP` 输满 6 位纯数字自动提交、回车/确定按钮均可，进入 `/d` 无码时自动弹出，空态/错误态/结果页均提供重新输入入口）；四类状态：加载中 `Spin` / 错误 `Alert`+重新输入按钮 / 空态 `Empty`+输入按钮 / 命中态；`displayMode==='waybill'` 时命中态渲染 `PickupWaybill`（取件回执：取件码栏+文件信息栏，含备注），`page-wide` 宽卡片；简约模式仍用 antd `Result`（status=success：标题「文件已就绪」、subTitle 文件名 break-all、extra 用 `.result-hero` 承载 `.stat-row` 统计卡，灰底 content 区放下载按钮、有效期提示与「换个取件码」；`.ant-result.retrieve-result` 紧凑样式压缩图标/标题/内边距；≤480px 移动端进一步自适应（页面与卡片边距收紧、统计卡 2 列/≤360px 单列、下载按钮整行、图标 36px、OTP 高度 44px），防止小屏内容溢出视口） |
| `/admin` | Admin | 管理端外壳 `AdminShell`（未登录渲染双栏登录页）；**仪表盘**（有效文件/总大小/累计下载/累计上传）+ **公告设置**（开关 / 显示方式：弹窗·顶部公告条·两者 / 标题 / 内容） |
| `/admin/files` | AdminFiles | 独立**文件管理**页：搜索过滤（取件码/文件名/备注）、备注列、多选批量删除、下载进度条、剩余时间、可调分页（10/20/50/100） |
| `/admin/settings` | AdminSettings | **站点设置**页：站点名称（Input ≤50，留空用默认）+ **备案号**（Input ≤100，可选，留空不显示）+ **公安备案号**（Input ≤100，可选，留空不显示）+ Logo（上传/更换/删除，可选，未设置不显示）+ **单文件上传大小上限**（InputNumber 1–MAX_FILE_SIZE MB，默认 env 值）+ **禁止上传的文件类型**（Select tags，后缀黑名单）+ **前端显示样式**（Select：简约版 simple / 快递面单 waybill）+ **自定义取件码开关**（Switch，控制发件页是否显示自定义码输入框），保存后通过 `refreshSettings()` 通知全站刷新 |

**UI 约定**：
- **布局分区**：公共顶部菜单栏（`.site-header`，**logo（如有）+ 站点名称** + 上传/取件菜单）**仅在非 `/admin` 路由渲染**（`App.jsx` 按 `isAdmin` 判断），公共页在 header 下渲染 `NoticeBar` 顶部公告条（**文字超出视口宽度时自动无缝滚动**：`scrollWidth > clientWidth` 触发，两份副本 `translateX(-50%)` 循环，时长按内容宽/60px/s 计算且 ≥6s，悬停暂停，窗口 resize 重测）；`document.title` 同步为站点名称。站点设置通过 `useSettings()` 模块级缓存订阅（保存后 `refreshSettings()` 通知所有消费方）；`settings.beian` / `settings.gongan` 任一非空时，公开页（非 `/admin`）底部渲染 `.site-footer` 备案页脚（均空则不渲染；flex 并排、`marginTop:auto` 吸底，无背景色）。管理端统一由 `AdminShell` 渲染为**左侧边栏布局**（`.admin-layout`）：未登录 → 双栏登录页；已登录 → 深色侧边栏（品牌（logo/站点名） / **仪表盘 · 文件管理 · 设置**菜单 / 返回首页 · 退出，宽 220px，可折叠至 72px，≤768px 自动折叠）+ 右侧内容区（`.admin-inner`，**max-width 1400px**，仪表盘与表格使用整宽），`/admin`、`/admin/files`、`/admin/settings` 共用该外壳，不与主页共用菜单。
- 使用 Ant Design 全量引入（`import { App as AntApp } from 'antd'` 统一 message/notification）。
- 中文文案，`dayjs` 时间格式 `YYYY-MM-DD HH:mm`。
- 页面标题统一在 `App.jsx` 布局中，不在各页重复。

## 9. 命令约定

| 命令 | 作用 |
|---|---|
| `npm install` | 安装全部依赖 |
| `npm run dev` | 开发模式：后端 :3000 + 前端 :5173（代理 `/api`） |
| `npm run build` | 构建前端到 `web/dist` |
| `npm start` | 生产启动（读取 `web/dist`） |
| `npm test` | 端到端测试（自动启停服务器，端口 3999） |

## 10. 开发流程规范

1. **改后端**：改 `server/*.js` → `npm test` 必须通过。
2. **改前端**：改 `web/src/**` → `npm run build` 无报错 → 手动走一遍 `/`、`/d/码`、`/admin`。
3. **新增接口**：必须同步更新本文件第 7 节契约表 + `scripts/test.js` 增加用例。
4. **新增依赖**：优先零依赖实现；确需依赖时记录在本文档第 2 节。
5. **代码风格**：ESM、2 空格缩进、单引号、分号结尾；不写行内注释（文档即注释来源）。

## 11. 部署

```bash
npm install
cp .env.example .env      # 修改 ADMIN_KEY、PORT 等
npm run build
npm start
```

Windows 下复制为 `copy .env.example .env`。生产环境建议用 pm2 或 NSSM 守护：`pm2 start server/index.js --name file-share`。

## 12. 安全清单（上线前逐项确认）

- [ ] `.env` 已设置强随机 `ADMIN_KEY`，且 `.env` 在 `.gitignore` 中
- [ ] `data/` 目录权限仅服务账号可读写
- [ ] 已限制 `MAX_FILE_SIZE`
- [ ] 反向代理（如 Nginx）限制请求体大小与上传带宽
- [ ] 限流参数符合预期（`RATE_LIMIT_MISSES`）
