# ADR-003: 浏览器端分片组装采用 File System Access API 优先、Blob 回退

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-001 §4.4 | 影响：`web/src/downloader.js`、`web/src/pages/Retrieve.jsx`、`web/src/api.js`

## Context

服务端分片就绪后，浏览器端要把 N 个分片拼成用户可保存的文件。浏览器的硬约束：

- 普通网页不能任意写用户磁盘路径；`fetch` 只有网络流，没有"写指定文件"的原生 API。
- 可选路径：① `File System Access API`（`showSaveFilePicker` + `createWritable`，Chromium 系，支持流式按序写盘）；② 全部 `ArrayBuffer` 收齐后 `Blob` + `URL.createObjectURL` + `<a download>`（全浏览器，但内存 = 文件大小）；③ Service Worker 拦截流式下载（StreamSaver 类方案，链路长、调试差）。
- 项目默认文件上限 100MB（`MAX_FILE_SIZE`），并发分片 4MB × 4 路。

## Decision

1. `web/src/downloader.js` 暴露 `parallelDownload({ code, password, onProgress })`：创建会话 → 按 `partSize` 切片、并发 4 路 fetch（每片重试 2 次、`AbortController` 取消）→ 组装。
2. **组装优先级**：
   - 若 `window.showSaveFilePicker` 可用：先弹保存对话框（`suggestedName = filename`），`createWritable` 后**按序流式写盘**——分片乱序返回时只在内存里暂存"尚未轮到写盘"的分片（窗口 ≤ 并发数），内存占用 O(并发 × 分片)。
   - 否则回退 Blob 方案：聚合所有分片 → `<a download>` 触发保存；进度在 fetch 阶段实时回调，组装阶段提示"正在合并"。
3. **进度与错误**：`onProgress({ loaded, total, percent, speed })` 聚合已完成分片字节；HTTP 错误携带 `err.status` 直传 UI（403 密码错 / 404 会话过期 / 429 限流）提示中文文案。
4. **阈值与回退**：`Retrieve.jsx` 对 `size > 1MB` 使用并行下载；小文件保持既有直链 `window.location.href`。服务端不可用时前端不降级（本项目的服务端一定支持该接口，降级只会掩盖故障）。
5. **取消**：组件卸载或用户取消 → `AbortController.abort()`，服务端会话由 `/api/download/end`（尽力而为）或 TTL 回收。

## Alternatives

- **纯 Blob 组装（不做 FS Access 分支）**：实现最简、全浏览器一致，但最大文件场景内存翻倍（100MB 文件 → 100MB ArrayBuffer + 100MB Blob 峰值），在低端设备上有 OOM 风险；且 Chrome 已是目标环境主流（文件驿站用户以桌面浏览器为主）。保留为回退而非唯一路径。否决（作为唯一方案）。
- **StreamSaver.js / Service Worker 流式下载**：能流式写盘且兼容 Firefox/Safari，但需注册 Service Worker、维护第三方交互、CSP 与 HTTPS 要求高，维护成本与本项目单页应用的复杂度不匹配。否决。
- **分片存 IndexedDB 再导出**：把浏览器当临时盘，增加配额/清理/导出复杂度，无收益。否决。
- **要求用户手动保存每个分片**：体验不可接受。否决。
- **服务端 ZIP 分片流**：把组装问题转成压缩包语义，但用户拿到的是 zip 而非原文件，且与压缩容器叠加表述混乱。否决。

## Consequences

- 正：Chromium 桌面端大文件下载内存 O(分片)，流式落盘；回退路径保证浏览器全覆盖。
- 负：两条组装路径都需要测试与文案（保存对话框被用户取消、无权限、非 Chromium 回退），前端复杂度上升；`showSaveFilePicker` 需要用户手势（点击"下载"按钮内同步发起，本设计满足）。
- 风险：用户取消保存对话框时，下载次数已消费（与服务端"会话创建即扣减"语义一致，属产品口径而非缺陷）；Safari/Firefox 大文件回退 Blob 的内存峰值依赖设备，列为已知限制（backlog B1-4 记录观察项）。

## 修订记录

- 2026-10-13 修订一（backlog B4-10/B4-4 落地，代码 `b6eebf8`）：组装路径从「FS Access / Blob」两态扩为**三态**：①用户句柄（手势期选定，现状保留）；②**OPFS 暂存 + 完成后导出**（新增首选回退，见 ADR-012 修订二）——Chromium 侧内存不再随文件大小增长；③内存 Blob（非 Chromium / 拿不到暂存锁 / 浏览器不支持 OPFS）。**非 Chromium 仍为 Blob 回退**（Safari/Firefox 无 OPFS 句柄的持久化语义）：大文件建议 Chromium 系浏览器，该项在 DEVELOPMENT §12 的上线清单里作为需人工确认项。用户取消「另存为」对话框依旧消费 1 次下载（与服务端「会话创建即扣减」语义一致，未改）。

## References

- RFC-001 §4.4、§5、§7；ADR-002（会话制接口）
- MDN：File System Access API / `showSaveFilePicker`；Chromium 支持矩阵（Chromium 86+）
