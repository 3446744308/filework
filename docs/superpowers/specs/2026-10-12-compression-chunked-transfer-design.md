# 存储压缩与分片并行传输 设计快照（传输域）

> 索引：`RFC-001` | 关联 REQ：REQ-001~REQ-008 | 收益：可压缩文件占用 ≤30%；上传/下载 4 路分片并行且消费计数不重复
> 位置：本文档为实现快照；权威见 `docs/rfc/RFC-001-compression-chunked-transfer.md`（冲突时以 RFC 为准并修掉冲突）

## 1. 需求

见 RFC-001 §1（REQ-001~008，含基线与验证命令），本快照不复制。

## 2. 现状根因（勘察结论）

| 位置 | 事实 | 影响 |
|---|---|---|
| `server/store.js:commitUpload()` | tmp 文件 `renameSync` 直落 `files/<code>`，无压缩字段 | 磁盘占用 = 原大小 |
| `server/store.js:tryConsume()` | 每次调用 `downloads++`；`getActive()`/`cleanupExpired()` 在耗尽时 `removeShare` | 分片请求会重复扣次数 / 会话中被删文件 |
| `server/index.js:/api/download` | `res.download()` 单连接全量；每请求 `tryConsume` | 无并行入口 |
| `server/index.js:/api/upload` | `makeUpload()` multer 单请求收全文件 | 无分片、失败整体重传 |
| `server/index.js` | 无 transfer 路由、health 无新标记 | 需接线 |
| `server/settings.js` | 无 `compressionEnabled` | 需开关 |
| `server/config.js` | 无 `TRANSFER_PART_SIZE` | 需 env（测试用小分片覆盖多片路径） |
| `web/src/api.js` | `uploadXhr` 单请求；下载只有 `downloadUrl` 直链 | 需 `uploadChunked` + 会话接口 |
| `web/src/pages/Upload.jsx:doUpload()` | 直接调 `api.upload`，409 走自定义码弹窗 | 分片路径需复用 409 语义 |
| `web/src/pages/Retrieve.jsx:download()` | 预检 info/密码后 `window.location.href = downloadUrl` | 大文件改并行 + 进度 |

## 3. 总体设计

见 RFC-001 §3（mermaid 数据流；分片按原始范围 + 服务端按块解压切片；会话制消费）。

## 4. 详细设计（实现视角增量）

### 4.1 服务端：压缩（Task 1）

- 新增 `server/compress.js`：
  - `isCompressible(mime, filename)`：跳过已压缩 MIME 前缀与扩展名（清单见 RFC §4.1）。
  - `compressInPlace(filePath)`：4MB 块 `zlib.gzip` 异步；逐块 `min(gz, raw)`；`.pack` 汇总后 `总存储 ≥ 原始` 则回退删除，否则 `renameSync` 替换；返回 `{ ok, storedSize, blocks, blockSize }`。
  - `readRange(filePath, meta, start, end)`：块索引定位 → 读存储 → `gunzip` → 切片拼接（Buffer）。
  - `streamOriginal(res, filePath, meta)`：逐块解压 + `drain` 背压写响应；`Content-Disposition` 含 `filename*=UTF-8''` 与 ASCII 回退。
- `server/settings.js`：`DEFAULT_SETTINGS.compressionEnabled = true`；`saveSettings` 处理该键；`getCompressionEnabled()`（读取端 `!== false`）。
- `server/store.js`：`commitUpload(tmpFile, info)` 接受可选 `{ compression, blockSize, blocks, storedSize }` 写入 meta（缺省 `storedSize = size`、`compression = ''`）。
- `server/index.js`：`/api/upload` 成功落位前调用 `maybeCompress`（受开关与 `isCompressible` 控制；失败仅记日志并继续）；`/api/download` 命中压缩时改用 `streamOriginal`；201 响应与 `/api/admin/list` 增加 `storedSize`、`compressed`；health 增加 `compression`。
- 测试 `scripts/test.js` [17]：压缩率断言（512KB `'A'.repeat` → storedSize ≤ 30%）、逐字节下载一致、随机二进制回退（storedSize === size）、开关关闭/开启。

### 4.2 服务端：分片传输（Task 2）

- `server/config.js`：`transferPartSize: intEnv('TRANSFER_PART_SIZE', 4MB)`；`.env.example` 同步。
- 新增 `server/sessions.js`（零依赖，防循环引用）：
  - 下载：`createDownloadSession(code)`、`getDownloadSession(token)`、`dropDownloadSession(token)`、`hasActiveSession(code)`、`sweepDownloadSessions()`（返回过期列表）。
  - 上传：`createUploadSession(fields)`（含 `partSize/totalParts/received`）、`getUploadSession(id)`、`dropUploadSession(id)`、`sweepUploadSessions()`（返回过期列表供删 tmp）。
