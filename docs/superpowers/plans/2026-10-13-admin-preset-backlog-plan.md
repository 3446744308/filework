# 管理端与预设 backlog 待触发项 实现计划（2026-10-13，计划快照）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **性质说明**：本文件是 **计划快照，不是执行结果**。把 `docs/backlog.md` 的 B7-1~B7-3（预设满替换、预设分组、配额用量可见性）拆成可执行任务。本文件已于 2026-10-13 **全量执行**（提交号见上方 Status）。

**Goal:** 三个低优先级管理端缺口具备可直接执行的实现步骤与验收标准。

**Status:** ✅ **已全部执行**（2026-10-13）：Task 2（B7-2 预设分组）= `6147855`（`npm test` [33] 共 6 条，336 passed / 0 failed）；Task 1 + Task 3（B7-1 预设满替换 UI、B7-3 配额用量可见性）= `4eba6df`（`npm test` [34]，339 passed / 0 failed；`npm run e2e` E2E-14，91 passed / 0 failed）。

> **测试段号约定（三份计划共用）**：文中 `[30]`/`[31]` 与 `[E2E-12]` 表示**当前下一个空闲编号**（`scripts/test.js` 现最大为 `[29]`、`scripts/e2e-browser.js` 现最大为 `E2E-11`）。三份计划里的编号会互相撞号，**实现时一律以当时脚本的最大编号顺延 +1 为准**，不照抄本文件里的数字。

---

## 触发条件总览

| Task | backlog | 触发条件 |
|---|---|---|
| 1 | B7-1 | 出现「预设已满但只想换一个」的操作反馈 |
| 2 | B7-2 | 真实预设素材数量 >20（出现归类诉求） |
| 3 | B7-3 | NAT / 公司出口场景出现配额误伤 429 的反馈 |

---

## File Structure

- Task 1：Modify `web/src/pages/Admin.jsx`（预设保存 handler 约 L170~L190、预设卡片约 L618~L740）、`scripts/e2e-browser.js`
- Task 2：Modify `server/notice-presets.js`（`readStore` / `presetPayload` / `exportPresets` / `importPresets` / `createPreset`）、`web/src/pages/Admin.jsx`、`scripts/test.js`、`docs/DEVELOPMENT.md` §7
- Task 3：Modify `server/sessions.js`（`countDownloadSessions` L23 / `uploadTmpUsage` L33 同源）、`server/index.js`（`/api/admin/stats` L478~L508）、`web/src/pages/Admin.jsx`（仪表盘卡片约 L440~L510）、`scripts/test.js`、`docs/DEVELOPMENT.md` §7

---

### Task 1: 预设达上限时的「替换目标」选择（B7-1）

**触发条件**：出现「预设已满但只想换一个」的操作反馈。
**现状**：达上限时保存按钮禁用，只有服务端 409 的文案提示（ADR-014 Consequences 保留项）。
**Files:** Modify `web/src/pages/Admin.jsx`、`scripts/e2e-browser.js`

- [ ] **Step 1**: `Admin.jsx` 预设保存 handler（约 L170~L190）捕获 `PRESET_LIMIT`（409）后，不再只弹错误文案，而是打开一个 `Select` 弹窗列出当前预设（按 `order`），标题「预设已满，选择要替换的预设」
- [ ] **Step 2**: 确认后按「先 `DELETE /api/admin/notice/presets/:id`，再 `POST /api/admin/notice/presets`」两步走（**不新增接口**，`DELETE` 后腾出名额再建）；任一失败时提示并保留已删除项的信息，不留半成品
- [ ] **Step 3**: 达上限时保存按钮**保持可用**（改为触发弹窗），文案从「已达上限」改为「已达上限，保存将需要替换」
- [ ] **Step 4**: 补 E2E `scripts/e2e-browser.js` 段 `[E2E-12]`：站点设置把 `presetLimit` 调为 1 → 建第一个预设 → 再保存第二个 → 走替换弹窗 → 断言「总数仍为 1、列表中是第二个的名字、第一个的 `appliedAt` 审计消失（被删除）」
- [ ] **Step 5**: `npm run build` + `set -o pipefail; npm run e2e` → 提交 — `feat(admin): 预设达上限时可选择替换目标`

**验收标准**：替换后预设总数不超过上限；被替换项确实被删除（不是隐藏）；服务端零改动（`rev` 校验沿用）。

---

### Task 2: 预设分组（B7-2）

**触发条件**：真实预设素材 >20 个，出现归类诉求。
**Files:** Modify `server/notice-presets.js`、`web/src/pages/Admin.jsx`、`scripts/test.js`、`docs/DEVELOPMENT.md` §7

