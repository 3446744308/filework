# 文件匿名共享 · 统一开发文档

> 本文档是项目的**唯一开发规范来源**。所有开发、评审、部署行为均以此为准。

---

## 1. 项目概述

一个类"快递驿站"的文件匿名共享服务：

- **寄件（上传）**：上传者上传一个文件，系统生成 **6 位纯数字取件码**，同时给出分享链接。
- **取件（下载）**：取件人**无需注册登录**，只需输入取件码即可下载。
- **销毁**：分享在 `有效期` 或 `下载次数` **任一**先耗尽时自动销毁（文件与元数据一并删除）。
- **管理**：提供一个简单管理页，凭管理员密钥查看/删除所有有效分享。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Node.js ≥ 18 + Express 4 + Multer 2 | ESM 模块（`"type": "module"`） |
| 前端 | Vite 6 + React 18 + Ant Design 5 | 构建产物 `web/dist` 由后端静态托管 |
| 路由 | react-router-dom 7 | 前端页面路由 |
| 存储 | 本地文件系统 `data/` | 每个分享一个元数据 JSON + 一个文件体 |
| 压缩 | Node.js 内置 zlib | **自适应单元容器**：内容定界切分（Gear-hash CDC）+ 单元级去重 + raw/gzip/brotli 逐单元择优，无收益则回退原文件，`server/compress.js` + `server/units.js` + `server/codec.js` |
| 传输压缩 | HTTP `Content-Encoding` 协商 | 分片按客户端 `Accept-Encoding` 直发存储态编码（0 拷贝、浏览器网络层自动解压）；不支持时服务端解压后发原始字节 |
| 分片传输 | 应用层会话协议 | 上传 `init/part/complete`（固定分片）、下载 `session/part/end`（分片由服务端自适应计划下发），`server/transfer.js` + `server/sessions.js` |
| 二维码 | qrcode-generator 2.0 | 前端生成取件二维码（库自身无运行时依赖） |
| 依赖管理 | npm | 单 `package.json`，前后端依赖统一安装 |

## 3. 目录结构

```
文件共享/
├── package.json              # 唯一的包清单，所有命令入口
├── vite.config.js            # root=web，产物输出 web/dist，dev 代理 /api
├── .env.example              # 环境变量样例（复制为 .env 使用）
├── .gitignore
├── README.md                 # 面向使用者的快速上手
├── docs/
│   └── DEVELOPMENT.md        # 本文件：开发统一规范
├── server/                   # 后端（全部 ESM）
│   ├── index.js              # Express 入口：API + 静态托管 + SPA 回退
│   ├── config.js             # 读取 .env/环境变量，输出不可变配置对象
│   ├── store.js              # 存储层：取件码生成、读写、消费、删除（含会话保护）
│   ├── compress.js           # 单元容器：打包/读取/流式输出（内嵌 units-v2 与清单化 units-v3 双读），旧容器（gzip-blocks）只读兼容
│   ├── compress-job.js       # 压缩后台任务：CAS 清单优先 → 内嵌容器回退，边车→改名→回写元数据
│   ├── jobs.js               # 内存任务表 + 并发 1 的串行队列（enqueue/getJob/getJobByKey/queueStats）
│   ├── objects.js            # 内容寻址对象存储（跨文件去重）：原子写入、引用派生（扫描清单）、标记-清扫 GC
│   ├── units.js              # 自适应单元计划 + 内容定界切分（Gear-hash CDC）+ 去重哈希（含清单化覆盖校验）
│   ├── codec.js              # 逐单元多编解码择优（raw/gzip/brotli）+ Accept-Encoding 协商
│   ├── sessions.js           # 会话注册表：下载 token 内存态；上传会话位图落盘（tmp/<id>.json + <id>.bin），启动恢复，零依赖
│   ├── transfer.js           # 分片并行接口：upload init/part/complete、download session/part/end
│   ├── cleanup.js            # 定时清理过期/耗尽的分享
│   ├── notice.js             # 公告数组读写 + 仲裁（data/notices.json，含 notice.json 写穿镜像）
│   ├── notice-presets.js     # 公告预设读写（data/notice-presets.json，数量上限可配置，默认 10）
│   ├── stats.js              # 累计计数器（data/stats.json）
│   ├── settings.js           # 站点设置（data/settings.json + logo 文件读写删除）
│   ├── feedback.js           # 意见反馈（data/feedback/<id>.json + feedback-templates.json）：反馈号生成/查询/状态与回复
│   └── rate-limit.js         # 内存限流（防暴力破解、防滥用；missGuard 可按业务分桶）
├── web/                      # 前端源码
│   ├── index.html
│   └── src/
│       ├── main.jsx          # React 挂载入口
│       ├── App.jsx           # 路由 + 布局（/admin 路由不渲染公共菜单栏；header 显示 logo/站点名）
│       ├── api.js            # 所有 HTTP 请求统一封装（含分片上传 uploadChunked 与会话接口）
│       ├── downloader.js     # 会话制并行下载（按服务端自适应单元取片、并发 2~8 自适应、FS Access 流式写盘 / Blob 回退）
│       ├── utils.js          # 格式化时间/大小等纯函数
│       ├── hooks/
│       │   ├── useAdminAuth.js   # 管理端鉴权：模块级单例状态（订阅通知）；login 先调 /api/admin/ping 服务端验证，401 不放行；logout 全局可调
│       │   └── useSettings.js    # 站点设置缓存：模块级单例 + 订阅；refreshSettings() 通知全站刷新
│       ├── components/
│       │   ├── AdminShell.jsx    # 管理端外壳：左侧边栏（仪表盘/文件管理/设置/反馈管理菜单）+ 登录守卫
│       │   ├── AdminLogin.jsx    # 双栏登录页（左产品介绍 / 右密钥表单）
│       │   ├── NoticeBar.jsx     # 公告条（display=bar/both 时显示，关闭记录 updatedAt 版本；按 position 分顶部/底部槽位，支持四种位置、五种滚动与自定义配色）
│       │   └── WaybillReceipt.jsx # 发件快递面单回执（displayMode=waybill 时渲染；面单号/条码/寄收信息/打印与发送）
│       └── pages/
│           ├── Upload.jsx        # 上传页（首页）+ 公告弹窗
│           ├── Retrieve.jsx      # 取件页 /d/:code
│           ├── About.jsx         # 关于页 /about（服务说明、使用步骤、开源地址）
│           ├── Feedback.jsx      # 意见反馈 /feedback（提交后弹反馈号）
│           ├── FeedbackQuery.jsx # 查询反馈 /feedback-query（凭反馈号看进度与回复）
│           ├── Admin.jsx         # 仪表盘 + 公告设置 /admin
│           ├── AdminFiles.jsx    # 文件管理 /admin/files
│           ├── AdminSettings.jsx # 站点设置（名称/备案号/Logo/大小上限/黑名单/显示模式）/admin/settings
│           └── AdminFeedback.jsx # 反馈管理 /admin/feedback（状态/回复/模板/删除）
├── scripts/
│   ├── dev.js                # 并行启动后端 + Vite（零依赖实现）
│   ├── test.js               # 端到端自动化测试（自启/自停服务器）
│   └── e2e-browser.js        # 真实浏览器 E2E（CDP，自启服务器 + headless Chrome，验证自动解压与提速）
└── data/                     # 运行时数据（.gitignore，勿提交）
    ├── meta/<code>.json      # 元数据
    ├── files/<code>          # 文件体（无扩展名）
    ├── notices.json          # 公告数组（真相源，≤ MAX_NOTICES，默认 20；含 priority/startAt/endAt）
    ├── notice.json           # 公告写穿镜像（只写不读，供旧构建回滚）
    ├── notice-presets.json   # 公告预设（单例，数量 ≤ 站点设置上限，默认 10；含 order/rev/启用审计）
    ├── stats.json            # 累计计数器（单例）
    ├── settings.json         # 站点设置（单例，含 beian/gongan 备案号）
    ├── feedback/<id>.json    # 意见反馈条目（每单一个文件，含 code/type/content/status/reply）
    ├── feedback-templates.json # 管理端回复模板（单例，≤20 条）
    ├── logo.<ext>            # 站点 logo 图片（可选）
    └── tmp/                  # 上传中转目录（分片上传 <uploadId>.bin + 位图 <uploadId>.json）；启动时恢复未过期会话并清理孤儿，过期会话 30 分钟清理
```

## 4. 环境变量（`server/config.js` 统一读取）

