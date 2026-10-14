# 传输域 backlog 待触发项 实现计划（2026-10-13，计划快照）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **性质说明**：本文件是 **计划快照，不是执行结果**。它把 `docs/backlog.md` 中传输域尚未闭环的条目（B1-2、B1-4、B4-2、B4-4、B4-5、B4-8、B4-10）拆成「一个 Task = 一次提交 = 一个可独立验证的单元」，并写明**触发条件、要动的 file/function、验收命令与预设提交消息**。触发条件满足时照本文件逐条开做，无需重新勘察。本批（批次 6）已在触发条件满足下**逐条执行**：Task 1/2/3 的提交号与执行结果见上方 Status 与各 Task 末尾的「执行结果」小节；Task 4/5 早前已执行（`403298a`、`121d6b4`）。

**Goal:** 把传输域的全部「已定设计 / 待触发」条目转成可直接执行的任务分解，消灭「知道要做但不知道从哪下手」的状态。

**Status:** Task 1 / Task 2 / Task 3 / Task 4 / Task 5 **均已执行**（2026-10-13：`a217e55`、`b6eebf8`、`d8f2990`，加上早前的 B4-5 `308 passed` 与 B4-8 `343 passed`）。执行结果与偏差记录在各 Task 末尾的「执行结果」小节；全量回归 **`npm test` 375 passed / 0 failed、`npm run e2e` 93 passed / 0 failed、`npm run build` 通过**。

> **测试段号约定（三份计划共用）**：文中 `[30]~[33]` 与 `[E2E-12]` 表示**当前下一个空闲编号**（`scripts/test.js` 现最大为 `[29]`、`scripts/e2e-browser.js` 现最大为 `E2E-11`）。三份计划里的编号会互相撞号，**实现时一律以当时脚本的最大编号顺延 +1 为准**，不照抄本文件里的数字。

---

## 触发条件总览（何时启动哪个 Task）

> 下表为**原始触发条件**（立项时的排期依据）；Task 1~5 均已执行，执行记录见上方 Status。

| Task | backlog | 触发条件（满足其一即启动） |
|---|---|---|
| 1 | B1-2 | 单文件 >200MB 成为常态，或 `complete` 超时被反馈 |
| 2 | B4-10 / B4-4 / B1-4 | 排期本轮之后；或低端设备（非 Chromium）OOM 反馈 |
| 3 | B4-2 | 连续观测**同类文件重复上传占比 >20%** |
| 4 | B4-5 | `MAX_FILE_SIZE > 1024 × TRANSFER_PART_SIZE`（默认配置下需 >4GB） |
| 5 | B4-8 | 出现计费级精度诉求 |

---

## File Structure（按 Task 汇总，均为改动现有文件）

- Task 1：Create `server/jobs.js`；Modify `server/transfer.js`、`server/store.js`、`server/index.js`、`web/src/api.js`、`web/src/pages/Upload.jsx`、`scripts/test.js`
- Task 2：Modify `web/src/downloader.js`、`web/src/utils.js`、`web/src/pages/Retrieve.jsx`、`scripts/e2e-browser.js`、`docs/adr/ADR-003-browser-download-assembly.md`、`docs/adr/ADR-012-upload-session-persistence.md`
- Task 3：Create `server/objects.js`；Modify `server/compress.js`、`server/store.js`、`server/transfer.js`、`server/config.js`、`.env.example`、`scripts/test.js`、`docs/rfc/RFC-006-cross-file-dedup.md`、`docs/adr/ADR-015-cross-file-dedup-cas.md`
- Task 4：Modify `server/transfer.js`、`server/sessions.js`、`server/config.js`、`.env.example`、`scripts/test.js`
- Task 5：Modify `server/stats.js`、`server/index.js`、`scripts/test.js`

---

### Task 1: 压缩后台任务化（B1-2）

**触发条件**：单文件 >200MB 成为常态，或 `complete` 超时被反馈。
**Files:** Create `server/jobs.js`；Modify `server/transfer.js`（`complete` 处理，约 L261~L300）、`server/store.js`（`commitUpload` L55~L95）、`server/index.js`、`web/src/api.js`、`web/src/pages/Upload.jsx`、`scripts/test.js`、`docs/DEVELOPMENT.md` §6/§7

