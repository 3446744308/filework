# ADR-017: 与同事版合并采用文件级移植，不做 git 历史合并

> Status: Accepted（2026-10-14 完成合并并验收） | Date: 2026-10-14 | Deciders: zwh | 关联 RFC: 无（工程过程决策） | 影响：`server/feedback.js`、`server/config.js`、`server/settings.js`、`server/index.js`、`server/rate-limit.js`、`web/src/App.jsx`、`web/src/api.js`、`web/src/components/AdminShell.jsx`、`web/src/pages/AdminSettings.jsx`、`web/src/pages/{About,Feedback,FeedbackQuery,AdminFeedback}.jsx`、`web/src/index.css`、`web/public/icons/*`、`LICENSE`、`docs/API.md`、`docs/openapi.json`

## Context

同一个「文件驿站」服务存在两份互不相干的实现，需要合成一份可交付的代码：

- **本仓库（`文件共享完美`）**：`805dc82` 等 46 个提交，压缩/自适应单元、分片上传与断点续传、跨文件去重、多公告与预设、统计导出清零、下载器 OPFS 续写，以及完整的 RFC/ADR/C4 文档；
- **同事版（`filework`，有 GitHub 远程）**：16 个提交，独有「关于」页、意见反馈（提交 / 凭反馈号查询 / 管理端处理）、ICP 与公安备案展示、手机端菜单（窄屏抽屉）优化、LICENSE 与 `docs/API.md` + `openapi.json`。

两者**没有共同祖先提交**（`git merge-base` 为空），共同文件几乎全部双向分歧（`scripts/test.js` 913↔4324 行、`web/src/pages/Admin.jsx` 208↔1140 行）。因此 `git merge --allow-unrelated-histories` 只会在每个共同文件上产生 add/add 冲突，人工逐个解决的成本高于直接移植，且会把两套历史缝在一起、掩盖真实来源。

## Decision

1. **以本仓库为主干、在独立目录 `filework-merged` 中合并**：`git` 历史与现有文档体系（RFC/ADR/C4）完整保留，工作树带上完整的 `.git`。
2. **对同事版只做「文件级移植」**：新增文件（反馈页/关于页/`server/feedback.js`/备案图标/LICENSE/API 文档）直接引入并按本仓库风格归一化（LF、无行内注释）；共同文件（`App.jsx`、`AdminShell.jsx`、`AdminSettings.jsx`、`api.js`、`settings.js`、`index.js`、`index.css`）以本仓库实现为准，只把同事版的功能点**重新实装**进去。
3. **冲突取舍口径**：
   - 传输/压缩/去重/公告/统计等本仓库更完整的实现一律保留，不回退（例：`.waybill-print` 的 `max-width: 920px` 与响应式覆盖保留，不采用同事版的 `100%`）。
   - 同事版的 `NoticeBar` 用法（无槽位）不采用——本仓库是双槽位（`slot="top"/"bottom"`），只把「其他」菜单、抽屉与页脚并入。
   - 反馈号查询失败使用**独立限流桶**（`missGuard(limit, windowMs, 'fbquery')` 的 `bucket` 参数），保留同事版「反馈失败不挤占取件失败次数」的行为，同时不改变既有调用点的默认桶名（`miss:`）。
4. **配套补齐**：`scripts/test.js` 新增 `[39]` 反馈与备案用例；`scripts/e2e-browser.js` 新增 `E2E-15`（关于页 / 反馈闭环 / 页脚备案图标 / 390px 抽屉菜单）；`docs/API.md` 与 `docs/openapi.json` 补齐分片上传、压缩任务、分片下载、公告预设与反馈的全部路径（openapi 与代码路由已交叉校验一致）。

## Consequences

- **正面**：主干能力不回退；新增功能有测试与浏览器验收（`npm test` 400 条、`npm run e2e` 106 条全绿）；文档与代码同源，追溯矩阵可继续维护。
- **代价**：同事版的 git 提交历史不进入本仓库（其仓库与远程保持原样），合并以一次提交呈现，历史以本 ADR 与提交信息说明来源。
- **遗留**：`E2E-14` 的会话配额卡片断言会在 stats 未落地时先看到空态行而误判，本次一并修成「等到真实出口行再断言」；该问题与合并无关，属既有竞态。
