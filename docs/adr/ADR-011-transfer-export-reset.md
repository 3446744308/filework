# ADR-011: 传输维度明细的导出与清零（权限与审计口径）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.4（REQ-023） | 影响：`server/stats.js`、`server/index.js`、`web/src/api.js`、`web/src/pages/Admin.jsx`

## Context

ADR-010 落地了按日/按文件的传输节省维度，但管理端只能"看"（仪表盘近 7 日 + 文件管理页单列）。backlog B4-9 要求提供**明细导出**与**清零/归档**能力，并明确"需先定权限与审计口径"。落地前必须回答四个问题：

- **权限**：本项目没有多账号体系，唯一的主体身份是管理密钥（`x-admin-key`，`crypto.timingSafeEqual` 常量时间比较）。任何更强的权限模型（只读令牌、分角色）都超出"单管理员匿名中转站"的产品边界。
- **审计**：清零是破坏性操作（明细与累计值都会归零）。没有账号与集中日志，采用"数据文件自己记录审计事实"的最小方案：持久化 `resetAt`（最近一次清零时间）与 `resetCount`（累计清零次数），经只读接口暴露。
- **清零范围**：只清明细，还是连同站点级累计 `transferOriginalBytes`/`transferWireBytes` 一起？若只清明细，仪表盘会出现"近 7 日之和 ≠ 累计值"的长期困惑。
- **与 ADR-009 内存聚合的交互**：未落盘增量（`pending`/`pendingDays`/`pendingFiles`/墓碑）在清零时应一并处置，否则清零点后立刻"复活"一小段计数。

实现过程中另发现一处与导出精度直接相关的问题：`recordUpload()`/`recordDownload()` 写 `stats.json` 后会调用 `clearPending()`，把**尚未刷盘的维度增量（`pendingDays`/`pendingFiles`）连同计数器增量一起丢弃**——即"下一次上传/下载会吞掉一个刷盘窗口的明细"。对"导出即归档"而言这是正确性缺陷，需一并修正。

## Decision

1. **导出 = CSV 附件，单一长表**：`GET /api/admin/stats/export`（`x-admin-key`）。列固定 `维度,标识,文件名,原始字节,线上字节,节省字节,片数`；`维度` ∈ `按日`/`按文件`。按日行覆盖**全部保留的 30 天**（不只近 7 日），按日期降序；按文件行按节省字节降序、取件码升序（确定性输出）；文件名经 `store.getMeta` 关联，分享已销毁则为空。响应为 `text/csv; charset=utf-8` + UTF-8 BOM + `Content-Disposition: attachment`（Excel 直开不乱码）；字段按 RFC 4180 转义（含 `,`/`"`/换行时加引号、内部引号翻倍）。导出与读取路径一致：先合并未落盘增量，保证"刚发生、未刷盘"的传输也在归档里。
2. **清零 = 重开计量周期**：`POST /api/admin/stats/reset`（`x-admin-key`，JSON `{ confirm: true }`；缺失 `400`）。范围 = **全部传输统计**：`transfer-stats.json` 的 `days`/`files` 与 `stats.json` 的 `transferOriginalBytes`/`transferWireBytes` 一并归零，内存 pending 与墓碑清空。**不影响** `totalUploads`/`totalDownloads` 等非传输计数——它们与传输节省不同源，清掉会让"累计上传/下载"失去连续性意义。
3. **清零的原子性**：先经 `readCounters()` 合并增量后整体归零写 `stats.json`，再以空 `days`/`files` 覆写 `transfer-stats.json`（`resetAt = now`、`resetCount += 1`），最后 `clearPending()`。两次写入各自是临时文件 + rename 原子替换；进程恰在两者之间崩溃会留下"总量已零、明细未零"（或反之）的窗口——与 ADR-009 崩溃损失同量级，记为接受的取舍（再清零一次即可修正）。
4. **审计口径 = 数据文件自述 + 只读暴露**：`/api/admin/stats` 新增 `transferResetAt`/`transferResetCount`；管理端在「近 7 日传输节省」卡片展示"上次清零时间（第 N 次）"。不引入独立审计日志文件（会带来文件生命周期与轮转问题，单管理员场景过度设计）；导出本身就是"归档"动作，界面在清零前提示先导出。
5. **维度增量不再被上传/下载写盘连带丢弃**（修正）：`recordUpload()`/`recordDownload()` 写 `stats.json` 时只清计数器 `pending`（`pending = null`），**保留** `pendingDays`/`pendingFiles`/`forgottenFiles`/`pendingParts`，让维度数据仍按 ADR-009 的窗口（32 片或 2s）落盘。否则"恰好在上传/下载间隙的明细"会被无声吞掉，导出与累计值将出现无法解释的差额。
6. **界面**：仪表盘「近 7 日传输节省」卡片右上角提供「导出 CSV」（Blob 下载，文件名 `transfer-stats-<本地时间戳>.csv`）与「清零」（`Popconfirm` 二次确认）两个动作；清零成功后自动刷新统计，并展示审计行。卡片说明文案补充口径（导出为全量归档；清零会重置累计与明细、不影响上传/下载次数）。
7. **自检标记**：`/api/health` features 增加 `transferExport`，用于区分新旧版本。

