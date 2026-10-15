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
    "publicIp", "customCode", "password", "beian", "gongan", "feedback"
  ]
}
```

`features` 为功能标记数组，App 可据此判断服务器是否支持某能力（如 `"password"` 表示支持取件密码）。

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
  "enabled": true,
  "title": "维护通知",
  "content": "本周日凌晨 2 点服务维护……",
  "display": "modal",
  "updatedAt": 1760000000000
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用；App 仅在 `true` 时展示 |
| `title` | 标题，可为空（建议 fallback「公告」） |
| `content` | 正文 |
| `display` | `modal` 弹窗 / `bar` 顶部条 / `both` 两者 |
| `updatedAt` | 更新时间，可用于本地缓存去重 |

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
  "status": "active",
  "filename": "报告.pdf",
  "size": 1048576,
  "mime": "application/pdf",
  "note": "选填备注",
  "hasPassword": true,
  "createdAt": 1760000000000,
  "expiresAt": 1760086400000,
  "maxDownloads": 5,
  "downloads": 0,
  "clientIp": "1.2.3.4"
}
```

| 字段 | 说明 |
|---|---|
| `code` | 6 位取件码，App 应引导用户分享此码或 `/d/<code>` 链接 |
| `status` | 分享状态：`active` 生效中 / `expired` 已过期 / `exhausted` 次数用尽；新上传恒为 `active` |
| `hasPassword` | 是否设有取件密码（布尔，不含密码本身） |
| `clientIp` | 仅上传响应回传，`/api/info` 不返回；可选展示 |
| `createdAt` / `expiresAt` | Unix 毫秒时间戳 |

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
  "status": "active",
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

> 不含 `clientIp`，不含 `password` 哈希。已失效（过期/次数耗尽）的记录本接口返回 `404`，`status` 字段仅在管理接口中可能出现非 `active` 值。

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

**每次成功下载消耗 1 次次数**，次数耗尽或过期后取件码失效（文件销毁，记录留存为已失效）。

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
      "status": "active",
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

> 列表项使用与 `/api/info` 相同的 `publicInfo` 结构（含 `status`），不含 `password` 与 `clientIp`。**返回全部记录，包含已失效**（`status` 为 `expired` / `exhausted`），按 `createdAt` 倒序；失效记录的文件体已销毁，仅元数据留存。

---

### 3.4 删除分享 / 清空已失效记录

```
DELETE /api/admin/832451
```

**响应 200**：`{ "ok": true }`  
彻底删除该条记录与文件（含已失效记录），取件码立即失效。注意与自然失效的区别：自然失效（过期/次数耗尽）只销毁文件、记录留存为已失效。

```
DELETE /api/admin/expired
```

**响应 200**：`{ "ok": true, "removed": 3 }`  
彻底清空全部已失效记录（`expired` 与 `exhausted`），生效中的分享不受影响。`removed` 为删除的记录条数。

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
| 取件相关失败（`/api/info`、`/api/verify-password`、`/api/download` 的 4xx） | 每 IP 每分钟 `RATE_LIMIT_MISSES` 次（默认 10） | 返回 429，窗口 60s |
| 上传频率（`/api/upload`） | 每 IP 每分钟 `UPLOAD_LIMIT_PER_MINUTE` 次（默认 10） | 返回 429 |

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
| GET | `/api/notice` | 公开 | 读取公告 |
| PUT | `/api/notice` | admin | 保存公告 |
| GET | `/api/ip` | 公开 | 获取公网 IP |
| POST | `/api/upload` | 公开* | 上传文件 |
| GET | `/api/info` | 公开 | 查询分享信息 |
| POST | `/api/verify-password` | 公开 | 验证取件密码 |
| GET | `/api/download` | 公开 | 下载文件（消耗次数） |
| GET | `/api/admin/ping` | admin | 验证管理密钥 |
| GET | `/api/admin/stats` | admin | 统计概览 |
| GET | `/api/admin/list` | admin | 分享列表（含已失效，含 status） |
| DELETE | `/api/admin/expired` | admin | 清空全部已失效记录（彻底删除） |
| DELETE | `/api/admin/:code` | admin | 删除指定分享（彻底删除记录与文件） |

\* 上传接口受每 IP 每分钟频率限制，但无需管理密钥。

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

# 管理：列出所有分享（含已失效）
curl -H "x-admin-key: YOUR_KEY" http://localhost:3000/api/admin/list

# 管理：删除分享（彻底删除记录与文件）
curl -X DELETE -H "x-admin-key: YOUR_KEY" http://localhost:3000/api/admin/832451

# 管理：清空全部已失效记录
curl -X DELETE -H "x-admin-key: YOUR_KEY" http://localhost:3000/api/admin/expired
```

---

## 8. 注意事项

1. **HTTPS**：生产环境务必通过 Nginx / Caddy 等反向代理启用 HTTPS，避免密码与文件在传输中被窃听。
2. **密码安全**：`password` 仅在上传时以明文通过表单发送一次，服务端立即哈希；之后所有接口只暴露 `hasPassword` 布尔，永不回传哈希或明文。
3. **下载消耗次数**：每次成功返回 200 文件流即消耗 1 次；App 应在下载**成功后**再更新 UI 的剩余次数，失败（网络中断等）不消耗。
4. **失效后文件销毁、记录留存**：过期或次数耗尽后，服务端销毁文件体（取件请求一律 404），但元数据记录会留存并标记为已失效（`expired` / `exhausted`），仅管理接口可见；管理员可「清空已失效」彻底删除这些记录。
5. **自定义码冲突**：收到 409 时，App 可提示用户换码，或不传 `customCode` 让系统随机生成。
6. **时区**：所有时间戳为 UTC 毫秒，前端/App 用本地时区格式化即可。