复制 `.env.example` 为 `.env` 后修改。环境变量优先于 `.env` 文件。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_KEY` | 随机生成并打印到控制台 | 管理页密钥，**生产环境必须显式设置** |
| `DATA_DIR` | `<项目根>/data` | 数据目录 |
| `MAX_FILE_SIZE` | `104857600`（100MB） | 单文件大小上限（字节） |
| `DEFAULT_EXPIRE_HOURS` | `24` | 默认有效期（小时） |
| `DEFAULT_MAX_DOWNLOADS` | `5` | 默认最大下载次数 |
| `RATE_LIMIT_MISSES` | `10` | 每 IP 每分钟允许的取件失败次数 |
| `UPLOAD_LIMIT_PER_MINUTE` | `10` | 每 IP 每分钟允许的上传次数（按上传会话计一次） |
| `TRANSFER_PART_SIZE` | `4194304`（4MB） | 上传分片大小（同时是分片体的 body 上限）；下载「任意范围」请求（`start/end`）的单片上限（测试用 262144 覆盖多分片）。**仅当按该值会超出 1024 片上限时**，`/api/upload/init` 会把本次会话的 `partSize` 向上翻倍到使片数 ≤1024（默认配置下永不触发）；后续分片体上限与 `upload/status` 均按该会话实际 `partSize` |
| `UNIT_TARGET_COUNT` | `32` | 目标分片数：文件被切成约这么多单元（并发 4~8 时兼顾负载均衡与请求开销） |
| `UNIT_MIN_SIZE` | `262144`（256KB） | 单个单元最小字节数（同时是 CDC 的 min 下限来源） |
| `UNIT_MAX_SIZE` | `8388608`（8MB） | 单个单元最大字节数（CDC 的 max 上限来源） |
| `UNIT_MAX_COUNT` | `256` | 单文件最大单元数；超出时自动放大单元尺寸（并回退均匀切分） |
| `COMPRESS_CODECS` | `br,gzip` | 存储态编解码候选（按序尝试取最小）；设为 `gzip` 可省掉一半压缩 CPU。**同时是管理端「压缩编码候选」的硬上限**：此处为 `gzip` 时管理端无法开启 Brotli |
| `MAX_UPLOAD_SESSIONS_PER_IP` | `8` | 每 IP 允许的在途上传会话数；超出时 `POST /api/upload/init`（新建会话）返回 429，**带 `uploadId` 的续传复用既有会话、不受配额限制** |
| `MAX_DOWNLOAD_SESSIONS_PER_IP` | `32` | 每 IP 允许的在途下载会话数；超出时 `POST /api/download/session` 返回 429（**在消费次数之前拦截**，被拒的请求不消耗取件次数） |
| `MAX_TMP_BYTES_PER_IP` | `536870912`（512MB） | 每 IP 待处理上传的「声明总大小」上限（字节），超出 429；未过期会话才计入，完成/过期即时释放 |
| `MAX_NOTICE_PRESETS` | `50` | 公告预设数量的硬上限，同时是「站点设置 → 公告预设上限」的可调上界（站点设置默认生效值 10，传 `0` 即回到默认） |
| `MAX_NOTICES` | `20` | 公告条数上限（多公告数组 `data/notices.json`）；新增超出返回 `409`，读盘时也截断到该值 |
| `STATS_WAL` | `off` | 传输记账追加日志：`on` 时每次记账先追加 `data/transfer-stats.wal`，启动按刷盘偏移（`stats.json.walOffset`）重放，`SIGKILL` 也不丢；默认 `off` 保留「最多丢一个刷盘窗口（≤2s 或 ≤31 片）」的既定取舍（ADR-009 决策 5 / backlog B4-8）。代价 = 每片多一次追加写 |
| `CROSS_FILE_DEDUP` | `off` | 跨文件去重（内容寻址对象存储）：`on` 时新上传写**清单化容器** `units-v3`（载荷入 `data/objects/<hh>/<hash>`，meta 只留清单，源文件在清单落定后删除）；关闭时行为与既有内嵌容器**完全一致**（对象目录保持为空）（RFC-006 / ADR-015 / backlog B4-2） |
| `DEDUP_GC_GRACE_MS` | `3600000`（1h） | 无引用对象的回收宽限期（毫秒）：保护「对象已写、清单未落盘」的崩溃窗口与「清单已删、响应流在途」的下载窗口 |
| `DEDUP_GC_INTERVAL_MS` | `21600000`（6h） | 对象回收（标记-清扫）周期（毫秒）；启动时另执行一次，**不在请求路径上**遍历对象目录 |

> **规则**：新增配置项必须同时更新 `.env.example` 与本表。

## 5. 数据模型

`data/meta/<code>.json`：

```json
{
  "code": "832451",
  "filename": "报告.pdf",
  "size": 1048576,
  "mime": "application/pdf",
  "note": "选填备注",
  "password": "",
  "createdAt": 1760000000000,
  "expiresAt": 1760086400000,
  "maxDownloads": 5,
  "downloads": 1
}
```

- 时间统一为 **Unix 毫秒时间戳**（number）。
- `password` 为取件密码的 **SHA-256 十六进制**（空字符串 = 无密码）；明文永不落盘，校验在 `verifyPassword` 内以常量时间比较哈希（ADR-012）。
- `downloads` 表示已成功取件次数；剩余次数 = `maxDownloads - downloads`；下载会话创建即 +1（见 §6 第 7 条）。
- 压缩字段：`compression`（`''` / `'units-v2'`（内嵌容器）/ `'units-v3'`（跨文件去重清单，仅 `CROSS_FILE_DEDUP=on` 时新写）；旧数据为历史值 `'gzip-blocks'`，只读兼容）、`storedSize`（磁盘实际占用，未压缩时 = size，恒有值）、`units`（仅压缩时存在，按原始顺序排列的单元表）、`dedup`（命中单元级去重的单元数）、`storageVersion`（`2` = 清单化容器）、`crossHits`（打包时命中既有对象的单元数）。
- 单元结构：内嵌容器 `{ o, c, r, z, d? }`：`o` = 容器内偏移（字节）、`c` = 存储字节数、`r` = 原始字节数、`z` = 存储态编码（`r` 原始 / `g` gzip / `b` brotli）、`d` = 去重时指向的源单元下标（存在时 `o/c/r/z` 与源单元一致）。约束：`Σr === size`、`o + c ≤ storedSize`、单元按原始顺序无缝覆盖。旧容器 `blocks` 中 `z` 为 `0/1`，读取时归一化为 `r/g`。
- 清单化容器（`units-v3`）单元结构 `{ h, c, r, z }`：`h` = 载荷 sha256 **全量 64 位十六进制**（对象名，不用 `o`，碰撞后果是「甲的字节被乙替换」，不可截断）、`c` / `r` / `z` 含义同上。约束：`Σr === size`、每个 `h` 对应的对象存在且长度 === `c`（缺失或不符 → `500 文件损坏`）。对象路径 `data/objects/<h 前 2 位>/<h 后 62 位>`，写入为 tmp + rename，已存在则跳过（命中即不占盘）。
- 压缩字段的**形态真源是 `compressionState`**：`'pending'` = 后台压缩任务进行中（此时文件仍是未压缩原文件，`storedSize = size`、无 `units`），`''` = 已落定。下载计划在 `pending` 窗口内先等落定再下发（`waitForSettledBody`，超时 `503 文件正在处理`），因为分片索引与单元表在会话建立时就固定了。
- `data/meta/<code>.packmeta`（压缩边车，临时）：后台压缩在改名/回写前先落盘 `{ format, storedSize, units, dedup }`，进程被杀后启动 `repairPendingCompressions()` 用它把元数据补齐；文件大小与声明一致（改名未发生）则丢弃边车回退为未压缩。后缀刻意不是 `.json`，不会被 meta 目录扫描器当成分享。
- 跨文件去重的回收：`removeShare` 只删清单与（内嵌）源文件，**不碰对象**；对象由标记-清扫回收（扫描全部清单得被引用集合，删除「无引用且 mtime 早于 `DEDUP_GC_GRACE_MS`」的对象），时机 = 启动 + `DEDUP_GC_INTERVAL_MS` 周期，实现见 `server/objects.js`。
- 文件体存于 `data/files/<code>`，**不暴露真实路径**给客户端。

`data/notices.json`（公告，单例数组，条数 ≤ `MAX_NOTICES` 默认 20）——RFC-007 后的**唯一真源**：

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
      "title": "维护通知",
  "content": "本周日凌晨 2 点服务维护……",
  "display": "both",
  "position": "fixed-bottom",
  "scroll": "up",
      "bgColor": "#112233",
      "textColor": "#ffee00",
      "rev": 3,
      "updatedAt": 1760000000000
    }
  ]
}
```

- `id`：`default` 为保留 id（承载旧语义，也是「启用预设」未指明目标时的默认落点）；其余为 `crypto.randomBytes(8).toString('hex')`，重复 id 只保留首个。
- `priority`：`0~100` 整数（默认 `50`，越大越优先，非法回退默认）；**仲裁序** = `priority` desc → `updatedAt` desc → `id` 升序。
- `startAt`/`endAt`：`null`（不限）或正整数 epoch ms；判定 `startAt ≤ now < endAt`（**半开区间**）；`endAt ≤ startAt` 时归一化把 `endAt` 置 `null`。**调度 = 请求时求值**（每次 `GET /api/notice` 现场过滤，无后台定时器、无 SSE、无需重启）。
- 两个 `rev`：**文件级** `rev`（每次写 +1，用于 `PUT /api/notice` 的 `expectedRev`）与**条目级** `rev`（该项每次写 +1，用于 `PUT /api/admin/notices/:id`）；顶层返回的 `rev` 恒为文件级。
- **写穿镜像** `data/notice.json`：每次写 `notices.json` 后把「当前胜者或关闭态」以旧单条形状写入该文件（**只写不读**），供旧构建回滚后可读；迁移只在 `notices.json` 不存在时用旧文件构造单元素数组（旧文件保留不删）。
- 读盘容错：解析失败或非数组 → 空集合（**不回退旧文件**）；逐项过滤 + 归一化 + 截断到 `MAX_NOTICES`。
- `title` ≤ 100 字符（可为空，前端默认显示「公告」），`content` ≤ 2000 字符。
- `content` 为空时保存会强制 `enabled=false`（空公告不弹窗）。
- `display` 显示方式白名单：`modal`（弹窗，默认）/ `bar`（公告条）/ `both`（两者），非法值回退 `modal`。
- `position` 公告条位置白名单：`top`（流内顶部，默认）/ `bottom`（流内底部）/ `fixed-top`（悬浮顶部）/ `fixed-bottom`（悬浮底部），非法值回退 `top`；仅对公告条生效。
- `scroll` 滚动方式白名单：`none`（静态单行省略）/ `left`（右→左，默认）/ `right`（左→右）/ `up`（纵向向上）/ `bounce`（纵向往返），非法值回退 `left`。
- `scrollFill`（布尔，默认 `false`）**仅对横向 `left`/`right` 生效**：`false` = 只有内容超出可视宽度才滚（装得下就静态）；`true` = 一律滚动（装得下时自动重复填满整条）。纵向模式无论该值都需内容 ≥2 行才滚，否则静态（ADR-013 决策 7）。
- `bgColor` / `textColor` 为十六进制颜色（`#RGB`/`#RRGGBB`，三位补全为六位、统一小写）；**空字符串 = 跟随默认主题**。配色**同时作用于公告条与公告弹窗内容块**（ADR-013）。
- `fontSize`（12~24，取整；`0`/非法 = 默认）、`radius`（1~16，取整；`0` = 默认）、`opacity`（50~100，取整；`0` = 默认 100）：与配色同一套「空值即默认主题」口径，同时作用于公告条与弹窗内容块（`utils.noticeColors()`）。
- `maxLines`（只接受 `1`/`2`/`3`，缺省与非法回落 `1`）：**仅纵向 `up`/`bounce` 生效**，决定纵向视口高度 = `maxLines × 24px`（行高常量），内容超出该高度才滚；横向不受影响（backlog B5-4）。
- 读（`getNotice`）与写（`saveNotice`）共用同一份归一化（`normalizeNotice`，预设复用）：旧文件缺字段自动补齐默认值，非法枚举/颜色自动回落，无需迁移脚本。
- 公开接口形状：`GET /api/notice` 顶层 = 最高优先级胜者（无有效项时为空公告形状 + `enabled:false`），另**新增 `notices[]`**（全部有效项，已按仲裁序排序）供上下两槽位各取第一条；`notices[]` **不含**停用/未生效/已过期条目（不泄露运营排期）。

`data/notice-presets.json`（公告预设，单例，数量 ≤ 站点设置上限，默认 10）：

```json
{
  "version": 1,
  "presets": [
    {
      "id": "3f2a9c1d5b7e4081",
      "name": "维护公告（深色）",
      "order": 1,
      "rev": 2,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000,
      "appliedAt": 1760000005000,
      "appliedBy": "key:9a1b2c3d",
      "appliedCount": 1,
      "notice": { "enabled": true, "title": "维护公告", "content": "……", "display": "both", "position": "fixed-bottom", "scroll": "up", "bgColor": "#112233", "textColor": "#ffee00" }
    }
  ]
}
```

