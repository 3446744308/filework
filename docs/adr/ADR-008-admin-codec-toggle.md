# ADR-008: 管理端编码候选开关（设置值在 env 上限内收窄）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.4 | 影响：`server/settings.js`、`server/compress.js`、`server/index.js`、`server/transfer.js`、`web/src/pages/AdminSettings.jsx`

## Context

ADR-005 决策 3 已经提供 `COMPRESS_CODECS=br,gzip|gzip` 的降级路径：brotli 候选让压缩耗时约翻倍（br-5 与 gzip-6 速率相当，两者都试即接近一倍），CPU 吃紧的机器希望只跑 gzip。但这条路径的实际使用体验很差：

- **要改 env ⇒ 要重启进程**：临时 CPU 尖峰（同时上传多个大文件）时，运维不可能为一次降级重启服务，因此开关形同不存在。
- **只加设置项、忽略 env 会带来两个真相源**：`COMPRESS_CODECS=gzip` 的部署（明确表达了"这台机器不做 brotli"）可能被管理端设置重新打开 brotli，违反部署者的显式选择与容量规划。
- **修改必须可预期**：编码是**存储态**属性（写进 `meta.units[].z`），改开关不能、也不应该去重写已存在的文件——否则 CPU 与 IO 成本落在热路径上（上百 MB 文件的重新打包）。

## Decision

1. **新增设置项 `settings.compressionCodecs`**（数组，默认 `['br','gzip']`），保存时归一化：只接受 `br`/`gzip`，含 `br` 即规范为 `['br','gzip']`，否则 `['gzip']`；非法值（如 `zstd,snappy`）回退 `['gzip']`。管理端只暴露两个选项：「Brotli + gzip 双试」「仅 gzip」。
2. **env 为硬上限**：生效值 `getCompressionCodecs() = 设置值 ∩ COMPRESS_CODECS`；交集为空时回退 `['gzip']`（env 无 gzip 时回退 env 原值）。`/api/settings` 同时返回生效值 `compressionCodecs` 与上限 `compressionCodecCap`，前端据此把不可用的选项置灰并说明原因。
3. **生效于打包路径**：`maybeCompress({ codecs })` 由调用方传入（`server/index.js` 单请求上传、`server/transfer.js` 分片上传 complete 各一次），不再直接读 `config.compressionCodecs`；`codec.encodeUnit(raw, codecs)` 只尝试传入的候选。
4. **只影响此后新上传**：已存文件的 `meta.units[].z` 不变，下载与协商逻辑不感知开关（`planTransferCodec` 只看存储态），因此切换开关不需要迁移、不影响在途下载。
5. **可观测**：`/api/health` features 增加 `codecToggle`；`/api/settings` 的读接口即验证入口。

## Alternatives

- **只保留 env（现状）**：维持两个真相源但零代码——代价是"CPU 吃紧时降级"需要重启进程，等于没有这条能力（ADR-005 已把该能力列为决策的一部分）。否决。
- **设置项可越过 env 上限（设置优先）**：管理端可临时开启 brotli 而不动部署配置，但会让"部署者声明"失效，容量规划失去约束。否决（env 优先）。
- **保存设置时重压缩已存在的文件**：能立刻回收/改变体积收益，但会在请求路径或后台任务里做全量重打包（CPU/IO 成本、失败回滚、并发控制），收益仅是"体积再小 1%~3%"。否决（不迁移）。
- **布尔开关 `brotliEnabled` 而非候选数组**：语义更窄，未来若加入第三种编码（zstd 等）就要改结构。候选数组与 env 同名同形，语义一致。否决（布尔）。
- **把候选选择做成上传时参数（每文件可选）**：把容量决策推给发件人，且要与站点策略冲突判定，用户体验与安全边界都更差。否决。

## Consequences

- 正：CPU 吃紧时管理端一键降级（保存即对新上传生效，无需重启），部署侧的 `COMPRESS_CODECS` 仍是不可逾越的上限。
- 正：开关只影响存储态编码，下载/协商/旧容器兼容路径零改动，风险面极小。
- 负：`settings.compressionCodecs` 与 `COMPRESS_CODECS` 同名不同层，需要在文档与 UI 文案里说清"设置值只能收窄上限"（已写入 `docs/DEVELOPMENT.md` §5/§13.7 与设置页提示）。
- 负：切换后新旧文件编码不同（同一站点内可能同时存在 brotli 与 gzip 容器）——这是既有设计（逐单元择优）的延续，读取侧按 `meta` 逐单元解码，无额外复杂度。
- 风险：若运维把 env 设为 `gzip` 却在 UI 上反复尝试开启 brotli，会看到选项置灰——UI 已给出原因文案（当前 `COMPRESS_CODECS=gzip`），不会静默无效。

## References

- RFC-002 §4.4/§6 REQ-020；ADR-005 决策 3（`COMPRESS_CODECS` 的由来与实测 CPU 代价）
- `scripts/test.js` [24]（仅 gzip 时单元无 `b`、非法值回退、恢复双试）
