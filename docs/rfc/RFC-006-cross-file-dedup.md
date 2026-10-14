# RFC-006: 跨文件去重（全局内容寻址对象存储）

> Status: Implemented（默认 off）| Type: RFC | Created: 2026-10-12 | Updated: 2026-10-13 | Authors: zwh | Reviewers: zwh | Target: v1.6.0 存储优化（backlog B4-2）
> 索引：`RFC-006` | 关联 REQ：REQ-042~REQ-047 | 收益（已实现，开关默认 off，生产收益待开启后实测）：同站点重复/近似重复文件的**存储与打包开销降到「唯一内容 + 清单」**
> 位置：`docs/rfc/RFC-006-cross-file-dedup.md`（权威，无独立 spec 快照）；关联 `ADR-015`（本 RFC 的决策记录）
> 一致性声明：本 RFC **不改动** RFC-002 的传输语义（`/api/download/part` 仍按 `index` 取片、`Content-Encoding` 协商不变）与 RFC-003 的续传语义（会话令牌与位图不改）；只替换「单元载荷放在哪里」。`ADR-015` 已转 Accepted（2026-10-13）。

## 0. 更新摘要

2026-10-12 首版需求（backlog B4-2 关闭设计阶段）：把去重从**单文件内**（ADR-005 决策 4/5，内存 `Map`）扩展到**跨文件**——同站点重复上传的同一份内容（模板文件、日志轮转、同批次分发的大附件）只存一份。设计结论：把 `data/files/<code>` 从「整文件容器」改为**清单**，载荷移入全局内容寻址对象存储 `data/objects/`；引用计数**不落盘**，由清单派生（标记-清扫 + 宽限期）。本文档只做设计，**不实现**；实现受 `ADR-015` 决策 7 的开关与触发条件约束。

## 1. 需求

| REQ | 目标 | 基线（RFC-002 后） | 目标 | 验证 |
|---|---|---|---|---|
| REQ-042 | 全局内容寻址对象存储 | 载荷只存在于 `data/files/<code>`，跨文件零复用 | `data/objects/<hh>/<hash>`（`hash` = 载荷 sha256 全 64 位十六进制），内容即键 | `scripts/test.js` 新增段：上传同一内容两次 → 对象目录只 1 份、第二份 `storedSize` 不增长；对象内容 sha256 与文件名一致 |
| REQ-043 | 清单取代整文件容器 | 容器 = 载荷 + `units[{o,c,r,z,d}]` | 压缩文件改为清单 `units[{h,c,r,z}]`（`h` = 对象哈希，去掉文件内偏移 `o` 与同文件去重指针 `d`）；字节 = 按序拼接 `r` 之和 | 同一文件上传前后下载逐字节一致；`unitRanges`/`unitsCoverage` 断言仍通过 |
| REQ-044 | 引用与被引用一致 | 无跨文件引用概念 | 删除分享**不**立即删对象；对象仅在「无任何清单引用 + 超过宽限期」时回收 | 删除分享后对象仍在（宽限期内）；重建索引后孤儿对象在启动清扫中消失 |
| REQ-045 | 索引重建 | 无需重建 | 索引不落盘；启动时扫描 `data/meta/*.json` 得到「被引用对象集合」，与磁盘对象求差即孤儿 | 手工删除一个对象文件后重启：受影响分享按既有「文件损坏」错误路径 500，其余分享不受影响 |
| REQ-046 | 收益可观测 | `storedSize`/`dedup` 仅单文件 | `/api/admin/stats` 增 `dedupCrossObjects`/`dedupCrossBytes`/`dedupCrossRatio`（全站对象数与「若无去重需存字节」的对比），管理端仪表盘展示 | 上传两份相同大文件后断言比值 > 1.5；接口与仪表盘数值一致 |
| REQ-047 | 零回归 | `npm test` 301 passed / 0 failed | 传输语义（分片/协商/统计口径）、续传、未压缩文件路径（`res.download`）与全部既有用例保持通过 | 全量 `npm test` + `npm run e2e` + `npm run build` |