- 数量上限 = `effectivePresetLimit()`（站点设置 `presetLimit`，`0`/非法值回退默认 `10`，钳制在 `[1, MAX_NOTICE_PRESETS]`）；读盘时逐项过滤（`id` 必须为非空字符串）、按 `order` 升序排列并截断到 `max(MAX_NOTICE_PRESETS, 生效上限)`，解析失败回退空列表（不影响公告本体）。**调低上限不会删除已有预设**，只是不能再新增。
- `id` = `crypto.randomBytes(8).toString('hex')`（不做自增编号）；`notice` 与 `notice.json` 同构但**不含 `updatedAt` / `rev`**（启用时才盖新时间，避免访客的「已关闭」记录误判；版本号由公告本体维护）。
- `group`（≤ 20 字符，去首尾空白，**空串 = 未分组**）：**只影响管理端展示归类**，不参与 `order`（`order` 仍是全局唯一）；旧文件无该字段时读盘回落空串，无需迁移；导出/导入均携带（导入缺 `group` 也回落空串，向后兼容旧导出文件）。
- `name` ≤ 50 字符，留空时回退「公告自身标题 → `预设 N`（N 为列表位次）」；`notice` 写入前与读盘后都过 `normalizeNotice()`，与公告同一套白名单/颜色/空内容规则（ADR-014）。
- `order`（正整数，默认按创建顺序）：列表与导出均按 `order` 升序；`PUT /api/admin/notice/presets/order` 重排后重写为连续的 `1..n`。
- `rev`（正整数，默认 `1`）：预设乐观锁；`PUT` 若带 `rev` 且与当前不一致返回 `409`，成功后 `rev + 1`（启用/审计不改 `rev`）。
- `appliedAt` / `appliedBy` / `appliedCount`：启用审计 —— 最近一次启用时间、操作者标识与累计次数；`appliedBy` 为**管理密钥指纹**（`key:` + `sha256(ADMIN_KEY)` 前 8 位十六进制），换密钥即换标识（当前无管理员身份体系，以指纹区分操作者）。启用因公告版本冲突被拒时**不写审计**。
- 导入导出（B6-1）：导出为 `{ format: 'file-share-notice-presets', version: 1, exportedAt, count, presets: [{ name, group, notice }] }`（不含 id/rev/审计，`group` 为 B7-2 新增）；导入校验 `format`/`version`/数组/条目为对象/条数 ≤ 200，重名自动加（2）（3）序号，受 `min(硬上限, 生效上限)` 容量约束，超出部分计入 `skipped`。

`data/stats.json`（累计计数器，单例）：

```json
{
  "totalUploads": 120,
  "totalDownloads": 345,
  "transferOriginalBytes": 21944304,
  "transferWireBytes": 4504951,
  "updatedAt": 1760000000000
}
```

- 每次上传成功 `totalUploads +1`（`store.commitUpload`），每次成功下载 `totalDownloads +1`（`store.tryConsume`）。
- `transferOriginalBytes` / `transferWireBytes`：分片下载链路的累计原始字节与线上字节，由 `stats.recordTransfer()` 在 `GET /api/download/part` 每次成功产出分片时累加；**同一会话内同一分片（`index` 或 `start-end` 键）只计一次**（`sessions.markSessionPart`），越界/参数错误不计数。节省值不落盘，由 `/api/admin/stats` 派生 `transferSavedBytes = 原始 − 线上`（避免双写漂移）。
- 写入策略（ADR-009）：`recordTransfer` 只累加内存增量，**达 32 片或每 2s** 刷盘一次，`SIGINT`/`SIGTERM` 优雅退出前显式刷盘；`readCounters()` 返回前合并未落盘增量，因此**读接口始终是最新值，直接读文件可能滞后一个窗口**（外部消费者请走 `/api/admin/stats`）。崩溃最多丢失一个窗口（≤2s 或 ≤31 片）的计数。
- 上传/下载计数的即时写盘（`recordUpload`/`recordDownload`）只清除计数器增量，**未刷盘的维度增量保留到下一个刷盘窗口**（否则明细会被下一次上传/下载无声吞掉，ADR-011 决策 5）。
- 维度数据（ADR-010）另存于 `data/transfer-stats.json`（单例，与 `stats.json` 共用同一个刷盘窗口，仅在有增量或墓碑时写）：

```json
{
  "version": 1,
  "days": { "2026-10-12": { "originalBytes": 3908890, "wireBytes": 163855, "parts": 15 } },
  "files": { "486529": { "originalBytes": 3908890, "wireBytes": 163855, "parts": 15, "updatedAt": 1791806000000 } },
  "resetAt": 0,
  "resetCount": 0,
  "updatedAt": 1791806000000
}
```

- `days` 键 = **服务器本地日期** `YYYY-MM-DD`（`stats.dayKey(ts)`），**保留最近 30 天**（超出在刷盘时裁剪）；`files` 键 = 取件码，**生命周期等于分享**：`store.removeShare()` 调 `stats.forgetFileStat(code)` 记墓碑（读取端立即不可见、下次刷盘删除），条目数**封顶 2000**（超出按 `updatedAt` 淘汰最旧）。`savedBytes` 均为读取端派生值，不落盘。
- `resetAt`/`resetCount` 为**清零审计**（最近一次清零时间与累计次数，默认 0）：由 `POST /api/admin/stats/reset` 写入，经 `/api/admin/stats` 的 `transferResetAt`/`transferResetCount` 只读暴露；清零会同时归零 `stats.json` 的传输累计与内存未刷盘增量，**不影响上传/下载次数**（ADR-011）。
- `fileCount`/`totalSize`/`activeDownloads` 由 `listAll()` 实时聚合，不落盘。
- 统计口径仅覆盖分片下载（`>1MB` 文件与并行下载路径）：`GET /api/download` 单流导航下载与浏览器实际落盘字节不计入（ADR-007）。

`data/tmp/<uploadId>.json` + `data/tmp/<uploadId>.bin`（分片上传会话，临时）：

```json
{
  "version": 1,
  "uploadId": "5b8b6e2c9f68eba99513058c",
  "partSize": 4194304,
  "totalParts": 3,
  "size": 10485760,
  "fields": { "filename": "报告.pdf", "mime": "application/pdf", "note": "", "customCode": "", "expiresIn": 24, "maxDownloads": 5, "passwordHash": "…" },
  "received": [0, 2],
  "expiresAt": 1791810000000
}
```

- `received` = 已成功收片的序号位图，随每次收片**原子更新**（临时文件 + rename）；`complete` 成功后连同 `.bin` 一起删除；启动时 `restoreUploadSessions` 恢复未过期且 `.bin` 存在的会话，删除过期/孤儿/残留临时文件（ADR-012）；上传 TTL **30 分钟绝对过期**。
- `fields.passwordHash` 为 SHA-256 十六进制：`init` 即哈希入会话，**明文密码不落盘、也不驻留内存**（单次上传路径在 `store.commitUpload` 内哈希，两条路径共享同一口径）。

`data/settings.json`（站点设置，单例）：

```json
{ "siteName": "我的驿站", "beian": "粤ICP备2024000000号", "gongan": "粤公网安备 44030402000000号", "logo": ".png", "maxFileSize": 52428800, "blockedExts": ["php", "exe"], "displayMode": "simple", "customCodeEnabled": true, "compressionEnabled": true, "compressionCodecs": ["br", "gzip"], "updatedAt": 1760000000000 }
```

- `siteName` ≤ 50 字符，空字符串 = 使用默认名称（前端 fallback「文件驿站 · 匿名共享」）。
- `logo` 为扩展名（含点，如 `.png`），图片实体存于 `data/logo.<ext>`；空 = 未设置，前端不显示 logo。
- `maxFileSize` 单文件大小上限（**字节**），`0` = 使用环境变量 `MAX_FILE_SIZE` 默认值；保存时钳制到 `[1MB, MAX_FILE_SIZE]`，生效值 = `min(存储值, MAX_FILE_SIZE)`（`effectiveMaxFileSize()`，env 值同时是硬上限与默认值）。
- `blockedExts` 禁止上传的后缀黑名单（数组）；保存/读取均经 `normalizeExts`：小写、去前导点、过滤非 `^[a-z0-9]{1,20}$` 项、去重、最多 100 项。
- `displayMode` 发件成功页显示模式：`simple`（简约版，取件码+二维码，默认）/ `waybill`（快递面单回执）；非法值回退 `simple`。
- `customCodeEnabled` 是否允许自定义取件码（布尔，默认 `true`）；关闭后发件页隐藏输入框，`POST /api/upload` 忽略 `customCode` 参数改为随机生成。
- `compressionEnabled` 是否启用存储压缩（布尔，默认 `true`）；关闭后新上传文件一律原样存储。
- `compressionCodecs` 存储态编码候选（数组，默认 `['br','gzip']`）；保存/读取均经归一化：只保留 `br`/`gzip`，含 `br` 即规范为 `['br','gzip']`，否则 `['gzip']`。生效值 `getCompressionCodecs()` = 设置值 ∩ `COMPRESS_CODECS`（env 是硬上限，交集为空时回退 `['gzip']`），仅影响此后新上传的文件，已存文件保持原编码（ADR-008）。
- logo 另有独立端点 `GET /api/logo` 公开读取，`hasLogo` 由「扩展名非空 + 文件存在」共同判定。
- `beian` / `gongan` ICP 与公安备案号（均 ≤ 100 字符，空串 = 不显示）；经 `/api/settings` 公开返回，公共页脚并排展示（含 `web/public/icons/icp.webp` 与 `gonganbeian.png` 两个图标，随构建复制进 `web/dist`）。

`data/feedback/<id>.json`（意见反馈，一单一文件，`<id>` = `<时间戳>-<8 位随机 hex>`）：

```json
{
  "id": "1791987737396-1a2b3c4d",
  "code": "FB-12345678",
  "type": "bug",
  "contact": "tester@example.com",
  "content": "上传大文件时进度条卡住",
  "status": "done",
  "reply": "已修复，下个版本发布",
  "repliedAt": 1791988000000,
  "createdAt": 1791987737396,
  "updatedAt": 1791988000000
}
```

- `code` = `FB-` + 8 位数字（`crypto.randomInt(10000000, 100000000)`），全局唯一，是**唯一的公开凭证**；`id` 不出现在公开接口。
- `type` ∈ `bug` / `feature` / `other`（非法值回退 `other`）；`contact` ≤ 100、`content` ≤ 2000。
- `status` ∈ `pending` / `processing` / `done`；置 `done` 必须同时提供 `reply`（否则 `400`）。
- 公开查询只返回 `code/type/content/status/reply/createdAt/updatedAt`（不含 `id`/`contact`）；`reply` 仅在 `done` 时非空。

`data/feedback-templates.json`（回复模板，单例）：`{ "templates": ["…"], "updatedAt": 0 }`，最多 20 条、单条 ≤500 字，去重去空白；文件缺失/非法时回退内置 5 条默认模板。

## 6. 核心业务规则（必须遵守）

1. **取件码**：`crypto.randomInt(100000, 1000000)` 生成 6 位数字（100000–999999，无前导零）；若 meta 或文件已存在则重试，最多 50 次。
2. **失效判定**：`now > expiresAt` **或** `downloads ≥ maxDownloads` 即失效，失效即**物理删除** meta 与文件。
3. **消费原子性**：`store.tryConsume(code)` 必须用**同步**读-改-写完成计数，成功返回最新 meta，失败返回失败原因（`not_found` / `expired` / `exhausted`）。
4. **限流**：
   - 取件查询/下载：每 IP 每分钟失败 `RATE_LIMIT_MISSES` 次 → 返回 429。
   - 上传：每 IP 每分钟最多 10 次 → 返回 429。