- [ ] **Step 1**: `notice-presets.js` 增 `group` 字段：`normalizeGroup(value)`（`String(...).slice(0, 20).trim()`，**空字符串 = 未分组**），接入 `readStore` 的逐项归一化、`presetPayload`、`createPreset`/`updatePreset`（旧数据无 `group` → 自动空组，**无需迁移**，沿用既有「读写共用归一化」约定）
- [ ] **Step 2**: `exportPresets` / `importPresets` 携带 `group`（保持 `format`/`version` 为 `file-share-notice-presets`/`1`；导入时缺 `group` → 空组，向后兼容旧导出文件）
- [ ] **Step 3**: `Admin.jsx` 预设卡片：列表按 `group`（空组排最后）再按 `order` 分组展示（`Collapse` 或小标题分段）；新建/编辑弹窗增「分组」输入（`Select` 支持自由输入已有分组名）
- [ ] **Step 4**: 明确并文档化：`order` 仍是**全局**排序（跨组唯一），分组仅影响展示聚合——避免与 `PUT /api/admin/notice/presets/order` 语义冲突
- [ ] **Step 5**: 补测试 `scripts/test.js` 段 `[30]`：①`group` 截断到 20 字符；②旧数据（无 `group`）读为空组；③导出含 `group` 且导入回来一致；④导入无 `group` 的旧格式文件不报错
- [ ] **Step 6**: `set -o pipefail; npm test` + `npm run build` → 提交 — `feat(notice): 预设支持分组`

**验收标准**：旧 `notice-presets.json` 与旧导出文件均能无损读入；`order` 排序行为不变。

---

### Task 3: 按 IP 的会话 / 临时空间用量可见性（B7-3）

**触发条件**：NAT / 公司出口场景出现配额误伤 429 的反馈。
**现状**：429 只在响应体提示（文案含具体上限值），管理端仪表盘没有「当前会话 / 临时空间用量」视图。
**Files:** Modify `server/sessions.js`、`server/index.js`、`web/src/pages/Admin.jsx`、`scripts/test.js`、`docs/DEVELOPMENT.md` §7

- [ ] **Step 1**: `sessions.js` 增 `usageByIp()`——复用现有 `countDownloadSessions(ip)`（L23）与 `uploadTmpUsage(ip)`（L33）的记账口径，聚合出各 IP 的 `{ uploadSessions, downloadSessions, tmpBytes }`（仅统计**未过期**会话，与配额判定同源，保证「显示即为拦截依据」）
- [ ] **Step 2**: `/api/admin/stats`（index.js L478~L508）增 `sessionQuota` 段：`{ maxUploadSessionsPerIp, maxDownloadSessionsPerIp, maxTmpBytesPerIp, topIps: [{ ip, uploadSessions, downloadSessions, tmpBytes }] }`（按 `tmpBytes` 或会话数降序，取前 N=10，避免响应体过大）
- [ ] **Step 3**: `Admin.jsx` 仪表盘增卡片「会话配额」：展示三个上限值 + 用量接近上限的出口列表（用量 ≥80% 标红），文案说明「同一出口（NAT）下多个用户共享配额；出现 429 时先看这里」
- [ ] **Step 4**: 隐私口径写进文档：IP 仅对已鉴权的管理端可见（与 `x-admin-key` 同权），不做匿名聚合
- [ ] **Step 5**: 补测试 `scripts/test.js` 段 `[31]`：隔离小配额服务器下创建若干上传/下载会话 → `/api/admin/stats` 的 `sessionQuota.topIps` 与 `countDownloadSessions`/`uploadTmpUsage` 一致；会话 `end`/过期后用量下降；上限字段等于 `config` 值
- [ ] **Step 6**: `set -o pipefail; npm test` + `npm run build` → 提交 — `feat(admin): 仪表盘展示按 IP 的会话与临时空间用量`

**验收标准**：仪表盘用量与实际拦截判据**同源**（不会出现「显示没超但被 429」）；无新增写盘、无额外后台定时器。

---

### 收尾 Task: 全量回归 + 文档（每个 Task 完成后各自执行）

- [ ] **Step 1**: `set -o pipefail; npm test`；改前端时另跑 `npm run build`；Task 1 另跑 `set -o pipefail; npm run e2e`
- [ ] **Step 2**: 文档收尾——`docs/backlog.md` B7 对应行闭环标记；`C3` §2/§5/§6；`DEVELOPMENT.md` §7（新字段 / 新接口响应段）
- [ ] **Step 3**: 提交 — `docs: 管理端 <改动> 追溯与契约同步`

---

## Self-Review

- **与既有机制共存**：Task 1 必须复用服务端既有 `PRESET_LIMIT`/`rev` 语义（不新增接口、不做客户端乐观删除）；Task 2 不得改变 `order` 的全局唯一语义（否则 `reorderPresets` 与导出顺序会错乱）；Task 3 的统计口径必须与 `transfer.js` 的配额判定走**同一函数**，否则会出现「仪表盘与 429 不一致」的二次误判。
- **回归**：Task 2 的旧数据/旧导出文件兼容必须有用例；Task 3 不得给 `/api/admin/stats` 引入显著耗时（纯内存聚合）。
- **可自动验证**：Task 1（E2E 断言列表与数量）、Task 2（test 归一化与往返）、Task 3（stats 与配额函数一致性）均可自动验证；不可自动验证的仅「运维是否真的因此少踩坑」，属观感。
