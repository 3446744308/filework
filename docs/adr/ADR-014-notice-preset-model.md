# ADR-014: 公告预设模型（服务端单例 JSON + 上限拒绝 + 套用/启用分离）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-005 §4 | 影响：`server/notice-presets.js`、`server/notice.js`、`server/index.js`、`web/src/api.js`、`web/src/pages/Admin.jsx`、`web/src/index.css`

## Context

RFC-004 把公告做成可配样式的运营位后，另一个现实问题浮现：公告内容形态是**少数几种反复使用**的（维护通知、活动公告、免责声明），但每次切换都要重填十几个字段（标题、内容、显示方式、位置、滚动、两个颜色）。需要一层「配置快照」能力，于是要定几个口径：

- 快照存浏览器还是服务端？
- 快照里存什么（整条公告？仅样式？）
- 数量有没有上限，超限怎么办？
- 「用某个预设」是填表单还是直接上线？
- 预设与当前公告如何避免语义混淆（例如关闭状态的时间戳）？

## Decision

1. **存服务端单例 JSON**（`data/notice-presets.json`）：管理端本来就要密钥登录，预设属于站点配置而非个人偏好——放服务端可跨浏览器/多管理员共享，也随 `data/` 一起备份；localStorage 换台机器就没了。数据层仍沿用「单例 JSON + 原子写（临时文件 + rename）」，不引入数据库（与 `notice.json`/`settings.json`/`stats.json` 一致）。
2. **预设 = 一条完整公告快照**（与 `notice.json` 同构，仅少 `updatedAt`）：启用即 `saveNotice(预设.notice)`，不需要任何字段映射或合并规则；也因此预设能表达「换标题+换配色+换位置」这类整体切换。
3. **不落 `updatedAt`**：公告的 `updatedAt` 还是「访客已关闭记录」的版本键（`notice-bar-closed-<updatedAt>`）。若沿用预设里的旧时间戳，启用后访客可能仍被判定为「已关闭」而看不到公告；统一在启用时盖新时间。
4. **上限 10，超限拒绝**：`MAX_PRESETS = 10`，第 11 个新增返回 `409` 且**既有预设一个不丢**。自动淘汰最旧的会在运营不知情时删掉素材，静默数据丢失比多一次点击更糟。
5. **套用与启用分离**：「套用」是纯前端动作（把预设塞回表单 state），不触碰 `notice.json`，允许「套用 → 微调 → 保存公告」；「启用」是接口动作（`POST .../apply`），一步上线。两者共用同一个 normalize 口径，避免出现「套用后保存」与「直接启用」结果不一致。
6. **复用公告归一化**：`notice.js` 导出 `normalizeNotice()`，预设校验直接调用它（位置/滚动白名单、十六进制颜色、空内容强制 `enabled=false`）；读盘时也归一化，手工改坏的字段不会进入 UI。名称单独校验：`≤50` 字符，留空回退「公告标题 → `预设 N`」。
7. **id 用随机 hex**：`crypto.randomBytes(8).hex`，不做自增编号——避免「删掉 2 号后 3 号变 2 号」造成的引用歧义，也不给枚举留口子。
8. **路由留在 `index.js`**：数据逻辑放 `notice-presets.js`（不依赖 express），五个接口写在 `server/index.js` 并复用其中的 `adminAuth`/`fail`。刻意不在模块里自己实现鉴权，避免出现第二套密钥比较实现（`transfer.js` 的 `fail` 是纯错误格式化，性质不同）。

## Alternatives

- **浏览器 localStorage 存预设**：零后端改动，但换浏览器/换管理员就看不到同一套素材，且「服务端明明有公告却只有本机有预设」会让协作排查变复杂。否决。
- **预设只存样式（配色/位置/滚动），内容仍手填**：最常见诉求恰恰是「把上周那条维护公告原样换回来」，只存样式解决不了。否决。
- **自动淘汰最旧 / 循环覆盖**：上限达到后静默丢弃历史素材，运营在没有反馈的情况下失去配置。否决（改为显式 409 + 删除后再存）。
- **把预设塞进 `notice.json`（`{ current, presets }` 一个文件）**：每次切换都要重写两个语义不同的对象，且公告读取路径（公开、每次页面加载）会被无关的预设数据拖累，还可能因预设损坏影响公告读取。否决（独立文件，互不牵连）。
- **无上限**：单例 JSON 会随运营随手保存无限膨胀，且管理端列表没有分页/搜索。否决（上限 10，够覆盖「几种常用公告」的真实场景）。
- **启用时保留原 `updatedAt`（认为「内容没变就不该打扰访客」）**：会与「已关闭记录」语义冲突（见决策 3），且无法表达「重新展示」——而重新保存公告让所有人重新看到，正是运营期望的行为。否决。