5. **错误信息**：所有 API 错误返回 JSON `{ "error": "<中文提示>" }`，HTTP 码语义：400 参数错误 / 401 密钥错误 / 404 码不存在或已失效 / 413 文件过大 / 429 限流 / 500 内部错误。
6. **管理鉴权**：请求头 `x-admin-key`，使用 `crypto.timingSafeEqual` 恒定时间比较（长度不等时直接判失败）。
7. **分片会话**：上传会话（TTL 30 分钟）在 `upload/init` 创建，限流只在 init 计一次；下载会话（TTL 10 分钟）在 `download/session` 创建并消费 1 次，分片请求不重复计数。会话存续期抑制失效分享的物理删除（`getActive`/`cleanupExpired` 检查活跃会话），由 `download/end` 或 TTL 清扫最终回收。
8. **传输协商（安全红线）**：只有当客户端在 `Accept-Encoding` 中**明确声明**支持 `gzip`/`br`（含 `*` 通配、`q>0`）时才可发送 `Content-Encoding`；缺失该请求头、或仅声明 `identity`/`deflate`、或 `q=0` 时必须发送解码后的原始字节。响应始终带 `Vary: Accept-Encoding` 与 `Cache-Control: private, no-store`。
9. **容器完整性**：服务前必须校验单元表能无缝覆盖 `size` 且 `o + c ≤` 实际文件大小，任一不成立返回 `500 文件损坏，请联系管理员`（宁可不服务也不输出可疑字节）；去重单元必须与源单元共用同一份存储载荷。
10. **传输统计口径（默认只增不减、不重复计）**：`GET /api/download/part` 每次成功产出分片时累加「原始字节 = `end − start`」与「线上字节 = 实际响应 `Content-Length`」；同一下载会话内同一取片键只计一次（重试/重复取片不重复累加），4xx/5xx 与未产出字节的失败不计数；节省值恒由 `原始 − 线上` 派生（可为 0，不为负）。增量先进内存、按阀值与定时刷盘（ADR-009）；**任何读取（含 `store` 的读-改-写）必须先经 `readCounters()` 合并未落盘增量**，否则会覆盖丢失。唯一的"减"操作是显式清零（`POST /api/admin/stats/reset`，需 `{ confirm: true }`）：站点传输累计与全部维度明细（含未刷盘增量）一并归零，非传输计数不受影响（ADR-011）。
11. **断点续传（RFC-003 / ADR-012）**：上传恢复走 `GET /api/upload/status` 与 `init` 的 `uploadId` 复用（元数据不匹配 `409`；恢复**不占**上传限流额度）；下载续传走 `GET /api/download/status`（**不消费**下载次数、不重置 TTL）。上传会话磁盘位图（`tmp/<id>.json`）是唯一事实源，启动以 `restoreUploadSessions` 恢复；下载会话仅内存，token 失效即回退新建（消费 1 次，与旧行为一致）。上传 30 分钟、下载 10 分钟均为绝对过期。
12. **压缩后台任务化（backlog B1-2）**：`/api/upload` 与 `/api/upload/complete` 只落位文件并回 `201`（响应带 `compressionState: 'pending'`），压缩在**串行队列**（`server/jobs.js`，并发 1）里跑；队列任务表**不落盘**（进程重启即丢），未跑完的压缩由启动 `repairPendingCompressions()` 按边车收尾（改名已发生 ⇒ 补元数据；未发生 ⇒ 回退未压缩，**不丢文件**）。任务结束才回写 `compression`/`units`/`storedSize`；失败一律回退未压缩（`status: 'done'` + `compressed: false`），不阻断下载。
13. **下载计划的形态一致性（B1-2 硬约束）**：分片计划（`units`/`ranges`）在会话建立时固定，因此 `compressionState === 'pending'` 时**不得**下发计划——`/api/download/session`、`/api/download/status`、`/api/download/part` 与 `GET /api/download` 均先 `waitForSettledBody(code)`（默认 15s，超时 `503`），宁可不服务也不给会漂移的索引。跨文件去重（B4-2）只是把「容器」换成「清单」，此约定不变。
14. **反馈号与分桶限流**：反馈号 `FB-` + 8 位数字由 `server/feedback.js` 生成（逐文件扫描冲突重试 50 次），是公开查询的唯一凭证，**不可枚举猜测成本考虑**——查询失败走 `missGuard(limit, windowMs, 'fbquery')` **独立分桶**，与取件码失败桶（`miss:`）互不挤占；提交反馈与上传共用 `rateGuard` 频率桶。置 `done` 必须带 `reply`（否则 `400`），管理端删除即物理删除该条 JSON。

## 7. API 契约

