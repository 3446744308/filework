# 公告域 backlog 待触发项 实现计划（2026-10-13，计划快照）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **性质说明**：本文件是 **计划快照，不是执行结果**。把 `docs/backlog.md` 公告域未闭环项（B5-2 字号/圆角/透明度、B5-3 多公告与定时投放、B5-4 纵向行数上限）拆成可执行任务，写明触发条件、要动的 file/function、验收与预设提交消息。本文件已于 2026-10-13 **全量执行**（提交号见上方 Status）。

**Goal:** 公告域的样式类扩展（B5-2/B5-4）与结构性扩展（B5-3）准备好可执行步骤，避免触发时现场设计。

**Status:** ✅ **已全部执行**（2026-10-13）：Task 2（B5-3 多公告/定时投放）= `3c9bc12`（`npm test` [31] 共 17 条，325 passed / 0 failed；`npm run e2e` E2E-12 共 6 条，84 passed / 0 failed；ADR-016 → Accepted）；Task 1 + Task 3（B5-2 字号/圆角/透明度、B5-4 纵向行数上限）= `5181700`（`npm test` [32]，330 passed / 0 failed；`npm run e2e` E2E-13，87 passed / 0 failed）。执行偏差与本轮新增的验收口径以 `docs/backlog.md` B5-2/B5-3/B5-4 行与 DEVELOPMENT §8 为准。

> **测试段号约定（三份计划共用）**：文中 `[30]` 与 `[E2E-12]` 表示**当前下一个空闲编号**（`scripts/test.js` 现最大为 `[29]`、`scripts/e2e-browser.js` 现最大为 `E2E-11`）。三份计划里的编号会互相撞号，**实现时一律以当时脚本的最大编号顺延 +1 为准**，不照抄本文件里的数字。

---

## 触发条件总览

| Task | backlog | 触发条件 |
|---|---|---|
| 1 | B5-2 | 运营提出具体字号 / 圆角 / 透明度诉求 |
| 2 | B5-3 | 运营需要同时挂多条公告，或按时间窗自动上下线 |
| 3 | B5-4 | 运营希望「显示 2~3 行再滚动」 |

**排序建议**：2 与 1/3 **互斥优先级更高**——B5-3 会重写 `notice.js` 的单例模型，先做 2 的话 1/3 需在数组模型上实现（改动面更大）。若两者都可能做，**先 B5-3 再 B5-2/B5-4**。若只做样式，1 与 3 相互独立。

---

## File Structure

- Task 1：Modify `server/notice.js`（`normalizeNotice` / `DEFAULT_NOTICE`）、`web/src/pages/Admin.jsx`（noticeForm 约 L60~L115、样式控件约 L540~L590）、`web/src/components/NoticeBar.jsx`（`colors`/style）、`web/src/utils.js`（`noticeContentStyle` 约 L75）、`web/src/index.css`、`scripts/test.js`、`scripts/e2e-browser.js`
- Task 2：Modify `server/notice.js`（单例 → 数组）、`server/index.js`（`/api/notice` L166、`PUT /api/notice` L168~L175、admin 路由 L385~L452）、`web/src/components/NoticeBar.jsx`（上下槽取值）、`web/src/pages/Admin.jsx`、`scripts/test.js`、`scripts/e2e-browser.js`、`docs/rfc/RFC-007-*.md`、`docs/adr/ADR-016-*.md`
- Task 3：Modify `server/notice.js`、`web/src/components/NoticeBar.jsx`（`measure` 纵向分支约 L88~L110）、`web/src/index.css`（`.notice-bar-viewport-vertical` L386）、`web/src/pages/Admin.jsx`、`scripts/e2e-browser.js`

---

### Task 1: 公告字号 / 圆角 / 透明度（B5-2）

**触发条件**：运营提出具体字号 / 圆角 / 透明度诉求。
**Files:** Modify `server/notice.js`、`web/src/pages/Admin.jsx`、`web/src/components/NoticeBar.jsx`、`web/src/utils.js`、`web/src/index.css`、`scripts/test.js`、`scripts/e2e-browser.js`

