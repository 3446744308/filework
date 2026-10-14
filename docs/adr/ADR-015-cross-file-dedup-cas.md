# ADR-015: 跨文件去重采用全局内容寻址对象存储，引用计数由清单派生

> Status: Accepted（2026-10-13 实现，开关默认 off）| Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-006 §4 | 影响：`server/store.js`、`server/compress.js`、`server/objects.js`（新增）、`server/compress-job.js`（新增）、`server/transfer.js`、`server/cleanup.js`、`server/config.js`

## Context

去重目前只在**单个文件内**（ADR-005 决策 4/5）：`compress.packUnits` 用一次打包过程内的内存 `Map`，把命中单元记为 `{ o, c, r, z, d }`（`o` = 文件内偏移，`d` = 源单元下标），**不新增存储字节**。它有两个硬边界：

- **跨请求即失效**：哈希表不落盘、不跨文件、不跨请求（ADR-005 决策 5 明确「那会带来删除时序与磁盘回收的一整套复杂度」——本 ADR 就是来还这笔账）。
- **存储单位是分享而非内容**：`server/store.js:commitUpload` 把 tmp 文件 `renameSync` 进 `data/files/<code>`；`removeShare` 按 `code` 删这一个文件。同一份 20MB 附件发两个取件码，磁盘上就是两份。

同时，ADR-004 的内容定界切分（`server/units.js:chunkFile`）已经保证**平移后的重复内容命中的是相同单元边界**——这是跨文件去重可行的前提，不是本 ADR 新引入的能力。

必须定清楚的约束：

- **不变量 1（逐字节一致）**：任何分享下载结果必须与其原始字节完全一致（RFC-001~003 的核心验收）。
- **不变量 2（清单是唯一真源）**：`data/meta/<code>.json` 是原子写的（`writeMeta`，tmp + `renameSync`），任何「第二处状态」都要与它保持一致，否则崩溃即泄漏或悬空。
- **不变量 3（未压缩路径零改动）**：`res.download` / `getFileStreamPath` 对未压缩文件是既有正确路径，不能为了去重而重写它。

## Decision

1. **对象粒度 = 自适应单元**（ADR-004 的 `chunkPlan` 产物，默认 256KB~8MB），不是固定小块、也不是整文件：单元已经是 CDC 对齐的内容单位，直接复用可零成本获得「平移命中」；固定 4KB~64KB 会让对象数量爆炸，整文件则丢掉跨文件命中。
2. **对象命名用 sha256 全量 64 位十六进制**（`data/objects/<前 2 位>/<后 62 位>`），不用 ADR-005 的 128bit 截断，也**不做写入前内容比对**：文件内去重的碰撞后果是「同一文件内两块错配」，跨文件去重的碰撞后果是「甲的字节被乙的内容替换」，必须落在不可行的 2⁻²⁵⁶ 量级。
3. **引用计数不落盘，由清单派生**：启动（及每 6 小时）扫描 `data/meta/*.json` 收集 `units[].h` 得到 `refs`，遍历 `data/objects/**` 删除「不在 `refs` 且 `mtime` 早于 `now − 1h`」的对象。**不引入 `refcount` 字段、不引入索引文件**——否则「删清单 / 写清单 / 删对象」三处必须同步，任一处崩溃就永久泄漏或悬空引用；派生法把这个一致性问题整体消除，代价只是一次周期扫描。
4. **GC 是唯一删除路径**：`removeShare(code)` 仍只删清单（与今天一致），不触碰对象；对象只由标记-清扫回收。宽限期 `GC_GRACE = 1h` 专门保护「对象已写、清单未写」的崩溃窗口与「清单已删、响应流仍在途」的下载窗口。GC **不在请求路径上**执行。
5. **清单内嵌于 `meta/<code>.json`**，压缩文件的 `data/files/<code>` **不再存在**；`units` 条目改为 `{ h, c, r, z }`（去掉 `o`，`d` 仅为旧容器只读兼容而保留）。`compression` 取值**另取 `units-v3`**（`units-v2` 已被内嵌容器占用，重新定义会让已存文件被误判）并用 `meta.storageVersion: 2` 标记清单化；读路径按值分派；写路径永不写旧值（单向门，同 RFC-002 §4.1）。
6. **未压缩文件不进 CAS**：`plan.compressed === false` 时保持「`data/files/<code>` 单文件 + `res.download`」不变（不变量 3）。
7. **默认关闭 + 收益触发**：`CROSS_FILE_DEDUP=off`（默认）。只有连续观测到同类文件重复上传占比 >20%（backlog B4-2 的原始触发条件）才开启；开启后 `/api/health` 暴露 `dedup.{enabled,objects,bytes,lastGcAt,lastGcRemoved}` 以便确认 GC 真在运行。
8. **写对象失败即整体回退**：`complete` 阶段写对象失败时，只清理**本次新建且未被任何清单引用**的对象，随后回退为「不压缩」或报错，绝不留下半成品清单（不变量 2）。

## Alternatives

