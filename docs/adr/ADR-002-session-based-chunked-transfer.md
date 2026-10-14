# ADR-002: 分片并行传输采用会话制应用层协议而非裸 HTTP Range

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-001 §4.2~4.3 | 影响：`server/sessions.js`、`server/transfer.js`、`server/store.js`、`server/rate-limit.js` 使用方式、前端 uploader/downloader

## Context

要本地化 gopeed 的分片并行传输（RFC-001 REQ-005~007），必须先穿过本项目的两个既有不变量：

1. **消费计数是请求级**：`server/index.js` 的 `/api/download` 每次请求执行 `tryConsume(code)`（`server/store.js`），下载次数 `downloads++`。若浏览器对同一文件发 4 个 `Range` 请求，次数瞬间 −4，还可能触发 `missGuard`/`rateGuard` 限流。
2. **耗尽即物理删除**：`store.getActive()` 与 `cleanupExpired()` 在 `downloads ≥ maxDownloads` 或过期时立即 `removeShare`。并行下载的第 2 个分片就可能 404。

同时上传侧：`UPLOAD_LIMIT_PER_MINUTE` 限流按请求计（`server/rate-limit.js` rateGuard），若 N 个分片各自计数，一次上传就会把自己限流。

## Decision

1. **下载走"会话制"**：`POST /api/download/session` 一次性完成校验（码/密码/失效）+ `tryConsume` 消费 1 次 + 生成内存 token（`crypto.randomBytes(16).hex`，TTL 10 分钟）。之后的分片请求 `GET /api/download/part?token=&start=&end=` 只认 token，**不重复计数、不再查 getActive**，直接按 `store.getMeta(code)` + 原始字节范围读取。
2. **分片按原始字节范围寻址**：`start/end` 是原始文件偏移；未压缩走 `createReadStream({start,end})`，压缩容器走 `compress.js readRange`（只解压相交块）。分片大小上限 = `TRANSFER_PART_SIZE`（默认 4MB），会话响应回传该值供客户端切片。
3. **会话保护文件**：`store.getActive()` / `cleanupExpired()` 在物理删除前检查 `sessions.hasActiveSession(code)`，会话存续期只判失效不删文件；`POST /api/download/end`（幂等）与 TTL 清扫执行最终回收（无活跃会话且已失效 → `removeShare`）。最大滞留 = TTL(10min) + 清扫间隔(60s)，仅发生在"最后一单还在被并行下载"的窗口。
4. **上传同理**：`POST /api/upload/init` 创建上传会话（`uploadId`，TTL 30 分钟，`data/tmp/<uploadId>.bin` + 内存位图），限流只在 init 计一次；`PUT /api/upload/part?uploadId=&index=` 按 `index × partSize` 偏移写入（乱序、重试幂等）；`POST /api/upload/complete` 校验齐全与大小后压缩 + `commitUpload`。
5. **默认值**：并发 3（上传）/4（下载）、分片 4MB、每片重试 2 次指数退避；跨页面断点续传不做（backlog B1-1）。
6. **小文件回退**：`size ≤ 1MB` 走既有直链/单请求路径，不为小文件引入会话开销；旧接口 `/api/upload`、`/api/download` 原样保留。

## Alternatives

- **裸 HTTP Range + 每次请求计数**：协议最标准（`Accept-Ranges`/`206`），但会打穿消费计数与限流两个不变量（Context 1/2），需要在每个 Range 请求里区分"第几片、是否首片"，语义比会话制更隐晦。否决。
- **HTTP Range + 服务端"首片计数、后续免费"识别**：按 `Range` 头与 token 双轨识别，请求间无显式会话，断连后无法区分"重试"与"新下载"；实现上等价于隐式会话，显式 token 更清晰可测。否决。
- **WebSocket / WebRTC 分片通道**：协议复杂度、连接管理、代理兼容性全面超标；本项目是 HTTP 中转站模型。否决。
- **先扣次数并发 webhook 逐片核销**：多一层状态与失败补偿，无收益。否决。
- **不做并行、仅加断点续传**：不满足"分片并行传输"需求本身（REQ-005/006）。否决。
- **分片按压缩后偏移（对容器直接 Range）**：客户端无法在不解压的情况下拼接原始字节；服务端返回压缩块还需要客户端具备 gzip 能力（浏览器有 DecompressionStream，但拼装逻辑与直链、密码、重试全面复杂化）。按原始范围 + 服务端切片（本决策 2）把复杂度留在服务端一处。否决。

## Consequences

- 正：消费计数语义不变（一次下载 = 1 次）；并行分片天然不触发限流；压缩与并行正交组合；token 短命 + 内存态，无持久化成本。
- 负：服务端多一个有状态组件（`sessions.js`），引入"内存态 vs 重启"边界：重启丢会话，进行中的下载/上传分片失败（文件本身完好）；已在错误处理表中显式定义（RFC-001 §5）。
- 负：`getActive`/`cleanup` 学会"保护会话"，store 与 sessions 产生依赖（sessions 保持无依赖以保证方向单向：store → sessions，不产生循环）。
- 风险：恶意客户端可创建大量会话占内存（token 每条 <100B，10 分钟 TTL 自清）；并发上传会话占 tmp 磁盘——**已在修订一闭环**（按 IP 配额）。

## 修订记录

- 2026-10-12 修订一（backlog B1-3 关闭）：按 IP 增加**会话数与临时空间配额**。`sessions.js` 为上传/下载会话记录归属 IP（上传位图落盘一并保存 `ip`，重启恢复后仍归位；旧文件无该字段则归空 IP 桶、不占任何真实 IP 配额），新增 `countDownloadSessions(ip)` / `uploadTmpUsage(ip)`（只统计未过期会话）；`config.js` 新增 `MAX_UPLOAD_SESSIONS_PER_IP`（默认 8）/ `MAX_DOWNLOAD_SESSIONS_PER_IP`（默认 32）/ `MAX_TMP_BYTES_PER_IP`（默认 512MB）；`transfer.js` 在「新建上传会话」与「创建下载会话」前拦截，超限 429，且**下载侧拦截发生在 `tryConsume` 之前**（被拒请求不消耗取件次数）；带 `uploadId` 的续传复用既有会话、不占新名额；`complete` / `end` / TTL 清扫即时释放名额（声明字节数按会话 `size` 计，与磁盘实际占用同量级）。验证：`scripts/test.js` [28]（隔离端口小配额服务器：字节配额 429、会话数 429、续传豁免、位图 IP 归属、完成即释放、下载配额 429 且不消耗次数、end 后释放）+ [1]（`/api/health` 新增 `sessionQuota`）。

## References

- `server/index.js`（/api/download 现状）、`server/store.js`（tryConsume/getActive/cleanupExpired）、`server/rate-limit.js`、`server/sessions.js`（配额记账）、`server/transfer.js`（配额拦截）
- `docs/DEVELOPMENT.md` §4（三个新 env）、§7（429 语义）；`scripts/test.js` [28]
- RFC-001 §4.2、§4.3、§5；ADR-001（压缩容器随机读）、ADR-003（客户端组装）