## Consequences

- 正：切换公告从「重填十余个字段」变成一次点击；预设可精确复现（含配色/位置/滚动），不会出现「记得配了颜色但记不清是哪个」。
- 正：预设与当前公告**物理隔离**（两个文件），任一文件损坏都不会影响另一个；公开的 `/api/notice` 仍只读一个小对象。
- 正：上限与归一化都在服务端强制，前端被绕过（手写请求）也不会写出脏数据。
- 负（**修订一已闭环**）：上限 10 硬编码 → 改为站点设置 `presetLimit`（默认 10，钳制到 env `MAX_NOTICE_PRESETS` 硬上限，默认 50；调低不删除已有预设，只拦新增）。仍保留的缺口：「预设满 → 必须删除」没有「替换哪一个」的选择 UI。
- 负（**修订一已闭环**）：无排序 / 无导入导出 → 新增 `order` 与 `PUT /api/admin/notice/presets/order`（↑/↓ 按钮驱动），以及 `GET .../export` / `POST .../import`（带 `format` + `version` 的文件格式、重名加序号、容量上限与 `skipped` 回报）。
- 负（**修订一已闭环**）：无审计 → 条目新增 `appliedAt` / `appliedBy` / `appliedCount`，管理端预设行展示「上次启用 时间 · key:指纹 · 共 N 次」；因无管理员身份体系，`appliedBy` 取**管理密钥指纹**（`key:` + sha256 前 8 位，换密钥即换标识、不可反推密钥，且仅对已鉴权管理端可见）。
- 负（**修订一已闭环**）：并发保存无乐观锁 → 预设与公告均加 `rev`：携带旧 `rev` 写入返回 `409`（预设「已被其他管理端修改」/公告「已被其他管理端修改」），被拒时不覆盖内容、预设侧也不写审计；不带 `rev` 仍兼容（最后写入者生效）。

## 修订记录

- 2026-10-12 修订一（backlog B6-1~B6-4 关闭）：预设从「纯 CRUD」扩为**可运维素材库**——`notice-presets.js` 重写：上限取 `effectivePresetLimit()`（`settings.presetLimit`，`0` 回退默认 10，钳制到 `MAX_NOTICE_PRESETS`）；条目新增 `order`（读盘按 `order` 升序，`reorderPresets` 重写为连续 1..n，未列出的保持相对顺序排尾）、`rev`（写入校验 → 409，成功后 +1）、`appliedAt`/`appliedBy`/`appliedCount`（启用审计，公告写失败则不写审计）；新增 `reorderPresets`/`exportPresets`/`importPresets`（`mode: merge|replace`，校验 `format`/`version`/数组/条目对象/≤200 条，重名加 `（2）（3）`，超容量计 `skipped`）。同时 `notice.js` 加公告侧 `rev` + `NOTICE_CONFLICT`，`settings.js` 加 `presetLimit`/`effectivePresetLimit()`，`config.js` 加 `MAX_NOTICE_PRESETS`，`index.js` 加排序/导出/导入三个接口并把冲突映射 409，前端加排序、导出/导入、审计展示与 409 自动刷新，设置页加「公告预设上限」。验证：`scripts/test.js` [29]（17 条：上限可配置与钳制、调低不删、审计落盘、公告/预设乐观锁、导出格式与附件头、排序、合并重名、容量跳过、替换、导入校验）、`scripts/e2e-browser.js` E2E-11（真实浏览器：排序点击落库、审计行、导出真实下载 JSON、站点设置改上限即时生效与预设接口同步）。

## References

- RFC-005 §4/§6；RFC-004 / ADR-013（公告字段、白名单、归一化与「空值即默认主题」口径）
- `docs/DEVELOPMENT.md` §5（`data/notice-presets.json` 字段）、§7（五个管理端接口）、§8（管理端预设区）
- `scripts/test.js` [27]（CRUD/上限/归一化/启用语义）、[29]（上限可配置/审计/乐观锁/导入导出与排序）、`scripts/e2e-browser.js` E2E-10（真实浏览器：保存→套用→启用→删除）、E2E-11（排序/审计/导出/上限）
- `docs/DEVELOPMENT.md` §4（`MAX_NOTICE_PRESETS`）、§5（预设文件结构）、§7（八个预设接口与 409 语义）
