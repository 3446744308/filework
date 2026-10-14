# RFC-005: 公告预设（最多 10 个）

> Status: Implemented (Completed 2026-10-12) | Type: RFC | Created: 2026-10-12 | Updated: 2026-10-12 | Authors: zwh | Reviewers: zwh | Target: v1.4.0 站点运营
> 索引：`RFC-005` | 关联 REQ：REQ-036~REQ-041 | 位置：`docs/rfc/RFC-005-notice-presets.md`（权威，无独立 spec 快照）
> 关联 `ADR-014`（预设模型：服务端单例 JSON、上限拒绝、套用与启用分离）；依赖 RFC-004 的公告字段与归一化口径（ADR-013）。
> 一致性声明：`docs/DEVELOPMENT.md` §3（目录）/§5（数据模型）/§7（接口契约）/§8（管理端页面）已登记。

## 0. 更新摘要

2026-10-12 首版需求：运营经常在几种公告之间来回切换（维护通知 / 活动公告 / 免责声明），每次都要重填标题、内容、位置、滚动与配色。为此新增**公告预设**：

- **服务端单例 JSON**（`data/notice-presets.json`，随 `data/` 一起备份），五个管理端接口（列表/新增/覆盖/删除/启用），全部需要 `x-admin-key`。
- **最多 10 个**：第 11 个新增返回 `409` 并提示先删除，既有预设不丢。
- **两种用法**：「套用」只把预设回填到表单（确认后再保存）；「启用」立即把预设写为当前公告（相当于一次带样式的保存）。
- **复用公告归一化**：预设里的公告字段与 `notice.json` 走同一套校验（位置/滚动白名单、十六进制颜色、空内容强制关闭）。

## 1. 需求

| REQ | 目标 | 基线（RFC-004 后） | 目标 | 验证 |
|---|---|---|---|---|
| REQ-036 | 预设增删改查 | 无预设概念，换公告只能重填 | `GET/POST/PUT/DELETE /api/admin/notice/presets[/:id]`，单例 JSON，全部 `adminAuth` | `scripts/test.js` [27] 无密钥 401、初始空列表、新增 201、列表读回、覆盖改名称与内容（`createdAt` 不变）、删除生效且重复删除 404 |
| REQ-037 | 最多 10 个 | — | 第 11 个新增 `409 预设数量已达上限（最多 10 个），请先删除`，既有 10 个不变 | [27] 逐个补到 10 个全部 201；第 11 个 409 且列表仍为 10 |
| REQ-038 | 校验与归一化一致 | — | 复用 `notice.normalizeNotice`；名称 ≤50 且留空回退「公告标题 → 预设 N」；预设内的公告不存 `updatedAt` | [27] `position: 'fixed-top'`/`bgColor: '#0A0' → '#00aa00'` 归一化、名称取标题、`updatedAt` 未落盘、80 字符名称截到 50 |
| REQ-039 | 套用（不直接上线） | — | 「套用」仅回填表单，当前公告与 `updatedAt` 不变 | [27] 套用无需新接口（纯前端）；E2E-10 断言套用后表单名称与选项状态被回填且 `/api/notice` 未变 |
| REQ-040 | 一键启用 | — | `POST /api/admin/notice/presets/:id/apply` 把预设写为当前公告，`updatedAt` 刷新，访客立即可见 | [27] 启用后 `/api/notice` 与预设字段一致且 `updatedAt` 刷新；E2E-10 真实点击「启用」后接口字段与预设一致 |
| REQ-041 | 零回归 | `npm test` 255 passed / 0 failed | 公告既有语义（空内容强制关闭、401、样式归一化）与全部既有用例保持通过 | 全量 `npm test` + `npm run e2e` |

> 基线环境：Windows（Git Bash），Node 24 ESM（要求 ≥18），`npm test` 自启服务器（端口 3999，`DATA_DIR=data-test`）；浏览器用例为 headless Chrome 154（CDP）。

## 2. 现状根因

- **切换公告是纯手工操作**：`data/notice.json` 只存「当前那一条」，运营想把上周的维护公告换回来，只能凭记忆重填标题、内容、位置、滚动和两个颜色。
- **没有「配置快照」的地方**：管理端表单值完全由 `/api/notice` 反填，前端不保留历史；浏览器 localStorage 又无法跨设备/跨管理员共享。
- **直接复用公告接口不够**：`PUT /api/notice` 是「立即上线」语义（会改 `updatedAt` 从而让所有访客重新看到公告），无法表达「先存起来、稍后再用」。

## 3. 总体设计

