# Backlog 待办清单（工程级）

> Status: Active | Created: 2026-10-12 | Updated: 2026-10-13 | 用途：归档跨阶段遗留项，防止遗漏；每项含证据、现状、收尾标准
> 关联：RFC-001~007、ADR-001~016
> 批次 3 闭环：B1-3、B3-1、B3-2、B5-1、B6-1~B6-4；B2-4 本地部分已验证（公网抽查待上线）。
> 批次 4 闭环：**B4-10/B4-4 实测完成（OPFS 句柄跨刷新与跨浏览器重启均持久，方案定为 OPFS 暂存 + 完成后导出）**、**B4-3 调研完成（决策：不在导航下载上启用 `Content-Encoding`）**、**B4-2 与 B5-3 的设计阶段关闭（RFC-006/ADR-015、RFC-007/ADR-016 草案入档）**。
> 批次 6（本轮，本轮逐个实现）：按 `2026-10-13-transfer-backlog-plan.md` 把传输域剩余三项**全部落地**——**B1-2 压缩后台任务化**（`a217e55`）、**B4-10/B4-4 下载 OPFS 暂存 + 刷新后字节级续写**（`b6eebf8`）、**B4-2 跨文件去重 CAS（默认 off）**（`d8f2990`）；`npm test` **375 passed / 0 failed**、`npm run e2e` **93 passed / 0 failed**、`npm run build` 通过。至此传输/存储域**不存在未实现的待触发项**，仅剩「需人工/真机验收」与「需业务触发才开启」两类。
> 批次 5（仅文档）：把剩余**待触发**项拆成可执行实现计划快照（含触发条件 / file:function / 验收命令 / 预设提交消息），代码未改——`docs/superpowers/plans/2026-10-13-transfer-backlog-plan.md`（B1-2、B1-4、B4-2、B4-4、B4-5、B4-8、B4-10）、`docs/superpowers/plans/2026-10-13-notice-backlog-plan.md`（B5-2、B5-3、B5-4）、`docs/superpowers/plans/2026-10-13-admin-preset-backlog-plan.md`（B7-1~B7-3）。

## B0. 已闭环