- [ ] **Step 1**: 新增 `server/jobs.js`——内存任务表（`Map<jobId, {status:'pending'|'running'|'done'|'failed', progress, error, result}>`），并发 1 的串行队列，`enqueue(task)` / `getJob(jobId)` / `listJobs()`；任务不落盘（进程重启即丢，与 ADR-012 的「上传会话可恢复」边界一致，需在文档写明）
- [ ] **Step 2**: `transfer.js` 的 `complete` 改为：写 meta 时标 `compressionState:'pending'`（未压缩，`storedSize = size`），**立即 201 返回**；把 `maybeCompress(...)` 包成队列任务，完成后回写 meta（`compressionState:'done'` + `storedSize`/容器字段）
- [ ] **Step 3**: 新增 `GET /api/upload/job?uploadId=`（凭 `uploadId` 查任务，返回 `status`/`progress`/`compressionState`）；`/api/health` 增 `compressQueue: { pending, running }`；同步 DEVELOPMENT §7 契约表
- [ ] **Step 4**: `Upload.jsx` 在 `complete` 成功后按 `uploadId` 轮询任务状态，展示「压缩中…」（完成即跳转取件码页）；`failed` 时提示「文件已保存（未压缩）」并提供重试按钮
- [ ] **Step 5**: 补测试 `scripts/test.js` 段 `[30]`：①`complete` 在压缩完成前即返回 201 且 meta 可查询；②轮询到 `done` 后逐字节一致（对照原始 SHA-256）；③压缩任务抛错时文件仍可下载（未压缩回退）且任务状态 `failed`；④`/api/health` 的 `compressQueue` 计数随任务增删
- [ ] **Step 6**: `set -o pipefail; npm test`（期望：既有 301 + 新增 ≥6 条全绿）→ 提交 — `feat(transfer): 压缩改为后台任务并暴露进度状态`

**验收标准**：大文件 `complete` 的 P95 响应时间不再包含压缩耗时（对照压缩前后日志）；压缩进行中访客可直接下载未压缩原文件；失败不丢文件。

**执行结果（已执行）**：
- Step 1~3 完成：`server/jobs.js`（串行队列 + `getJobByKey`）、`server/compress-job.js`（`compressionPlanned`/`enqueueCompression`/`compressionJob`）、`GET /api/upload/job`、`health.compressQueue`。
- **偏差 1（重要）**：验收标准里的「压缩进行中访客可直接下载未压缩原文件」**未采用**，改为「pending 窗口内下载先等落定（`waitForSettledBody`，默认 15s，超时 `503 文件正在处理，请稍后重试`）」。原因：分片计划（`units`/`ranges`）在会话建立时固定，若先按「未压缩」发计划、压缩随后落定，同一 `index` 会指向不同字节（长度与边界都变）⇒ 会把错位数据写进用户文件；要既发计划又允许并发改名，必须保留原文件直到最后一个会话结束（双倍磁盘 + 第二条删除路径），收益不成立。文档化的取舍见 DEVELOPMENT §6 规则 13。
- **偏差 2**：新增 `compressionState` 状态机与 `meta/<code>.packmeta` 边车（原计划只有 `compressionState`）；先写边车 → 改名 → 回写元数据，使「改名已发生但元数据未回写」的崩溃残局也能零丢失恢复（[37] 手工构造两种残局 + SIGKILL 真中断）。
- Step 4 完成（`Upload.jsx` 展示「压缩中…」并按 `code` 轮询；`api.waitUploadJob`）。
- Step 5 完成：[36] 13 条 + [37] 5 条；另有 `scripts/test.js` 新增 `settleCompression`/`mergeCompression` 助手，既有用例改为「上传后等任务落定再断言最终形态」。
- 全量：`npm test` **362 passed / 0 failed**（当批），`npm run e2e` 93 passed / 0 failed，`npm run build` 通过。

---

### Task 2: 下载写 OPFS 暂存 + 刷新后字节级续写（B4-10 / B4-4 / B1-4）

