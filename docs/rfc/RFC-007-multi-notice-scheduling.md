# RFC-007: 多公告与定时投放（优先级 / 时间窗 / 请求时仲裁）

> Status: Implemented（2026-10-13） | Type: RFC | Created: 2026-10-12 | Updated: 2026-10-13 | Authors: zwh | Reviewers: zwh | Target: v1.7.0 站点运营（backlog B5-3）
> 索引：`RFC-007` | 关联 REQ：REQ-048~REQ-056 | 收益：公告从「同时只能挂一条」变为**多条共存 + 按时间窗自动上下线 + 双槽位各显示一条**，且**无需后台任务或重启**
> 位置：`docs/rfc/RFC-007-multi-notice-scheduling.md`（权威，无独立 spec 快照）；关联 `ADR-016`（本 RFC 的决策记录）、`ADR-013`（公告样式与归一化口径）、`ADR-014`（预设模型）
> 一致性声明：本 RFC 复用 RFC-004 的全部样式字段与 `normalizeNotice()` 口径、复用 RFC-005/ADR-014 的预设机制与 `rev` 乐观锁；`/api/notice` 的**顶层字段保持旧形状**（老前端零改动）。`ADR-016` 已转 Accepted（2026-10-13）。

## 0. 更新摘要

2026-10-12 首版需求（backlog B5-3 关闭设计阶段）：`data/notice.json` 只能存**一条**公告，运营要「同时挂维护通知和活动公告」或「今晚 22:00 自动上线、明早 08:00 自动下线」时，只能靠人肉守点改配置。设计结论：数据模型改为**单例数组** `data/notices.json`，每项带 `id`/`priority`/`startAt`/`endAt`；**调度 = 请求时求值**（读文件 → 过滤 → 仲裁 → 返回），因此没有后台定时器、无需重启、时钟即真相；公开接口顶层仍是「一条公告」（旧前端零改动），另加 `notices` 数组供上下两个槽位各取一条。本文档只做设计，**不实现**。

## 1. 需求

| REQ | 目标 | 基线（RFC-005 后） | 目标 | 验证 |
|---|---|---|---|---|
| REQ-048 | 多公告数据模型 | 单例单条 `data/notice.json`（`notice.js` `getNotice`/`saveNotice`） | 单例数组 `data/notices.json` = `{ version: 2, rev, notices: [{ id, priority, startAt, endAt, …样式字段 }] }`；首次读到旧 `notice.json` 且无新文件时**自动迁移**为单元素数组 | `scripts/test.js` 新增段：旧文件存在时首次 `GET /api/notice` 得到同内容公告且新文件已生成；两文件同时存在时以新文件为准 |
| REQ-049 | 时间窗 | 无时间概念 | 每项 `startAt`/`endAt`（epoch ms 或 `null` = 不限）；判定 `startAt ≤ now < endAt`（**半开区间**） | 段：`startAt` 在未来 → 不展示；`endAt` 已过 → 不展示；边界 `now === startAt` 展示、`now === endAt` 不展示 |
| REQ-050 | 优先级仲裁 | 唯一一条，无仲裁 | 有效集合（`enabled` + 有内容 + 时间窗内）按 `priority` desc → `updatedAt` desc → `id` 升序取首个；同输入必得同结果 | 段：三条同时有效时按 `priority` 取胜者；同 `priority` 时 `updatedAt` 新者胜；完全并列时 `id` 小者胜（两次请求结果一致） |
| REQ-051 | 请求时求值（无后台任务） | 无调度 | 每次 `GET /api/notice` 现场读盘 + 过滤 + 仲裁；**不启动定时器、不缓存到进程内存**（除非带 mtime 校验） | 段：把 `startAt` 改为 1 秒后 → 不刷新配置直接重新请求即生效；不依赖任何定时器（测试中无 `setInterval` 计数） |
| REQ-052 | 无可展示公告的降级 | 关闭时返回 `{ enabled: false, … }` | 有效集合为空时，顶层返回与今天「关闭」**完全同构**的对象（`enabled: false` + 默认样式值），`notices: []` | 段：过期/停用/空内容三种情况均返回 `enabled: false` 且 HTTP 200（不报错） |
| REQ-053 | 公开接口向后兼容 + 多槽位 | `/api/notice` = 单条 | 顶层 = 最高优先级胜者（老前端与 `Upload.jsx` 弹窗零改动）；新增 `notices: [...]`（全部有效项，已按仲裁序排序）供 `NoticeBar` 按槽位取该槽位最高优先级那条 | 段：既有 [6] 公告用例不改仍通过；新增断言顶层 === `notices[0]`；E2E 断言 top/bottom 两槽位各渲染一条不同公告 |
| REQ-054 | 管理端多公告 CRUD | 单表单 | 公告列表（新增/编辑/删除/启用停用/优先级 ↑↓）+ 表单 `startAt`/`endAt`（DatePicker，可空）；预设「启用」需目标公告 id，缺省落到 `id === 'default'` 的公告 | 段：新增两条、删一条、改优先级顺序落库；E2E 真实点击新增/切换编辑目标/删除 |
| REQ-055 | 上限与并发 | 单条无上限问题 | `MAX_NOTICES`（env，默认 20）超限 `409`；数组级 `rev` 与每项 `rev` 双重复用 `expectedRev` 校验（沿用 `NOTICE_CONFLICT`） | 段：补满 20 条后第 21 条 409 且列表不变；带旧 `rev` 写入 409、不带 `rev` 兼容 |
| REQ-056 | 零回归 | `npm test` 301 passed / 0 failed | 样式（位置/滚动/配色/无障碍）、预设全套语义、`notice.json` 回滚镜像与全部既有用例保持通过 | 全量 `npm test` + `npm run e2e` + `npm run build` |