- 公告预设运维闭环（backlog B6-1~B6-4，代码/测试/文档本批提交）：预设从纯 CRUD 扩为可运维素材库——**上限可配置**（站点设置 `presetLimit`，默认 10，钳制到新 env `MAX_NOTICE_PRESETS` 默认 50，调低不删已有预设）、**排序**（`order` + `PUT /api/admin/notice/presets/order` + 管理端每行 ↑/↓ 按钮，用按钮而非拖拽以保持零新依赖）、**导入/导出**（`GET .../export` 带 `format: file-share-notice-presets`/`version: 1` 的 JSON 附件；`POST .../import` 支持 `merge`/`replace`、重名加（2）（3）序号、容量超出计 `skipped`、格式/版本/条目/条数校验）、**启用审计**（`appliedAt`/`appliedBy` = 管理密钥指纹 `key:`+sha256 前 8 位/`appliedCount`，管理端展示「上次启用 时间 · 指纹 · 共 N 次」，公告写失败不写审计）、**乐观锁**（预设与公告均带 `rev`，携带旧版本号写入 409 并自动刷新，不带 `rev` 仍兼容）。`npm test` **301 passed / 0 failed**（新增 [29] 共 17 条）、`npm run e2e` **78 passed / 0 failed**（新增 E2E-11 共 10 条：排序点击落库、审计行、真实下载导出 JSON、站点设置改上限即时生效）；参见 ADR-014 修订一、RFC-005 增量、DEVELOPMENT §4/§5/§7、C3 §2/§5/§6。
- 动效无障碍（backlog B5-1，代码/测试/文档本批提交）：`NoticeBar.jsx` 新增 `useReducedMotion()`（`matchMedia` + change 监听），系统开启「减少动态效果」时四种滚动一律降级为静态（保留单行省略与 `title` 完整提示、副本不复制），视图加 `role="status"` + `aria-live="polite"`，`index.css` 加 `@media (prefers-reduced-motion: reduce)` 动画兜底；E2E-9 用 `Emulation.setEmulatedMedia` 真实验证「降级 → 语义保留 → 取消模拟后恢复动画」；参见 ADR-013 修订三、RFC-004 增量四、C3 §2.2/§2.3/§5/§6。
- 会话数限流加固（backlog B1-3，代码/测试/文档本批提交）：按 IP 限制在途会话数与待处理临时空间——`sessions.js` 记录会话归属 IP（上传位图落盘含 `ip`，重启恢复后仍归位；旧文件归空 IP 桶不占额）并新增 `countDownloadSessions`/`uploadTmpUsage`（只看未过期会话）；`config.js` 新增 `MAX_UPLOAD_SESSIONS_PER_IP`（默认 8）/`MAX_DOWNLOAD_SESSIONS_PER_IP`（默认 32）/`MAX_TMP_BYTES_PER_IP`（默认 512MB）；`transfer.js` 在新建上传会话与创建下载会话前拦截，超限 429，**下载侧拦截发生在 `tryConsume` 之前**（被拒请求不消耗取件次数），续传（带 `uploadId`）复用既有会话不占新名额，`complete`/`end`/TTL 清扫即时释放；`/api/health` 新增 `sessionQuota`。`npm test` **284 passed / 0 failed**（新增 [28] 共 12 条，隔离端口小配额服务器：字节配额、会话数配额、续传豁免、位图 IP 归属、完成即释放、下载配额 429 不消耗次数、end 后释放）；参见 ADR-002 修订一、DEVELOPMENT §4/§7、C3 §2.1/§3/§5/§6。
- 文档一致性（backlog B3-1/B3-2，本批提交）：C3 的 §2 组件表、§3 数据流、§5 追溯矩阵、§6 变更日志已按三批实现（RFC-004 增量三、B1-3、B5-1、B6-1~B6-4）核对补齐，引用到的测试段号（[28]/[29]/E2E-9/E2E-11）与函数名（`countDownloadSessions`/`uploadTmpUsage`/`effectivePresetLimit`/`reorderPresets`/`exportPresets`/`importPresets`/`useReducedMotion`）逐项对照实现存在；RFC-002 补 `docs/superpowers/plans/2026-10-12-adaptive-units-plan.md`（追补快照：任务分解 + 验收留痕，含本次响应头复核数据）并在 RFC-002 头部回链。
- 分片断点续传（RFC-003 REQ-024~029，关闭 B1-1，代码/测试 `0491e16`）：上传会话位图落盘（`tmp/<id>.json`）+ 启动恢复（取代整目录清空，重启不再丢在途会话）；新增 `GET /api/upload/status`、`GET /api/download/status`、`init` 的 `uploadId` 复用；前端按 `fs-upload:` 指纹与 `fs-download:` token 自动续传（成功才 `end`，不重复消费）；密码改为 SHA-256 落盘（`passwordHash`）。`npm test` **249 passed / 0 failed**（新增 18 条）、`npm run e2e` **37 passed / 0 failed**（新增 E2E-8：阻断分片→刷新→续传，落地文件哈希一致）；参见 `docs/rfc/RFC-003-resumable-chunked-transfer.md`、`docs/adr/ADR-012-upload-session-persistence.md`。
- 初始基线：项目首个 git 提交 `24a91e6`（41 文件）；`npm test` 100 通过 / 0 失败（2026-10-12 实测）。
- 传输优化 RFC-001（压缩 + 分片并行，REQ-001~008 全部通过）：服务端 `414bb78`、前端 `0fbc1c0`；`npm test` 145 passed / 0 failed（基线 100 + 新增 45）；`npm run build` 通过；Chrome headless（CDP）浏览器冒烟 3/3。参见 `docs/rfc/RFC-001-compression-chunked-transfer.md` §6/§8。
- 传输维度明细的导出与清零（RFC-002 REQ-023，关闭 B4-9，代码/测试 `c8cac85`）：新增 `GET /api/admin/stats/export`（CSV 长表：BOM + RFC 4180 转义，全量 30 天 + 全部文件条目，文件名关联分享）与 `POST /api/admin/stats/reset`（`{ confirm: true }`，重置站点传输累计与全部明细，审计 `resetAt`/`resetCount`，上传/下载次数不受影响）；同时修复上传/下载计数写盘会吞掉未刷盘维度增量的问题。`npm test` **231 passed / 0 failed**（新增 19 条）、`npm run e2e` **29 passed / 0 failed**（新增 8 条：E2E-7 真实浏览器导出/清零）；参见 `docs/adr/ADR-011-transfer-export-reset.md`。
- 传输节省维度明细（RFC-002 REQ-022，关闭 B4-6，代码/测试 `6eb7374`）：新增 `data/transfer-stats.json`（与站点计数共刷盘窗口）：日维度保留 30 天、文件维度随分享销毁回收并封顶 2000；`/api/admin/stats` 增 `transferToday`/`transferDays`（近 7 日），`/api/admin/list` 每项增 `transfer`；仪表盘「今日 + 近 7 日」、文件管理页「传输节省」列。`npm test` **212 passed / 0 failed**（新增 9 条）、`npm run e2e` **21 passed / 0 failed**（新增 3 条界面断言）；线上实测 3,908,890B/15 片：今日桶与按文件维度即时准确，磁盘维度文件窗口内落盘，分享销毁后条目被清理而日桶保留；参见 `docs/adr/ADR-010-transfer-dimension-retention.md`。
- 统计写入批量聚合（RFC-002 REQ-021，关闭 B4-7，代码/测试 `96c13d2`）：内存聚合 + 合并读（读接口永不陈旧）+ 32 片/2s 刷盘 + 优雅退出刷盘；同时把开发环境数据目录与生产隔离（`scripts/dev.js` 默认 `DATA_DIR=data-dev`）。`npm test` **203 passed / 0 failed**（新增 8 条）、`npm run e2e` **18 passed / 0 failed**；线上实测 18 片下载：接口侧即时准确、磁盘 1250ms 收敛（窗口内同步写 0 次）；参见 `docs/adr/ADR-009-stats-write-batching.md`。
- 观测与降级增量（RFC-002 REQ-019/020，关闭 B4-1，代码/测试 `8a900f0`）：传输节省落库 + 仪表盘「传输节省」卡片（`stats.recordTransfer`，会话内去重，节省值派生）、管理端编码候选开关（`settings.compressionCodecs`，env 为上限）；`npm test` **195 passed / 0 failed**（新增 13 条）、`npm run e2e` **18 passed / 0 failed**（新增 E2E-6：真实浏览器登录管理端并核对卡片与接口一致，实测线上 4,691,564 / 原始 32,594,304 = 省 86%）；参见 `docs/adr/ADR-007-transfer-savings-counting.md`、`docs/adr/ADR-008-admin-codec-toggle.md`、DEVELOPMENT.md §5/§7/§13.7。
- 下载提速 RFC-002（自适应单元 + 传输压缩，REQ-009~018 全部通过）：服务端 `ba57346`、前端 `719b9c5`、测试 `40494c9`（文档随 RFC-002 提交）；`npm test` **182 passed / 0 failed**（基线 145 + 新增 37 条对抗断言）；`npm run e2e` **15 passed / 0 failed**（真实 headless Chrome，含浏览器自动解压哈希校验、限速 A/B 提速 6.30x、OPFS 流式写盘）；线上实例实测 2MB 日志类文件存储 44.3% / 传输省 55.7% 且逐字节一致。参见 `docs/rfc/RFC-002-adaptive-units-transfer-compression.md` §6/§8。
- 公告样式 RFC-004（REQ-030~035）+ 增量二/三/四：位置/滚动/配色 + `scrollFill` 两种横向模式 + 动效无障碍，代码/测试 `0030699`、`d9ba044`、`47b3e57` 与本批提交；`npm run e2e` E2E-9 覆盖计算样式与无障碍降级。参见 `docs/adr/ADR-013-notice-style-model.md`。
- 公告预设 RFC-005（REQ-036~041）+ 增量一（B6 四项）：代码/测试 `d69c771` 与本批提交；参见 `docs/adr/ADR-014-notice-preset-model.md`。

