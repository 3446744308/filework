# ADR-016: 多公告采用单例数组 + 请求时仲裁，调度不做后台任务

> Status: Accepted（2026-10-13 实现并验收） | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-007 §4 | 影响：`server/notice.js`、`server/index.js`、`server/notice-presets.js`、`server/config.js`、`web/src/api.js`、`web/src/components/NoticeBar.jsx`、`web/src/pages/Admin.jsx`、`web/src/pages/Upload.jsx`

## Context

公告目前是**一条**（RFC-004/005）：

- 存储：`server/notice.js:noticePath = data/notice.json`，`getNotice()` 直接 `JSON.parse` 一个对象，`saveNotice()` 直接覆盖写；数据结构里没有「集合」的位置。
- 消费：`web/src/components/NoticeBar.jsx:loadNotice` 缓存单条 `noticePromise`，两个槽位（`App.jsx` 的 `slot="top"`/`slot="bottom"`）读的是**同一条**；`web/src/pages/Upload.jsx` 用 `api.notice()` 弹窗。
- 时间：`normalizeNotice` 只有 `enabled` 布尔，没有生效时间；「到点上下线」只能人工守点（RFC-005 §7 已把它列为非目标并转记 backlog B5-3）。

需要同时挂多条（维护通知 + 活动公告，一上一下），并按时间自动上下线。必须先把几个口径定死，否则实现会分叉：

- **不变量 1（老前端零改动）**：已发布的旧构建只认 `/api/notice` 的**单条顶层字段**（`enabled`/`title`/`content`/`display`/`position`/`scroll`/`scrollFill`/`bgColor`/`textColor`/`updatedAt`）。
- **不变量 2（无后台任务优先）**：本工具是单进程、无守护进程/无 cron 的架构（`server/index.js` 只有请求处理与既有 `cleanup`），引入调度器会带来「重启丢失 / 时钟补偿 / 任务可观测」一整套新面。
- **不变量 3（样式口径不变）**：位置/滚动白名单、十六进制颜色、空内容强制关闭（ADR-013）必须继续由同一份 `normalizeNotice()` 承担。

## Decision

1. **存储改为单例数组** `data/notices.json = { version: 2, rev, notices: [...] }`，每项在既有样式字段外新增 `id`/`priority`/`startAt`/`endAt`；`id === 'default'` 为保留项，承载旧语义与预设的缺省目标。读盘失败 → 空集合（等同「无公告」），**不回退读取 `notice.json`**（避免坏文件静默回滚到旧公告）。
2. **调度 = 请求时求值**：`GET /api/notice` 每次现场读盘 → 过滤 → 仲裁 → 返回。**不启动定时器、不常驻调度进程**。时间窗只是过滤谓词的一部分，因此没有「定时器漏跑」「重启丢任务」这类故障面；误差 = 访客刷新间隔（公告位可接受）。
3. **升级兼容靠一次性迁移 + 写穿镜像**：首次发现只有旧 `notice.json` 时迁移为 `[{ id: 'default', priority: 50, startAt: null, endAt: null, ...normalizeNotice(旧值) }]`，旧文件**保留不删**；此后每次写 `notices.json` 后把「当前胜者/关闭态」按**旧单条形状**写穿到 `notice.json`，让旧构建回滚后 `/api/notice` 仍可读（单向门里留退路）。
4. **仲裁序固定为 `priority` desc → `updatedAt` desc → `id` 升序**，且**同一槽位只下发一条**。最后一级 `id` 保证完全并列时结果确定（界面不抖动、测试可断言）；不叠加显示多条的理由：挤压页面、多个 `role="status"` 同时播报破坏无障碍语义（RFC-004 增量四）。
5. **公开接口顶层形状不变，另加 `notices` 数组**：顶层 = 仲裁胜者（老前端与 `Upload.jsx` 弹窗零改动），`notices: [...]` = 全部**有效**项（已按仲裁序排序，不含停用/未生效/已过期条目，避免泄露运营排期）。前端按槽位取「该槽位第一条」。
6. **时间窗用半开区间 `startAt ≤ now < endAt`**（`null` 表示不限），非法（`endAt ≤ startAt`）时把 `endAt` 置 `null`。半开区间让「前一条 08:00 结束、后一条 08:00 开始」不出现同时命中或同时落空的边界抖动。
7. **双重复用 `rev` 乐观锁**：文件级 `rev`（防「加/删条目」的丢失更新）+ 条目级 `rev`（防两个管理员改同一条互相覆盖），不一致即 `409`（复用 `NOTICE_CONFLICT`）；不带 `rev` 保持兼容（最后写入者生效，同 ADR-014 口径）。上限 `MAX_NOTICES`（env，默认 20）超限 `409`。
8. **实施触发条件**：运营真实需要「同时挂多条公告」或「按时间窗自动上下线」时实施；否则维持单条（本设计不实现，只入档）。

