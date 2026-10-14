# ADR-006: 传输压缩走 HTTP Content-Encoding 协商（浏览器网络层自动解压）

> Status: Accepted | Date: 2026-10-12 | Deciders: zwh | 关联 RFC: RFC-002 §4.4 | 影响：`server/transfer.js`、`server/index.js`、`server/codec.js`、`web/src/downloader.js`

## Context

压缩数据既然已经存在磁盘上（ADR-004/005 的单元容器），下载时却有两条可选路线：

- **服务端解压后发原始字节**（RFC-001 的做法）：实现简单，但带宽零收益——"压缩"只省了磁盘。
- **把压缩后的字节直接发出去，让接收端解压**：这是真正的省带宽路线（实测文本可降到 16%~44%）。接收端解压有两种实现方式：
  1. **HTTP 内容编码**：响应带 `Content-Encoding: gzip|br`，浏览器网络栈透明解压，`fetch().arrayBuffer()` 直接拿到原始字节，前端零改动；代价是必须尊守 `Accept-Encoding` 协商规则。
  2. **JS 解压**：浏览器 `DecompressionStream` 只支持 `gzip`/`deflate`/`deflate-raw`，**不支持 brotli**；且要求客户端把"压缩分片"先落到本地再解压拼装，等于把服务端的解压工作搬到客户端并新增一条代码路径。

另外还有三个必须回避的坑：多成员（multi-member）压缩流、范围（Range）语义、以及"对不支持的客户端强行压缩"。

## Decision

1. **走浏览器自动解压（方案 1）**：`/api/download/part` 按 `Accept-Encoding` 决定响应编码，前端不写任何解压代码，`fetch` 拿到的就是原始字节。
2. **存储态 0 拷贝直传**：单元在磁盘上就是一个完整压缩成员，协商通过时直接用 `createReadStream` 把该段字节发出去（`X-Transfer-Mode: store`），**不做二次压缩**；一个分片恒定等于一个压缩成员，从根上避免多成员流。
3. **协商优先级**（`codec.planTransferCodec`）：
   - 存储 `g` + 客户端接受 `gzip` ⇒ 直传 `Content-Encoding: gzip`
   - 存储 `b` + 客户端接受 `br` ⇒ 直传 `Content-Encoding: br`
   - 否则若接受 `gzip` ⇒ 服务端解压后重编码为 gzip（`Mode: recompress`）
   - 否则若只接受 `br` ⇒ 重编码为 brotli
   - 否则 ⇒ 发原始字节，**不带** `Content-Encoding`（`Mode: raw`）
4. **红线：未声明不压缩**。只有客户端显式声明（请求头存在、编码名匹配、`q > 0`，或 `*` 通配）才允许压缩；**缺失 `Accept-Encoding` 头**按"只接受 identity"处理（HTTP 语义允许任意编码，但服务端主动压缩未声明的客户端是真实事故来源，选择保守）。
5. **任意范围请求（兼容路径）**：`start/end` 模式按需解码后重编码为**单个**压缩成员（旧前端缓存因此也能享受传输压缩）；`index` 计划内模式才走 0 拷贝直传。
6. **不做传输压缩的两处**：① ≤1MB 小文件的单流导航下载（`GET /api/download`）保持"服务端解压 + `Content-Length` = 原始大小"，避免与 `Content-Disposition` 下载管理器交互的不确定性；② 未压缩文件（`compressed=false`，如 jpg/mp4/zip）直接流式切片，不做无意义重压。
7. **响应头卫生**：所有分片响应带 `Vary: Accept-Encoding` 与 `Cache-Control: private, no-store`（避免共享缓存混淆编码、避免消费计数的文件被缓存），并附 `X-Transfer-Mode` / `X-Transfer-Codec` 便于自查与前端展示。
8. **服务端解压失败即报错**：任一单元载荷超出实际文件大小（截断/损坏）直接 `500 文件损坏`；客户端对每个分片校验字节数，不匹配即中断，绝不拼接可疑数据。

## Alternatives

- **JS 侧 `DecompressionStream` 解压**：能拿到"压缩分片→本地解压"，但 brotli 不被支持（会白扔 5%~14% 优势），且需要客户端把压缩数据先落地/缓存再解压，等于多一条组装路径、多一份内存与代码。否决（浏览器原生解码已覆盖该收益）。
- **把压缩包（zip/tar.gz）整体下发再由浏览器解压**：用户拿到的是压缩包而不是原文件，改变产品语义，且无法与"按范围取片/并行"共存。否决。
- **自己在 JS 里实现 brotli 解码器（WASM）**：多一个构建产物与体积成本，收益与 `Content-Encoding` 完全相同。否决。
- **不协商，一律发压缩字节**：会让只声明 `identity` 的客户端拿到无法解读的字节（数据损坏级事故）。否决（红线）。
- **给每片加自定义头 `X-Encoded: br` 由前端解码**：绕开 `Accept-Encoding`，等价于方案"JS 解压"，且更容易被中间代理误处理。否决。

## Consequences

- 正：文本类文件线上字节实测降到 16%~44%（`npm test` 分片级断言 + `npm run e2e` 浏览器 resource timing `encodedBodySize/decodedBodySize` 双证），限速 12.5MB/s 下与单流基线 A/B 对比 **6.3x**。
- 正：浏览器自动解压 = 前端零解压代码；错误的分片（长度不符）会被客户端立刻发现。
- 负：服务端要正确实现 `Accept-Encoding` 语义（`q=0`、通配、别名 `x-gzip`、缺省、`deflate` 不等于 `gzip`），并为此维护 13 行协商矩阵测试；`br` 与 `gzip` 的存储态差异引入了"重编码"分支（CPU 换取客户端兼容）。
- 负：明文 HTTP 下 `br` 的可用性依赖浏览器与中间设备（实测 Chrome 在 `http://localhost` 会声明 `br`，公网明文站点可能被代理剥掉）——发生时自动退化为 gzip 重编码或原始字节，功能不减、收益降低。
- 风险：`Content-Encoding` + `Content-Disposition` 组合在部分代理/下载管理器上有历史坑，故决策 6 明确小文件导航路径不启用传输压缩。

## References

- RFC-002 §4.4、§5、§6；ADR-004/005（存储态编码）；RFC-001（分片协议与消费语义仍有效）
- `scripts/test.js` [21]：六种客户端编码画像逐分片断言、无 `Accept-Encoding` 头原样输出、旧 `start/end` 范围路径同样压缩
- `scripts/e2e-browser.js`：Chrome 154 实测 `Accept-Encoding: gzip, deflate, br, zstd`，17/17 分片响应 `Content-Encoding: br`