> 基线环境：Windows（Git Bash），Node 24 ESM（要求 ≥18），`npm test` 自启服务器（端口 3999，`DATA_DIR=data-test`）；浏览器用例为 headless Chrome 154（CDP）。

## 2. 现状根因

- **存储单位是「唯一」**：`server/notice.js:getNotice` 直接 `JSON.parse` 一个对象、`saveNotice` 直接覆盖写——数据结构里没有「集合」的位置，超过一条就无处安放。
- **前端按单条消费**：`web/src/components/NoticeBar.jsx:loadNotice` 缓存一个 `noticePromise`，`NoticeBar` 用 `n.display`/`n.position`/`n.updatedAt` 自己决定是否渲染；`web/src/pages/Upload.jsx:158` 用 `api.notice()` 展示弹窗。**两个槽位共用同一条公告**（`App.jsx` 渲染 `slot="top"`/`slot="bottom"`），所以「上一条维护公告 + 下一条活动公告」今天根本无法表达。
- **没有时间维度**：`normalizeNotice` 只有 `enabled` 布尔，没有生效时间；「到点自动上下线」只能人工守点（RFC-005 §7 已把定时投放列为非目标并转记为 backlog B5-3）。

## 3. 总体设计

```mermaid
flowchart LR
  ADMIN[管理端 /admin 公告列表] -->|CRUD + priority| STORE[(data/notices.json<br/>{ version:2, rev, notices[] ≤ 20 })]
  STORE --> MIRROR[(data/notice.json<br/>写穿镜像 = 胜者快照)]
  PUB[访客 GET /api/notice] --> READ[读盘 + 归一化]
  READ --> FILTER{enabled 且有内容<br/>且 startAt ≤ now &lt; endAt}
  FILTER -->|有效集合空| EMPTY["enabled:false（旧形状）"]
  FILTER -->|非空| RANK[priority desc → updatedAt desc → id 升序]
  RANK --> TOP[顶层 = 胜者]
  RANK --> ARR["notices[] = 全部有效项（已排序）"]
  TOP --> MODAL[Upload.jsx 弹窗 零改动]
  ARR --> SLOT[NoticeBar 按槽位各取一条]
```

- **一次仲裁、两种消费**：服务端算出「有效 + 已排序」的集合，顶层给「最该被看到的那条」，`notices` 给「按槽位分流」。老前端读顶层字段，新前端读数组——**同一接口同时满足两种消费者**，无需版本协商。
- **调度不是任务，是谓词**：时间窗只是过滤条件的一部分，因此「上线/下线」发生在下次请求读取时，误差 = 访客的刷新间隔。对公告位（非交易态数据）完全够用，且换来「零后台任务、零重启丢失、零时钟漂移补偿逻辑」。
- **数据层**：`server/notice.js` 升级为「数组的读写 + 仲裁」；`normalizeNotice` 继续为每一项归一化（样式字段口径不变），新增 `id`/`priority`/`startAt`/`endAt` 四个字段。

## 4. 详细设计

### 4.1 数据文件（`data/notices.json`）

```json
{
  "version": 2,
  "rev": 7,
  "notices": [
    {
      "id": "default",
      "priority": 50,
      "startAt": null,
      "endAt": null,
      "enabled": true,
      "title": "例行维护",
      "content": "本周末 02:00 至 04:00 例行维护……",
      "display": "both",
      "position": "top",
      "scroll": "left",
      "scrollFill": false,
      "bgColor": "",
      "textColor": "",
      "rev": 3,
      "updatedAt": 1760000000000
    },
    {
      "id": "3f2a9c1d5b7e4081",
      "priority": 90,
      "startAt": 1760025600000,
      "endAt": 1760112000000,
      "enabled": true,
      "title": "活动公告",
      "content": "…",
      "display": "bar",
      "position": "bottom",
      "scroll": "right",
      "scrollFill": false,
      "bgColor": "#112233",
      "textColor": "#ffee00",
      "rev": 1,
      "updatedAt": 1760020000000
    }
  ]
}
```