**触发条件**：排期本轮之后；或低端设备（非 Chromium）OOM 反馈。
**依据**：ADR-012「修订一」已实测结论——`FileSystemFileHandle` 存 IndexedDB 后跨刷新/跨重启 `queryPermission('readwrite')` 均 `granted`；`createWritable({ keepExistingData: true }) + seek(已写偏移)` 续写逐字节一致（65536 + 32768 = 98304）。
**Files:** Modify `web/src/downloader.js`（`parallelDownload` / `canStreamToDisk` / `planRanges`）、`web/src/utils.js`、`web/src/pages/Retrieve.jsx`、`scripts/e2e-browser.js`、`docs/adr/ADR-003-browser-download-assembly.md`、`docs/adr/ADR-012-upload-session-persistence.md`、`docs/DEVELOPMENT.md` §12

- [ ] **Step 1**: `downloader.js` 增 `canUseOpfs()`（`typeof navigator?.storage?.getDirectory === 'function'`）与暂存命名 `fs-download-<code>.part`（OPFS 根目录，句柄 + `writtenBytes` 存 IndexedDB，键 `fs-download-opfs:<code>`）
- [ ] **Step 2**: 改写落盘路径三态：①**OPFS + 续写**（首选）——`getFileHandle(name)` → `queryPermission/requestPermission` → `createWritable({ keepExistingData: true })` → `seek(writtenBytes)` 后顺序写；②`showSaveFilePicker` 存在且用户在手势期已选文件 → 直接写用户句柄（现状）；③非 Chromium / 无 OPFS → **Blob 回退**（现状保留，B1-4 的剩余风险如实记录）
- [ ] **Step 3**: 完成后导出：OPFS 文件 → 一次性交给用户（Chromium 走 `showSaveFilePicker` 或 `Blob + <a download>`）；导出成功才清 OPFS 暂存与本地记录，失败保留（可重试）
- [ ] **Step 4**: 多标签互斥——`navigator.locks.request('fs-download-<code>', ...)` 包住暂存写入，第二个标签等待或直接回退 Blob（避免并发写同一暂存文件）
- [ ] **Step 5**: 补 E2E `scripts/e2e-browser.js` 段 `[E2E-12]`：阻断 `/api/download/part` → 失败但保留 token → `Page.reload` → 续用同一 token 完成；断言 ①OPFS 暂存偏移 == 已收字节（断点前后只补缺口）②落地文件 SHA-256 一致 ③`totalDownloads` 只 +1
- [ ] **Step 6**: 文档：ADR-012 增「修订二（OPFS 暂存落地）」；ADR-003 记录「非 Chromium 仍为 Blob、大文件建议 Chromium 系浏览器」；DEVELOPMENT §12 写「导出对话框需有头人工验收 / OPFS 容量取决于磁盘剩余 / 多标签互斥」
- [ ] **Step 7**: `set -o pipefail; npm run e2e`（期望：既有 78 + 新增 ≥5 条全绿）→ 提交 — `feat(web): 下载先写 OPFS 暂存并支持刷新后字节级续写`

**验收标准**：刷新/重启后重试**只请求缺口分片**（网络字节数 < 首次全量）；落地文件逐字节一致；Firefox/Safari 走 Blob 不回归。
**限制（不可自动验证，需人工）**：①导出对话框（`showSaveFilePicker` 必须有头浏览器人工验收）②OPFS 容量上限（取决于磁盘剩余）③非 Chromium 真机峰值内存（B1-4 关闭前提，见下）。

**执行结果（已执行）**：
- Step 1~4 完成：`canUseOpfs()`/`stagedName()`/`stagedResume()`（**前缀必须正好等于前 k 片字节和**，非对齐则丢弃重写）/`openStagedWriter()`；三态落盘（用户句柄 > OPFS 暂存 > 内存 Blob）；导出走暂存文件的 blob URL + 120s 清理；`navigator.locks`（`ifAvailable`）互斥，拿不到锁的标签回退 Blob（**不另建会话**，避免多消耗一次下载次数）。
- **偏差**：暂存**不逐片提交，改为每 4 片提交一次**。原因：`createWritable({ keepExistingData: true })` 的 `close()` 会把旧内容与新写区间整体落盘，逐片提交在 E2E-3 的 14MB/16 片下载上实测多花约 0.6s（端到端 1554ms → 940ms，单流基线 1493ms，原断言 `elapsed < baseline` 会失败）。续写粒度因此变成「4 片」，仍满足验收标准。
- **偏差**：不把「已写偏移」存 IndexedDB（原计划 Step 1），改为直接用 OPFS 文件长度（提交粒度已是整片，长度即前缀），少一份需要与文件保持一致的旁路状态。
- Step 5 完成：E2E-8 重写为「限速 2MB/s 下载中 `Page.reload` 中断 → 已提交 1MB（4 片）→ 刷新后续用同一 token **只请求 12/16 片** → 落地 SHA-256 一致 + `totalDownloads` 只 +1 + 暂存写满原始大小」。
- Step 6 完成：ADR-012 增「修订二」、ADR-003 增「修订一」、DEVELOPMENT §12/§14.2 更新。
- 全量：`npm run e2e` **93 passed / 0 failed**（新增 2 条断言）；`npm run build` 通过。