- 新增 `server/transfer.js`：`registerTransferRoutes(app)`
  - `POST /api/upload/init`（rateGuard 计一次）：校验 size/后缀/自定义码/totalParts ≤ 1024；返回 `{ uploadId, partSize, totalParts }`。
  - `PUT /api/upload/part`：`express.raw({ limit: partSize, type: () => true })`；长度严格等于预期；`fs.open/write` 偏移写 `tmp/<uploadId>.bin`；错误映射 413/400/404。
  - `POST /api/upload/complete`：齐全 + 实际大小校验 → 压缩 → `commitUpload` → 409 透传；返回 201。
  - `POST /api/download/session`（missGuard）：校验/密码/`tryConsume` → token（TTL 10min）→ `{ token, partSize, filename, size, mime, expiresAt }`。
  - `GET /api/download/part`：token 校验 404；`0 ≤ start < end ≤ size` 400；`end-start ≤ partSize` 400；未压缩 `createReadStream({start,end})`、压缩 `readRange`；不计数。
  - `POST /api/download/end`：幂等释放；无活跃会话且分享失效 → `removeShare`。
  - 60s 清扫定时器（unref）：过期下载会话释放、过期上传会话删 tmp。
- `server/store.js`：导出 `getMeta(code)`；`getActive`/`cleanupExpired` 增加 `hasActiveSession(code)` 保护（会话期只判失效不物理删除）。
- `server/index.js`：`registerTransferRoutes(app)` 在 `/api` 404 兜底前注册；health 增加 `chunkedUpload`/`parallelDownload`/`downloadSession`；admin stats 增加 `totalStoredSize`/`savedBytes`。
- 测试 `scripts/test.js`：测试 env 增加 `TRANSFER_PART_SIZE: '262144'`；[18] 分片上传（乱序、409、413、400、complete 一致性）；[19] 下载会话（消费 +1、并发 part 拼接、坏 token 404、范围 400、maxDownloads=1 会话保护与 `/end` 回收）。

### 4.3 前端（Task 3）

- `web/src/api.js`：`uploadChunked(file, fields, onProgress)`（并发 3、重试 2、聚合进度）；`createDownloadSession(code, password)`、`downloadPart(token, start, end, signal)`、`endDownloadSession(token)`。
- 新增 `web/src/downloader.js`：`parallelDownload({ code, password, onProgress, onPhase })`；FS Access 优先按序流式写盘，Blob 回退；`AbortController` 取消；错误透传 `status`。
- `web/src/pages/Upload.jsx`：`file.size > 1MB` → `api.uploadChunked`，否则原路径；进度/409 弹窗复用。
- `web/src/pages/Retrieve.jsx`：`size > 1MB` → 并行下载（进度条 + 速率）；小文件直链；完成后 `load(code)` 刷新次数。
- `web/src/pages/AdminSettings.jsx`：新增"启用存储压缩"Switch；`Admin.jsx` 仪表盘展示"实际占用 / 节省空间"。
- `web/src/index.css`：下载进度样式（复用 `.upload-progress` 同族类）。
- 陷阱：`showSaveFilePicker` 必须用户手势内调用（点击处理内同步发起会话请求前先调用？——先 `showSaveFilePicker` 再拉分片，防止 await 后手势失效）；非 Chromium 直接 Blob 分支；密码错误 403 文案。

### 4.4 文档收尾（Task 4）

- `docs/DEVELOPMENT.md`：§4 增加 `TRANSFER_PART_SIZE`；§5 数据模型增加压缩字段与上传临时文件；§6 增加会话规则；§7 契约表新增 6 个接口与既有接口的字段变化；§8 前端要点。
- `README.md` / `knowledge.md`：特性与命令补充。
- RFC-001 §6/§8 回填实测数据；`docs/backlog.md` 登记 B1-1~B1-4；C3 变更日志追加。

## 5. Self-Review（精度/共存/回归三查）

- **语义保持**：`size` 恒为原始字节数（展示/限制/进度不变）；`storedSize` 仅存储统计；下载 `Content-Length` 保持 `size`；消费语义"开始即扣 1 次"不变。
- **与既有机制共存**：密码校验、自定义码 409、限流（missGuard/rateGuard）、清理定时器、上传限额、面单 `clientIp`、公告/设置缓存全部保持；分片路径不绕过任一校验（init 时前置校验 + complete 时复查）。
- **回归**：既有 100 用例全绿 + 新增 [17][18][19]；`npm run build` 无报错；`/`、`/d/:code`、`/admin` 手动冒烟。
