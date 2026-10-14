# 文件驿站 · API 开发文档

> 面向移动端 / 第三方应用开发者。所有接口均为 HTTP/HTTPS + JSON（下载接口为文件流），无需 Cookie / Session，凭取件码即可操作。
>
> **机器可读版本**：同目录下 [openapi.json](./openapi.json)（OpenAPI 3.0），可直接导入 Apifox / Postman / Swagger UI。

---

## 1. 概述

| 项 | 值 |
|---|---|
| Base URL | `http://<host>:<port>`（生产建议 HTTPS 反代） |
| 字符编码 | UTF-8 |
| 时间格式 | Unix **毫秒**时间戳（number） |
| 鉴权 | 公开接口无鉴权；管理接口需请求头 `x-admin-key` |
| 限流 | 见 [限流规则](#限流规则) |

### 1.1 通用响应结构

**成功**：HTTP 2xx，Body 为 JSON（或下载接口的文件流）。

**失败**：HTTP 4xx / 5xx，Body 统一为：

```json
{ "error": "中文错误提示" }
```

### 1.2 错误码速查

| HTTP | 含义 | 常见触发 |
|---|---|---|
| 400 | 参数错误 | 取件码格式不对、文件为空、类型被禁 |
| 401 | 管理密钥错误 | `x-admin-key` 缺失或不匹配 |
| 403 | 密码错误 | 取件密码不匹配 |
| 404 | 资源不存在/已失效 | 取件码无效、已过期、次数耗尽 |
| 409 | 冲突 | 自定义取件码已被占用 |
| 413 | 文件过大 | 超过 `maxFileSize` |
| 429 | 触发限流 | 失败次数或上传频率超限 |
| 500 | 服务器内部错误 | 存储失败等 |

---

## 2. 公开接口（App 核心流程）

### 2.1 健康检查

```
GET /api/health
```

无需参数。用于探测服务版本与已部署功能。

**响应 200**

```json
{
  "ok": true,
  "features": [
    "siteSettings", "maxFileSize", "blockedExts",
    "noticeDisplay", "displayMode", "waybill",
    "publicIp", "customCode", "password",
    "compression", "chunkedUpload", "parallelDownload", "downloadSession",
    "transferCompression", "adaptiveChunking", "unitDedup", "multiCodec",
    "transferStats", "codecToggle", "transferExport", "uploadResume",
    "downloadResume", "sessionQuota", "multiNotice", "compressQueue",
    "crossFileDedup", "beian", "gongan", "feedback"
  ],
  "notice": { "total": 1, "active": 1, "winnerId": "default", "nextChangeAt": null },
  "compressQueue": { "pending": 0, "running": 0, "done": 3, "failed": 0 },
  "dedup": { "enabled": false, "objects": 0, "bytes": 0, "lastGcRemoved": 0, "lastGcAt": 0 }
}
```

`features` 为功能标记数组，App 可据此判断服务器是否支持某能力（如 `"password"` 表示支持取件密码、`"chunkedUpload"` 表示支持分片上传、`"uploadResume"` 表示支持断点续传）。除 `ok` / `features` 外还会附带 `notice`（公告槽位统计）、`compressQueue`（压缩后台队列）与 `dedup`（跨文件去重开关与对象统计）三段运行时快照。

---

### 2.2 获取站点设置

```
GET /api/settings
```

**响应 200**

```json
{
  "siteName": "我的驿站",
  "beian": "粤ICP备2024000000号",
  "gongan": "粤公网安备 44030402000000号",
  "hasLogo": true,
  "maxFileSize": 104857600,
  "maxFileSizeCap": 104857600,
  "blockedExts": ["exe", "php"],
  "displayMode": "simple",
  "customCodeEnabled": true,
  "compressionEnabled": true,
  "compressionCodecs": "br,gzip",
  "compressionCodecCap": "br,gzip",
  "presetLimit": 10,
  "presetLimitCap": 50,
  "updatedAt": 1760000000000
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `siteName` | string | 站点名称，空串表示使用默认名 |
| `beian` | string | 备案号，空串表示不显示 |
| `gongan` | string | 公安备案号，空串表示不显示 |
| `hasLogo` | boolean | 是否已设置站点 Logo |
| `maxFileSize` | number | 生效的单文件上限（字节） |
| `maxFileSizeCap` | number | 环境变量硬上限（字节），`maxFileSize ≤ maxFileSizeCap` |
| `blockedExts` | string[] | 禁止上传的后缀（无点、小写） |
| `displayMode` | string | `simple` 简约 / `waybill` 面单 |
| `customCodeEnabled` | boolean | 是否允许自定义取件码 |
| `compressionEnabled` | boolean | 是否开启存储压缩（可压缩类型自动写入自适应单元容器） |
| `compressionCodecs` | string | 生效的压缩编码候选，`br,gzip` 双试 / 仅 `gzip` |
| `compressionCodecCap` | string | 环境变量 `COMPRESS_CODECS` 给的硬上限，为 `gzip` 时前端不允许切双试 |
| `presetLimit` | number | 公告预设上限（生效值） |
| `presetLimitCap` | number | 公告预设上限的环境硬上限（`MAX_NOTICE_PRESETS`） |

App 建议：上传前用 `maxFileSize` 做本地预检，用 `blockedExts` 拦截明显不合法类型。

---

### 2.3 读取站点 Logo

```
GET /api/logo
```

**响应 200**：图片二进制流（Content-Type 为图片 MIME）。  
**响应 404**：未设置 Logo。

---

### 2.4 获取公告

```
GET /api/notice
```

**响应 200**

```json
{
  "id": "default",
  "enabled": true,
  "title": "维护通知",
  "content": "本周日凌晨 2 点服务维护……",
  "display": "modal",
  "position": "top",
  "scroll": "none",
  "priority": 0,
  "startAt": null,
  "endAt": null,
  "bgColor": "",
  "textColor": "",
  "fontSize": 0,
  "radius": 0,
  "opacity": 0,
  "maxLines": 1,
  "rev": 3,
  "updatedAt": 1760000000000,
  "notices": [
    { "id": "default", "enabled": true, "title": "维护通知", "content": "本周日凌晨 2 点服务维护……", "priority": 0 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用；App 仅在 `true` 时展示 |
| `title` | 标题，可为空（建议 fallback「公告」） |
| `content` | 正文（≤2000 字） |
| `display` | `modal` 弹窗 / `bar` 顶部条 / `both` 两者 |
| `position` | 普通条位置：`top` / `bottom`（前端按槽位渲染） |
| `scroll` | 滚动方式：`none` / `left` / `right` / `up` / `bounce` |
| `bgColor` / `textColor` | 自定义配色，空串表示跟随主题 |
| `fontSize` / `radius` / `opacity` | 字号 / 圆角 / 不透明度，`0` 表示跟随默认 |
| `maxLines` | 普通条纵向行数上限：`1` / `2` / `3` |
| `priority` | 仲裁优先级 `0~100`（≥100 抢占弹窗位） |
| `startAt` / `endAt` | 投放时间窗（毫秒时间戳，`null` 表示不限）；请求时求值，到点自动生效/下线 |
| `rev` | 公告存储版本号，写接口的回写校验基准（冲突返回 409） |
| `notices` | 当前生效的全部公告，已按仲裁序（优先级→时间窗→更新时间）排好 |

> **顶层字段 = 仲裁胜者**。单公告时代的 App 只读顶层字段即可继续工作；多公告能力见 [§9.5](#95-多公告与预设管理) 。

---

### 2.5 获取公网 IP

```
GET /api/ip
```

**响应 200**：`{ "ip": "1.2.3.4" }`  
用于展示/记录寄件方公网地址，App 可选调用。

---

### 2.6 上传文件

```
POST /api/upload
Content-Type: multipart/form-data
```

**表单字段**

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `file` | 是 | 文件 | 单文件 |
| `expiresIn` | 否 | number | 有效期（小时），白名单 `1 / 24 / 72 / 168`，非法值回退默认 `24` |
| `maxDownloads` | 否 | number | 最大下载次数，白名单 `1 / 3 / 5 / 10`，非法值回退默认 `5` |
| `note` | 否 | string | 备注，≤200 字符 |
| `customCode` | 否 | string | 自定义取件码，6 位数字；若 `customCodeEnabled=false` 则被忽略；非法则忽略并随机生成；冲突返回 409 |
| `password` | 否 | string | 取件密码，≤64 字符；服务端仅存 SHA-256 哈希，**明文永不回传** |

**响应 201**

```json
{
  "code": "832451",
  "filename": "报告.pdf",
  "size": 1048576,
  "storedSize": 327680,
  "mime": "application/pdf",
  "note": "选填备注",
  "hasPassword": true,
  "createdAt": 1760000000000,
  "expiresAt": 1760086400000,
  "maxDownloads": 5,
  "downloads": 0,
  "compressionState": "pending",
  "compressed": false,
  "clientIp": "1.2.3.4"
}
```

| 字段 | 说明 |
|---|---|
| `code` | 6 位取件码，App 应引导用户分享此码或 `/d/<code>` 链接 |
| `hasPassword` | 是否设有取件密码（布尔，不含密码本身） |
| `storedSize` | 当前落盘字节数；压缩为后台任务，可能随后变小 |
| `compressionState` | `pending`（压缩排队中）/ 空串（无需压缩或已完成） |
| `compressed` | 是否已压入自适应单元容器；`pending` 时先用 `/api/upload/job` 轮询到 `finished` 再取最终值 |
| `clientIp` | 仅上传响应回传，`/api/info` 不返回；可选展示 |
| `createdAt` / `expiresAt` | Unix 毫秒时间戳 |

> 大文件建议改走分片上传与断点续传（`/api/upload/init` → `/api/upload/part` → `/api/upload/complete`），详见 [§9.1](#91-分片上传与断点续传) 。

**错误**

| 状态码 | 场景 |
|---|---|
| 400 | 未选文件 / 文件为空 / 类型被 `blockedExts` 禁止 |
| 409 | `customCode` 已被占用 |
| 413 | 超过 `maxFileSize` |
| 429 | 上传频率超限 |

**建议 App 流程**

1. 本地校验大小与后缀（用 `/api/settings` 返回值）。
2. 用 XHR / OkHttp / AFNetworking 等支持**上传进度**的方式发送。
3. 成功后缓存 `code`、`filename`、`hasPassword`，引导用户复制或生成分享卡片。

---

### 2.7 查询分享信息

```
GET /api/info?code=832451
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `code` | 是 | 6 位数字取件码 |

**响应 200**

```json
{
  "code": "832451",
  "filename": "报告.pdf",
  "size": 1048576,
  "mime": "application/pdf",
  "note": "选填备注",
  "hasPassword": true,
  "createdAt": 1760000000000,
  "expiresAt": 1760086400000,
  "maxDownloads": 5,
  "downloads": 1
}
```

> 不含 `clientIp`，不含 `password` 哈希。

**错误**：`400` 格式不对 / `404` 不存在或已失效 / `429` 失败次数超限。

**App 建议**

- `hasPassword === true` 时，下载前先弹密码输入框。
- `downloads` / `maxDownloads` 可计算剩余次数：`maxDownloads - downloads`。

---

### 2.8 验证取件密码（可选，推荐）

```
POST /api/verify-password
Content-Type: application/json
```

```json
{ "code": "832451", "password": "secret123" }
```

**响应 200**：`{ "ok": true }`  
**错误**：`400` 格式不对 / `403` 密码错误 / `404` 码无效 / `429` 限流。

> 本接口**不消耗下载次数**，仅校验密码，适合在下载前做前置校验并给出友好提示。

---

### 2.9 下载文件

```
GET /api/download?code=832451
GET /api/download?code=832451&password=secret123
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `code` | 是 | 6 位取件码 |
| `password` | 设密时是 | 取件密码；缺失或错误返回 403 |

**响应 200**

- `Content-Type`：由文件决定
- `Content-Disposition`：`attachment; filename=...`（文件名按 UTF-8 编码）
- Body：文件二进制流

**每次成功下载消耗 1 次次数**，次数耗尽或过期后码立即失效。

**错误**：`400` / `403` 密码错误 / `404` 不存在、已失效或次数耗尽 / `429` 限流 / `500` 下载失败。

**App 实现建议**

- **Android**：OkHttp `Response.body().byteStream()` 写入 `MediaStore` 或应用私有目录；注意 `403`/`404` 需读 JSON 错误体。
- **iOS**：`URLSessionDownloadTask`，在 `didFinishDownloadingTo` 中处理 `Content-Disposition` 文件名。
- **Web/H5**：`window.location.href` 或 `<a download>`；设密时把 `password` 拼进 query。
- **React Native**：`react-native-blob-util` / `expo-file-system` 下载，403/404 时解析 JSON 错误。

---

### 2.10 提交意见反馈

```
POST /api/feedback
Content-Type: application/json
```

Body：

```json
{
  "type": "bug",
  "contact": "test@qq.com",
  "content": "下载偶发失败"
}
```

| 字段 | 约束 |
|---|---|
| `type` | `bug` / `feature` / `other`，非法回退 `other` |
| `contact` | ≤100 字符，可空 |
| `content` | **必填** ≤2000 字符 |

**响应 201**：`{ "ok": true, "id": "1760000000000-a1b2c3d4", "code": "FB-24815302" }`（`code` 为反馈号，用户凭此查询进度）  
**错误**：`400` 内容为空 / `429` 限流（与上传同限流器）。

---

### 2.11 查询反馈进度

```
GET /api/feedback/query?code=FB-24815302
```

凭提交时返回的反馈号（`FB-` + 8 位数字，大小写不敏感）查询处理状态。

**响应 200**

```json
{
  "code": "FB-24815302",
  "type": "bug",
  "content": "下载偶发失败",
  "status": "done",
  "reply": "已修复，请更新到最新版本。",
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000
}
```

`status`：`pending` 等待中 / `processing` 处理中 / `done` 已完成。不返回 `contact` 与内部 `id`。  
`reply`：官方回复；仅 `status === 'done'` 时为非空字符串，否则为空串。  
**错误**：`400` 格式非 `FB-` + 8 位数字 / `404` 不存在 / `429` 限流（独立失败桶）。

---

## 3. 管理接口（需 `x-admin-key`）

所有管理接口需请求头：

```
x-admin-key: <你的管理密钥>
```

密钥在服务端 `.env` 的 `ADMIN_KEY` 中配置。

### 3.1 验证密钥（登录前置）

```
GET /api/admin/ping
```

**响应 200**：`{ "ok": true }`  
**错误**：`401` 密钥错误。

App 登录页可先调此接口轻量校验，避免直接拉全量列表。

---

### 3.2 统计概览

```
GET /api/admin/stats
```

**响应 200**

```json
{
  "fileCount": 12,
  "totalSize": 104857600,
  "activeDownloads": 30,
  "totalUploads": 120,
  "totalDownloads": 345
}
```

| 字段 | 说明 |
|---|---|
| `fileCount` | 当前有效分享数 |
| `totalSize` | 当前有效分享总大小（字节） |
| `activeDownloads` | 当前有效分享累计已下载次数之和 |
| `totalUploads` | 历史累计上传次数 |
| `totalDownloads` | 历史累计下载次数 |

---

### 3.3 分享列表

```
GET /api/admin/list
```

**响应 200**

```json
{
  "list": [
    {
      "code": "832451",
      "filename": "报告.pdf",
      "size": 1048576,
      "mime": "application/pdf",
      "note": "选填备注",
      "hasPassword": true,
      "createdAt": 1760000000000,
      "expiresAt": 1760086400000,
      "maxDownloads": 5,
      "downloads": 1
    }
  ]
}
```

> 列表项使用与 `/api/info` 相同的 `publicInfo` 结构，不含 `password` 与 `clientIp`。

---

### 3.4 删除分享

```
DELETE /api/admin/832451
```

**响应 200**：`{ "ok": true }`  
物理删除元数据与文件，取件码立即失效。

---

### 3.5 读取 / 保存公告

```
GET  /api/notice          # 同公开接口
PUT  /api/notice          # 需 x-admin-key
```

PUT Body：

```json
{
  "enabled": true,
  "title": "维护通知",
  "content": "本周日凌晨 2 点服务维护……",
  "display": "modal"
}
```

| 字段 | 约束 |
|---|---|
| `title` | ≤100 字符 |
| `content` | ≤2000 字符；为空时强制 `enabled=false` |
| `display` | `modal` / `bar` / `both`，非法回退 `modal` |

**响应 200**：`{ "ok": true, "notice": { ... } }`

---

### 3.6 读取 / 保存站点设置

```
GET /api/settings         # 同公开接口
PUT /api/settings         # 需 x-admin-key
```

PUT Body（字段均可选，只传需要改的）：

```json
{
  "siteName": "我的驿站",
  "beian": "粤ICP备2024000000号",
  "gongan": "粤公网安备 44030402000000号",
  "maxFileSize": 52428800,
  "blockedExts": ["exe", "php"],
  "displayMode": "waybill",
  "customCodeEnabled": true
}
```

| 字段 | 约束 |
|---|---|
| `siteName` | ≤50 字符；空串恢复默认名 |
| `beian` | ≤100 字符；空串不显示备案号 |
| `gongan` | ≤100 字符；空串不显示公安备案号 |
| `maxFileSize` | 字节；`≤0` 恢复 env 默认；保存时钳制到 `[1MB, MAX_FILE_SIZE]` |
| `blockedExts` | string[]；服务端会规范化（小写/去点/过滤非法/去重/最多 100） |
| `displayMode` | `simple` / `waybill`，非法回退 `simple` |
| `customCodeEnabled` | boolean |

**响应 200**：`{ "ok": true, "settings": { ... } }`（`settings` 为 `publicSettings` 结构，同 GET）。

---

### 3.7 上传 / 删除 Logo

```
POST   /api/settings/logo   # 需 x-admin-key，multipart 字段名 logo
DELETE /api/settings/logo   # 需 x-admin-key
```

Logo 约束：PNG / JPG / WebP / SVG / GIF / ICO，≤2MB。

**响应 200**：`{ "ok": true, "settings": { ... } }`  
**错误**：`400` 非图片 / `413` 超限。

---

### 3.8 反馈管理

```
GET    /api/admin/feedback           # 列表
PUT    /api/admin/feedback/:id       # 更新状态（done 需回复）
DELETE /api/admin/feedback/:id       # 删除反馈
GET    /api/admin/feedback/templates # 回复模板列表
PUT    /api/admin/feedback/templates # 保存回复模板
```

反馈对象结构：

```json
{
  "id": "1760000000000-a1b2c3d4",
  "code": "FB-24815302",
  "type": "bug",
  "contact": "test@qq.com",
  "content": "下载偶发失败",
  "status": "pending",
  "reply": "",
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000
}
```

| 字段 | 说明 |
|---|---|
| `code` | 反馈号（`FB-` + 8 位数字，公开查询凭据） |
| `type` | `bug` / `feature` / `other` |
| `status` | `pending` 等待中 / `processing` 处理中 / `done` 已完成 |
| `reply` | 官方回复；置为 `done` 时写入（≤2000），并记录 `repliedAt` |

**列表响应 200**：`{ "list": [ ... ] }`（`createdAt` 倒序）  
**更新请求**：`{ "status": "done", "reply": "已修复，请更新到最新版本。" }` — **status 为 `done` 时 reply 必填**（非空白 ≤2000），否则 `400 已完成状态需要填写回复内容`。  
**更新响应 200**：`{ "ok": true, "feedback": { ... } }`；非法状态 `400`；不存在 `404`。  
**删除响应 200**：`{ "ok": true }`（物理删除）。

**回复模板**（`data/feedback-templates.json`，缺文件回退默认 5 条）：

- `GET /api/admin/feedback/templates` → `{ "templates": ["感谢你的反馈，...", ...] }`
- `PUT /api/admin/feedback/templates` body `{ "templates": ["...", ...] }`（≤20 条，单条 ≤500，去空去重）→ `{ "ok": true, "templates": [...] }`

---

## 4. 限流规则

| 维度 | 默认阈值 | 触发后 |
|---|---|---|
| 取件相关失败（`/api/info`、`/api/verify-password`、`/api/download`、`/api/download/session` 的 4xx） | 每 IP 每分钟 `RATE_LIMIT_MISSES` 次（默认 10） | 返回 429，窗口 60s |
| 反馈号查询失败（`/api/feedback/query` 的 4xx） | 同上，但**独立分桶**，不挤占取件码失败次数 | 返回 429，窗口 60s |
| 上传频率（`/api/upload`、`/api/feedback`、`/api/upload/init`） | 每 IP 每分钟 `UPLOAD_LIMIT_PER_MINUTE` 次（默认 10） | 返回 429 |
| 在途会话配额 | 上传 `MAX_UPLOAD_SESSIONS_PER_IP`（默认 8）/ 下载 `MAX_DOWNLOAD_SESSIONS_PER_IP`（默认 32）/ 待处理上传总大小 `MAX_TMP_BYTES_PER_IP`（默认 512MB） | 返回 429（带 `uploadId` 的续传不占新名额） |

**成功请求会重置该 IP 的失败计数**。App 收到 429 时应提示用户稍后再试，而非无限重试。

---

## 5. 推荐 App 业务流程

### 5.1 寄件（上传）

```
1. GET  /api/settings          → 读取 maxFileSize / blockedExts / customCodeEnabled
2. 本地预检文件大小与后缀
3. POST /api/upload            → 得到 code / hasPassword / expiresAt ...
4. 展示取件码 + 分享链接 /d/<code>，可选引导用户设置密码
```

### 5.2 取件（下载）

```
1. GET  /api/info?code=xxx     → 拿到 filename / size / hasPassword / 剩余次数
2. 若 hasPassword=true         → 弹密码框
3. POST /api/verify-password   → 可选：前置校验，友好提示 403
4. GET  /api/download?code=xxx[&password=xxx]
   → 读取 Content-Disposition 得到文件名，写入本地
5. 失败时根据 404/403/429 分别提示：已失效 / 密码错误 / 操作频繁
```

### 5.3 分享卡片数据（供系统分享面板使用）

上传成功后可拼装：

| 平台 | 建议文案 |
|---|---|
| 通用 | `文件名 + 取件码 + https://<host>/d/<code>` |
| 带密码 | 额外提示「取件密码：xxx」（由用户自行决定是否随消息发送） |

---

## 6. 接口速查表

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 健康检查 / 功能标记 |
| GET | `/api/settings` | 公开 | 站点设置 |
| PUT | `/api/settings` | admin | 保存站点设置 |
| POST | `/api/settings/logo` | admin | 上传 Logo |
| DELETE | `/api/settings/logo` | admin | 删除 Logo |
| GET | `/api/logo` | 公开 | 读取 Logo 图片 |
| GET | `/api/notice` | 公开 | 读取公告（顶层=仲裁胜者，另带 `notices[]`） |
| PUT | `/api/notice` | admin | 保存公告（单条兼容写，带 `rev` 乐观锁） |
| GET | `/api/ip` | 公开 | 获取公网 IP |
| POST | `/api/upload` | 公开* | 上传文件（单请求） |
| GET | `/api/info` | 公开 | 查询分享信息 |
| POST | `/api/verify-password` | 公开 | 验证取件密码 |
| GET | `/api/download` | 公开 | 下载文件（整文件流，消耗次数） |
| POST | `/api/feedback` | 公开* | 提交意见反馈，返回反馈号 |
| GET | `/api/feedback/query` | 公开 | 凭反馈号查询处理进度与回复 |
| GET | `/api/upload/status` | 公开 | 查询分片上传会话进度 |
| POST | `/api/upload/init` | 公开* | 创建 / 恢复分片上传会话 |
| PUT | `/api/upload/part` | 公开 | 上传单个分片（原始字节体） |
| POST | `/api/upload/complete` | 公开 | 合并分片并落位（消耗次数前） |
| GET | `/api/upload/job` | 公开 | 压缩任务进度（按 uploadId 或取件码） |
| POST | `/api/download/session` | 公开 | 创建分片下载会话（消耗 1 次） |
| GET | `/api/download/status` | 公开 | 查询下载会话与分片计划 |
| GET | `/api/download/part` | 公开 | 取一个分片（按 index 或 start/end） |
| POST | `/api/download/end` | 公开 | 结束下载会话并释放引用 |
| GET | `/api/admin/ping` | admin | 验证管理密钥 |
| GET | `/api/admin/stats` | admin | 统计概览（传输/去重/会话配额） |
| GET | `/api/admin/stats/export` | admin | 导出传输维度明细 CSV |
| POST | `/api/admin/stats/reset` | admin | 清零传输统计（需 `confirm: true`） |
| GET | `/api/admin/list` | admin | 有效分享列表（含传输与存储态） |
| DELETE | `/api/admin/:code` | admin | 删除指定分享 |
| GET | `/api/admin/notices` | admin | 公告快照（`rev` / `limit` / `notices[]`） |
| POST | `/api/admin/notices` | admin | 新建公告 |
| PUT | `/api/admin/notices/{id}` | admin | 更新公告（时间窗 / 优先级 / 样式） |
| DELETE | `/api/admin/notices/{id}` | admin | 删除公告 |
| GET | `/api/admin/notice/presets` | admin | 预设列表（含上限与审计字段） |
| POST | `/api/admin/notice/presets` | admin | 新建预设 |
| PUT | `/api/admin/notice/presets/{id}` | admin | 更新预设 |
| DELETE | `/api/admin/notice/presets/{id}` | admin | 删除预设 |
| POST | `/api/admin/notice/presets/{id}/apply` | admin | 套用预设到某条公告 |
| PUT | `/api/admin/notice/presets/order` | admin | 预设排序 |
| GET | `/api/admin/notice/presets/export` | admin | 导出预设 JSON |
| POST | `/api/admin/notice/presets/import` | admin | 导入预设 JSON |
| GET | `/api/admin/feedback` | admin | 反馈列表 |
| PUT | `/api/admin/feedback/{id}` | admin | 改状态 / 回复（置 `done` 必须带 `reply`） |
| DELETE | `/api/admin/feedback/{id}` | admin | 删除反馈 |
| GET | `/api/admin/feedback/templates` | admin | 读取回复模板 |
| PUT | `/api/admin/feedback/templates` | admin | 保存回复模板（≤20 条） |

\* 上传 / 反馈接口受每 IP 每分钟频率限制，但无需管理密钥；`/api/upload/init` 仅在**新建**会话时计数（带 `uploadId` 的续传不计）。

---

## 7. 示例：curl

```bash
# 健康检查
curl http://localhost:3000/api/health

# 上传（带密码，有效期 24h，最多 5 次）
curl -X POST http://localhost:3000/api/upload \
  -F "file=@./report.pdf" \
  -F "expiresIn=24" \
  -F "maxDownloads=5" \
  -F "password=secret123"

# 查询
curl "http://localhost:3000/api/info?code=832451"

# 验证密码
curl -X POST http://localhost:3000/api/verify-password \
  -H "Content-Type: application/json" \
  -d '{"code":"832451","password":"secret123"}'

# 下载（设密）
curl -o report.pdf "http://localhost:3000/api/download?code=832451&password=secret123"

# 管理：列出所有分享
curl -H "x-admin-key: YOUR_KEY" http://localhost:3000/api/admin/list

# 管理：删除分享
curl -X DELETE -H "x-admin-key: YOUR_KEY" http://localhost:3000/api/admin/832451
```

---

## 8. 注意事项

1. **HTTPS**：生产环境务必通过 Nginx / Caddy 等反向代理启用 HTTPS，避免密码与文件在传输中被窃听。
2. **密码安全**：`password` 仅在上传时以明文通过表单发送一次，服务端立即哈希；之后所有接口只暴露 `hasPassword` 布尔，永不回传哈希或明文。
3. **下载消耗次数**：每次成功返回 200 文件流即消耗 1 次；App 应在下载**成功后**再更新 UI 的剩余次数，失败（网络中断等）不消耗。
4. **失效即时销毁**：过期或次数耗尽后，服务端会物理删除文件与元数据，之后所有请求均 404，无法找回。
5. **自定义码冲突**：收到 409 时，App 可提示用户换码，或不传 `customCode` 让系统随机生成。
6. **反馈号即凭证**：反馈号为 `FB-` + 8 位数字，`/api/feedback/query` 只凭号返回处理进度，App 应提示用户妥善保存；反馈号查询与取件码失败限流分桶，互不影响。

---

## 9. 传输优化与运维扩展接口

> 本章接口与第 2 章的「整文件上传 / 整文件下载」可同时使用：小文件走简单路径，大文件（或需要断点续传、进度与省流量）时按本章实现。字段口径与仓库内 `docs/DEVELOPMENT.md`、`docs/rfc/*` 保持一致。

### 9.1 分片上传与断点续传

```
POST /api/upload/init     # 创建或恢复会话
PUT  /api/upload/part     # 上传一个分片（原始字节，非 multipart）
POST /api/upload/complete # 合并并落位
GET  /api/upload/status   # 查询会话已收分片（重传前先查）
```

**创建会话（`POST /api/upload/init`）**

| 字段 | 必填 | 说明 |
|---|---|---|
| `filename` | 是 | 文件名（≤255 字符），用于后缀黑名单校验 |
| `size` | 是 | 字节数，超过 `maxFileSize` 返回 413 |
| `mime` | 否 | MIME，默认 `application/octet-stream` |
| `uploadId` | 否 | 带此字段即**续传**：文件一致时返回原会话与已收分片，不占用新配额 |
| `expiresIn` / `maxDownloads` / `note` / `customCode` / `password` | 否 | 与 [§2.6](#26-上传文件) 同义 |

```json
{ "uploadId": "8f0c...", "partSize": 4194304, "totalParts": 12, "resumed": false, "received": [] }
```

`partSize` 默认取 `TRANSFER_PART_SIZE`（4MB）；仅当按该尺寸会超出分片数上限时自动向上翻倍，此时以响应回传的 `partSize` 为准。

**上传分片（`PUT /api/upload/part?uploadId=...&index=...`）**：请求体为该分片的原始字节（`Content-Type` 任意），长度必须精确等于该分片应有长度（末片为余数），否则 400。响应 `{ "ok": true, "received": 3 }`。分片可并发、可乱序、可重传。

**完成（`POST /api/upload/complete`）**：JSON body `{ "uploadId": "..." }`；分片不全返回 400。响应与 [§2.6](#26-上传文件) 的 201 一致（含 `compressionState` / `storedSize` / `compressed` / `clientIp`）。

**错误**：400 参数/分片不合法、404 会话不存在或过期、409 自定义码冲突、413 超限、429 频率或会话配额超限。

### 9.2 压缩任务进度

```
GET /api/upload/job?code=832451        # 或 ?uploadId=...
```

```json
{ "status": "done", "error": "", "compressed": true, "storedSize": 327680, "compressionState": "done", "finished": true }
```

压缩在上传成功后异步执行（串行队列）。`finished: true` 后 `compressed` / `storedSize` 才是最终值；App 若展示「已省 xx%」建议轮询到 `finished` 再展示。

### 9.3 分片下载（并行 + 省流量）

```
POST /api/download/session  # 创建会话（此步消耗 1 次下载次数）
GET  /api/download/status   # 断点续传前查询计划
GET  /api/download/part     # 取分片
POST /api/download/end      # 结束会话
```

**创建会话**：JSON body `{ "code": "832451", "password": "..." }`（设密时必填）。

```json
{
  "token": "3b1f...",
  "partSize": 4194304,
  "filename": "报告.pdf",
  "size": 10485760,
  "mime": "application/pdf",
  "expiresAt": 1760001200000,
  "compressed": true,
  "units": [[0, 4194304], [4194304, 8388608], [8388608, 10485760]],
  "unitCount": 3,
  "parallel": 3
}
```

`units` 是服务端给出的**自适应分片计划**，`parallel` 为建议并发（2~8）。

**取分片（`GET /api/download/part?token=...&index=N`）**：返回该分片的**原始字节**（即浏览器/客户端拼接后就是完整文件）。若客户端在 `Accept-Encoding` 里声明支持 `br` / `gzip`，服务端可能直接下发存储态编码并置 `Content-Encoding`，由 HTTP 层自动解压——因此**不要**对响应体再做一次解压。相关头部：

| 响应头 | 说明 |
|---|---|
| `X-Transfer-Part` | 分片序号（按 `index` 取时回传） |
| `X-Transfer-Mode` | `store` 存储态直发 / `recompress` 重新编码 / `raw` 未压缩 |
| `X-Transfer-Codec` | 本次实际使用的编码（`br` / `gzip` / `raw`） |
| `Content-Encoding` | 仅在直发或重编码时出现，客户端库通常已自动解压 |

也支持 `?token=...&start=0&end=1048575` 的字节范围取法（单次跨度不得超过 `partSize`）。

**结束会话**：JSON body `{ "token": "..." }`，响应 `{ "ok": true }`。会话过期或被回收后重新 `POST /api/download/session` 即可（会**再消耗 1 次**下载次数，务必复用同一 token 直至下载完成）。

### 9.4 统计与运维（管理端）

```
GET  /api/admin/stats          # 概览：文件数 / 实际占用 / 传输节省 / 近 7 日 / 会话配额 / 跨文件去重
GET  /api/admin/stats/export   # 传输维度明细导出 CSV（UTF-8 BOM，文件名带时间戳）
POST /api/admin/stats/reset    # 清零传输统计：body 必须为 { "confirm": true }
```

`/api/admin/stats` 在基础字段外还返回：`totalStoredSize`、`savedBytes`、`transferOriginalBytes`、`transferWireBytes`、`transferSavedBytes`、`transferToday`、`transferDays`（近 7 日）、`transferResetAt`、`transferResetCount`、`sessionQuota.topIps`，以及 `dedupCross*`（`CROSS_FILE_DEDUP=on` 时的去重收益）。

### 9.5 多公告与预设管理

```
GET/POST         /api/admin/notices
PUT/DELETE       /api/admin/notices/{id}
GET/POST         /api/admin/notice/presets
PUT/DELETE       /api/admin/notice/presets/{id}
POST             /api/admin/notice/presets/{id}/apply
PUT              /api/admin/notice/presets/order
GET/POST         /api/admin/notice/presets/export|import
```

- **多条公告**：`/api/admin/notices` 返回 `{ rev, limit, notices[] }`；写操作可携带 `rev` 做乐观锁，过期返回 409。上限于环境变量 `MAX_NOTICES`（默认 20）。
- **时间窗**：每条公告可带 `startAt` / `endAt`（毫秒），服务端在**请求时**求值，到点自动上线/下线，无需定时任务；非法时间窗（`endAt ≤ startAt`）自动把 `endAt` 置空。
- **预设**：保存一套公告样式与内容（`notice` 快照，天然不含 id / 时间窗），可分组、排序、导出导入，`apply` 时套用到指定公告（可选 `noticeRev` / `noticeId`）。上限由站点设置 `presetLimit` 控制（硬上限 `MAX_NOTICE_PRESETS`，默认 50）。
- 公开侧读取见 [§2.4](#24-获取公告) 。
6. **时区**：所有时间戳为 UTC 毫秒，前端/App 用本地时区格式化即可。