> 基线环境：Windows（Git Bash），Node 24 ESM（要求 ≥18），`npm test` 自启服务器（端口 3999，`DATA_DIR=data-test`）；浏览器用例为 headless Chrome 154（CDP）。

## 2. 现状根因

- **载荷与分享强绑定**：`server/store.js:commitUpload` 把 tmp 文件 `renameSync` 进 `data/files/<code>`（一个分享一个文件），`removeShare` 也按 `code` 删这一个文件——存储单位是「分享」，没有「内容」这一层。
- **去重只在单文件内**：`ADR-005` 决策 4/5 的 `Map` 只覆盖「同一个文件里重复出现的单元」，跨请求即失效（`compress.packUnits` 的哈希表不落盘、不跨文件）。同一份 20MB 附件发给两个取件码仍存两份。
- **单元已是内容定界**：`server/units.js:chunkFile`/`chunkRanges` 用 Gear-hash CDC 切分，**平移后的重复内容会命中相同的单元边界**——这是跨文件去重可行的前提（ADR-004 决策 2 早已埋好）。

## 3. 总体设计

```mermaid
flowchart LR
  subgraph W[上传 complete]
    TMP[tmp 文件] --> PLAN[单元计划 + 编码择优]
    PLAN --> HASH[每单元 sha256]
    HASH -->|已存在| HIT[命中：不写盘]
    HASH -->|不存在| PUT[原子写入 objects/&lt;hh&gt;/&lt;hash&gt;]
  end
  PUT --> OBJ[(data/objects/&lt;hh&gt;/&lt;hash&gt;)]
  HIT --> OBJ
  HIT --> MAN[(data/meta/&lt;code&gt;.json<br/>units[{h,c,r,z}])]
  PUT --> MAN
  MAN --> DL[下载：readUnit 按 h 取对象 + 按 z 解码]
  OBJ --> DL
  MAN --> GC[启动/周期：标记-清扫]
  OBJ --> GC
  GC -->|无引用且超宽限| RM[删除对象]
```

- **一层抽象**：`data/meta/<code>.json` 是**唯一真源**（既有原子写盘 `writeMeta` 不动）；压缩文件的载荷全部落在 `data/objects/`；未压缩文件保持今天的单文件路径（`data/files/<code>`），因此 `res.download`、`getFileStreamPath`、`streamOriginal` 之外的路径零改动。
- **引用计数 = 派生量**：不维护 `refcount` 字段，也不落盘索引——删除时的一致性风险（双写、崩溃半途）直接消失；需要回收时**扫描清单**算出被引用集合。
- **GC 是唯一删除路径**：分享删除只删清单；对象由标记-清扫回收，配一个宽限期保护「刚写完对象、清单还没落盘」的窗口。

## 4. 详细设计

### 4.1 对象存储与命名（REQ-042）

- 路径：`data/objects/<hash 前 2 位>/<hash 后 62 位>`；`hash = crypto.createHash('sha256').update(payload).digest('hex')`（**64 位全量**，非 ADR-005 的 128bit 截断——跨文件场景下哈希碰撞意味着「另一个人的文件被替换成别人的字节」，必须不可行）。
- 写入：`tmp + rename` 原子落位（ADR-009 既有惯例）；若目标已存在则**跳过写入**（命中），仅记一次 `dedupCross` 命中计数。
- 对象粒度 = **自适应单元**（ADR-004 `chunkPlan` 的产物，默认 256KB~8MB）——不再细到「固定块」，也不粗到「整文件」。理由见 ADR-015 决策 1。
- 未压缩文件（`plan.compressed === false`）**不进入 CAS**：它本来就是一个不可压缩的整体，切单元无收益，且会破坏 `res.download` 的零改动。

### 4.2 清单格式（REQ-043）

```json
{
  "code": "123456",
  "filename": "app.log",
  "size": 4194304,
  "mime": "text/plain",
  "compression": "units-v2",
  "storedSize": 1762133,
  "dedup": 3,
  "units": [
    { "h": "9f2c…", "c": 524288, "r": 1048576, "z": "br" },
    { "h": "1a77…", "c": 524288, "r": 1048576, "z": "br" },
    { "h": "9f2c…", "c": 524288, "r": 1048576, "z": "br" }
  ]
}
```

