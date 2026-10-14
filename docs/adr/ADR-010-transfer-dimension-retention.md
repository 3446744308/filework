# ADR-010: 传输节省的维度数据（按日 / 按文件）与保留策略

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.4 | 影响：`server/stats.js`、`server/store.js`、`server/transfer.js`、`server/index.js`、`web/src/pages/Admin.jsx`、`web/src/pages/AdminFiles.jsx`

## Context

ADR-007 只落了**站点级**累计（`stats.json` 的 `transferOriginalBytes`/`transferWireBytes`），管理端只能看到"这台服务器一共省了多少"，回答不了"哪个文件省得多、哪天传输量异常"（backlog B4-6 的收尾标准：按文件/日期的可查询明细 + 保留策略）。落地前有三个硬约束：

- **不能把 per-part 记账写进 `meta/<code>.json`**：那正是 B4-7 刚消除的写放大（单文件最多 `UNIT_MAX_COUNT=256` 次写），而且 meta 是消费语义的核心文件（`tryConsume` 读-改-写），不应混入统计噪声。
- **保留策略必须避免无界增长**，且不能依赖"定期全量对账"：对账要对每个条目 `stat` 一次 meta，按 2s 刷盘频率、数千分享规模就是每秒数百次系统调用。
- **匿名服务没有稳定的"客户端"身份**：`req.ip` 在 `trust proxy` 下是代理地址、在移动网络下会漂移，按 IP 记传输明细既不可靠又有隐私与保留风险。

## Decision

1. **独立单例文件 `data/transfer-stats.json`**（`{ version, days, files, updatedAt }`），不复用 meta、也不拆多文件：维度数据与站点计数**共用同一个内存 pending 与刷盘窗口**（ADR-009），因此不引入新的写放大；且只在"有维度增量或墓碑"时才写该文件。
2. **按日维度**：键 = 服务器本地日期 `YYYY-MM-DD`（`stats.dayKey(ts)` 纯函数，可单测）；每桶记 `originalBytes`/`wireBytes`/`parts`。**保留最近 `TRANSFER_DAYS_KEPT = 30` 天**，刷盘时按日期字符串裁剪（`YYYY-MM-DD` 可直接字典序比较）。
3. **按文件维度**：键 = 取件码，值附 `updatedAt`。生命周期**等于分享生命周期**：`store.removeShare(code)` 调用 `stats.forgetFileStat(code)` 记墓碑 → **读取端立即不可见**，下次刷盘从文件删除（零额外 IO、无需全量对账）。条目数封顶 `TRANSFER_FILES_MAX = 2000`，超出时按 `updatedAt` 淘汰最旧——即使未来出现绕过 `removeShare` 的删除路径，文件也不会无界增长。
4. **读取合并未落盘增量**（与 ADR-009 一致）：`readTransferStats()` 把 pending 与墓碑应用到返回值，因此 `/api/admin/stats`、`/api/admin/list` 永远是最新值。
5. **对外契约**：`/api/admin/stats` 增加 `transferToday`（今日桶）与 `transferDays`（最近 7 天，降序，含 `savedBytes` 派生值）；`/api/admin/list` 每项增加 `transfer`（`originalBytes`/`wireBytes`/`parts`/`savedBytes`），缺失时为 0。
6. **界面**：仪表盘「传输节省」卡片加"今日"副行，统计行下新增「近 7 日传输节省」明细卡；文件管理页新增「传输节省」列（`xl` 断点显示，避免窄屏拥挤）。

## Alternatives

- **把维度写进 `meta/<code>.json`**：读起来自然（删文件即删统计），但把 per-part 记账户落到消费语义的核心文件上，写放大与耦合都不可接受。否决。
- **独立文件 + 每次刷盘全量对账 meta 目录**：能自动清理"被绕过 removeShare 删除"的残留，但成本是 O(活跃分享数) 的 `stat` 调用/刷盘窗口。改为墓碑 + 条目上限（决策 3）。否决（全量对账）。
- **按 IP（客户端）维度**：`trust proxy` 下 IP 是代理地址、移动网络会漂移，且把"谁下载了多少"落盘带来隐私与保留责任，对匿名中转站无产品价值。列为非目标（RFC-002 §7）。
- **保留全部历史 / 只保留今日**：前者无界增长且读写成本随时间上升；后者无法回答"最近趋势"。30 天是运维复盘与前端 7 日展示之间的折中。否决两个极端。
- **把维度数据放 SQLite / 独立时序库**：查询能力更强，但引入依赖与部署面（本项目坚持零依赖、单文件单例），当前规模（≤2000 条目 + 30 天）用 JSON 足够。否决。
- **在 `stats.json` 里内联维度**：少一个文件，但站点总量（高频小写）与维度（可能数百 KB）的写频率与体积完全不同，混在一起会放大每次刷盘的成本。否决。

## Consequences

- 正：可回答"今天省了多少""哪个文件省得多"；维度数据与总量共用刷盘窗口，写入次数不随分片数放大（实测 15 片下载只触发 1 次维度落盘，接口侧即时准确）。
- 正：保留策略是"每个维度各自成立"的——日期按 30 天裁剪、文件按分享生命周期回收并封顶 2000，两者都不需要额外定时任务。
- 负：`transfer-stats.json` 的体积随活跃分享数增长（2000 条上限时约 120KB 级），每次刷盘全量重写一次（仅在有待刷盘数据时）。当前规模无感；若将来单站活跃分享数达数千并持续高并发下载，需改为分片/追加存储（列为 backlog 观察项）。
- 负：日维度按**服务器本地日期**切分，跨时区部署或服务器改时区时，"今天"的边界会随之变化；对运维复盘足够，不作为计费口径。
- 风险：`forgetFileStat` 是唯一清理路径，若将来新增删除入口而忘记调用它，条目会滞留到触发 2000 上限被淘汰——文档与用例（`scripts/test.js` [24b] 墓碑断言）已固定该约定。

## References

- RFC-002 §4.4/§6 REQ-022、§7；ADR-007（统计口径与派生节省值）、ADR-009（批量写入与合并读）
- `scripts/test.js` [24c]（今日桶/近 7 日/按文件维度/销毁后失效）、[24b]（墓碑即时不可见、30 天裁剪、2000 条封顶）；`scripts/e2e-browser.js` E2E-6（真实浏览器校验今日行、近 7 日明细与文件管理列）
