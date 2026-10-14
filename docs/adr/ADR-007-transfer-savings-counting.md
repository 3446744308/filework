# ADR-007: 传输节省的统计口径（分片链路、会话内去重、节省值派生）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.4 | 影响：`server/stats.js`、`server/sessions.js`、`server/transfer.js`、`server/index.js`、`web/src/pages/Admin.jsx`

## Context

RFC-002 让"压缩数据真正走线"后，收益只存在于响应头（`Content-Encoding`/`X-Transfer-Mode`）与取件页进度条里，刷新即失；运维无法回答"这套优化到底省了多少带宽"。需要把传输字节落库并在管理端仪表盘可见（backlog B4-1）。落库前必须先定口径，否则数据会自相矛盾：

- **统计哪些请求**：下载有两条链路——`GET /api/download`（单流导航下载，服务端解压后发原始字节，线上字节恒等于原始字节）与 `GET /api/download/part`（分片并行下载，协商后可发压缩字节）。把单流也算进去会以"1:1 的中性数据"稀释比例，让卡片读数不再代表压缩收益。
- **原始字节怎么算**：分片的原始字节 = 该分片在原始文件中的范围长度（`end − start`），可由服务端单元表前缀和算出，不依赖客户端上报。
- **线上字节怎么算**：必须以**实际写出**的字节为准（`Content-Length` 即 `store` 直传的单元长度、`recompress`/`raw` 的 body 长度），而非估算值。
- **重复与失败**：客户端有分片重试（5xx 重试 2 次）、旧式 `start/end` 范围请求、以及脚本/浏览器可能重复取同一片；同一份字节被多次计费会让统计失去意义。失败（400/404/500）不产出字节，不应计数。
- **节省值**：`saved = original − wire` 是派生的，若与两个原始计数一起落盘就会出现"三者互不相等"的脏数据（写入中断、手工改文件、旧版本文件）。

## Decision

1. **口径 = 分片下载链路**：只在 `GET /api/download/part` 成功产出分片时累计。`GET /api/download`（含 ≤1MB 单流下载）与浏览器实际落盘字节不计入。
2. **两个基础计数落盘**：`stats.json` 新增 `transferOriginalBytes`（Σ `end − start`）与 `transferWireBytes`（Σ 实际响应 `Content-Length`）。`transferSavedBytes` **只在读取端派生**（`/api/admin/stats`，`max(原始 − 线上, 0)`），不落盘，避免三者漂移。
3. **会话内去重**：`sessions.markSessionPart(token, key)` 用会话级 `Set` 记录已计数的取片键（`index` 序号，或旧式范围请求的 `start-end`）；同一键第二次及以后不再累加。会话 TTL 10 分钟，重启即丢——重复计数的上限被限制在"同一 token 内"，而计数器本身跨会话永久累计。
4. **成功才计数**：计数发生在响应即将写出时（`store` 直传前 / 原始流 pipe 前 / 重编码 `res.end` 前），参数校验、容器损坏、令牌失效等失败路径直接返回，不触碰计数器。
5. **可观测**：`/api/admin/stats` 同时返回三项；`/api/health` features 增加 `transferStats` 作为部署自检标记。

## Alternatives

- **只存 `transferSavedBytes` + `transferWireBytes`（backlog 原文字）**：节省值落盘需要"原始 − 线上"的反推，两个独立计数一旦有一个写入中断或手工篡改，节省值就永久错误且无法自愈。存两个基础量、派生第三个更稳。否决（落盘派生值）。
- **按响应头 `X-Transfer-Mode` 统计"压缩节省"（只统计 `store`/`recompress`）**：会漏掉同一次下载里未压缩但确实传输了原始字节的分片（未压缩文件、raw 单元），使"线上字节"偏小、节省率虚高。否决。
- **统计所有下载请求（含 `/api/download`）**：口径更"全"，但单流链路恒为 1:1，比例会被稀释成无意义的数字，且 ≤1MB 小文件占请求数不少。否决。
- **在内存里累加、定时批量落盘（减少同步写）**：能降低 IO，但引入"未落盘即丢失"窗口与测试不确定性（读接口需要 flush 时序）。当前每分片一次同步小写入（单文件 ≤ `UNIT_MAX_COUNT=256` 次）是可接受的。列为后续优化（backlog B4-7）。否决（本期）。
- **按文件/日期/客户端维度分别累计**：需要新的数据结构与保留策略，超出"一张卡片"的目标。列为 backlog B4-6。否决（本期）。

## Consequences

- 正：卡片数据可自证——`Δ原始 === 分片计划覆盖的原始字节`、`Δ线上 === ΣContent-Length`、`Δ节省 === Δ原始 − Δ线上`，测试可逐项断言（`scripts/test.js` [24]）。
- 正：去重键与会话绑定，天然覆盖"重试/重复取片"，无需客户端配合上报。
- 负：口径"只含分片下载"需要向使用者解释（卡片下已有说明文案）；≤1MB 单流下载的节省为 0 且不可见。
- 负：每次分片产出一次同步读-改-写 `stats.json`；并发下载时存在 IO 抖动（实测 5 片/次的量级无感），高并发/大文件场景进 backlog B4-7。
- 风险：客户端中断（下载到一半关页）时，服务端已写出的字节仍被计入——统计的是"服务端发出的字节"，不是"用户收到的字节"；该偏差只影响绝对量，不影响比例口径的理解。已在 `docs/DEVELOPMENT.md` §5 注明。

## References

- RFC-002 §4.4/§6 REQ-019、§7；ADR-006（传输协商，决定线上字节的技术来源）
- `scripts/test.js` [24]（增量/去重/派生断言）、`scripts/e2e-browser.js` E2E-6（真实浏览器卡片核对）
