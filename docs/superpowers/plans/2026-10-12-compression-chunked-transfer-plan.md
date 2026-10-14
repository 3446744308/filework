# 存储压缩与分片并行传输 实现计划（2026-10-12）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 RFC-001 两条传输算法：分块 gzip 压缩（降低占用）+ 会话制分片并行上传/下载（gopeed 机制本地化），REQ-001~008 全部可验收。

**Status:** 已全部完成（2026-10-12）。执行备注：Task 1+2 因 `server/index.js` 接线交错合并为一次提交 `414bb78`；Task 3 提交 `0fbc1c0`；Task 4 文档随本次收尾提交。RFC §6/§8 与 backlog 已回填；全量 `npm test` 145 passed / 0 failed，浏览器冒烟 3/3。

---

## File Structure

- Create: `server/compress.js`、`server/sessions.js`、`server/transfer.js`、`web/src/downloader.js`、`docs/rfc/RFC-001-*.md`（已建）、`docs/adr/*`（已建）、`docs/architecture/*`（已建）、`docs/backlog.md`
- Modify: `server/config.js`、`server/settings.js`、`server/store.js`、`server/index.js`、`scripts/test.js`、`.env.example`、`docs/DEVELOPMENT.md`、`README.md`、`knowledge.md`
- Modify: `web/src/api.js`、`web/src/pages/Upload.jsx`、`web/src/pages/Retrieve.jsx`、`web/src/pages/AdminSettings.jsx`、`web/src/pages/Admin.jsx`、`web/src/index.css`

---

### Task 0: 基线确认（已完成）

- [x] **Step 1**: `npm test` → **100 通过, 0 失败**（2026-10-12，Windows Git Bash，Node ESM，含静态页用例）
- [x] **Step 2**: 基线文档：RFC-001 §1 记录；git 基线提交 `24a91e6`

### Task 1: 服务端压缩（REQ-001~004）

**Files:** `server/compress.js`（新）、`server/settings.js`、`server/store.js`、`server/index.js`、`scripts/test.js`

- [ ] **Step 1**: 写 `compress.js`（`isCompressible` / `compressInPlace` / `readRange` / `streamOriginal`），4MB 块、逐块择优、整体回退
- [ ] **Step 2**: `settings.js` 增加 `compressionEnabled`（默认 true）+ 读取函数；`store.js` `commitUpload` 接受压缩字段（默认 `storedSize=size`、`compression=''`）
- [ ] **Step 3**: `index.js` 接线：单请求上传 complete 前压缩；单连接下载压缩文件走 `streamOriginal`；201/admin list 增加 `storedSize`/`compressed`；health `compression`
- [ ] **Step 4**: `scripts/test.js` 新增 [17] 用例：压缩率 ≤30%、逐字节一致（中文名）、随机二进制回退、开关关闭/开启
- [ ] **Step 5**: `npm test` 全绿（≥100 + 新增）→ 提交 — `feat(server): 分块 gzip 压缩存储与压缩开关`

### Task 2: 服务端分片传输（REQ-005~007）

**Files:** `server/config.js`、`server/sessions.js`（新）、`server/transfer.js`（新）、`server/store.js`、`server/index.js`、`.env.example`、`scripts/test.js`

- [ ] **Step 1**: `config.js` 增加 `transferPartSize`（env `TRANSFER_PART_SIZE`，默认 4MB）；`.env.example` 同步
- [ ] **Step 2**: `sessions.js`：下载 token（TTL 10min）与上传会话（TTL 30min）注册表、`hasActiveSession`、两个 sweep
- [ ] **Step 3**: `transfer.js`：upload init/part/complete + download session/part/end + 60s 清扫；express.raw 超限映射 413
- [ ] **Step 4**: `store.js`：导出 `getMeta`；`getActive`/`cleanupExpired` 会话保护（`hasActiveSession`）
- [ ] **Step 5**: `index.js` 注册 transfer 路由；health 增加 `chunkedUpload`/`parallelDownload`/`downloadSession`；admin stats 增加 `totalStoredSize`/`savedBytes`
- [ ] **Step 6**: `scripts/test.js`：测试 env `TRANSFER_PART_SIZE: '262144'`；新增 [18] 分片上传（乱序/409/413/400/一致性）、[19] 下载会话（消费+1/并发拼接/坏 token/范围400/会话保护与回收）
- [ ] **Step 7**: `npm test` 全绿 → 提交 — `feat(server): 分片并行上传下载会话接口与文件保护`

### Task 3: 前端（REQ-005~006 客户端）

**Files:** `web/src/api.js`、`web/src/downloader.js`（新）、`web/src/pages/Upload.jsx`、`web/src/pages/Retrieve.jsx`、`web/src/pages/AdminSettings.jsx`、`web/src/pages/Admin.jsx`、`web/src/index.css`

- [ ] **Step 1**: `api.js`：`uploadChunked`（并发 3/重试 2/聚合进度）+ 会话三接口
- [ ] **Step 2**: `downloader.js`：FS Access 优先流式写盘、Blob 回退、AbortController、进度/速率
- [ ] **Step 3**: `Upload.jsx` >1MB 走分片（409 弹窗复用）；`Retrieve.jsx` >1MB 并行下载 + 进度条
- [ ] **Step 4**: `AdminSettings.jsx` 压缩开关；`Admin.jsx` 仪表盘"实际占用/节省"
- [ ] **Step 5**: `npm run build` 无报错 → 提交 — `feat(web): 分片并行上传下载与存储节省展示`

### Task 4: 全量回归 + 文档收尾

- [ ] **Step 1**: `set -o pipefail; npm test` → 记录最终 passed 数；`npm run build`
- [ ] **Step 2**: `docs/DEVELOPMENT.md`：§4 env 表、§5 数据模型（压缩字段/tmp 会话）、§6 会话规则、§7 契约表（6 新接口 + 字段变化）、§8 前端要点；`README.md`、`knowledge.md` 补充
- [ ] **Step 3**: RFC-001 §6 验收结果与 §8 追溯回填；`docs/backlog.md` 标记；C3 变更日志追加
- [ ] **Step 4**: 提交 — `docs: RFC-001 追溯与开发契约更新`

---

## Self-Review

- **精度保持**：`size`/进度/限制恒为原始字节；`storedSize` 仅存储统计；下载 `Content-Length`=原始大小。
- **与既有机制共存**：密码、409、限流、清理、公告、面单字段逐条不回归；分片路径每步都有校验（init 前置 + complete 复查）。
- **回归**：全量 `npm test`（既有 100 + 新增）+ `npm run build`；手动冒烟 `/`、`/d/:code`、`/admin`。
- **已知边界**：服务器重启丢会话；跨刷新续传不做（backlog B1-1）；Safari/Firefox Blob 峰值内存观察（B1-4）。