- 与今天相比：**去掉 `o`（文件内偏移）**（改由 `h` 定位对象）、**保留 `d` 字段但不再用于定位**（旧容器只读兼容仍需要它，见 §5）、新增 `h`；`unitsCoverage` 的「`Σr == size`」不变。
- `compression` 取新值 `units-v2`：读路径按版本分派——`units-v2` 走 CAS，`units`/`gzip-blocks` 走旧容器。**单向门**（同 RFC-002 §4.1 口径）：新容器不被旧构建识别，回滚需保留旧构建。

### 4.3 标记-清扫与删除时序（REQ-044/REQ-045）

- **标记**：扫描 `data/meta/*.json`，收集所有 `units[].h` 得到被引用集合 `refs`（内存 `Set`，全站规模 ≪ 10⁵，一次扫描毫秒级）。
- **清扫**：遍历 `data/objects/**`，`stat.mtimeMs` 早于 `now - GC_GRACE`（建议 1 小时）且哈希不在 `refs` 中 → `unlink`；空桶目录顺带 `rmdir`。
- **时机**：①启动一次（覆盖崩溃/异常退出留下的孤儿）；②每 `GC_INTERVAL`（建议 6 小时）一次；③**不在删除分享的请求路径上做**（避免大目录遍历阻塞请求）。
- **宽限期解决三个窗口**：对象已写但清单未写（崩溃）、清单已删但下载会话仍在途（`hasActiveSession` 之外还有已建立的响应流）、同一对象的并发写入。
- **不落盘索引**：若要落盘，就必须在「删清单」「写清单」「删对象」三处同步维护，任一处崩溃即产生永久泄漏或悬空引用；派生法把这类一致性需求整体消除，代价只是周期扫描（可接受，见 ADR-015 决策 3/4）。

### 4.4 开关与观测（REQ-046）

- `CROSS_FILE_DEDUP=off|on`（**默认 `off`**）：关闭时新上传继续走今天的内嵌容器（`COMPRESSION_FORMAT = 'units-v2'`，见 `server/compress.js`），CAS 只读兼容；开启后新上传写**清单化容器** `COMPRESSION_FORMAT_CAS = 'units-v3'`（**实现定案**：不沿用 `units-v2`，否则既有文件会被误判）并用 `meta.storageVersion: 2` 标记清单化；任务链 = `compress-job.enqueueCompression` 里「CAS 清单优先 → 无收益回退内嵌容器 → 再无收益回退未压缩」，接受清单的条件是「整体有压缩收益（Σc < size）**或**至少命中一个既有对象（`crossHits > 0`）」。实现步骤见 `docs/superpowers/plans/2026-10-13-transfer-backlog-plan.md` Task 3。
- `/api/admin/stats` 增 `dedupCrossObjects`（对象总数）、`dedupCrossBytes`（`Σc`）、`dedupCrossSavedBytes`（`Σr − Σc` 与「假想无去重」的差）；管理端仪表盘加一行「跨文件去重」。
- 上线前需先**量化触发条件**（backlog B4-2 原文）：连续观测同类文件重复上传占比，>20% 才值得开启。

## 5. 错误处理与可观测性

| 失败模式 | 行为 |
|---|---|
| 对象缺失/长度不符（手工删除、磁盘损坏） | 下载命中该单元时返回既有 `500 文件损坏，请联系管理员`（`unitPayloadFits` 语义改为「对象存在且 `size === c`」） |
| 写对象失败（磁盘满/权限） | `complete` 失败并**清理本会话已写的新对象**（只删本次新建、未被其它清单引用的），整体回退为「不压缩」或报错；不留下半成品清单 |
| 崩溃于「对象已写、清单未写」 | 启动 GC 在宽限期后回收孤儿对象（无引用即删） |
| 哈希碰撞 | 全量 sha256（2⁻²⁵⁶ 量级）视为不可行；不额外做「写入前比对内容」 |
| GC 误删在途对象 | 宽限期（1h）+ 只在启动/周期执行 + 清单为真源（引用即保留） |
| 旧容器混存 | `compression` 字段按值分派读取；写路径永不写旧值 |

