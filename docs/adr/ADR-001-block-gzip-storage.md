# ADR-001: 压缩采用分块 gzip 容器而非整文件 gzip

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-001 §4.1 | 影响：`server/compress.js`、`server/store.js` meta 结构、下载路径

## Context

目标是通过压缩降低 `data/files/` 的磁盘占用（RFC-001 REQ-001）。但本项目不是纯粹的"压缩换空间"——它同时要实现分片并行下载（RFC-001 REQ-006），且下载分片按**原始字节范围**寻址。两个硬约束：

1. 分片下载要求服务端能按任意原始字节偏移随机读取，否则并行无意义。
2. 任何压缩方案不得让文件膨胀、不得改变既有失效/删除/统计语义（`server/store.js` 的 `commitUpload`/`getActive`/`cleanupExpired` 只认单文件路径 `files/<code>`）。

可选压力源：整文件 gzip 是最简单、压缩率最高的方案，但 gzip 是连续流、无随机访问，解压后仍要全量扫描才能到达任意偏移——与约束 1 直接冲突。

## Decision

1. **存储格式**：按 `BLOCK_SIZE = 4MB` 将原始文件切块，每块**独立** gzip；所有块依次拼接为单文件 `data/files/<code>`（容器），meta 记录索引 `blocks: [{ o, c, r, z }]`（容器偏移/存储字节/原始字节/是否 gzip）。4MB 块上每块 gzip 头部开销 <0.01%，压缩率损失可忽略。
2. **逐块择优**：每块取 `min(gzip 长度, 原始长度)`（`z=0` 存原样），保证任何单块不会比原始更大。
3. **整体回退**：所有块写完后若 `总存储 ≥ 原始大小`，删除压缩产物、保留原始文件（`compression=''`，`storedSize=size`）。压缩是增强不是依赖，绝不膨胀。
4. **预检 + 兜底**：`isCompressible(mime, filename)` 跳过已压缩格式（jpeg/png/webp/mp4/zip/rar/…）；即使预检漏了，逐块择优与整体回退保证结果只是"不省空间"。
5. **随机读取接口**：`readRange(filePath, meta, start, end)` 只解压与范围相交的块并切片（内存 O(blockSize + 范围)）；单连接下载 `streamOriginal` 逐块解压流式输出，`Content-Length` 仍为原始大小。
6. **兼容字段**：旧 meta 无 `compression`/`storedSize` 视为未压缩；`storedSize` 恒有值（未压缩时 = size），统计与展示统一读它。
7. **异步压缩**：块级 `zlib.gzip` 异步执行（默认 100MB 上限 ≈ 25 块），不阻塞事件循环；压缩失败时放弃压缩、继续 commit。

## Alternatives

- **整文件 gzip（单流）**：压缩率最好且实现最简，但 gzip 流不可随机访问，分片下载要么放弃压缩、要么全量解压才能切片（每次 part 都全量解压 = O(fileSize) CPU/内存放大）。与 REQ-006 冲突，否决。
- **下载时 `Content-Encoding: gzip` 只降带宽**：存储占用不变，不满足"降低占用"目标；且浏览器透明解压让并行分片的字节对账复杂化。否决。
- **块级 deflate（raw）替代 gzip**：每块省 ~18B 头，收益可忽略；gzip 可被 `gunzip` 标准工具直接检查，利于排障。否决。
- **引入 zstd/7z 等外部实现**：Node 无内置 zstd，新增原生依赖违背项目"优先零依赖"约定（`docs/DEVELOPMENT.md` §10.4）。否决。
- **压缩任务后台队列**：本期量级（≤100MB）同步-异步压缩可接受；任务化增加状态机与一致性成本，列 backlog B1-2。否决（本期）。

## Consequences

- 正：可压缩文件磁盘占用典型降至 5~30%（gzip 对文本类），且不牺牲分片随机读取；统计口径新增 `storedSize`，管理端可量化展示节省。
- 负：每个分享下载/上传路径多一次"解压/压缩"CPU 成本（典型文本 100MB 压缩约 1~3s，发生在 complete 时）；容器格式是本项目自定义结构，需要测试锁死（用例 [17][18]）。
- 风险：极端情况（块内数据分布异常）可能出现"部分块压缩、整体回退"的浪费（写满 `.pack` 后发现无收益再删）；触发条件是整体无收益且部分块收益，代价仅一次多余写盘，可接受。未来如需更优压缩率，可在保持容器结构不变的前提下换块级 zstd（需评估依赖）。

## 修订记录

- 2026-10-13 修订一（backlog B1-2，代码 `a217e55`）：上文 Consequences 里的「压缩发生在 complete 时」（因此上传响应含压缩耗时）**不再成立**。`complete` / 单请求上传只落位文件并把元数据标 `compressionState: 'pending'`（`storedSize = size`、无 `units`），压缩改由**串行后台队列**（`server/jobs.js` + `server/compress-job.js`）执行，完成才回写 `compression`/`units`/`storedSize`；内嵌容器落位前先写 `meta/<code>.packmeta` 边车，崩溃后启动 `repairPendingCompressions()` 按边车补齐或回退未压缩。容器格式与整体回退判据（`Σc < size` 才保留）不变；下载侧在 `pending` 窗口内等待落定（不服务可能被改名的字节）。

## References

- `server/store.js`（commitUpload / getActive / cleanupExpired / publicInfo）
- `server/index.js`（/api/upload、/api/download 现状）
- RFC-001 §4.1、§7；ADR-002（分片协议依赖按原始范围读取）