## Alternatives

- **客户端拼 CSV（不开新接口）**：文件名列需要 `/api/admin/list`（只覆盖活跃分享），按日只有近 7 天，要先扩成"全 30 天 + 全文件"；CSV 转义在前端等于第二份事实源，且外部脚本（curl/巡检）无法直接归档。否决。
- **两个独立 CSV（days.csv / files.csv）或单文件分节**：单表长格式对 Excel 与脚本都最省事，也避免"一次下载两个文件"的状态。否决。
- **清零只清明细、保留累计**：会长期出现"明细之和 ≠ 累计值"的困惑，且 B4-9 的语义就是重开计量。否决。
- **清零连同上传/下载次数**：破坏站点运行指标连续性。否决。
- **独立审计文件 / 数据库表**：单管理员场景引入文件生命周期、轮转与查询面，收益不足。否决。
- **直接删除 `transfer-stats.json` 文件**：连审计字段一起丢；竞态下与刷盘窗口叠加更易留下"文件缺失"状态（读取端要处理默认值）。否决。
- **导出加筛选参数（近 7 日/单文件）**：当前数据规模（≤30 天 + 2000 条）全量导出即可，筛选是后期需求。不做。

## Consequences

- 正：可归档（CSV 长表，含全量 30 天与全部文件条目）、可一键重开计量；权限沿用唯一主体（管理密钥），审计事实随数据文件走，管理端可见"上次清零"。
- 正：修复了维度增量被上传/下载写盘连带丢弃的问题，导出/累计/明细三者自洽（[24b] 用例锁定）。
- 负：清零不可撤销——用 `Popconfirm` 与 `{ confirm: true }` 双闸；CSV 字段含中文与 BOM，按 RFC 4180 引用后对 Excel/脚本均兼容，但"严格 ASCII"的下游需要自行处理。
- 负/风险：崩溃窗口（决策 3）可能留下总量与明细不同步；导出体积随 30 天 + 2000 条封顶（数千行、数十 KB 量级）。
- 非目标：按操作者/操作时间的多条审计日志（无账号体系）；定时自动清零/归档；导出筛选；对清零点前后数据的对账工具。

## References

- RFC-002 §4.4/§6 REQ-023、§7；ADR-007（统计口径）、ADR-009（批量写入与合并读）、ADR-010（维度数据与保留策略）
- `scripts/test.js` [24d]（导出契约/转义/权限/清零/审计/清零后继续计量）、[24b]（维度增量不再被上传/下载丢弃）；`scripts/e2e-browser.js` E2E-7（真实浏览器点击导出得到 CSV、点击清零后界面归零）