- `id`：`default` 为保留 id（承载旧语义与预设缺省目标）；其余为 `crypto.randomBytes(8).toString('hex')`（与预设同口径）。
- `priority`：`0~100` 整数，默认 `50`，越大越优先；非整数按默认值回落。
- `startAt`/`endAt`：`null` 或正整数 epoch ms；非法/负数按 `null`（不限）回落。
- `rev`：文件级 `rev`（每次写 +1）+ 每项 `rev`（该项每次写 +1），两者都参与 `expectedRev` 校验——文件级防「加/删条目」丢失更新，条目级防「两个管理员同时改同一条」互相覆盖。
- 读盘规则与 `notice.js` 既有「宁可再生，不冒用脏数据」一致：解析失败 → 空集合；逐项过滤（`id` 必须非空字符串，重复 `id` 只保留首个）→ 归一化 → 截断到 `MAX_NOTICES`。

### 4.2 迁移与回滚镜像（REQ-048）

- **迁移（只写一次）**：`notices.json` 不存在、`notice.json` 存在 → 用后者构造 `[{ id: 'default', priority: 50, startAt: null, endAt: null, ...normalizeNotice(旧值) }]` 写入 `notices.json`；旧文件**保留**（不删，作为回滚证据）。
- **写穿镜像**：每次写 `notices.json` 后，把「当前胜者（或关闭态）」以今天的单条形状写入 `notice.json`。作用：旧构建回滚后 `/api/notice` 仍能读到一条合理公告（**单向门中留一条退路**，同 RFC-002 §4.1 的「保留旧构建」思路）。
- 两文件同时存在时**以新文件为准**；镜像只写不读。

### 4.3 公开接口（REQ-050/052/053）

- `GET /api/notice` 响应 = `{ ...胜者或关闭态, notices: [全部有效项] }`；`notices` 已按仲裁序排序，因此前端只需「按槽位找第一条」。
- 仲裁序：`priority` desc → `updatedAt` desc → `id` 升序（最后一级保证完全并列时结果确定，便于测试与「界面不抖动」）。
- 降级：有效集合为空 → 顶层取 `DEFAULT_NOTICE` 形状（`enabled: false`），`notices: []`。**不返回 404/500**——「没有公告」是正常状态，不是错误。
- **不暴露无关系目**：`notices` 只含「当前有效」项，不含停用/未生效/已过期条目，避免泄露运营排期。

### 4.4 前端（REQ-053/054）

- `NoticeBar.jsx`：`loadNotice` 返回整个响应；每个槽位在自己的有效项里取**该槽位第一条**（`slotOf(position) === slot`）；关闭键改为 `notice-bar-closed-${notice.id}-${notice.updatedAt}`（否则两条公告共用 `updatedAt` 时互相牵连）。`NoticeBarView`/`useReducedMotion`/测量逻辑**零改动**（它对「一条公告」的契约不变）。
- `Upload.jsx`：弹窗继续用顶层胜者（零改动），但仅当 `display` 含 `modal` 时才弹。
- `Admin.jsx`：公告设置从「单表单」改为「列表 + 表单」——左侧列表（标题/优先级/状态/生效时间/启用开关/删除），右侧编辑选中项；预设「启用」写入**选中**的公告（缺省 `default`），保持「套用 → 微调 → 保存」既有交互。

## 5. 错误处理与可观测性

| 失败模式 | 行为 |
|---|---|
| 无有效公告（过期/停用/空内容/未到点） | 顶层返回 `enabled: false` 旧形状，`notices: []`，HTTP 200 |
| `notices.json` 损坏或非数组 | 回退空集合（等同「无公告」），**不**回退读取 `notice.json`（避免「坏文件静默回滚到旧公告」的惊吓） |
| 条目 `id` 重复 | 只保留首个，其余丢弃（并在 health 暴露计数） |
| 时间窗非法（`endAt ≤ startAt`） | 归一化时把 `endAt` 置 `null`（视为「一直有效到手动关闭」），管理端表单即时提示 |
| 达到 `MAX_NOTICES` | 新增返回 `409`（文案含上限），既有条目不变（与预设 `PRESET_LIMIT` 同口径） |
| 并发写 | 文件级 `rev` 不一致 → `409 已被其他管理端修改`；条目级 `rev` 不一致同样 409（复用 `NOTICE_CONFLICT`） |
| 多条同时有效且同槽位 | 仲裁序只让**一条**胜出，另一条不下发到该槽位（界面不叠加、无障碍不打架） |

