# 自适应单元与传输压缩 实现计划（2026-10-12，追补快照）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **性质说明（B3-2）**：本文件是 RFC-002 落地**完成后补写的追溯快照**——RFC-002 执行期沿用 RFC-001 的「RFC + superpowers plans/specs」惯例但没有留下独立计划文件，此处按最终提交补齐任务分解、验收与留痕，便于后续同类改动（尤其是下载域名）复用同一节奏。内容以代码与提交为准，不做事后美化。

**Goal:** 落地 RFC-002 的两条下载域提速：①自适应单元容器（内容定界切分 + 单元级去重 + 逐单元 raw/gzip/brotli 择优）取代「固定 4MB 块 gzip」；②传输压缩协商（服务端按 `Accept-Encoding` 直发存储态编码 / 重编码 / 原始，浏览器网络层自动解压）。

**Status:** 已全部完成（2026-10-12）。服务端 `ba57346`、前端 `719b9c5`、测试 `40494c9`；增量见下「增量任务」。验收：`npm test` 301 passed / 0 failed（RFC-002 首版交付时为 182）、`npm run e2e` 78 passed / 0 failed（首版 15）、`npm run build` 通过；线上实例（本机 :3002）实测 2MB 日志类文件存储 44.3% / 传输省 55.7% 且逐字节一致。

---

## File Structure

- Create: `server/units.js`（Gear-hash 内容定界 + 单元计划 + 去重哈希）、`server/codec.js`（多编解码择优 + `Accept-Encoding` 协商）、`scripts/e2e-browser.js`（真实浏览器 E2E）
- Rewrite: `server/compress.js`（固定块容器 → 单元容器 `units-v2`，保留旧 `gzip-blocks` 只读兼容）
- Modify: `server/transfer.js`（计划下发、`store`/`recompress`/`raw` 三态、`index` 取片）、`web/src/downloader.js`（按计划取片 + 自适应并发 + 内存预算）、`web/src/pages/Retrieve.jsx`、`web/src/api.js`、`server/config.js`、`.env.example`、`docs/DEVELOPMENT.md`、`scripts/test.js`

---

### Task 1: 自适应单元切分（REQ-012/013，ADR-004）

- [x] **Step 1**: `server/units.js` 实现 `chunkPlan`/`chunkBounds`/`chunkFile`/`chunkRanges`（Gear-hash 内容定界，受 `UNIT_MIN_SIZE`/`UNIT_MAX_SIZE`/`UNIT_TARGET_COUNT`/`UNIT_MAX_COUNT` 约束）与 `uniformRanges` 回退
- [x] **Step 2**: 单元级去重 `contentHash`（内存哈希表）+ `unitRanges`/`unitsCoverage` 自检（`Σr === size`、无缝覆盖）
- [x] **Step 3**: `scripts/test.js` [20] 纯函数对抗用例（边界、覆盖、去重命中、超限放大）

### Task 2: 单元容器与多编解码（REQ-014/015，ADR-005）

- [x] **Step 1**: `compress.js` 重写为 `units-v2` 容器（`{ o, c, r, z, d? }`），逐单元 raw/gzip/brotli 择优，`storedSize` 恒有值
- [x] **Step 2**: `server/codec.js`（`encodeUnit`/`decodePayload`/`parseAcceptEncoding`/`planTransferCodec`/`encodeForTransfer`）
- [x] **Step 3**: 旧容器 `gzip-blocks` 只读兼容（`z: 0/1` → `r/g` 归一化）
- [x] **Step 4**: `scripts/test.js` [22] 损坏容器/截断降级、[23] 旧容器兼容

### Task 3: 服务端下发计划与三态传输（REQ-009~011，ADR-006）

- [x] **Step 1**: `GET /api/download/session` 返回 `units`/`unitCount`/`parallel`；`/api/download/part` 支持 `index` 取片，按 `Accept-Encoding` 选 `store`/`recompress`/`raw`，加 `Vary` 与 `X-Transfer-Mode`/`X-Transfer-Codec`
- [x] **Step 2**: 压缩容器校验（`unitPayloadFits`）与损坏回退 500
- [x] **Step 3**: `scripts/test.js` [21] HTTP 编码协商（多 profile：宣称 br / 只宣称 gzip / identity）

### Task 4: 前端按计划下载 + 自适应并发（REQ-010/017，ADR-003）

- [x] **Step 1**: `downloader.js` 按服务端 `units` 计划 `index` 取片、分片长度校验、FS Access 流式写盘 / Blob 组装回退、取消与进度
- [x] **Step 2**: 自适应并发（按 32MB 内存预算与建议值收敛，成功反馈上调）
- [x] **Step 3**: `Retrieve.jsx` 展示传输编码/线上字节/已省比例
- [x] **Step 4**: `scripts/e2e-browser.js` E2E-2（浏览器自动解压 + 哈希一致）、E2E-3（限速 A/B 提速）、E2E-4（不可压缩不造假收益）、E2E-5（OPFS 流式写盘）

### Task 5: 观测与降级增量（REQ-019/020，ADR-007/008）

- [x] **Step 1**: `stats.recordTransfer`（会话内去重）+ `sessions.markSessionPart`；仪表盘「传输节省」卡片与副行
- [x] **Step 2**: `settings.compressionCodecs`（生效值 = 设置 ∩ env `COMPRESS_CODECS`）+ 管理端编码候选开关
- [x] **Step 3**: `/api/health` 新增 `transferStats`/`codecToggle`；E2E-6 真实浏览器核对卡片与接口一致

### 增量任务

- [x] **增量一（REQ-021，ADR-009）**：统计写入批量聚合（内存聚合 + 合并读 + 32 片/2s 刷盘 + 优雅退出刷盘）与开发/生产数据目录隔离（`scripts/dev.js` → `data-dev/`）
- [x] **增量二（REQ-022，ADR-010）**：按日/按文件维度明细（保留 30 天、文件维度随分享销毁回收并封顶 2000）
- [x] **增量三（REQ-023，ADR-011）**：导出 CSV（BOM + RFC 4180）与清零（`confirm: true` + `resetAt`/`resetCount` 审计），并修复计数写盘吞掉未刷盘维度增量

---

## 验收留痕

| 项 | 值 |
|---|---|
| `npm test` | 301 passed / 0 failed（首版交付 182；新增 37 条对抗断言） |
| `npm run e2e` | 78 passed / 0 failed（首版 15） |
| 线上实例（本机 :3002） | 2MB 日志类文件：存储 44.3%、传输省 55.7%、逐字节一致 |
| 响应头抽查（本次复核） | `br+gzip` → `Content-Encoding: br` / `X-Transfer-Mode: store`；仅 `gzip` → `Content-Encoding: gzip` / `recompress`；`identity` → 无 `Content-Encoding` / `raw`；三者均带 `Vary: Accept-Encoding` |
| 组件追溯 | `docs/architecture/C3-component.md` §2.1/§2.2/§5；ADR-004~011 |
