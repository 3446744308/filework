# ADR-004: 分片尺寸自适应 + 内容定界切分（取代固定 4MB 分块）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.1 | 影响：`server/units.js`、`server/compress.js`、`server/transfer.js`、`web/src/downloader.js`

## Context

RFC-001 的压缩容器把文件按**固定 4MB** 分块，下载分片也按固定 4MB（`TRANSFER_PART_SIZE`）切分，两个"固定"带来三个问题：

- **与文件大小无关**：4MB 文件被切成 1 片（无并行可言），300MB 文件只有 75 片且每片很大，并发 4~8 时"尾部拖尾"明显（最后一片独自跑完，其余通道空转）。
- **固定边界 vs 内容边界**：块边界与内容无关，重复内容（日志轮转、稀疏区、模板化文本）只要落点错开一点就落在不同块，无法识别为同一份数据。
- **压缩上下文偏短**：gzip 窗口 32KB，块内重复能压，块间重复无法引用。

## Decision

1. **自适应单元计划**（`server/units.js` `chunkPlan`）：
   `unit = clamp(ceil(size / UNIT_TARGET_COUNT), UNIT_MIN_SIZE, UNIT_MAX_SIZE)`；若 `ceil(size/unit) > UNIT_MAX_COUNT` 则 `unit = ceil(size / UNIT_MAX_COUNT)`。默认 `UNIT_TARGET_COUNT=32`、`UNIT_MIN_SIZE=256KB`、`UNIT_MAX_SIZE=8MB`、`UNIT_MAX_COUNT=256`。
   依据：并发 4~8 时每路约 4~8 片，既摊薄尾部拖尾，又不制造过多请求；片越小编码上下文越短，故设下限。
2. **内容定界切分**（Gear-hash CDC 简化实现，`chunkFile`/`chunkRanges`）：以 `min = max(floor(unit/4), 16KB)`、`max = unit` 约束，切点条件 `len ≥ min 且 (hash & mask) == 0`，`mask = 2^round(log2(unit - min)) - 1`，哈希为 `h = (h << 1) + GEAR[byte]`，切后归零。
3. **片数上限保护**：CDC 结果超过 `UNIT_MAX_COUNT` 时返回 `null`，上层回退为均匀切分（`uniformRanges`），保证任意病态输入下请求数可控。
4. **服务端下发计划**：`/api/download/session` 返回 `units`/`unitCount`/`parallel`，客户端不再自行按 `partSize` 切片，而是按 `index` 取片。旧的 `start/end` 任意范围模式保留（上限仍为 `TRANSFER_PART_SIZE`），旧前端缓存不失效。
5. **两套切分实现互证**：`chunkRanges`（内存）与 `chunkFile`（流式）必须产出完全相同的边界，由测试强制（`scripts/test.js` [20]）。

## Alternatives

- **保持固定分片，只调大/调小**：改动最小，但无法解决"内容边界错开即不能去重"，也让不同体积文件的并行效率无法同时最优。否决。
- **固定分片 + 按块哈希去重（不做 CDC）**：只能命中"对齐的重复"；对日志/模板化数据收益不稳定。否决（作为 CDC 的降级路径保留在片数超限时）。
- **FastCDC 完整实现（两级掩码归一化）**：切分分布更贴近目标均值，但实现与调参成本高，收益是"片长分布更均匀"这一边际改善。本期用单掩码简化版，实测片长落在 `[min, max]` 内且片数贴合目标。
- **纯按大小切 + 客户端乱序加载**：与并行无关，未解决压缩上下文问题。否决。

## Consequences

- 正：分片大小随文件自适应（不再固定），平移/重复内容也能命中同一单元，为单元级去重（ADR-005 第 2 条）提供前提；客户端并发按内存预算自适应，落盘保序不变。
- 正：单元尺寸有硬上下限与片数上限，请求数与单请求体积均可预期。
- 负：单元尺寸在 `[min, max]` 内浮动，分片不再等长——客户端必须使用服务端计划（已改为按 `index` 取片），进度与内存预算改按"平均单元大小"估算。
- 负：打包多了一次全文件扫描（CDC 定位边界），对 300MB 文件额外增加约数百毫秒读盘；换来的是去重收益与分片质量，判定为划算。
- 风险：CDC 参数（`UNIT_*`）配置失当时片数会偏离目标；已由 `UNIT_MAX_COUNT` 兜底并纳入测试。

## References

- RFC-002 §4.1、§6；ADR-005（单元级去重与多编解码）；`scripts/test.js` [20] 自适应分片与编解码对抗