---

### Task 3: 跨文件去重 CAS（B4-2）

**触发条件**：连续观测同类文件重复上传占比 >20%。
**依据**：`docs/rfc/RFC-006-cross-file-dedup.md`（REQ-042~047）+ `docs/adr/ADR-015-cross-file-dedup-cas.md`（Proposed）。本 Task 只做「把 RFC 拆成可执行步」，设计不在此重述。
**Files:** Create `server/objects.js`；Modify `server/compress.js`（`maybeCompress` / `readUnit` / `streamPayload`）、`server/store.js`（`commitUpload` / `getFileStreamPath`）、`server/transfer.js`、`server/config.js`、`.env.example`、`scripts/test.js`、`docs/rfc/RFC-006-*.md`、`docs/adr/ADR-015-*.md`

- [ ] **Step 1**: 新增 `server/objects.js`：路径严格按 RFC-006 §4——`data/objects/<hash 前 2 位>/<hash 后 62 位>`（`hash` = 载荷 sha256 **全 64 位十六进制**，非 ADR-005 的 128bit 截断）；`writeObject(buffer)`（tmp + rename 原子落盘）、`hasObject(hash)`、`streamObject(res, hash)`；**未压缩文件不进 CAS**（保持 `res.download` 零改动）
- [ ] **Step 2**: `compress.js` 的 `maybeCompress` 产出**清单** `units[{ h, c, r, z }]`（去掉文件内偏移 `o`；`h` = 单元载荷 sha256 **全量**——碰撞后果是「甲的字节被乙替换」，不能截断）；载荷写 CAS 而非单文件容器
- [ ] **Step 3**: `store.js` meta 增 `storageVersion: 2` + `units` 清单；下载读取路径按清单从 `objects/` 取载荷；旧单文件容器**只读兼容**（无 `units[]` 清单 → 走老路径）
  - **前置：先理顺容器版本命名**。RFC-006 §4.4 写「关闭时走 `units`、开启后写 `units-v2`」，但代码里 `COMPRESSION_FORMAT` **当前已经是 `units-v2`**（`server/compress.js` L20）。实现时以代码为准：CAS 清单容器另取 **`units-v3`**，用 `meta.storageVersion: 2` 标记清单化，并同步修正 RFC-006 §4.4 措辞。**不要**把既有 `units-v2` 重新定义为新格式（会让已存文件被误判）
- [ ] **Step 4**: GC：**不落引用计数**——启动时 + 每 6h 扫描 `data/meta/*.json` 派生被引用对象集合，对 `data/objects` 中「未被引用且 mtime 早于 1h 宽限期」的对象回收；删除分享不立即回收（GC 是唯一删除路径）
- [ ] **Step 5**: `config.js` 增 `crossFileDedup`（env `CROSS_FILE_DEDUP`，**默认 off**）+ `.env.example` + DEVELOPMENT §4；开关 off 时行为与当前**完全一致**
- [ ] **Step 6**: 补测试 `scripts/test.js` 段 `[31]`：①两个相同内容文件 → `objects/` 只落一份载荷；②删除其中一个分享 → 对象保留（宽限期内）；③两者都删且宽限期过 → GC 回收；④开关 off 时 `objects/` 为空且下载逐字节一致；⑤旧容器文件仍可下载（只读兼容）
- [ ] **Step 7**: 文档：RFC-006 §8 回填验收数据；ADR-015 由 `Proposed` → `Accepted`；C3 §2/§5、DEVELOPMENT §5/§7 同步
- [ ] **Step 8**: `set -o pipefail; npm test`（期望：既有 301 + 新增 ≥8 条全绿）→ 提交 — `feat(store): 跨文件内容寻址去重（开关默认关闭）`