- **落盘引用计数索引（`data/objects-index.json` 或对象旁的 `.ref` 文件）**：可控回收时机（删除即减到 0 就删），但把「清单 + 索引」变成两处状态，任何崩溃点都可能不一致，且需要修复流程。派生法的扫描成本（全站清单一次遍历）远低于这份复杂度。否决。
- **固定小块（4KB~64KB）内容去重（rsync/zbackup 风格）**：命中粒度更细、跨文件命中率更高，但对象数量从「百级」涨到「万级」（inode 与目录遍历成本），而 CDC 单元已经覆盖了「平移命中」这个主要场景。否决。
- **整文件哈希去重（完全相同才复用）**：实现最简，但只在「逐字节相同的两个文件」上命中，且对部分相似的文件零收益；CDC 已能覆盖这一场景的超集。否决。
- **把多个分享打包成一个归档文件**：省对象数，但改变分享语义（删除粒度、取件码与内容不再一一对应），下载侧要重做打包/解包。否决。
- **硬链接/inode 级复用**：只能表达「完全相同的字节」，表达不了「同内容、不同必要编码」（`z` 不同的单元）；且删除语义与 `renameSync` 的既有路径冲突。否决。
- **对历史文件做回溯迁移**：一次性重写全部压缩文件，风险高、收益一次性；新上传生效即可。否决。

## Consequences

- 正：同站点重复内容只存一份，重复上传占比高的场景存储与打包开销近「唯一内容 + 清单」；跨文件命中直接复用内容定界单元，无需新切分算法。
- 正：状态只有一处（清单），没有需要修复的索引文件；崩溃只可能产生「孤儿对象」，由定期 GC 在宽限期后回收，**不会产生错误数据**。
- 正：读路径按 `compression` 值分派，旧容器（`units`/`gzip-blocks`）继续可读，升级可分文件进行。
- 负：下载多一层「按 `h` 定位对象」的路径，`unitPayloadFits` 语义从「文件内偏移合法」改为「对象存在且 `size === c`」；错误检测点变多（对象缺失 → 既有的 500 损坏路径）。
- 负：GC 需要遍历 `data/objects/`（百万级对象时会变慢）；以本工具规模（单机、分享有上限）可接受，但需要一个「对象数上限」的运维提示。
- 负：清单里的 `h` 让「分享」与「内容」解耦，运维直觉（「删了取件码，磁盘没变小」）会变；需在 DEVELOPMENT 明确「删除是逻辑删除，回收由 GC 负责」。
- 风险：**跨文件去重天然泄露「服务器上已存在某内容」**——上传同内容会命中既有对象（时序/`storedSize` 可推断）。本工具是单站点、单管理员、无跨租户，判定为可接受；若将来引入多租户，需改为「按租户密钥的 HMAC 命名 + 不做跨租户共享」。
- 风险：时间为准的 GC 依赖 `mtime`；若备份工具还原文件会刷新 `mtime`，宽限期失效可能误删——缓解：对象被引用即保留（`refs` 判定优先于 `mtime`），`mtime` 只用于「无引用对象的新鲜度」。
- 风险：`units-v2` 是单向门（同 RFC-002 的容器升级口径），回滚需保留旧构建；`CROSS_FILE_DEDUP=off` 只保证「不再新建 `units-v2`」，不保证旧构建能读已写入的 `units-v2`。

## 实现备注（2026-10-13）

- 写入链：`compress-job.enqueueCompression` →（开启时）`compress.packManifest` → `objects.writeObject`（命中即不写盘）→ `commitManifest` 写 `compression=units-v3`/`storageVersion=2`/`crossHits` 后再删除内嵌源文件；清单不可接受或无收益 → `packContainer`（内嵌 `units-v2`，原路径不变）→ 都无收益则回退未压缩。
- 读路径：`downloadPlan` 按 `compression` 分派；`readUnit`/`readRanges`/`streamOriginal` 逐单元「有 `h` 读对象 / 无 `h` 读 fd 偏移」；`planPayloadOk` 把「对象存在且长度 === `c`」作为完整性判据（缺失 → 既有 `500 文件损坏`）。
- 删除语义：`removeShare` 只删清单与（内嵌）源文件；对象仅由 `objects.sweepObjects`（启动 + `DEDUP_GC_INTERVAL_MS` 周期，宽限期 `DEDUP_GC_GRACE_MS`）回收——**GC 是唯一删除路径**，符合决策 4。
- 验收：`scripts/test.js` [38]（隔离端口 `CROSS_FILE_DEDUP=on`）共 13 条；关闭时的零行为变化由 [38] 首条断言（对象目录恒为空）与全量回归保证。

## References

- RFC-006 §3/§4（对象存储、清单格式、标记-清扫、开关与观测）
- ADR-004（内容定界切分，跨文件命中的前提）、ADR-005 决策 4/5（单文件去重与「不跨文件」的原始判定）、ADR-009（tmp + rename 原子写惯例）、RFC-002 §4.1（容器单向门）
- `server/store.js:commitUpload`/`removeShare`/`writeMeta`、`server/units.js:chunkFile`/`chunkPlan`/`unitsCoverage`、`server/compress.js:packUnits`、`server/transfer.js`（`readUnit`/`unitPayloadFits`）
- 关闭 backlog B4-2 的「需先设计」阶段；实现未开始（触发条件见决策 7）