## B1. 传输优化遗留（RFC-001 之后）

| ID | 项 | 现状与证据 | 结论 / 下一步 |
|---|---|---|---|
| B1-2 | 压缩后台任务化 | ✅ **已实现（2026-10-13，代码/测试 `a217e55`）**：`server/jobs.js`（内存任务表 + **并发 1 串行队列**）+ `server/compress-job.js`（CAS 优先 → 内嵌回退 → 未压缩回退）；`/api/upload` 与 `/api/upload/complete` 只落位文件并标 `compressionState: 'pending'`（`storedSize = size`、无 `units`）后**立即 201**，压缩完成才回写元数据；内嵌路径先写 `meta/<code>.packmeta` 边车 → 改名 → 回写，崩溃后启动 `repairPendingCompressions()` 按边车补齐或回退未压缩（零丢失）；新增 `GET /api/upload/job?uploadId=|code=` 与 `health.compressQueue`；下载四处（`/api/download`、download session/status/part）在 pending 窗口内先 `waitForSettledBody`（超时 503），避免分片计划漂移；`Upload.jsx` 展示「压缩中…」 | **证据**：`npm test` [36]（13 条）+ [37]（5 条，含边车两种残局与 SIGKILL 真实中断），**362 passed / 0 failed**（当批）；`npm run build` 通过 |
| B1-3 | 会话数限流加固 | ✅ 已闭环（见 B0） | — |
| B1-4 | 非 Chromium Blob 组装内存峰值 | **Chromium 侧已消解**（B4-10 落地：下载先写 OPFS 暂存，内存不再随文件大小增长）；非 Chromium（Firefox/Safari）无 OPFS 句柄持久化语义，仍走内存 Blob 回退（headless Chromium 无法代表该路径，本轮仍无真机数据） | **待触发**：触发条件 = 非 Chromium 低端设备 OOM 反馈；届时真机实测峰值内存，必要时在取件页对非 Chromium 大文件给出「建议 Chromium 系浏览器」提示（已在 DEVELOPMENT §12 登记为人工确认项） |
| B1-5 | 标准 HTTP Range/206 评估 | 维持 ADR-002 的否决（与消费计数冲突） | **维持**：触发条件 = 出现「单连接断点续传」硬需求时重开 ADR-002，届时同步 RFC-003 的续传语义 |