**验收标准**：重复内容多份上传后 `data/objects` 体积 ≈ 单份；删除分享不破坏其他文件引用；开关 off 时零行为变化。
**残余风险（已入档，勿在实现时遗忘）**：跨文件去重会泄露「服务器已存在某内容」；单站点单管理员下判定可接受，多租户需改租户 HMAC 命名。

**执行结果（已执行，默认 off）**：
- Step 1~3 完成：`server/objects.js`（`writeObject`/`readObject`/`objectSize`/`streamObject`/`collectManifests`/`sweepObjects`/`objectStats`/`referencedStats`/`dedupState`）；`compress.js` 的 `packManifest`/`packObjects`、`CAS_FORMAT='units-v3'`、`CAS_STORAGE_VERSION=2`、`unitsPayloadOk`/`planPayloadOk`/`streamStoredPayload`；`store.bodyAvailable`（清单化没有 `files/<code>`）。
- **前置项已按计划处理**：容器版本按代码现状另取 **`units-v3`**（`units-v2` 已被内嵌容器占用，重新定义会让已存文件被误判），并同步修正 RFC-006 §4.4 措辞。
- Step 4 完成：GC 不落引用计数，启动 + `DEDUP_GC_INTERVAL_MS` 周期扫描清单派生引用；**GC 是唯一删除路径**（`removeShare` 不碰对象）。
- Step 5 完成：`CROSS_FILE_DEDUP`（默认 off）+ `DEDUP_GC_GRACE_MS`/`DEDUP_GC_INTERVAL_MS` + `.env.example` + DEVELOPMENT §4。
- Step 6 完成：[38] 共 13 条（隔离端口 `CROSS_FILE_DEDUP=on`、宽限期 1ms、周期拉长以免周期 GC 在打包途中误删「已写、清单未落」的对象；回收用「重启触发启动 GC」验证）。
- **偏差**：接受清单的条件是「`Σc < size` **或** `crossHits > 0`」（原文只要求整体有压缩收益），因为跨文件命中本身就是收益（不可压缩但重复的文件也应进 CAS）。
- Step 7 完成：RFC-006 §6/§8 回填验收、ADR-015 → Accepted、C3 §2/§3/§5/§6 与 DEVELOPMENT §5/§7 同步。
- 全量：`npm test` **375 passed / 0 failed**（新增 13 条）；`npm run build` 通过。

---

### Task 4: 分片数超限时向上放宽 partSize（B4-5）

**触发条件**：`MAX_FILE_SIZE > 1024 × TRANSFER_PART_SIZE`（默认配置下需 `MAX_FILE_SIZE > 4GB`）。因默认行为零变化，也可作为**主动防御**提前修。
**Files:** Modify `server/transfer.js`（init 约 L198~L199）、`server/sessions.js`（`createUploadSession` 已落盘 `partSize`）、`server/config.js`、`.env.example`、`scripts/test.js`、`docs/DEVELOPMENT.md` §4/§6

- [ ] **Step 1**: `transfer.js` init：把硬编码的 `if (totalParts > 1024) return fail(...)` 改为**先放宽再判定**——`let partSize = config.transferPartSize; while (Math.ceil(size / partSize) > MAX_PARTS) partSize *= 2`；仍超限才 400。`session.partSize` 用**有效值**（已随位图落盘并被 `init`/`status` 回传，续传语义不变）
- [ ] **Step 2**: 确认 express.raw 的 body 上限与有效 `partSize` 匹配（否则放宽后仍会 413）；同步 `.env.example` 与 DEVELOPMENT §4 的 `TRANSFER_PART_SIZE` 说明
- [ ] **Step 3**: 补测试 `scripts/test.js` 段 `[32]`：用隔离端口小 `TRANSFER_PART_SIZE`（如 256KB）+ 大 `MAX_FILE_SIZE` 造出超限场景 → ①init 成功且返回的 `partSize` 已被放大到使 `totalParts ≤ 1024`；②按放大后的 `partSize` 上传可完成且逐字节一致；③带 `uploadId` 续传复用**同一** `partSize`（不重算）
- [ ] **Step 4**: `set -o pipefail; npm test`（期望：既有 301 + 新增 ≥3 条全绿）→ 提交 — `fix(transfer): 片数超限时向上放宽分片大小而非直接拒绝`