**可观测性**：`/api/health` 增 `dedup: { enabled, objects, bytes, lastGcAt, lastGcRemoved }`，便于上线后确认 GC 真的在跑。

## 6. 验收（已实现，开关默认 off）

| REQ | 结果 | 证据 |
|---|---|---|
| REQ-042 | ✅ 已实现 | `scripts/test.js` [38]：同一内容上传两次 → `data/objects` 只 1 份、第二份 `objectBytes()` 不变且 `crossHits > 0`；对象名 = 载荷 sha256 全量（清单内 `h` 为 64 位十六进制） |
| REQ-043 | ✅ 已实现 | [38]：清单 `compression='units-v3'` + `storageVersion=2`，单元 `{ h, c, r, z }` 无 `o`、`Σr === size`；`units-v3` 不再生成 `files/<code>`；单请求与分片下载均逐字节一致（含 passthrough 直发） |
| REQ-044 | ✅ 已实现 | [38]：删除一份分享后对象仍在（另一清单仍引用）；两份都删后由 GC 回收（`health.dedup.lastGcRemoved > 0`、对象数归零） |
| REQ-045 | ✅ 已实现 | 引用派生 = `objects.collectManifests()`（扫 `meta/*.json` 的 `units[].h`）；启动与周期 `sweepObjects()` 只删「无引用且 mtime 早于宽限期」的对象，实现见 `server/objects.js` |
| REQ-046 | ✅ 已实现 | [38]：`/api/admin/stats` 的 `dedupCrossObjects`/`dedupCrossBytes`/`dedupCrossImpliedBytes`/`dedupCrossRatio`（两份相同内容 → 比值 2.0 > 1.5）；`/api/health` 的 `dedup.{enabled,objects,bytes,lastGcAt,lastGcRemoved}`；管理端文件列表展示「跨文件去重」标签 |
| REQ-047 | ✅ 已实现 | 开关关闭时对象目录保持为空（[38] 首条断言）；全量回归 `npm test` **375 passed / 0 failed**、`npm run e2e` **93 passed / 0 failed**、`npm run build` 通过；旧内嵌容器用例 [17]/[23] 不回归 |

## 7. 非目标

- **子单元（固定 4KB~64KB 块）去重**：对象数量会爆炸（万级小文件对象）且 CDC 已经让单元对齐，收益边际、运维成本高。ADR-015 决策 1 记录否决。
- **跨站点/跨实例共享对象池**：本工具单机单实例（`data/` 本地目录），引入共享存储需分布式锁与一致性协议，与「零依赖、单进程」约定冲突。
- **压缩包归档（把多个分享塞进一个归档）**：改变分享语义与删除粒度，且下载侧要重做打包/解包。否决。
- **硬链接/inode 级去重**：同一内容可能有多种必要编码（`z` 不同），硬链接只能表达「完全相同的字节」，表达不了「同内容不同编码」。
- **对已存在的压缩文件做回溯迁移**：需要重写全部历史文件，风险高收益一次性；新上传生效即可。
- **加密存储 / 内容级访问控制**：超出本期范围（见 ADR-015 风险的诚实登记）。

## 8. 追溯

> 实现完成（2026-10-13，代码/测试 `d8f2990`）：本文档 + `docs/adr/ADR-015-cross-file-dedup-cas.md`（Status: Accepted）。backlog B4-2 已闭环（默认 `off`）；新增 `server/objects.js`、`compress.js` 的 `packManifest`/`unitsPayloadOk`/`planPayloadOk`、`store.bodyAvailable`、`cleanup` 的周期 GC，读路径按 `compression` 值分派、旧容器零改动。验收证据见 §6（`scripts/test.js` [38] 共 13 条）。
> 关联既有实现：`server/units.js`（CDC 切分，ADR-004）、`server/compress.js`（编码择优与单文件去重，ADR-005）、`server/store.js`（`commitUpload`/`removeShare`）、`server/transfer.js`（`readUnit`）。