| 方法 | 路径 | 参数 | 成功响应 |
|---|---|---|---|
| `POST` | `/api/upload` | multipart：`file`（必填）、`expiresIn`（小时，白名单 1/24/72/168）、`maxDownloads`（白名单 1/3/5/10）、`note`（选填备注，最长 200）、`customCode`（选填自定义取件码，6 位数字；被占用返回 409，非法则忽略并随机生成）、`password`（选填取件密码，≤64；SHA-256 哈希入库，明文不落盘不回传）；大小上限取 `effectiveMaxFileSize()`，后缀命中 `blockedExts` 拒绝；可压缩文件自动写入单元容器 | `201` `{ code, filename, size, mime, note, hasPassword, createdAt, expiresAt, maxDownloads, downloads, compressionState, storedSize, compressed, clientIp }`（`clientIp` 仅供发件面单展示，不入库、不出现在 `/api/info`；`note` 入库并在 `/api/info` 返回；`hasPassword` 布尔；`compressionState` = `pending` 表示压缩已入后台队列（此时 `compressed:false`、`storedSize = size`），可用 `GET /api/upload/job` 轮询；`storedSize`/`compressed` 反映压缩结果，仅上传响应返回）；超限 `413` 含 MB 提示；禁用类型 `400`；自定义码冲突 `409` |
| `POST` | `/api/verify-password` | JSON `{ code, password }` | `200` `{ ok: true }` 或 `403` 密码错误 / `404` 取件码无效 |
| `GET` | `/api/info?code=832451` | `code` 6 位数字 | `200` 同上结构（`publicInfo`，含 `hasPassword`，不含密码） |
| `GET` | `/api/download?code=832451` | `code`；设密时需 `password` query | `200` 文件流，`Content-Disposition: attachment`（压缩文件由服务端逐单元解压流式输出，`Content-Length` 为原始大小，此路径不做传输压缩）；密码缺失/错误 `403` |
| `GET` | `/api/upload/status?uploadId=` | `uploadId`（分片上传会话 ID） | `200` `{ uploadId, filename, size, mime, partSize, totalParts, received, expiresAt }`（`received` = 已收分片序号升序数组；不存在/过期 `404`） |
| `POST` | `/api/upload/init` | JSON `{ filename, size, mime, expiresIn, maxDownloads, note, customCode, password }`，可选 `uploadId`（断点续传复用）；校验大小/黑名单/自定义码（占用 409） | `200` `{ uploadId, partSize, totalParts, resumed, received }`（`resumed:true` 时复用会话、不占限流且 `received` 为已有位图；带 `uploadId` 但文件名/大小不一致 `409`；限流按新会话计一次；`totalParts ≤ 1024`） |
| `PUT` | `/api/upload/part` | Query `uploadId`、`index`；原始字节 body（≤ `partSize`，超出 413） | `200` `{ ok: true, received }`；会话不存在 `404`；序号/长度不符 `400`；分片可乱序/重试覆盖 |
| `POST` | `/api/upload/complete` | JSON `{ uploadId }` | `201` 同 `/api/upload` 响应结构（带 `compressionState`）；分片不完整/大小校验失败 `400`；自定义码竞争 `409` |
| `GET` | `/api/upload/job` | Query `uploadId`（分片上传）或 `code`（单请求上传） | `200` `{ status: 'pending'\|'running'\|'done'\|'failed', error, compressed, storedSize, compressionState, finished }`（压缩任务进度，任务表在内存、重启即丢；标识格式非法 `400`，无任务且无对应分享 `404`；**不阻塞、无副作用**） |
| `POST` | `/api/download/session` | JSON `{ code, password }` | `200` `{ token, partSize, filename, size, mime, expiresAt, compressed, units, unitCount, parallel }`（`units` = 服务端自适应分片计划 `[[start,end],…]`，`parallel` = 建议并发 2~8）；创建即消费 1 次；容器损坏 `500`；密码错误 `403`、失效 `404`（同下载语义） |
| `GET` | `/api/download/part` | Query `token` 加 `index`（计划内分片，推荐）**或** `start`/`end`（原始字节范围，`end - start ≤ partSize`）；请求头 `Accept-Encoding` 参与协商 | `200` 该分片原始字节（不重复计数）；按协商结果附 `Content-Encoding: gzip\|br` 与 `X-Transfer-Part/Mode/Codec/Algo`（`Mode` = `store` 存储态 0 拷贝直传 / `recompress` 重编码 / `raw` 原样）；token 无效 `404`；序号/范围非法 `400`；容器或文件损坏 `500` |
| `GET` | `/api/download/status?token=` | `token`（下载会话） | `200` 与 `session` 同构的 `{ token, partSize, filename, size, mime, expiresAt, compressed, units, unitCount, parallel }`；**不消费次数、不重置 TTL**；无效/过期 `404`，容器损坏 `500` |
| `POST` | `/api/download/end` | JSON `{ token }`（幂等） | `200` `{ ok: true }`；释放会话；若无活跃会话且分享已失效则立即回收 |
| `GET` | `/api/admin/ping` | 头 `x-admin-key` | `200` `{ ok: true }`（登录前置验证用，轻量） |
| `GET` | `/api/admin/list` | 头 `x-admin-key` | `200` `{ list: [...] }`（每项含 `storedSize`、`compressed`、`compressionState`（`pending` = 后台压缩中，管理端展示「压缩中」标签）、`crossHashed`（`storageVersion === 2`，即跨文件去重清单）、`transfer`（`{ originalBytes, wireBytes, parts, savedBytes }`，无传输记录时均为 0）） |
| `GET` | `/api/admin/stats` | 头 `x-admin-key` | `200` `{ fileCount, totalSize, totalStoredSize, savedBytes, transferOriginalBytes, transferWireBytes, transferSavedBytes, transferToday: { date, originalBytes, wireBytes, parts, savedBytes }, transferDays: [...], transferResetAt, transferResetCount, activeDownloads, totalUploads, totalDownloads, sessionQuota: { maxUploadSessionsPerIp, maxDownloadSessionsPerIp, maxTmpBytesPerIp, topIps: [{ ip, uploadSessions, downloadSessions, tmpBytes }] } }`（`sessionQuota` = 按 IP 的在途会话/临时空间快照，**与配额判定同一批 Map、同一套过期判定**，按 `tmpBytes` 降序取前 10，空 `ip` 为旧版位图恢复的会话，B7-3）（`savedBytes` = 磁盘节省（实时聚合）；`transfer*` = 分片下载链路的累计传输字节与派生节省；`transferDays` = 最近 7 天降序，含 `date`/`originalBytes`/`wireBytes`/`parts`/`savedBytes`；`transferResetAt`/`transferResetCount` = 最近清零审计，未清零为 0；`dedupCross*` = 跨文件去重收益（`dedupCrossEnabled` 开关、`dedupCrossManifests` 清单数、`dedupCrossObjects`/`dedupCrossBytes` 被引用对象数与字节、`dedupCrossImpliedBytes` = 若无去重需存字节（全部清单 Σc）、`dedupCrossSavedBytes` = 差值、`dedupCrossRatio` = 比值，无清单时为 1） |
| `GET` | `/api/admin/stats/export` | 头 `x-admin-key` | `200` CSV 附件（`text/csv; charset=utf-8` + UTF-8 BOM，`Content-Disposition: attachment`；列 `维度,标识,文件名,原始字节,线上字节,节省字节,片数`；按日行 = 全部保留日期降序，按文件行 = 节省字节降序、取件码升序，文件名取自已销毁则为空；字段按 RFC 4180 转义；读取合并未落盘增量） |
| `POST` | `/api/admin/stats/reset` | 头 `x-admin-key`，JSON `{ confirm: true }` | `200` `{ ok: true, resetAt, resetCount }`；缺 `confirm` `400`。清零 = 站点传输累计 + 全部维度明细与未落盘增量一并归零（上传/下载次数等不受影响），审计写入 `transfer-stats.json`（ADR-011） |
| `DELETE` | `/api/admin/:code` | 头 `x-admin-key` | `200` `{ ok: true }` |
| `GET` | `/api/notice` | 无（公开） | `200` `{ id, enabled, title, content, display, position, scroll, scrollFill, bgColor, textColor, priority, startAt, endAt, rev, updatedAt, notices: [……有效项（已按仲裁序排序）] }`（顶层 `rev` = 文件级；无有效公告时 `enabled:false` + `notices: []`，HTTP 200） |
| `PUT` | `/api/notice` | 头 `x-admin-key`，JSON body `{ enabled, title, content, display, position, scroll, scrollFill, bgColor, textColor, priority?, startAt?, endAt?, rev? }` | `200` `{ ok: true, notice }`（**兼容单条写入，落到 `id === 'default'` 的条目**；位置/滚动非法回落默认，颜色非十六进制存空串；`rev` 与**文件级 rev**不一致 `409 已被其他管理端修改`，不带 `rev` 不校验） |
| `GET` | `/api/admin/notices` | 头 `x-admin-key` | `200` `{ ok: true, rev, limit, notices: [……全部条目（含停用/未生效/已过期，按仲裁序）] }`；无密钥 `401` |
| `POST` | `/api/admin/notices` | 头 `x-admin-key`，JSON body 为公告字段（可带 `id`） | `201` `{ ok: true, notice, rev }`；达到 `MAX_NOTICES` `409 公告数量已达上限`；同 id 已存在 `409` |
| `PUT` | `/api/admin/notices/:id` | 头 `x-admin-key`，JSON body 为公告字段 + `rev`（**条目级**） | `200` `{ ok: true, notice, rev }`（条目 `rev + 1`、文件 `rev + 1`）；`rev` 过期 `409`；未知 id `404` |
| `DELETE` | `/api/admin/notices/:id` | 头 `x-admin-key` | `200` `{ ok: true, rev }`；未知 id `404` |
| `GET` | `/api/admin/notice/presets` | 头 `x-admin-key` | `200` `{ ok: true, limit: 10, limitCap: 50, presets: [{ id, name, order, rev, createdAt, updatedAt, appliedAt, appliedBy, appliedCount, notice }] }`（`limit` = 站点设置生效上限，`limitCap` = env 硬上限）；无密钥 `401` |
| `POST` | `/api/admin/notice/presets` | 头 `x-admin-key`，JSON body `{ name?, group?, notice }`（也接受扁平公告字段；`group` ≤20 字符，空串 = 未分组） | `201` `{ ok: true, preset }`；达生效上限 `409 预设数量已达上限（最多 N 个），请先删除或在站点设置中调整上限`；名称 ≤50 且留空回退公告标题 |
| `PUT` | `/api/admin/notice/presets/:id` | 头 `x-admin-key`，JSON body `{ name?, group?, notice?, rev? }`（缺省沿用原值；带 `rev` 则校验） | `200` `{ ok: true, preset }`（`createdAt` 不变、`updatedAt` 刷新、`rev + 1`）；`rev` 过期 `409 预设已被其他管理端修改`；未知 id `404` |
| `DELETE` | `/api/admin/notice/presets/:id` | 头 `x-admin-key` | `200` `{ ok: true }`；未知 id `404` |
| `POST` | `/api/admin/notice/presets/:id/apply` | 头 `x-admin-key`，JSON body `{ noticeRev?, noticeId? }` | `200` `{ ok: true, notice, preset }`（写入目标公告，缺省 `id === 'default'`；`updatedAt`/`rev` 刷新、访客立即可见；同时记 `appliedAt/appliedBy/appliedCount` 审计）；`noticeRev` 过期 `409`（不写审计）；未知 id `404` |
| `PUT` | `/api/admin/notice/presets/order` | 头 `x-admin-key`，JSON body `{ ids: [预设 id…] }` | `200` `{ ok: true, presets }`（按传入顺序重排，未列出的保持原有相对顺序排在末尾，重写为连续 `order` 1..n）；全部 id 不匹配 `400` |
| `GET` | `/api/admin/notice/presets/export` | 头 `x-admin-key` | `200` JSON 附件（`Content-Disposition: attachment; filename="notice-presets-YYYYMMDD-HHmmss.json"`；`{ format, version, exportedAt, count, presets: [{ name, group, notice }] }`，按 `order` 升序，不含 id/rev/审计） |
| `POST` | `/api/admin/notice/presets/import` | 头 `x-admin-key`，JSON body 为导出文件（可加 `mode: 'merge'（默认）| 'replace'`） | `200` `{ ok: true, mode, imported, skipped, limit, total, presets }`；重名自动加序号，超出容量计 `skipped`；`format` 不匹配 / `version` 过高 / 空内容 / 条目非对象 / >200 条 均 `400` |
| `POST` | `/api/feedback` | JSON `{ type, contact?, content }`（`type` ∈ bug/feature/other，非法回退 `other`；`content` 必填 ≤2000，空则 `400`；`contact` ≤100） | `201` `{ ok: true, id, code }`（`code` = `FB-` + 8 位数字，返回后 App 应提示用户保存）；提交与上传共用每 IP 频率限制 |
| `GET` | `/api/feedback/query?code=FB-12345678` | `code`（大小写不敏感，缺 `FB-` 前缀亦可） | `200` `{ code, type, content, status, reply, createdAt, updatedAt }`（`reply` 仅在 `status === 'done'` 时非空；格式非法 `400`，不存在 `404`）；失败计数走**独立限流桶**，不影响取件查询 |
| `GET` | `/api/admin/feedback` | 头 `x-admin-key` | `200` `{ list: [{ id, code, type, contact, content, status, reply?, repliedAt?, createdAt, updatedAt }] }`（按 `createdAt` 降序） |
| `PUT` | `/api/admin/feedback/:id` | 头 `x-admin-key`，JSON `{ status, reply? }`（`status` ∈ pending/processing/done；置 `done` 必填 `reply` ≤2000） | `200` `{ ok: true, feedback }`；状态非法或缺回复 `400`；未知 id `404`；id 含路径分隔符 `400` |
| `DELETE` | `/api/admin/feedback/:id` | 头 `x-admin-key` | `200` `{ ok: true }`；id 含路径分隔符 `400` |
| `GET` | `/api/admin/feedback/templates` | 头 `x-admin-key` | `200` `{ templates: ["…"] }`（无文件时返回内置 5 条默认模板） |
| `PUT` | `/api/admin/feedback/templates` | 头 `x-admin-key`，JSON `{ templates: ["…"] }` | `200` `{ ok: true, templates }`（去空/去重/去空白、单条 ≤500、最多 20 条） |
| `GET` | `/api/settings` | 无（公开） | `200` `{ siteName, beian, gongan, hasLogo, maxFileSize, maxFileSizeCap, blockedExts, displayMode, customCodeEnabled, compressionEnabled, compressionCodecs, compressionCodecCap, presetLimit, presetLimitCap, updatedAt }`（`beian`/`gongan` = ICP 与公安备案号，空串 = 页脚不渲染）（`maxFileSize`/`maxFileSizeCap` 为生效值与环境上限，单位字节；`compressionCodecs` 为生效候选、`compressionCodecCap` 为 env 上限，均为逗号串如 `br,gzip`；`presetLimit`/`presetLimitCap` = 公告预设生效上限与 env 硬上限） |
| `PUT` | `/api/settings` | 头 `x-admin-key`，JSON body `{ siteName, beian, gongan, maxFileSize, blockedExts, displayMode, customCodeEnabled, compressionEnabled, compressionCodecs, presetLimit }`（maxFileSize ≤0 表示恢复默认；displayMode ∈ simple/waybill；customCodeEnabled/compressionEnabled 布尔；compressionCodecs 为 `br,gzip` 或 `gzip`，非法值回退 `gzip`；presetLimit ≤0 表示恢复默认 10，钳制到 `[1, MAX_NOTICE_PRESETS]`） | `200` `{ ok: true, settings }` |
| `POST` | `/api/settings/logo` | 头 `x-admin-key`，multipart `logo`（PNG/JPG/WebP/SVG/GIF/ICO，≤2MB） | `200` `{ ok: true, settings }`；非图片 400；超限 413 |
| `DELETE` | `/api/settings/logo` | 头 `x-admin-key` | `200` `{ ok: true, settings }` |
| `GET` | `/api/logo` | 无（公开） | `200` 图片流；未设置 404 |
| `GET` | `/api/ip` | 无（公开） | `200` `{ ip }`：服务端请求 `openapi.lddgo.net/.../GetIp`（3s 超时，60s 内存缓存）取公网 IP，失败回退 `req.ip`；面单「IP / 地址」优先展示此值 |
| `GET` | `/api/health` | 无 | `200` `{ ok: true, features: [...] }`（features 为已部署功能标记：含 `beian`、`gongan`、`feedback`、`compression`、`chunkedUpload`、`parallelDownload`、`downloadSession`、`transferCompression`、`adaptiveChunking`、`unitDedup`、`multiCodec`、`transferStats`、`codecToggle`、`transferExport`、`uploadResume`、`downloadResume`、`sessionQuota`、`multiNotice`、`compressQueue`、`crossFileDedup`；另带 `notice: { total, active }`、`compressQueue: { pending, running }`（压缩后台队列深度）与 `dedup: { enabled, objects, bytes, lastGcAt, lastGcRemoved }`（对象回收可观测），用于快速自检服务器代码是否为新版本与确认 GC 真在运行） |

## 8. 前端页面

| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | Upload | **三步发件流程**（antd `Steps`）：①**上传文件** = `Upload.Dragger` 单文件 + 自定义已选文件卡片（类型图标/名称/大小/删除），点「下一步」进入 ②**填写收件信息** = 已选文件展示 + 有效期/次数下拉 + **自定义取件码**（选填 6 位数字，受 `customCodeEnabled` 开关控制，被占用时 `Modal.confirm` 询问是否自动生成）+ 选填备注 `Input.TextArea`（≤200），「上一步」/「确认发件」（此时才真正 `POST /api/upload`，上传中显示进度条）；成功后 ③**发件回执** = 按 `settings.displayMode` 分支：**简约版** = antd `Result`（取件码与二维码、复制操作、文件信息）；**快递面单**（`WaybillReceipt`）= 品牌/发件时间/面单号/条码/三列虚线分栏/四格承诺/打印与发送（寄件方 IP 优先取 `/api/ip` 公网地址，失败回退 `clientIp`；寄件方「文件备注」展示 `note`）；回执页均有「继续发件/返回首页」；进入首页拉取 `/api/notice`；上传前按 `settings.maxFileSize` 与 `blockedExts` 预检；>1MB 文件自动走分片上传（3 路并发 + 分片重试 2 次），进度与速率复用现有进度条 |
| `/d/:code` | Retrieve | 与发件页同构：`.page`（860px）宽卡片 + 左对齐 `Title`（取件 · 下载文件）/`Paragraph` 头部；取件码输入**常驻在页面上**（`.retrieve-form` 内联在卡片内、不弹窗：`Input.OTP` 6 格，输满 6 位纯数字自动提交、回车与「查询」按钮均可；无码进入 `/d` 时自动聚焦首格，输入区在空态/错误态/结果页始终可见，错误态与结果页另有「重新输入/换个取件码」按钮用于清空并聚焦，`displayMode==='waybill'` 时该输入区让位给回执，「换个取件码」回到 `/d` 无码态重新输入）；四类状态：加载中 `Spin` / 错误 `Alert`+重新输入按钮 / 空态 `Empty` 提示在上方输入 / 命中态；`displayMode==='waybill'` 时命中态渲染 `PickupWaybill`（取件回执：取件码栏+文件信息栏，含备注），`page-wide` 宽卡片；简约模式仍用 antd `Result`（status=success：标题「文件已就绪」、subTitle 文件名 break-all、extra 用 `.result-hero` 承载 `.stat-row` 统计卡，灰底 content 区放下载按钮、有效期提示与「换个取件码」；`.ant-result.retrieve-result` 紧凑样式压缩图标/标题/内边距；≤480px 移动端进一步自适应（页面与卡片边距收紧、统计卡 2 列/≤360px 单列、下载按钮整行、图标 36px、OTP 高度 44px），防止小屏内容溢出视口）；>1MB 文件经会话制并行下载（按服务端下发的自适应单元计划取片，并发 2~8 由内存预算与实测反馈自适应，Chromium 流式写盘、其余 Blob 回退），展示进度、速率与「传输压缩 + 已省百分比（浏览器自动解压）」；错误态/简约结果页/面单回执页均提供「返回首页」入口 |
| `/admin` | Admin | 管理端外壳 `AdminShell`（未登录渲染双栏登录页）；**仪表盘**（有效文件/总大小/实际占用/压缩节省/**传输节省**/累计下载/累计上传；传输节省卡片副行显示「线上 X / 原始 Y · 省 Z%」与「今日 …」，下方为**近 7 日传输节省**明细表，卡片下注明统计口径与保留策略）+ **公告设置**（开关 / 显示方式：弹窗·公告条·两者 / **位置：顶部·底部·悬浮顶部·悬浮底部** / **滚动：不滚动·右→左·左→右·纵向上·纵向往返** / **背景色·文字色取色器（可清除）** / 标题 / 内容 / **内容不足时开关（`scrollFill`：默认「不滚动」= 仅超出才滚；可切「自动填满滚动」）** / **实时预览（`NoticeBarView preview`，强制不悬浮，并显示「实时预览：横向滚动中 / 内容未超出可视宽度，不滚动 / 纵向需 ≥2 行内容…」）** / **公告预设（标题显示 `{已存}/{生效上限}`，上限可在站点设置调整）：名称输入 + 「保存为预设」（达上限禁用）+ 排序（每行 ↑/↓ 按钮，改 `order`）+ 「导出」（下载 JSON 附件）/「导入（合并）」「导入（替换）」（选本地 JSON 文件；替换带二次确认，导入结果提示新增/跳过条数）+ 预设行（排序按钮 + 名称 + 显示方式·位置·滚动·自动填满·底色·字色摘要 + 启用审计「上次启用 时间 · key:指纹 · 共 N 次」+ 套用/启用/覆盖/删除；保存/覆盖遇 409 冲突会提示并自动刷新到最新）**） |
| `/admin/files` | AdminFiles | 独立**文件管理**页：搜索过滤（取件码/文件名/备注）、备注列、**传输节省列**（节省字节 + 线上/原始，`xl` 断点显示）、多选批量删除、下载进度条、剩余时间、可调分页（10/20/50/100） |
| `/about` | About | **关于页**：服务说明、三步使用说明、主要特性、限制说明与开源地址（GitHub 链接），供 App 与访客了解服务边界 |
| `/feedback` | Feedback | **意见反馈页**：类型（问题反馈/功能建议/其他）+ 选填联系方式 + 内容（≤2000，showCount）；提交成功弹窗展示反馈号（可复制/一键跳转查询）；提交与上传共用频率限制 |
| `/feedback-query` | FeedbackQuery | **查询反馈页**：输入反馈号（自动补 `FB-` 前缀、只允许数字）、`?code=` 直达自动查询；三步进度条（等待中/处理中/已完成）+ 反馈原文 + 官方回复块（`.feedback-query-reply`）；格式非法/不存在分别提示 |
| `/admin/feedback` | AdminFeedback | **反馈管理页**：状态筛选 + 表格（反馈号/时间/类型/联系方式/内容/状态/操作）；状态下拉改状态（选「已完成」弹回复弹窗，支持模板一键填充）；详情弹窗（含 ID 与回复）；回复模板管理（每行一条，≤20 条）；删除带二次确认 |
| `/admin/settings` | AdminSettings | **站点设置**页：站点名称（Input ≤50，留空用默认）+ **备案号 / 公安备案号**（Input ≤100，留空 = 页脚不显示）+ Logo（上传/更换/删除，可选，未设置不显示）+ **单文件上传大小上限**（InputNumber 1–MAX_FILE_SIZE MB，默认 env 值）+ **禁止上传的文件类型**（Select tags，后缀黑名单）+ **发件成功显示模式**（Select：简约版 simple / 快递面单 waybill）+ **自定义取件码开关**（Switch，控制发件页是否显示自定义码输入框）+ **存储压缩开关**（Switch，控制服务端自适应单元压缩）+ **压缩编码候选**（Radio：Brotli + gzip 双试 / 仅 gzip，CPU 吃紧时降级；env `COMPRESS_CODECS` 为硬上限时双试选项置灰），保存后通过 `refreshSettings()` 通知全站刷新 |

**UI 约定**：
- **布局分区**：公共顶部菜单栏（`.site-header`，**logo（如有）+ 站点名称** + 上传/取件菜单）**仅在非 `/admin` 路由渲染**（`App.jsx` 按 `isAdmin` 判断），公共页在 header 下渲染 `NoticeBar slot="top"`、在内容之后渲染 `NoticeBar slot="bottom"`，组件按 `position` 归属槽位（`top`/`fixed-top` → 上槽，`bottom`/`fixed-bottom` → 下槽，两实例共享模块级 `noticePromise` 只抓一次公告）——公告条支持四种位置（流内顶部/底部、悬浮顶部/底部（`fixed` + `z-index: 900`，低于 antd 弹窗）与五种滚动：横向分两档（由公告的 `scrollFill` 决定，管理端以开关呈现，默认关闭）——**关闭**时只有 `scrollWidth > clientWidth` 才滚（两份副本，装得下就静态省略），**开启**时一律滚动（副本数 `2 × ceil(视口宽 / (内容宽+64px))`，内容装得下也自动重复填满），两档均 `translateX(0↔-50%)` 循环、时长按半轨道宽/60px/s 且 ≥6s；纵向仅在 `scrollHeight > clientHeight`（内容先 `pre-wrap` 换行）时滚，`translateY(0→-50%)` 向上循环（时长按溢出高/24px/s 且 ≥4s）或 `bounce` 往返，单行内容不滚；静态 `none` 保留单行省略号；跑马灯均悬停暂停、窗口 resize 重测；系统开启「减少动态效果」（`prefers-reduced-motion: reduce`）时四种滚动一律降级为静态（保留单行省略与悬停完整提示，`NoticeBarView` 视图带 `role="status"` + `aria-live="polite"`，另有 `@media` 动画兜底）；配色经 `utils.noticeColors()` 同时作用于公告条与公告弹窗内容块（空值即默认主题））；`document.title` 同步为站点名称。站点设置通过 `useSettings()` 模块级缓存订阅（保存后 `refreshSettings()` 通知所有消费方）。管理端统一由 `AdminShell` 渲染为**左侧边栏布局**（`.admin-layout`）：未登录 → 双栏登录页；已登录 → 深色侧边栏（品牌（logo/站点名） / **仪表盘 · 文件管理 · 设置**菜单 / 返回首页 · 退出，宽 220px，可折叠至 72px，≤768px 自动折叠）+ 右侧内容区（`.admin-inner`，**max-width 1400px**，仪表盘与表格使用整宽），`/admin`、`/admin/files`、`/admin/settings` 共用该外壳，不与主页共用菜单。
- **公共页头与页脚**：`.site-header` 内横向菜单带 `其他` 子菜单（关于 / 反馈 / 查询反馈）；≤768px 时横向菜单隐藏、右侧汉堡按钮打开 antd `Drawer` 抽屉菜单（`.mobile-drawer-menu`，点任意项自动关闭，路由变化也会关闭），页头在手机上收紧内边距、标题截断，**不产生横向溢出**。公共页在内容之后渲染 `.site-footer`（`margin-top: auto` 顶到底部）：备案行（按配置展示 ICP / 公安备案号及其图标，两者都为空时整行不渲染）与版权行。
- 使用 Ant Design 全量引入（`import { App as AntApp } from 'antd'` 统一 message/notification）。
- 中文文案，`dayjs` 时间格式 `YYYY-MM-DD HH:mm`。
- 页面标题统一在 `App.jsx` 布局中，不在各页重复。

## 9. 命令约定

| 命令 | 作用 |
|---|---|
| `npm install` | 安装全部依赖 |
| `npm run dev` | 开发模式：后端 :3000 + 前端 :5173（代理 `/api`）；**默认使用独立数据目录 `data-dev/`**（`scripts/dev.js` 注入 `PORT`/`DATA_DIR`，不覆盖显式环境变量；想用生产数据：`DATA_DIR=data npm run dev`） |
| `npm run build` | 构建前端到 `web/dist` |
| `npm start` | 生产启动（读取 `web/dist`） |
| `npm test` | 端到端测试（自动启停服务器，端口 3999，含自适应分片/传输压缩/去重/旧容器兼容的对抗用例） |
| `npm run e2e` | 真实浏览器 E2E（CDP + headless Chrome，端口 3998/9333；未找到 Chrome 时自动跳过） |

## 10. 开发流程规范

1. **改后端**：改 `server/*.js` → `npm test` 必须通过。
2. **改前端**：改 `web/src/**` → `npm run build` 无报错 → 手动走一遍 `/`、`/d/码`、`/admin`；涉及下载链路（`web/src/downloader.js`、取件页进度）时额外跑 `npm run e2e`。
3. **新增接口**：必须同步更新本文件第 7 节契约表 + `scripts/test.js` 增加用例。
4. **新增依赖**：优先零依赖实现；确需依赖时记录在本文档第 2 节。
5. **代码风格**：ESM、2 空格缩进、单引号、分号结尾；不写行内注释（文档即注释来源）。

## 11. 部署

```bash
npm install
cp .env.example .env      # 修改 ADMIN_KEY、PORT 等
npm run build
npm start
```

Windows 下复制为 `copy .env.example .env`。生产环境建议用 pm2 或 NSSM 守护：`pm2 start server/index.js --name file-share`。

## 12. 安全清单（上线前逐项确认）