**验收标准**：默认配置（`MAX_FILE_SIZE=100MB`、`TRANSFER_PART_SIZE=4MB`）下 `partSize` 与 `totalParts` 与当前**逐字节相同**；仅在超限场景放宽。

---

### Task 5: 统计追加日志（WAL，B4-8）

**触发条件**：出现计费级精度诉求（当前 ADR-009 决策 5 明确接受「最多丢一个刷盘窗口 ≤2s 或 ≤31 片」）。**默认不实施**。
**Files:** Modify `server/stats.js`、`server/index.js`（启动重建）、`scripts/test.js`、`docs/adr/ADR-009-stats-write-batching.md`

- [ ] **Step 1**: `stats.js` 在 `recordTransfer` 时**追加写** `data/transfer-stats.wal`（每行一条 JSON：`{ t, code, originalBytes, wireBytes }`，`fs.appendFileSync` 或常驻 fd）
- [ ] **Step 2**: 启动时重放 WAL 重建 counters 与维度明细（`days`/`files`），再按原逻辑刷盘；`flushCounters` 成功后把 WAL 截断（或记录已消费 watermark，避免重复累加）
- [ ] **Step 3**: WAL 落盘失败时降级为当前行为（只告警，不阻断下载）
- [ ] **Step 4**: 补测试 `scripts/test.js` 段 `[33]`：①写入后**不触发 flush** 直接重启（子进程/模拟）→ 数据仍在（零丢失）；②重复启动不重复累加（watermark 生效）；③WAL 截断后文件为空且计数正确
- [ ] **Step 5**: ADR-009 增「修订：可选 WAL 档位（默认关）」→ 提交 — `feat(stats): 追加日志保证崩溃零丢失（默认关闭）`

**验收标准**：开启后杀掉进程（`SIGKILL`）重启，`/api/admin/stats` 的累计值与崩溃前已返回给下载端的字节数一致；关闭时行为与当前一致。

---

### 收尾 Task: 全量回归 + 文档（每个 Task 完成后各自执行）

- [ ] **Step 1**: `set -o pipefail; npm test`（记录 passed 数）；改前端时另跑 `npm run build`；触及下载链路时另跑 `set -o pipefail; npm run e2e`
- [ ] **Step 2**: 文档收尾——`docs/backlog.md` 对应行标记闭环（ID 加删除线 + 写 `**Completed YYYY-MM-DD**：<结果数字>`）；`docs/ARCHITECTURE C3` §5 追溯矩阵、§6 变更日志；`docs/DEVELOPMENT.md` 对应小节；`knowledge.md` 若语义变了同步
- [ ] **Step 3**: 提交 — `docs: <本次改动> 追溯与契约同步`

---

## Self-Review

- **数值语义**：Task 1 未压缩期间 `storedSize = size`（统计口径不变，ADR-007）；Task 2 `loaded/percent` 仍按**原始字节**；Task 3 清单去掉 `o` 后必须保证 `Σr === size` 且无缝覆盖（沿用 `unitsCoverage` 自检）；Task 4 只放大 `partSize`，不改 `size`/`partSize` 的对外含义。
- **与既有机制共存**：Task 2 必须保留 `fs-download:<码>` token 语义（失败保留、`end` 才清）；Task 3 必须保留「≤1MB 单流导航下载」与「未压缩文件不进 CAS」；Task 5 必须与 ADR-011 的「计数写盘不吞维度增量」不冲突（WAL 在 `recordTransfer` 侧，flush 语义不变）。
- **回归**：每 Task 独立跑 `npm test`；Task 2 额外 `npm run e2e`；Task 3/4 触及 `transfer.js` 时 `[17]~[19]`/`[26]` 必须通过。
- **不可自动验证项**：Task 2 的导出对话框、OPFS 容量、非 Chromium 真机内存——写进 ADR-012 修订与 DEVELOPMENT §12，不谎报为已验证。