## B2. 环境与依赖

| ID | 项 | 说明 | 结论 / 下一步 |
|---|---|---|---|
| B2-1 | `TRANSFER_PART_SIZE` 部署提示 | 已登记 `.env.example` + DEVELOPMENT.md §4 | ✅ 保持（排查传输问题时优先检查该值） |
| B2-3 | `UNIT_*` / `COMPRESS_CODECS` 部署提示 | 已登记 `.env.example` + DEVELOPMENT.md §4 | ✅ 保持（CPU 吃紧时 `COMPRESS_CODECS=gzip`） |
| B2-4 | 正向代理/CDN 会否剥掉 `br` | **本地已抽查**（临时探针，端口 3991，可压缩文本 800,000B→存储 44B）：宣称 `br` → `Content-Encoding: br` + `X-Transfer-Mode: store`；仅 `gzip` → `gzip` + `recompress`；`identity` → 无 `Content-Encoding` + `raw`；三者均带 `Vary: Accept-Encoding` | **公网抽查待上线**：已把「公网抽查传输响应头」写入 DEVELOPMENT.md §12 安全/上线清单；届时若代理剥掉 `br`，功能无影响，将 `COMPRESS_CODECS` 降为 `gzip` 即可 |
| B2-2 | git 提交身份为仓库级占位 | `user.name=zwh`、`user.email=zwh@local` | **需用户输入**：提供真实邮箱后执行 `git config user.email <真实邮箱>`（本轮不改动提交身份） |

## B3. 文档一致性