- [ ] `.env` 已设置强随机 `ADMIN_KEY`，且 `.env` 在 `.gitignore` 中
- [ ] `data/` 目录权限仅服务账号可读写
- [ ] 已限制 `MAX_FILE_SIZE`
- [ ] 反向代理（如 Nginx）限制请求体大小与上传带宽
- [ ] 限流参数符合预期（`RATE_LIMIT_MISSES`、`UPLOAD_LIMIT_PER_MINUTE`）与**每 IP 会话配额**符合实际并发（`MAX_UPLOAD_SESSIONS_PER_IP`/`MAX_DOWNLOAD_SESSIONS_PER_IP`/`MAX_TMP_BYTES_PER_IP`；NAT/公司出口共享 IP 场景可适当放宽，否则会误伤正常用户）
- [ ] **公网抽查传输响应头（backlog B2-4）**：对可压缩文件取一片，确认 `Content-Encoding` 与 `X-Transfer-Mode` 符合预期（本机实测：宣称 `br` → `Content-Encoding: br` + `Mode: store`；仅 `gzip` → `gzip` + `recompress`；`identity` → 无 `Content-Encoding` + `raw`；三者均带 `Vary: Accept-Encoding`）。若链路代理剥掉 `br`（明文 HTTP 下常见），功能无影响，可把 `COMPRESS_CODECS=gzip` 降级以省一半压缩 CPU
- [ ] 续传凭据仅为随机 bearer（`uploadId` 192-bit / 下载 token 128-bit），`data/tmp/` 位图**不含明文密码**（只存 `passwordHash`）；TTL 上传 30 分钟、下载 10 分钟且不滑动
- [ ] **下载落盘（OPFS）人工验收（backlog B4-10，无法自动验证）**：①有头浏览器试一次导出（`<a download>` 文件名与内容正确）；②确认目标机器 OPFS 可用容量（取决于磁盘剩余）足以存最大文件；③多标签同时取同码时不串写（`navigator.locks` 抢不到的标签回退内存 Blob）。非 Chromium 无 OPFS ⇒ 回退内存 Blob，**大文件建议 Chromium 系浏览器**（ADR-003 修订一）
- [ ] **开启 `CROSS_FILE_DEDUP` 前确认风险已接受**：跨文件去重会让「服务端已存在同一内容」可被上传方感知（时序/`storedSize` 可推断），单站点单管理员场景判定可接受；若将来引入多租户，必须改为按租户 HMAC 命名且不跨租户共享（ADR-015 残余风险）。上线后周期检查 `health.dedup.{objects,bytes,lastGcAt,lastGcRemoved}`，确认 GC 真的在跑

## 13. 传输优化机制（自适应单元 + 传输压缩）

目标：**下载既快又省**——不是单纯压一遍存起来，而是「按内容分单元、逐单元选编码、编码直接上线、浏览器自己解压」。

### 13.1 五步机制

| 步骤 | 做什么 | 在哪里 |
|---|---|---|
| 1. 自适应单元计划 | 由文件大小算出目标单元尺寸（不是固定 4MB），单元数封顶 | `units.chunkPlan` / `compress.chunkBounds` |
| 2. 内容定界切分（CDC） | 用 gear 哈希在 `[min, max]` 内按内容定界，平移后的重复内容也能落在同一单元 | `units.chunkFile` / `units.chunkRanges` |
| 3. 单元级去重 | 单元内容 SHA-256（截 128bit）命中已存单元 ⇒ 只写引用 `d`，不重复占盘；开启 `CROSS_FILE_DEDUP` 时升级为**跨文件对象去重**（sha256 全量命名，命中即不写盘，清单记 `h`） | `compress.packUnits` / `compress.packObjects` + `objects.writeObject` |
| 4. 多编解码择优 | 每单元在 raw / gzip(6) / brotli(5) 中实测取最小，永不膨胀 | `codec.encodeUnit` |
| 5. 传输协商 | 按 `Accept-Encoding` 直发存储态编码（零重编码）+ `Content-Encoding`，浏览器网络层自动解压 | `codec.planTransferCodec` + `transfer.js` |

### 13.2 自适应分片算法

```
单文件：unit = clamp(ceil(size / UNIT_TARGET_COUNT), UNIT_MIN_SIZE, UNIT_MAX_SIZE)
        若 ceil(size / unit) > UNIT_MAX_COUNT ⇒ unit = ceil(size / UNIT_MAX_COUNT)
CDC  ：min = max(floor(unit/4), 16KB)、max = unit
        mask = 2^round(log2(unit - min)) - 1，切点：len ≥ min 且 (hash & mask) == 0
        超过 UNIT_MAX_COUNT ⇒ chunkFile/chunkRanges 返回 null ⇒ 回退均匀切分
```

设计依据：并发 4~8 时，分片数太少会「尾部拖尾」（最后一片独自跑完，其余通道空转），太多则请求头开销与压缩上下文变差。`UNIT_TARGET_COUNT=32` 让每路约 4~8 片，兼顾两者；`UNIT_MAX_COUNT` 保证请求数可控。默认区间（256KB ~ 8MB）是压缩率与并行度的折中：单元越小压缩上下文越短（gzip 窗口 32KB、brotli 窗口 4MB）。

客户端并发也是自适应的：以内存预算 `32MB / 平均单元大小` 与服务端建议值取小为上限，运行中每成功 3 片 +1（上限 8），失败降半（下限 2），始终保序写盘。

### 13.3 多编解码实测（8MB 真实语料，Node 内置 zlib，单位：输出/原始）

| 语料 | gzip(6) | brotli(4) | brotli(5) | brotli(9) | 结论 |
|---|---|---|---|---|---|
| 源码/文本 | 18.7% | 17.3% | **16.1%** | 15.3% | brotli(5) 体积更小、速度与 gzip 相当 |
| 日志 | 14.8% | 14.2% | **14.0%** | 13.5% | brotli(5) 略优 |
| 随机/已压缩 | 100% | 100% | 100% | 100% | 无收益 ⇒ 存原始（raw） |

因此默认候选 `COMPRESS_CODECS=br,gzip`（两者都试、取最小）；**brotli 必须比 gzip 小 4% 以上才采用**，这样多数文本仍以「明文 HTTP 也能直传的 gzip」存储。高压缩级别（brotli 9）收益边际且在 300MB 上传上代价显著，故不采用。

### 13.4 传输协商（红线：未声明不压缩）

| 客户端 `Accept-Encoding` | 存储态 | 服务端行为 | 响应头 |
|---|---|---|---|
| `br, gzip`（现代浏览器安全上下文） | brotli | 0 拷贝直传存储字节 | `Content-Encoding: br`，`X-Transfer-Mode: store` |
| `gzip, deflate` | brotli | 解 brotli 后重压 gzip | `Content-Encoding: gzip`，`Mode: recompress` |
| `gzip, deflate` | gzip | 0 拷贝直传 | `Content-Encoding: gzip`，`Mode: store` |
| `identity` / `deflate` / `q=0` / 无该请求头 | 任意 | 服务端解压后发原始字节 | 无 `Content-Encoding`，`Mode: raw` |
| 任意 | raw（不可压缩） | 原样切片 | 无 `Content-Encoding` |

### 13.5 实测验收（`npm run e2e`，headless Chrome 154，链路限速 12.5MB/s）

```
浏览器 Accept-Encoding: gzip, deflate, br, zstd
分片响应编码分布: {"br":17}                      # 真实浏览器走 brotli 直传
并行+压缩 传输窗口 237ms / 单流基线 1494ms → 提速 6.30x
线上字节 248630 / 原始 14200000（98.2% 省，语料为高重复文本）
落地文件与原始内容逐字节一致（Blob 拼装 / OPFS 流式写盘 两条路径均验证）
不可压缩文件：encoded == decoded（不产生虚假收益）
```

`npm test` 另含 249 条用例覆盖：编码协商矩阵（含 `q=0`/通配/缺省/别名）、六种客户端画像逐分片编码决策、去重正确性（引用与载荷一致）、单元覆盖校验、越界/负数/小数分片序号、单元表损坏与文件截断降级、旧容器 `gzip-blocks` 只读兼容、CDC 两套实现互证、传输节省累计与去重（[24]）、编码候选开关（[24]）、传输维度明细（[24c]）与导出/清零（[24d]，含 RFC 4180 转义与 BOM 字节校验）、断点续传（[26]：位图/重启恢复/密码哈希/不重复消费）等。`npm run e2e` 共 37 条，含 E2E-6（真实浏览器登录管理端并核对「传输节省」卡片与接口一致）、E2E-7（真实点击导出得到 CSV、点击清零后界面归零并展示审计行）与 E2E-8（阻断分片 → 刷新 → 续传完成且只消费 1 次）。

### 13.6 已知边界

- ≤1MB 的小文件仍走单流导航下载（`GET /api/download`），不做传输压缩：省下的字节可忽略，且避免多一次会话往返。**调研已结论（backlog B4-3）**：服务端 `streamOriginal`/`res.download` 均为**网络原始字节、不带 `Content-Encoding`**，因此无损坏风险；而给导航下载（`Content-Disposition: attachment`）注入 `Content-Encoding` 有真实损坏面（Chromium issue 41242019「Files are CHANGED (corrupted) on DOWNLOAD」、Firefox bug 406948 记录的 `Content-Encoding` 滥用），故**明确不在导航下载上启用**；如将来确需，改走「同源 `fetch`（浏览器透明解压）+ 内存 Blob + `<a download>`」，不走 `Content-Encoding`。
- 默认（`CROSS_FILE_DEDUP=off`）去重仅在**单个文件内**生效（跨文件去重需要全局内容索引）：跨文件去重**已实现但默认关闭**（RFC-006 + ADR-015，开关 `CROSS_FILE_DEDUP` 默认 `off`）；开启后新上传走清单化容器 `units-v3`，对象由标记-清扫 GC 回收（详见第 5 节与 §14.4）。
- 非 Chromium（无 File System Access）走 Blob 内存拼装，峰值内存 ≈ 文件大小；Chromium 为边下边写盘，64MB 级文件内存占用仅为在途分片。
- 上传分片默认为固定 `TRANSFER_PART_SIZE`（已 3 路并发）；自适应仅作用于下载侧——但**片数超限时会把该会话的 `partSize` 向上翻倍**（backlog B4-5 已闭环）：默认 4MB 下 ≤4MB 文件就是单片、100MB 上限只有 25 片，只有 `MAX_FILE_SIZE > 1024 × TRANSFER_PART_SIZE` 的部署才会触发，触发后仍受 1024 片上限约束（`partSize` 翻倍到够为止，翻倍后仍超限才 400）。
- 明文 HTTP 下浏览器通常仍声明 `br`（localhost 已实测）；若反向代理剥掉 `br`，会自动退化为 gzip 重编码或原始字节，路径均有测试覆盖。

### 13.7 观测与管理端降级