**可观测性**：`/api/health` 增 `notice: { total, active, winnerId, nextChangeAt }`——`nextChangeAt` = 未来最近的一次时间窗边界（无则 `null`），让运维一眼看出「下一条公告几点上下线」，而不必逐个算时间戳。

## 6. 验收（已实现）

| REQ | 结果 | 证据 |
|---|---|---|
| REQ-048 多公告数据模型 | ✅ | `scripts/test.js` [6]（旧 `notice.json` 迁移为 v2 单元素数组 + 保留旧文件）、[31]（列表/上限）；`server/notice.js:readStore/migrateLegacy` |
| REQ-049 时间窗（半开区间） | ✅ | [31]「时间窗内生效」「endAt 到点后下次请求即下线」「startAt 在未来不展示且不泄露」 |
| REQ-050 优先级仲裁 | ✅ | [31]「notices[] 按仲裁序排序」「同槽位多条由优先级决定谁被展示」「条目级乐观锁」 |
| REQ-051 请求时求值（无后台任务） | ✅ | [31]「endAt 到点时无需重启/定时器，下次请求即下线」；`notice.js` 无 `setInterval`，`getNotice()` 每次现场读盘过滤 |
| REQ-052 无可展示公告降级 | ✅ | [31]「全部停用后顶层回到旧形状（`enabled:false` + `notices:[]`，HTTP 200）」 |
| REQ-053 公开接口兼容 + 多槽位 | ✅ | [6]（既有公告用例未改仍通过）、[31]「顶层为最高优先级胜者」「两槽位各有归属」；E2E-12「上下两槽位同时渲染各自槽位最高优先级公告」 |
| REQ-054 管理端多公告 CRUD | ✅ | [31]（新增/编辑/删除/启用/优先级）；E2E-12「列表展示状态」「点编辑载入表单」「点新建清空表单」 |
| REQ-055 上限与并发 | ✅ | [31]「达到 MAX_NOTICES 后 409 且列表不变」「条目级旧 rev 409 不覆盖」；[29]（文件级 `expectedRev` 兼容回归） |
| REQ-056 零回归 | ✅ | `npm test` **325 passed / 0 failed**；`npm run e2e` **84 passed / 0 failed**；`npm run build` 通过 |

## 7. 非目标

- **后台定时器 / SSE 主动推送**：需要守护进程式的调度与「到点即推」，属另一层复杂度；请求时谓词已满足公告位的时效要求。ADR-016 决策 2 记录否决。
- **同槽位叠加显示多条**（堆叠公告条/轮播多条）：会挤压页面、破坏无障碍语义（多个 `role="status"` 同时播报），且「一条 + 按优先级胜出」已能表达「重要公告压过次要公告」。ADR-016 决策 4 记录否决。
- **按用户/地域/设备定向投放**：需要身份维度，与匿名共享定位冲突。
- **重复周期（每日 09:00~18:00 这类 cron/窗口）**：需要时区与日历语义，收益未验证；先只做「一次性时间窗」，留到有真实诉求再扩。
- **公告历史版本 / 变更审计**：预设已提供「素材库 + 启用审计」；公告本体的历史留待与预设合并考虑。
- **暂存草稿（先存不上线）**：`enabled: false` + 时间窗已能表达绝大部分诉求。

## 8. 追溯

> **已实现（2026-10-13）**：`server/notice.js`（数组模型 + 迁移 + 写穿镜像 + 请求时仲裁 + `noticeStats`）、`server/index.js`（`GET/POST/PUT/DELETE /api/admin/notices`、`/api/notice` 新增 `notices[]`、health `notice`）、`server/config.js`（`MAX_NOTICES`）、`server/notice-presets.js`（启用可指定目标公告）、`web/src/api.js`、`web/src/components/NoticeBar.jsx`（按槽位取第一条 + 关闭键含 id）、`web/src/pages/Admin.jsx`（列表 + 表单）。验收见 §6；决策记录 `docs/adr/ADR-016-multi-notice-arbitration.md`（Status: Accepted）。
> 关联既有实现：`server/notice.js`（`normalizeNotice`/`saveNotice`/`rev`）、`server/notice-presets.js`（预设与 `applyPreset`）、`web/src/components/NoticeBar.jsx`、`web/src/pages/Upload.jsx`、`web/src/pages/Admin.jsx`、`web/src/App.jsx`（双槽位）。