## Alternatives

- **后台定时器（`setInterval` 到点写文件）+ SSE 主动推送**：到点即时生效、访客无须刷新，但引入常驻调度状态（重启后要重建定时器、时钟回拨要补偿、任务执行要可观测），且本工具无 SSE 通道。请求时谓词以极低复杂度覆盖公告位的时效需求。否决。
- **公开接口直接返回数组，由前端仲裁**：服务端最简单，但①破坏不变量 1（老前端拿到数组会渲染错乱）；②把「哪些公告当前有效」这一运营信息暴露给所有访客；③仲裁逻辑会在多处前端复制。否决。
- **同槽位叠加显示多条（堆叠/轮播）**：需要新的布局与滚动协调，且无障碍播报会打架（见决策 4）；「重要压过次要」用 `priority` 已能表达。否决。
- **每条公告各自一个文件（`data/notices/<id>.json`）**：无「数组级 rev」的丢失更新问题，但多出目录遍历、文件数与命名冲突处理，且「一次写入多条目」需要跨文件事务。单例数组的一个原子 `rename` 就够。否决。
- **cron/日历语义（每日 09:00~18:00 这类重复窗口）**：需要时区与日历展开，收益未验证；先只做一次性时间窗。否决（列为 RFC-007 §7 非目标）。
- **复用预设承担「时间窗」**：预设是**手动素材库**（RFC-005），把时间语义塞进预设会让「套用/启用」两种语义与调度混在一起。职责分离：预设管内容，公告条目管生命周期。否决。

## Consequences

- 正：多条公告共存 + 按时间自动上下线，全部在**请求路径**上完成：无后台任务、无重启丢失、无时钟补偿逻辑；时钟即真相。
- 正：老前端零改动（顶层形状不变），新前端只是多读一个数组；样式/无障碍/归一化口径完全复用（不变量 3）。
- 正：`notice.json` 写穿镜像给回滚留了退路；迁移是一次性且**保留旧文件**，可人工核对。
- 负：每次 `GET /api/notice` 都要读盘 + 排序（公告条在多个页面前端并发请求）。规模极小（≤20 条），但如需优化需加「内存缓存 + mtime 校验」——**注意不能退化成纯内存缓存**，否则时间窗将不再随请求求值。
- 负：上下线精度 = 访客刷新间隔（不会「到点自动出现」在没有刷新的页面上）。对公告位判定为可接受。
- 负：`notices.json` 与 `notice.json` 两份文件会短暂不一致（镜像写失败时）。以新文件为准的规则让不一致是**良性**的（镜像只是退路）。
- 风险：时间依赖服务器本地时钟（与 `stats` 日切同口径）；若服务器时间漂移，时间窗会整体偏移——缓解：`/api/health` 暴露 `notice.nextChangeAt`，运维可直观核对。
- 风险：预设与公告的耦合点从「唯一公告」变成「指定的那条」；`applyPreset` 需要目标 id，缺省 `default` 才向后兼容（决策 1/5）。若实现时漏掉缺省逻辑，既有预设用例会失败——已列入 RFC-007 REQ-053/054 的验收。
- 风险：`notices[]` 只含有效项，虽然避免泄露排期，但也意味着前端无法预先知道「下一条几点来」；这是有意的取舍（要预知看管理端）。

## References

- RFC-007 §3/§4（数据模型、迁移镜像、仲裁、前端分流）
- ADR-013（公告样式白名单、归一化、空内容强制关闭）、ADR-014（预设模型、`rev` 乐观锁与 `NOTICE_CONFLICT` 口径）、RFC-004 增量四（无障碍：`role="status"`/`prefers-reduced-motion`）、RFC-002 §4.1（单向门与「保留旧构建」思路）
- `server/notice.js:getNotice`/`saveNotice`/`normalizeNotice`/`conflictError`、`server/notice-presets.js:applyPreset`、`server/index.js`（`/api/notice` 与预设路由）、`web/src/components/NoticeBar.jsx:loadNotice`/`slotOf`/关闭键、`web/src/pages/Upload.jsx:158`、`web/src/App.jsx`（双槽位）
- 关闭 backlog B5-3；**已实现（2026-10-13）**：`server/notice.js` 重写为数组模型（迁移/镜像/仲裁/`noticeStats`）、`index.js` 新增 `/api/admin/notices` CRUD 与 `notice` health，验收见 RFC-007 §6
- 实现备注：决策 1/5 预警的「`applyPreset` 缺省目标」已按缺省 `default` 实现（`targetId`）；另发现一个设计未覆盖的耦合点——管理端表单原先在挂载时载入「唯一公告」，改为列表后必须显式预填（取仲裁序首条），否则「保存为预设」会存下空表单（E2E-10 先回退后修复）