- **传输节省落库**：`GET /api/download/part` 每次成功产出分片时调用 `stats.recordTransfer({ originalBytes: end − start, wireBytes: 实际响应 Content-Length })`；同一会话内同一取片键（`index` 或 `start-end`）只计一次（`sessions.markSessionPart`），参数错误/损坏/重复取片不重复累加；节省值由 `/api/admin/stats` 派生 `transferSavedBytes = transferOriginalBytes − transferWireBytes`（不双写，见 ADR-007）。
- **仪表盘卡片**：`/admin` 新增「传输节省」（节省字节 + 副行「线上 X / 原始 Y · 省 Z%」），数据来自 `/api/admin/stats`；口径仅含分片下载链路，≤1MB 单流下载与浏览器实际落盘字节不计入（卡片下有说明文案）。
- **编码候选开关**：站点设置新增「压缩编码候选」（`settings.compressionCodecs`，`br,gzip` / `gzip`），生效值 = 设置值 ∩ `COMPRESS_CODECS`（env 为硬上限）；CPU 吃紧时可降为单 gzip（上传期压缩 CPU 约减半，文本体积通常大 1%~3%），仅影响此后新上传的文件（见 ADR-008）。
- **统计写入批量聚合**：传输计数先进内存，达 32 片或每 2s 刷盘一次（读接口合并未落盘增量，永不陈旧）；把单次下载的同步写从“每分片一次”压到 `ceil(片数/32)` 量级（见 ADR-009）。
- **开发/生产数据隔离**：`npm run dev` 默认 `DATA_DIR=data-dev`，避免两个进程共享 `data/` 时“下载会话仅进程内存、跨进程无保护”导致分享被对方清理（生产请只跑单进程）。
- **维度明细（按日/按文件）**：日维度保留最近 30 天（本地日期）、文件维度随分享销毁回收并封顶 2000 条；仪表盘「近 7 日传输节省」与文件管理页「传输节省」列均直接读接口，无需额外缓存（见 ADR-010）。
- **导出与清零（归档 / 重开计量）**：仪表盘「近 7 日传输节省」卡片提供「导出 CSV」（`GET /api/admin/stats/export`，单表长格式 + BOM + RFC 4180 转义）与「清零」（`POST /api/admin/stats/reset`，`confirm: true` + `Popconfirm` 双闸）；清零把站点传输累计与全部明细归零并记录 `resetAt`/`resetCount`（界面展示"上次清零"），不影响上传/下载次数（见 ADR-011）。
- 实测（headless Chrome 154，本机）：`npm run e2e` **37 passed / 0 failed**，其中 E2E-6 真实浏览器登录管理端后卡片文本「传输节省 26.6 MB 线上 4.5 MB / 原始 31.1 MB · 省 86%」与接口 `4,691,564 / 32,594,304` 一致；E2E-7 真实点击导出落盘 CSV（BOM + 表头 + 明细）与点击清零后界面归零并展示审计行；E2E-8 阻断分片失败后刷新页面续传成功（落地 SHA-256 一致、全程只消费 1 次）；`npm test` **249 passed / 0 failed**。

## 14. 断点续传机制（RFC-003）

### 14.1 上传（跨刷新/跨重启）

- 服务端：`data/tmp/<uploadId>.json` 位图 + `<uploadId>.bin` 分片体；每片成功即原子落盘；`complete` 后清理；启动 `restoreUploadSessions` 恢复未过期会话（校验版本/数值字段/位图范围/`.bin` 存在），删除过期与孤儿（ADR-012）。
- 客户端：`api.uploadChunked` 以 `fs-upload:<文件名>:<大小>:<lastModified>` 存 `uploadId`；重选同一文件时先 `GET /api/upload/status` 拉位图并从缺口继续；首帧进度带 `resume`，`Upload.jsx` 提示「已恢复上次未完成的上传（x/y 片）」；成功清理本地记录，失败保留（TTL 30 分钟内有效）。
- 密码：`init` 即 SHA-256 入会话，磁盘与内存均无明文。

### 14.2 下载（会话续用 + 字节级续写，不重复消费）

- 服务端：`GET /api/download/status?token=` 返回原计划（`units`/`parallel`/`expiresAt`），**不消费次数、不重置 TTL**。
- 客户端：`downloader.js` 以 `fs-download:<取件码>` 存 token；点击下载先尝试续用；成功才 `end` 并清理本地记录，失败/取消保留 token（10 分钟内重试不再消耗次数）。
- **落盘三态（B4-10 / B4-4）**：① 手势期选了「另存为」句柄 ⇒ 直接写用户句柄（无暂存，因此不跨刷新续写）；② 无句柄但支持 OPFS（`navigator.storage.getDirectory`）⇒ 写 OPFS 暂存 `fs-download-<code>.part`，每 4 个分片 `close()` 提交一次（暂存文件大小恒等于**已落盘前缀**，实测逐片提交会因整体落盘开销拖慢大文件），完成后用该文件的 blob URL 交给 `<a download>`（浏览器按需读盘，不整份进内存），导出后 120s 清理暂存；③ 两者都不可用 ⇒ 内存 Blob 拼装（非 Chromium 回退，峰值内存随文件增长）。
- 刷新后字节级续写：暂存前缀必须正好覆盖若干个完整分片（否则丢弃重写）；续写只请求缺口分片，落地文件逐字节一致。多标签用 `navigator.locks` 独占 `fs-download-<code>`（`ifAvailable`），拿不到锁的标签回退内存 Blob，避免并发写同一暂存文件。
- token 过期/服务重启后回退新建会话（消费 1 次，与旧行为一致）。

### 14.3 实测验收

```
[26] 上传：乱序收片 [0,2] → upload/status 位图一致；init 复用不新建、不占限流、元数据不匹配 409；
     补片后 complete 成功且逐字节一致；tmp 位图/分片体清理；落盘 JSON 无明文密码；
     重启恢复探针：仅未过期且成对的会话恢复，过期/孤儿/临时文件被清理；
[26] 下载：download/status 前后 totalDownloads 不变；续用 token 取完逐字节一致；end 后 404；
E2E-8（headless Chrome 154）：限速下载中 Page.reload 中断 → 已提交前缀留在 OPFS 暂存（实测 1MB = 4 片）→
     续用同一 token 只请求 12/16 片（缺口分片）→ 落地文件 SHA-256 一致、全程 totalDownloads 只 +1、
     本地记录清除、暂存最终写满原始大小。
```

## 14.4 压缩后台化与跨文件去重的验收（B1-2 / B4-2）

```
[36] 压缩后台任务化：201 立即回 compressionState=pending（storedSize=size、compressed=false）→ pending 期间 /api/info
     可用 → 任务落定后 meta 回写 compression/units 且无边车残留 → 下载 SHA-256 一致；无收益时任务 done + 回退未压缩；
     pending 窗口内建会话先等落定（compressed=true）且取片逐字节一致；/api/upload/job 缺参 400、不存在 404；
     health.compressQueue 窗口内计数非零，排队任务全部落定为压缩；
[37] 崩溃恢复：边车存在且文件大小 === 容器声明 ⇒ 启动补齐元数据；未改名 ⇒ 丢弃边车回退未压缩；SIGKILL 打断
     压缩后重启，文件逐字节一致（零丢失）；
[38] 跨文件去重（隔离端口）：同一内容上传两次 → 第二份全部命中既有对象（磁盘不再增长）→ 清单 units-v3 +
     storageVersion=2（h 为 64 位十六进制、无 o）→ 无 files/<code> → 单请求与分片下载逐字节一致 →
     admin/stats 的 dedupCrossRatio > 1.5 → health.dedup → 删一个分享对象仍在 → 引用全部消失后启动 GC 回收。
     CROSS_FILE_DEDUP=off 的主服务器：对象目录始终为空（零行为变化）。
```

## 15. 后续结论、实现状态与实测（已入档）

批次 4 把剩余遗留项从「未做无结论」推进到「有结论 + 明确触发条件」；后续批次把其中各项**逐项落地实现**（B1-2、B4-2、B4-10/B4-4 见下；B4-5、B4-8、B5-2~B5-4、B7-1~B7-3 已在 §8/§9 与 `docs/backlog.md` 闭环）。下表「状态」列区分已实现与仍待触发：

| 项 | 状态 | 结论 / 产物 | 触发条件 |
|---|---|---|---|
| backlog B1-2 压缩后台任务化 | ✅ **已实现**（`a217e55`）：`server/jobs.js`（串行队列，内存任务表）+ `server/compress-job.js`（边车 → 改名 → 回写元数据）；上传 201 不再含压缩耗时；`GET /api/upload/job` + `health.compressQueue`；下载侧 `waitForSettledBody` 等落定再发计划；[36][37] 共 18 条 | `docs/backlog.md` B1-2；§6 规则 12/13 | 已关闭 |
| backlog B4-2 跨文件去重 | ✅ **已实现**（默认 off，`d8f2990`）：对象 = 自适应单元载荷（`data/objects/<hh>/<hash>` = sha256 **全量**），`data/files/<code>` 在开启时不再生成，meta 存清单 `units-v3` + `storageVersion: 2`；引用计数**不落盘**（扫描清单派生 + `DEDUP_GC_GRACE_MS` 宽限清扫，GC 是唯一删除路径）；`admin/stats` 的 `dedupCross*` + `health.dedup`；[38] 共 13 条 | `docs/rfc/RFC-006-cross-file-dedup.md`、`docs/adr/ADR-015-cross-file-dedup-cas.md`（Accepted） | 已实现；开启仍建议先确认重复上传占比 >20% |
| backlog B5-3 多公告 / 定时投放 | ✅ **已实现**（`3c9bc12`；B5-2/B5-4 同属公告域，`5181700`）：`data/notices.json` 单例数组（`id`/`priority`/`startAt`/`endAt`，上限 `MAX_NOTICES` 默认 20）；**调度 = 请求时求值**（无后台定时器/无 SSE）；仲裁序 `priority` desc → `updatedAt` desc → `id` 升序且**同槽位只下发一条**；`/api/notice` 顶层形状不变、新增 `notices[]`（仅有效项）；时间窗半开区间；迁移一次性 + 写穿镜像 `notice.json`；[31] 共 17 条 + E2E-12 | `docs/rfc/RFC-007-multi-notice-scheduling.md`（Implemented）、`docs/adr/ADR-016-multi-notice-arbitration.md`（Accepted） | 已实现 |
| backlog B4-10 / B4-4 下载字节级续写与非 Chromium 内存峰值 | ✅ **已实现**（`b6eebf8`）：落盘三态（用户句柄 > OPFS 暂存 > 内存 Blob），每 4 片提交一次暂存，刷新后只补缺口分片（E2E-8 实测 12/16 片），导出走 OPFS 文件的 blob URL；多标签 `navigator.locks` 互斥。**仍需人工验收**：导出对话框（有头浏览器）、OPFS 容量、非 Chromium 真机峰值内存 | `docs/adr/ADR-012-upload-session-persistence.md` 修订二；ADR-003 修订一；§14.2 | 已实现；非 Chromium 仍走 Blob（大文件建议 Chromium 系） |
| backlog B2-4 正向代理/CDN 是否剥掉 `br` | **本地抽查已过**（临时探针）：宣称 `br` → `Content-Encoding: br` + `X-Transfer-Mode: store`；仅 `gzip` → `gzip` + `recompress`；`identity` → 无 `Content-Encoding` + `raw`；三者均带 `Vary: Accept-Encoding` | `docs/backlog.md` B2-4；§12 上线清单 | 公网抽查（待上线）；若被剥掉，功能无影响，降 `COMPRESS_CODECS=gzip` 即可 |
| 待触发项的可执行计划（批次 5 立项，批次 6 前已全量执行） | 三份计划快照把 B1-2、B1-4、B4-2、B4-4、B4-5、B4-8、B4-10、B5-2、B5-3、B5-4、B7-1~B7-3 拆成「一 Task = 一次提交」的实现步骤（含触发条件 / file:function / 测试段号 / 验收命令 / 预设提交消息），计划文件内保留原始触发条件与执行记录 | `docs/superpowers/plans/2026-10-13-transfer-backlog-plan.md`、`-notice-backlog-plan.md`、`-admin-preset-backlog-plan.md`（三份文件的 Status 行均为「已全部执行」） | 仅剩「需人工/真机验收」与「需业务触发才开启」两类（见上表与 §12 上线清单） |