```mermaid
flowchart LR
  subgraph Admin[管理端 /admin 公告设置]
    FORM[当前表单] -->|保存为预设| POST[POST presets]
    ROW[预设列表] -->|套用| FORM
    ROW -->|覆盖| PUT[PUT presets/:id]
    ROW -->|启用| APPLY[POST presets/:id/apply]
    ROW -->|删除| DEL[DELETE presets/:id]
  end
  POST --> STORE[(data/notice-presets.json<br/>presets[] ≤ 10)]
  PUT --> STORE
  DEL --> STORE
  STORE --> LIST[GET presets]
  APPLY --> NOTICE[(data/notice.json)]
  NOTICE --> PUBLIC[GET /api/notice 公开可见]
```

- **数据层**：`server/notice-presets.js` 只做读写与校验，不依赖 express（与 `notice.js` 一致）；路由写在 `server/index.js` 并复用其 `adminAuth`/`fail`，避免出现第二套鉴权实现。
- **套用 vs 启用**：套用是纯前端动作（把预设对象塞回表单 state），启用才走接口；这样运营可以「套用 → 微调 → 保存公告」，而紧急切换只需一次点击。
- **预设存的是一份公告快照**：字段与 `notice.json` 完全同构（少一个 `updatedAt`），因此启用 = `saveNotice(预设.notice)`，不需要任何字段映射。

## 4. 详细设计

### 4.1 数据文件（`data/notice-presets.json`）

```json
{
  "version": 1,
  "presets": [
    {
      "id": "3f2a9c1d5b7e4081",
      "name": "维护公告（深色）",
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000,
      "notice": {
        "enabled": true,
        "title": "维护公告",
        "content": "本周末 02:00 至 04:00 例行维护……",
        "display": "both",
        "position": "fixed-bottom",
        "scroll": "up",
        "bgColor": "#112233",
        "textColor": "#ffee00"
      }
    }
  ]
}
```

- `id` = `crypto.randomBytes(8).toString('hex')`（192/128-bit 随机，随管理密钥一起保护；不做顺序编号，避免猜测与复用）。
- 读盘时逐项过滤（`id` 必须是非空字符串）并按顺序截断到 10 条；任何解析失败都回退「空列表」，与 `notice.js` 的「宁可再生，不冒用脏数据」一致。
- 写盘仍是「临时文件 + rename」原子替换（ADR-009 的既有惯例）。
- 名称：`≤50` 字符，留空回退「公告自身的标题 → `预设 N`（N 为列表位次）」。
- 预设内的 `notice` 走 `normalizeNotice()` 后再删掉 `updatedAt`——即「启用时才盖新时间」，避免预设里的旧时间戳让访客的「已关闭」记录误判。

### 4.2 接口（全部 `adminAuth`）

| 方法 | 路径 | 语义 |
|---|---|---|
| `GET` | `/api/admin/notice/presets` | `{ ok, limit: 10, presets: [...] }` |
| `POST` | `/api/admin/notice/presets` | body `{ name?, notice }`（也接受扁平的公告字段）→ `201 { ok, preset }`；满 10 → `409` |
| `PUT` | `/api/admin/notice/presets/:id` | body `{ name?, notice? }`，缺省字段沿用原值 → `200 { ok, preset }`；未知 id → `404` |
| `DELETE` | `/api/admin/notice/presets/:id` | `200 { ok }`；未知 id → `404` |
| `POST` | `/api/admin/notice/presets/:id/apply` | 写为当前公告 → `200 { ok, notice }`；未知 id → `404` |

错误映射：`PRESET_NOT_FOUND → 404`、`PRESET_LIMIT → 409`、其余 → `400`（沿用「JSON `{ error: 中文提示 }`」约定）。

### 4.3 管理端（`web/src/pages/Admin.jsx`）

- 公告设置卡片新增 `Divider`「公告预设（n/10）」+ 名称输入 + 「保存为预设」（满 10 时禁用）。
- 每条预设渲染为一行 `.notice-preset-row`：名称 + 摘要（显示方式 · 位置 · 滚动 · 底色 · 字色）+ 四个动作（套用 / 启用 / 覆盖 / 删除，删除带 `Popconfirm`）。
- 显示方式/位置/滚动三组选项抽成模块级常量（`DISPLAY_OPTIONS`/`POSITION_OPTIONS`/`SCROLL_OPTIONS`），单选组与预设摘要共用同一份标签，避免文案漂移。

## 5. 错误处理与可观测性