| ID | 项 | 说明 | 结论 / 下一步 |
|---|---|---|---|
| B3-1 | C4 与实现同步检查 | ✅ 已闭环（见 B0）：C3 §2/§3/§5/§6 按三批实现核对补齐，测试段号与函数名逐项对照 | 保持：每次收尾时按同法核对（列入「新增接口必须同步 DEVELOPMENT §7 + C3」的既有约定） |
| B3-2 | RFC-002 无独立 spec/plan 快照 | ✅ 已闭环（见 B0）：补 `docs/superpowers/plans/2026-10-12-adaptive-units-plan.md` 并在 RFC-002 头部回链 | 保持：后续 RFC 落地时**先建计划文件**，避免再补追 |

## B4. 下载提速遗留（RFC-002 之后）

| ID | 项 | 现状与证据 | 结论 / 下一步 |
|---|---|---|---|
| B4-2 | 跨文件去重 | ✅ **已实现（2026-10-13，代码/测试 `d8f2990`，开关默认 off）**：新增 `server/objects.js`（`data/objects/<hh>/<hash>`，sha256 **全量**命名、tmp + rename 原子写、命中即不写盘）、清单化容器 `units-v3` + `meta.storageVersion: 2`（单元 `{ h, c, r, z }`，不再生成 `data/files/<code>`）、引用由 `collectManifests()` 派生、启动 + `DEDUP_GC_INTERVAL_MS` 周期 `sweepObjects()`（宽限期 `DEDUP_GC_GRACE_MS`）回收且**GC 是唯一删除路径**；`admin/stats` 增 `dedupCross*`（对象数/字节/若无去重需存字节/比值），`health.dedup` 暴露 enabled/objects/bytes/lastGcAt/lastGcRemoved；`CROSS_FILE_DEDUP=off` 时对象目录恒为空（零行为变化）。**证据**：`npm test` [38] 共 13 条，**375 passed / 0 failed**；ADR-015 转 Accepted。原设计（已按此实现）：`RFC-006`（`docs/rfc/RFC-006-cross-file-dedup.md`，Implemented）+ `ADR-015`（Accepted）——对象粒度 = 自适应单元（复用 ADR-004 的 CDC 对齐），对象名 = sha256 **全量**（非 128bit 截断，因为碰撞后果从「同文件内错配」变成「甲的字节被乙替换」），`data/files/<code>` 由「整文件容器」改为清单（`units[{h,c,r,z}]`，去掉文件内偏移 `o`），载荷入 `data/objects/<hh>/<hash>`；**引用计数不落盘**，由清单派生（启动/每 6h 扫描 `data/meta/*.json` 得被引用集 + 1h 宽限期清扫），删除分享不立即回收（GC 是唯一删除路径）；未压缩文件**不进 CAS**（保持 `res.download` 零改动）；开关 `CROSS_FILE_DEDUP` **默认 off** | **开启仍待触发**：实现已完成且默认 off，**建议先连续观测同类文件重复上传占比 >20%** 再开启；残余风险 = 跨文件去重会泄露「服务器已存在某内容」（单站点单管理员下判定可接受，多租户需改租户 HMAC 命名）。实现步骤见 `docs/superpowers/plans/2026-10-13-transfer-backlog-plan.md` Task 3（已执行） |
| B4-3 | ≤1MB 小文件的传输压缩 | ✅ **调研已完成，决策：不在导航下载上启用 `Content-Encoding`**。现状核实：≤1MB 走 `window.location.href → /api/download`，服务端 `streamOriginal`（逐单元解压后写出）/`res.download` 均为**网络原始字节、不带 `Content-Encoding`**，因此无损坏风险也无传输压缩收益。调研证据：Chromium issue 41242019「Files are CHANGED (corrupted) on DOWNLOAD」——服务端带 `Content-Encoding: gzip` 时由浏览器内容编码层解压，客户端/下载管理器若不按同规则处理即得改变/损坏的文件；Firefox bug 406948 记录站点长期滥用 `Content-Encoding`（本意 `Transfer-Encoding`）配合 `Content-Disposition` 的兼容雷区。结论：对**导航下载**（`Content-Disposition: attachment`）注入 `Content-Encoding` 的风险收益比不成立 | **维持（带安全替代方案）**：触发条件 = 运营反馈小文件下载慢；届时实现走**同源 `fetch` 单请求（浏览器透明解压，已有 E2E 证明）+ 内存 Blob（≤1MB）+ `<a download>`**，而非给导航下载加 `Content-Encoding`；若仍嫌重，可在 `/api/download/session` 后走一个分片 fetch。不改变当前行为 |
| B4-4 | 非 Chromium 组装内存峰值（承接 B1-4） | ✅ **已实现（2026-10-13，随 B4-10 同一提交 `b6eebf8`）**：落盘三态「用户句柄 > OPFS 暂存 > 内存 Blob」，Chromium 侧内存不再随文件大小增长；非 Chromium（Firefox/Safari）无 OPFS 句柄持久化语义，仍走 Blob 回退，已在 DEVELOPMENT §12 与 ADR-003 修订一登记「大文件建议 Chromium 系浏览器」 | **证据**：E2E-8 新流程（限速中断 → 刷新 → 只补 12/16 片 → 落地逐字节一致），**93 passed / 0 failed** |
| B4-5 | 上传分片自适应 | ✅ **已闭环（2026-10-13）**：原「维持固定分片」的评估结论不变，但把唯一真缺口（`MAX_FILE_SIZE > 1024 × TRANSFER_PART_SIZE` 时命中 `totalParts > 1024` 的 400）改为**向上放宽**——`transfer.js` 新增 `effectiveUploadPartSize(size)`（翻倍到使片数 ≤ `MAX_PARTS=1024`，仍超限才 400），会话 `partSize` 随位图落盘并被 `init`/`status` 回传（续传不重算），分片体 body 上限改为按会话 `partSize`（`rawPart(limit)` 工厂）。量化依据不变：默认 4MB 下 ≤4MB 文件就是单片、100MB 上限仅 25 片，「按文件大小自适应」反而多一次往返且无带宽收益，故**默认行为零变化**。`npm test` 新增 `[30]` 共 7 条（隔离端口 `TRANSFER_PART_SIZE=1024`：不超限不变 / 超限翻倍 / 放宽后收 2048B 片 / 未放宽仍 413 / 续传不重算 / status 回传），**308 passed / 0 failed**；参见 DEVELOPMENT §4/§13.6 |
| B4-8 | 统计的崩溃零丢失（WAL） | ✅ **已实现（2026-10-13，开关默认 off）**：新增 env `STATS_WAL`（默认 `off` 即维持 ADR-009 决策 5）；开启后 `recordTransfer` 先追加 `data/transfer-stats.wal`（`{o,w,c}` 行），启动 `replayWal()` 按 `stats.json.walOffset` 水位线只重放**未刷盘**部分（不重复累加），刷盘时写入新偏移；`resetTransferStats` 同时推进水位线（清零不被重放回卷） | **证据**：`npm test` [35]（隔离端口 `STATS_WAL=on`：刷盘窗口内磁盘计数为 0 → `SIGKILL` → 重启后重放补齐（零丢失）→ 二次重启不重复累加且 `walOffset > 0`），**343 passed / 0 failed** |
| B4-10 | 刷新后的下载字节级续写（OPFS 句柄持久化） | ✅ **实测已完成，结论可行**（2026-10-12，temp 探针已删）：headless Chrome 154（CDP，`127.0.0.1` 安全上下文）三阶段实测——①句柄可 `structuredClone` 存入/读回 IndexedDB；②`queryPermission({mode:'readwrite'})` 刷新后与**浏览器完整重启后**均为 `granted`，无二次授权弹窗；③`createWritable({keepExistingData:true})` + `seek(已写偏移)` 续写后前缀/后缀逐字节一致（65536 + 32768 = 98304）；④`navigator.storage.estimate()` 可用（quota ≈ 10GB，可分项看到 `fileSystem`/`indexedDB`） | ✅ **已实现（2026-10-13，代码/测试 `b6eebf8`）**：`web/src/downloader.js` 落盘三态——①用户句柄（手势期选定，现状）；②OPFS 暂存 `fs-download-<码>.part`（**每 4 片 `close()` 提交**，实测逐片提交在 14MB/16 片用例上多花约 0.6s），刷新后按「暂存长度 = 前 k 片字节和」续写（不需要偏移入库），完成后用暂存文件的 blob URL 交给 `<a download>`（不整份进内存）、120s 后清理；③内存 Blob 回退。多标签用 `navigator.locks`（`ifAvailable`）互斥，拿不到锁的标签回退 Blob（不另建会话）。**证据**：E2E-8 重写为「限速下载中 `Page.reload` 中断 → 已提交 1MB（4 片）留在暂存 → 刷新后续用同一 token **只请求 12/16 片** → 落地 SHA-256 一致、`totalDownloads` 只 +1、暂存写满原始大小」，**93 passed / 0 failed**。**仍未验证（需人工/真机）**：导出对话框（有头浏览器）、OPFS 容量上限（取决于磁盘剩余）、多标签互斥的真实并发体验、非 Chromium 真机峰值内存（B1-4 的剩余部分） |