- [ ] **Step 1**: `server/notice.js` 的 `normalizeNotice` 增三个字段（与 `bgColor`/`textColor` 同一套「非法/缺省 = 跟随默认」语义）：`fontSize`（整数 12–24，0/非法 = 默认）、`radius`（整数 0–16，0 = 默认）、`opacity`（整数 50–100，0/非法 = 默认 100）+ 同步 `DEFAULT_NOTICE`
- [ ] **Step 2**: 确认**预设自动携带**——`notice-presets.js` 的 `presetPayload` 走 `normalizeNotice` + `stripNotice`（只剥 `rev`/`updatedAt`），新字段无需改预设代码，但要补一条往返用例
- [ ] **Step 3**: `NoticeBar.jsx` 把三字段并入 Alert 的 `style`（`fontSize` → `fontSize` 与 `lineHeight`；`radius` → `borderRadius`；`opacity` → `opacity`），并让 `web/src/utils.js` 的公告弹窗内容块样式（约 L75）同源派生，保证弹窗与公告条一致
- [ ] **Step 4**: `Admin.jsx` 公告表单增三个控件（`InputNumber` 或 `Slider`，带「默认」态）+ 实时预览（预览已由 `NoticeBarView preview` 提供，无需新增）
- [ ] **Step 5**: 补测试：`scripts/test.js` 段 `[30]`——①边界值（12/24/0/16/50/100）与非法值（负数/小数/字符串/超上限）回落；②`/api/notice` 返回含三字段；③预设保存→读取往返三字段不丢；`scripts/e2e-browser.js` 扩展 `[E2E-9]` 断言计算样式（`getComputedStyle` 的 `font-size`/`border-radius`/`opacity`）
- [ ] **Step 6**: `set -o pipefail; npm test` + `npm run build` + `set -o pipefail; npm run e2e` → 提交 — `feat(notice): 新增字号/圆角/透明度样式字段`

**验收标准**：三字段独立生效且非法值静默回落；空值 = 与改动前**逐像素一致**（默认态不回归）；预设往返携带。

---

### Task 2: 多公告 + 定时投放（B5-3）

**触发条件**：需要同时挂多条公告，或按时间窗自动上下线。
**依据**：`docs/rfc/RFC-007-multi-notice-scheduling.md`（REQ-048~056）+ `docs/adr/ADR-016-multi-notice-arbitration.md`（Proposed）。本 Task 只做「把 RFC 拆成可执行步」。
**Files:** Modify `server/notice.js`、`server/index.js`、`web/src/components/NoticeBar.jsx`、`web/src/pages/Admin.jsx`、`server/config.js`、`.env.example`、`scripts/test.js`、`scripts/e2e-browser.js`、`docs/rfc/RFC-007-*.md`、`docs/adr/ADR-016-*.md`

- [ ] **Step 1**: `server/notice.js` 数据模型由单例改为 `data/notices.json` 单例数组：`{ version: 2, rev, notices: [{ id, enabled, title, content, display, position, scroll, scrollFill, bgColor, textColor, priority, startAt, endAt, rev, updatedAt }] }`，每项 `priority`（0~100 整数，默认 50，非整数按默认回落，见 RFC-007 §4.1）；上限 `MAX_NOTICES`（`config.js` 新 env，默认 20，超限 409）；`id === 'default'` 为保留项；`normalize` 读写共用（旧 `notice.json` 一次性迁移 + **写穿镜像** `notice.json` 作回滚退路）
- [ ] **Step 2**: 调度 = **请求时求值**（无后台定时器、无 SSE）：`getNotice()` 过滤 `startAt ≤ now < endAt`（**半开区间**）→ 按仲裁序 `priority` desc → `updatedAt` desc → `id` 升序排序 → **同槽位（top/bottom）只取一条**（不叠加，避免多个 `role="status"` 同时播报）
- [ ] **Step 3**: `GET /api/notice` **顶层形状不变**（老前端零改动），新增 `notices[]`（仅有效项、已排序；上下槽位各取第一条）；无有效公告 → 既有 `enabled:false` 形状（不报错）
- [ ] **Step 4**: admin 路由：单条 CRUD（列表 / 单项 GET+PUT+DELETE，带条目级 `rev` 乐观锁）+ 文件级 `rev`；`PUT /api/admin/notice` 保持兼容（写 `id='default'` 的那条）；超上限 409
- [ ] **Step 5**: `NoticeBar.jsx` 上下槽各自从 `notices[]` 取对应 `slot` 的第一条（`slotOf(position)` 逻辑复用），其余渲染不变
- [ ] **Step 6**: 补测试 `scripts/test.js` 段 `[30]`：①半开区间边界（`now === endAt` 不生效、`now === startAt` 生效）；②仲裁序（同 `priority` 比 `updatedAt`，再比 `id`）；③同槽位只下发一条；④无有效公告 → `enabled:false`；⑤条目级/文件级 `rev` 冲突 409；⑥旧 `notice.json` 迁移**幂等**（迁移两次结果一致）；⑦写穿镜像存在且可回滚
- [ ] **Step 7**: 补 E2E `scripts/e2e-browser.js` 段 `[E2E-12]`：挂两条不同槽位公告 → 两条同时渲染；把一条 `startAt` 设为未来 → 刷新后只剩一条
- [ ] **Step 8**: 文档：RFC-007 §8 回填、ADR-016 `Proposed` → `Accepted`、C3 §2/§5、DEVELOPMENT §5/§7、`knowledge.md` 撤下「未实现」标注
- [ ] **Step 9**: `set -o pipefail; npm test` + `npm run build` + `set -o pipefail; npm run e2e` → 提交 — `feat(notice): 支持多公告与按时间窗投放（请求时求值）`