| 失败模式 | 行为 |
|---|---|
| 未带管理密钥 | 全部接口 `401 管理密钥错误`（列表同样需要密钥） |
| 已达 10 个再新增 | `409 预设数量已达上限（最多 10 个），请先删除`；既有预设与文件不变 |
| 未知 id 覆盖/启用/删除 | `404 预设不存在` |
| 文件损坏/非 JSON/`presets` 不是数组 | 读为「空列表」（不抛错、不影响公告本身） |
| 预设里的样式值非法（旧数据或手工编辑） | 读盘即归一化，UI 不会出现「未知位置」这类值 |
| 预设内容为空 | 归一化时 `enabled=false`（与公告同一条规则），启用后是「关闭状态的公告」而不是报错 |
| 并发写（两个管理员同时保存） | 单进程内同步读写；最后写入者生效（与 `notice.json`/`settings.json` 同口径） |

## 6. 验收

| REQ | 结果 | 证据 |
|---|---|---|
| REQ-036 | ✅ 通过 | `scripts/test.js` [27]：无密钥 401；初始 `{ limit: 10, presets: [] }`；新增 `201` 且 id 稳定可读回；覆盖改名称/底色且 `createdAt` 不变；删除 `200`、重复删除 `404`；落盘为 `{ version: 1, presets: [...] }`；E2E-10 真实浏览器经 UI 完成保存→套用→启用→删除全流程 |
| REQ-037 | ✅ 通过 | [27] 依次补满 10 个全部 `201`；第 11 个 `409`（错误信息含「上限」）且列表仍为 10；E2E-10 读到 `limit: 10` |
| REQ-038 | ✅ 通过 | [27]：名称留空回退为公告标题；`position: 'fixed-top'`/`scroll: 'right'` 原样保存；`bgColor: '#0A0'` 归一化为 `#00aa00`；预设内无 `updatedAt`；80 字符名称截断为 50 |
| REQ-039 | ✅ 通过 | E2E-10：点「套用」后名称输入框回填为预设名、多个单选按钮进入选中态，且 `/api/notice`（含 `updatedAt`）保持不变 |
| REQ-040 | ✅ 通过 | [27] 启用后 `/api/notice` 字段与预设一致且 `updatedAt` 刷新、公开接口立即可见；E2E-10 真实点击「启用」后接口字段与预设一致；删除预设后当前公告不变 |
| REQ-041 | ✅ 通过 | `npm test` **270 passed / 0 failed**（RFC-004 基线 255 + 新增 15）；`npm run e2e` **55 passed / 0 failed**（新增 E2E-10 共 9 条断言）；`npm run build` 成功 |

## 7. 非目标

- **预设导入/导出与排序/分组**：**已实现（backlog B6-1 关闭，ADR-014 修订一）**——导出为带 `format`/`version` 的 JSON 附件，导入支持 `merge`/`replace`、重名自动加序号、超容量计 `skipped`；排序改用每行 ↑/↓ 按钮 + `PUT .../order`（**不引入拖拽依赖**，与「零新依赖」约定一致），分组仍未做。
- **预设数量可配置**：**已实现（backlog B6-2 关闭）**——上限改由站点设置 `presetLimit` 决定（默认 10，钳制到 env `MAX_NOTICE_PRESETS` 硬上限默认 50），调低上限不删除已有预设。
- **自动轮播/定时投放**：预设是「手动切换的素材库」，不是调度器；定时投放需数据模型（时间窗/优先级）与后台任务（列 backlog B5-3）。
- **预设的使用审计**：**已实现（backlog B6-3 关闭）**——条目记录 `appliedAt`/`appliedBy`（管理密钥指纹 `key:` + sha256 前 8 位，无身份体系时的稳定标识）/`appliedCount`，管理端预设行展示；启用因公告版本冲突被拒时不写审计。
- **多管理员并发编辑冲突**：**已实现（backlog B6-4 关闭）**——预设与公告均带 `rev`，携带旧 `rev` 写入返回 `409 已被其他管理端修改`（不覆盖内容），不带 `rev` 仍兼容（最后写入者生效）。

## 8. 追溯

> 实现追溯：代码/测试 `d69c771`（`feat(notice): 公告预设（最多 10 个，支持套用/启用）`）；增量一（backlog B6-1~B6-4：上限可配置、排序、导入导出、启用审计、乐观锁，见 ADR-014 修订一）与 B1-3/B5-1 同批提交；本批验收为 `npm test` **301 passed / 0 failed** 与 `npm run e2e` **78 passed / 0 failed**。
> 组件 ↔ 测试 ↔ ADR 追溯矩阵见 `docs/architecture/C3-component.md` §5；遗留项见 `docs/backlog.md` B6。