## B5. 公告样式遗留（RFC-004 之后）

| ID | 项 | 现状与证据 | 结论 / 下一步 |
|---|---|---|---|
| B5-1 | 动效无障碍（`prefers-reduced-motion`） | ✅ 已闭环（见 B0） | — |
| B5-2 | 公告字号 / 圆角 / 透明度 | ✅ **已实现（2026-10-13）**：`notice.js` 新增 `fontSize`（12~24）/`radius`（1~16）/`opacity`（50~100，`0` = 默认），走 ADR-013 同一套「空值即默认主题」归一化；`NoticeBarView` 应用到 Alert 内联样式，`utils.noticeColors()` 让弹窗内容块共用（管理端实时预览直接复用）；`Admin.jsx` 表单加三个 `InputNumber`（留空 = 默认）并在预设摘要展示 | **证据**：`npm test` [32]（落盘/越界回落/四舍五入取整/字符串数值/预设携带），**330 passed / 0 failed**；`npm run e2e` E2E-13（计算样式 `font-size`/`border-radius`/`opacity`），**87 passed / 0 failed** |
| B5-3 | 多公告 / 定时投放 | ✅ **已实现（2026-10-13）**，设计见 `RFC-007`（ADR-016 已转 Accepted）：`notice.js` 重写为数组模型（迁移 + 写穿镜像 + 请求时仲裁 + `noticeStats`），`index.js` 新增 `GET/POST/PUT/DELETE /api/admin/notices`、`/api/notice` 新增 `notices[]`、health `notice`，`config.js` 新增 `MAX_NOTICES`（默认 20），`notice-presets.js` 的启用可指定目标公告，前端 `NoticeBar` 按槽位取第一条（关闭键含 id）、`Admin.jsx` 改为「列表 + 表单」（新建/编辑/删除/启用开关/优先级 ↑↓/时间窗 RangePicker）（`docs/rfc/RFC-007-multi-notice-scheduling.md`，Implemented）+ `ADR-016`（Accepted）——`data/notices.json` 单例数组（`{ version:2, rev, notices[] ≤ MAX_NOTICES 默认 20 }`，每项增 `id`/`priority`/`startAt`/`endAt`，`id === 'default'` 为保留项）；**调度 = 请求时求值**（无后台定时器/无 SSE，时间窗只是过滤谓词）；仲裁序 `priority` desc → `updatedAt` desc → `id` 升序，**同槽位只下发一条**（不叠加，避免多个 `role="status"` 同时播报）；**`/api/notice` 顶层形状不变**（老前端零改动），新增 `notices[]`（仅有效项、已排序）供上/下槽位各取一条；时间窗为**半开区间** `startAt ≤ now < endAt`；无有效公告 → 既有 `enabled:false` 形状（不报错）；迁移一次性 + 写穿镜像 `notice.json`（回滚退路）；文件级 + 条目级 `rev` 双重复用 | **已完成**：`npm test` 新增 `[31]` 共 17 条、`npm run e2e` 新增 E2E-12 共 6 条（双槽位渲染、startAt 设未来后刷新只剩一条、管理端列表/编辑/新建），**325 passed / 0 failed** + **84 passed / 0 failed**；参见 DEVELOPMENT §4/§5/§7 与 C3 §2/§5 |
| B5-4 | 纵向模式的行数上限 | ✅ **已实现（2026-10-13）**：`notice.js` 新增 `maxLines`（只接受 1/2/3，缺省与非法回落 1）；`NoticeBarView` 纵向视口高度改为内联 `maxLines × 24px`（`scrollHeight - clientHeight` 测量口径不变，仅 `clientHeight` 随行数变化），预览文案改为「纵向需超过 N 行内容才会滚动」；`Admin.jsx` 加「纵向行数」单选 | **证据**：`npm test` [32]（1/2/3 合法、非法与缺省回落 1），**330 passed / 0 failed**；`npm run e2e` E2E-13（3 行 ⇒ 视口 72px、改回 1 行 ⇒ 24px，计算样式实测），**87 passed / 0 failed** |