**验收标准**：老前端（只读顶层字段）零改动可用；时间窗内外的上下线无需重启进程即可生效；同槽位永不出现两条。

---

### Task 3: 纵向模式行数上限（B5-4）

**触发条件**：运营希望「显示 2~3 行再滚动」。
**Files:** Modify `server/notice.js`、`web/src/components/NoticeBar.jsx`、`web/src/index.css`、`web/src/pages/Admin.jsx`、`scripts/e2e-browser.js`

- [ ] **Step 1**: `server/notice.js` 增 `maxLines`（白名单 1/2/3，默认 1，非法回落 1）+ `DEFAULT_NOTICE`
- [ ] **Step 2**: `NoticeBar.jsx` 纵向视口高度由固定 24px 改为随 `maxLines` 内联设置（`maxHeight = maxLines × 行高`，行高常量与 `.notice-bar-viewport-vertical` 的 `line-height` 对齐）；`measure` 的 `extra = item.scrollHeight - view.clientHeight` **口径不变**，仅 `clientHeight` 随行数变化
- [ ] **Step 3**: 预览文案随 `maxLines` 变化（当前固定「纵向需 ≥2 行内容才会滚动」→ 改为「纵向需超过 N 行内容才会滚动」），`web/src/index.css` 的 `.notice-bar-viewport-vertical`（L386）注释性说明改为由内联样式驱动
- [ ] **Step 4**: `Admin.jsx` 公告表单增「显示行数」选择（1/2/3）+ 实时预览（`NoticeBarView preview` 已能回报 `scrolling/reason`）
- [ ] **Step 5**: 补测试 `scripts/e2e-browser.js` 扩展 `[E2E-9]`：`maxLines=2` 且内容恰 2 行 → `scrolling:false`（reason 含行数）；3 行 → `scrolling:true`；另补 `scripts/test.js` 归一化用例（非法 `maxLines` 回落 1）
- [ ] **Step 6**: `set -o pipefail; npm test` + `npm run build` + `set -o pipefail; npm run e2e` → 提交 — `feat(notice): 纵向支持 1~3 行显示上限`

**验收标准**：`maxLines=1` 与改动前行为一致（不回归）；行数变化时滚动判定按新视口高度正确收敛。

---

### 收尾 Task: 全量回归 + 文档（每个 Task 完成后各自执行）

- [ ] **Step 1**: `set -o pipefail; npm test` / `npm run build` / `set -o pipefail; npm run e2e`（按改动面选择）
- [ ] **Step 2**: 文档收尾——`docs/backlog.md` 对应行闭环标记；`C3` §2.2/§2.3/§5/§6；`DEVELOPMENT.md` §4（新 env）/§5/§7；`knowledge.md` 同步语义
- [ ] **Step 3**: 提交 — `docs: 公告域 <改动> 追溯与契约同步`

---

## Self-Review

- **与既有机制共存**：三个 Task 都改 `normalizeNotice`，**必须保持「旧文件缺字段自动补齐、非法值自动回落、无需迁移脚本」**这一既有约定（B5-3 的数组模型是唯一例外，需一次性迁移 + 写穿镜像）；`display/position/scroll/scrollFill` 白名单不得弱化。
- **回归**：样式字段默认态（空值）必须与改动前逐像素一致；B5-3 必须保证 `/api/notice` 顶层形状不变，否则会打断已上线的 `NoticeBar` 与 localStorage「已关闭」记录（键含 `updatedAt`）。
- **预设联动**：B5-2/B5-4 的新字段经 `normalizeNotice` 自动进入预设快照；B5-3 数组模型下预设「启用」的目标按 **RFC-007 REQ-054** 执行——接口需带目标公告 `id`，缺省落到 `id === 'default'` 的那条（不要在本计划另立语义，避免与 RFC 并存矛盾）。
- **可自动验证**：计算样式（E2E-9）、接口形状与仲裁（test）；不可自动验证的仅「运营观感」，需人工预览确认。