## B6. 公告预设遗留（RFC-005 之后）

| ID | 项 | 现状与证据 | 结论 / 下一步 |
|---|---|---|---|
| B6-1 | 预设导入/导出与排序 | ✅ 已闭环（见 B0；排序用 ↑/↓ 按钮而非拖拽，保持零新依赖） | 保持：若要拖拽，需先引入 dnd 依赖并记录到 DEVELOPMENT §2 |
| B6-2 | 上限可配置 | ✅ 已闭环（见 B0） | — |
| B6-3 | 预设使用审计 | ✅ 已闭环（见 B0；标识口径 = 管理密钥指纹） | 保持：若将来引入管理员身份体系，`appliedBy` 可平滑替换为账号标识 |
| B6-4 | 并发编辑冲突 | ✅ 已闭环（见 B0；预设与公告均带 `rev`） | 保持：新增写接口时沿用 `expectedRev` 校验约定 |

## B7. 本轮已知的小缺口（新登记，低优先级）

| ID | 项 | 说明 | 下一步 |
|---|---|---|---|
| B7-1 | 「预设满 → 必须删除」无替换选择 UI | ✅ **已实现（2026-10-13）**：保存按钮不再禁用；达上限时保存返回 409 即弹出「选择要替换的预设」`Modal`（列出全部预设、未选不能确认），确认后**先 `DELETE` 再 `POST`**（服务端零改动，沿用既有 `rev` 校验）；目标被并发删除时提示并刷新列表 | **证据**：`npm run e2e` E2E-14（预置上限 1 → 点保存弹窗 → 下拉选中 → 点替换 → API 列表仍为 1 条且名称已切换），**91 passed / 0 failed** |
| B7-2 | 预设分组 | ✅ **已实现（2026-10-13）**：`notice-presets.js` 新增 `group`（≤20 字符、去首尾空白、空串 = 未分组），接入读盘归一化/`presetPayload`/创建/更新，导出导入均携带；`Admin.jsx` 预设区加「分组」输入并按分组分段展示（`order` 仍全局唯一，不参与分组排序） | **证据**：`npm test` [33]（去空白、截断 20、缺省空组、导出携带且不含 id/rev、导入携带、旧文件无 group 回落空串），**336 passed / 0 failed**；`npm run build` 通过 |
| B7-3 | 配额被误伤的运维可见性 | ✅ **已实现（2026-10-13）**：`sessions.js` 新增 `usageByIp()`（按 IP 汇总**未过期**会话与临时空间，与配额判定**同源同 Map**），`/api/admin/stats` 新增 `sessionQuota`（三个上限 + 按临时空间降序的 `topIps` 前 10），`Admin.jsx` 新增「会话配额」卡片（用量 ≥80% 标红，附「出现 429 先看这里」提示） | **证据**：`npm test` [34]（汇总口径与配额同源、上限回传、结束/完成后用量即时下降），**339 passed / 0 failed**；`npm run e2e` E2E-14（卡片按出口列出在途用量），**91 passed / 0 failed** |
