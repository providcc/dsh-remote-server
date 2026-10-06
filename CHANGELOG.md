# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

rc1 前的缺陷修复（逐行审计的发现，每条都有判据钉住）。

### 修复

- **未认证的畸形 `Host` 头可让中继进程 exit 1（远程 DoS）**。`new URL(req.url,
  "http://" + req.headers.host)` 在 request listener 里同步抛 TypeError，Node 不兜底 →
  `uncaughtException` → exit 1；实测 `GET /healthz` 配 `Host: [` 即复现，`Host: x:99999`
  与 absolute-form 同样崩。修法：URL 的 base 固定为 `http://relay.invalid`（不用客户端
  Host）、整个 HTTP 面 try/catch（异常只回 500）、补 `clientError`/upgrade 兜底。
- **同一条 socket 反复 `hello` 换身份时旧键永不释放**：`attachClient` 每次 set 新键，
  而 `close` 只按最后一次的 `clientId` 调 `clientGone`——未认证的对端在一条连接上连发
  N 个不同 clientId 就能让 `state.clients` 无界增长，`/healthz clients` 永久虚高
  （实测 3000 个 id → `clients:499`，关掉 socket 后仍是 499）。修法：二次 `hello`
  且身份不同就先走 `clientGone`/`hostGone` 释放旧键；`attachHost` 同形问题一并修。
- **日志值没有长度上限**：20 帧带 400 KiB `clientMeta.platform` 的 `hello` 写出
  8.19 MB 日志、单行 409 KB，而 journald 按条数限流不按字节。修法：`Log.log` 对
  所有字符串值（含 `msg`）统一截断到 256 字符并加 `…`；脱敏纪律不变。
- **停机只写一次盘，且写早了**：最后一次 `persistNow()` 在关 socket 之前，之后的变更
  （`clientGone` 更新 `lastActivityAt` 等）不落盘。修法：排空结束后再写一次；5 秒兜底
  路径也补写，并把 `shutdownForced` 记进 `/healthz`（兜底与排空成功同为 exit 0）。
- **`/api/pair-status` 无限流**（`DRC_PAIR_STATUS=1` 时）：一条无认证、回答"这个 6 位码
  在不在"的接口，10⁶ 空间等于免费枚举机。修法：新增 `DRC_PAIR_STATUS_PER_SEC`（默认
  5/s），超配额回 429 并记 warn。
- **连接数上限 off-by-one**：`wss.clients.size + 1 > max` 把新连接算两次（ws 在回调前
  已 `clients.add`），`DRC_MAX_CONNS=3` 实际只收 2 条。修法：去掉 `+1`。
- **帧名认识但形状不合法时错报 `unknown_frame`**（与注释承诺相反，排障时会误判成
  "对端版本不对"）。修法：未知帧名 → `unknown_frame`，已知帧名但形状坏 → `bad_frame`。
- **`enc-batch` 上行在主机缺席时静默丢弃还续命**（与单帧路径不对称）。修法：与 `enc`
  对齐——回 `host_unavailable`，不 `touchConversation`。
- **`resync` 的 `kept` 算错**（`claimed.size - dropped.length` 会把不属于该主机、
  甚至不存在的 id 也算进去）。修法：按实际保留的会话计数。
- **落盘临时文件权限可被残留/pid 复用带偏**：`mode: 0o600` 只在创建时生效，而 tmp 名
  固定为 `${path}.${pid}.tmp`。修法：`flag: 'wx'` 独占创建 + 显式 `chmodSync` 0600。

### 变更

- **主机重连不再向客户端重放 `peer-joined`**：随仓发布的 mp 客户端 `_onFrame` 里没有
  这条分支（落 default 静默忽略），且字段把 `hostId` 塞进了 `clientId`。客户端续用旧
  `convId` 靠的是 `hello-ok` → `cmd.list_sessions`。
- `/healthz` 新增 `shutdownForced`（累计强退次数）；配置新增 `DRC_PAIR_STATUS_PER_SEC`。
- `scripts/relay-start.sh` 默认日志级别从 `debug` 改为 `info`（debug 会打印完整配对码），
  并给短于 4 字符的 token 加长度守卫（原写法会把整个值打出来）。
- `scripts/loadtest-conns.mjs` 补 try/finally 收尾（抛错时回收子中继与日志流），
  `ROOT` 改用 `fileURLToPath`。

## [1.0.6] - 2026-10-06

### 新增

- **会话表落盘**（`DRC_STATE_FILE`，**默认关闭**）。配对关系此前只存在内存里，
  中继一重启全部消失，手机要回到电脑前重新扫码。这不是某次改坏的，是一直如此——
  以前没暴露，只因为线上那个进程连着跑了 29.7 小时。
- `/healthz` 新增 `persistence`（on/off）、`stateRestored`、`stateSavedAtSec`、
  `stateWrites`、`stateWriteFailures`。**刻意不暴露文件路径**：`/healthz` 公网可达，
  而绝对路径对排障没用、对探测者有用。

### 细节

- 落盘字段：`conversationId` / `hostId` / `clients` / `seqHost` / `lastActivityAt` /
  `emptySince`。不落 `pendingPairs`（短命 + 一次性语义）与 `hostOfflineSince`。
- 不落任何秘密：中继结构性零知识，从来不持有 PSK；会话 id 与 client id 本就明文
  出现在每一帧里，落盘不扩大暴露面。
- `hostOfflineSince` 刻意不落**也不恢复**：读盘那一刻没有任何主机连着，照搬计时等于
  宣称"主机从上次落盘起就已离线"，一次 130 秒的停机维护就能让宽限期当场到期、
  手机照样重扫——比不做落盘更糟。恢复出来的会话一律按"主机在场、只是还没连上"处理。
- 恢复放在 `createRelay`（listen 之前）：放 listen 之后有真实竞态——主机在读盘完成前
  连上来发 `resync`，那轮会按"服务器现有的表"去删，把主机刚声明的会话全删掉。
- 回收同步删盘；只在"建"的时候写的话，已回收的会话会永远留在盘上、重启被复活。
- 失败一律不致命：写失败只记日志并计数，坏文件按空启动并留痕（起不来的中继等于
  整个产品停摆）。原子写用同目录临时文件 + `rename`。

## [1.0.5] - 2026-10-06

### 修复

- `peer-left` 在两条永久失去配对的路径上带上 `unpaired`：客户端显式解绑
  （`session-leave`）与重新配对摘清旧成员（`leaveAll` detach）。此前主机收到的
  `peer-left` 不区分"用户主动解绑"与"socket 掉线"，前者会在主机侧留下一条永远
  清不掉的幽灵会话（pill 永远显示"手机离线"）。socket 关闭那条路**不带**这个
  标记——那是掉线，会话要留着等手机回来（D3 免扫码）。
- 有测试钉住这条：只有显式解绑带标记，socket 断开永远不带（`tests/relay.test.mjs`）。

### 变更

- `dsh-remote-wire` 依赖改为已发布的 `^1.8.0`（此前一度指向本地 `file:` 路径）。

## [1.0.4] - 2026-10-04

### 新增

- **空会话回收**（`DRC_CONV_EMPTY_TTL_MS`，默认 30 分钟）。配对按 D3 长存，socket 断开
  只是手机退后台——那时**不起表**；只有最后一个客户端主动离开（`leave`）或被重新配对
  摘清成员（`leaveAll`）才起表，到点删会话（日志 `conversation empty-dropped`）。
  护的是内存不无界增长，又不把"退后台再回来"的用户钉去重扫。

## [1.0.3] - 2026-10-04

### 变更

- **单帧上限 256 KiB → 1 MiB**（`DRC_MAX_MSG_BYTES`）：`cmd.send_prompt` 开始带图片附件，
  一张压过的 jpeg base64 后常超 256 KiB。零知识规矩不变（照样只当密文转发）。

## [1.0.2] - 2026-10-03

### 新增

- **计数器快照进日志**（`msg:"counters"`，周期 `DRC_COUNTERS_LOG_MS`，默认 60 秒）。
  `droppedFrames` / `slowConsumers` / `rejectedPairs` 是**自启动累计**，只在当前进程的
  `/healthz` 里有值、重启即归零，而中继又**不为每一次丢帧写日志**（那是刷屏）——
  两件事加起来，"昨天那段时间丢了多少帧"以前根本问不出来。现在它是 journalctl 里的一行，
  取差值即可。字段由**同一个 `health()`** 产出，不在日志这边再列一遍（两处各写迟早分叉）。
  这一行不许含凭据，有测试钉住（`hostToken` / `token` / `psk` / `secret` 一个都不许出现）。

## [1.0.1] - 2026-10-03

### 新增

- `scripts/loadtest-conns.mjs`：连接规模压测装置。起本地中继（跑生产同一个单文件产物）、
  开 N 条只走完 `hello`/`hello-ok` 的 ws、每 5 s 从进程外部采 RSS / fd / 出站字节 /
  ping 帧数 / `/healthz` 事件循环延迟 / 日志增速并输出 CSV。
- 两个新环境变量：`DRC_PING_INTERVAL_MS`（默认 60000）与 `DRC_PING_TICK_MS`（默认 1000）。
- `/healthz` 的字段契约文档补齐：实际响应一直有 12 个字段（含 `lastPingAgo` /
  `droppedFrames` / `slowConsumers` / `rejectedPairs`），此前文档写作"八个、且这三类不存在"。

### 变更

- **保活 ping 从"每轮全表"改为按桶轮转**，`DRC_SWEEP_MS` 的语义收窄为"表清扫周期"。
  实测 10k 连接：单轮对事件循环的最坏阻塞从 **96 ms 降到 7 ms**，ping 从 1960 次/秒
  降到 167 次/秒（见 `docs/SELF-HOSTING.md` §4.1 的前后对比表）。
  **这是有代价的行为变更**：静默死掉（无 FIN/RST）的半开对端，槽位回收从最坏约
  `2×sweepMs`（10 s）变成最坏约 `2×pingIntervalMs`（默认 121 s）。在意就把
  `DRC_PING_INTERVAL_MS` 调小；`tests/heartbeat.test.mjs` 第 4 条把这个界钉住了。

### 修复

- 表清扫与保活拆开后，配对码 TTL、慢消费者窗口、host 宽限期的粒度**不**跟着心跳周期
  一起变长（`tests/heartbeat.test.mjs` 第 3 条锁住这条）。

## [1.0.0] - 2026-10-03

### 新增

- 零知识 WebSocket 中继的首次公开发布（单进程、纯内存、运行时只依赖 `ws`）。
- 主机认证与会话路由；配对码的签发、路由与一次性消费。
- 分层限流：单连接帧速率、全局配对配额、单连接认证/配对失败上限、并发连接上限、待配对表上限。
- 背压闸门：慢消费者缓冲区持续超限即 1008 断开；客户端与主机窗口按角色区分。
- 心跳判活（WS 层 ping/pong）、主机宽限期、会话空闲回收。
- 优雅停机：新连接 1013、已连接对端收 1001，退出码 0。
- 运维契约：`/healthz` 八字段与 `/api/info`；一行一个 JSON 的 NDJSON 日志。
- **自包含单文件产物**（esbuild），部署退化为"拷一个文件 + 一个 env 文件"。
- 结构性零知识的机械防线：产物级断言构建产物里不含密码学代码。

[未发布]: https://github.com/providcc/dsh-remote-server/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/providcc/dsh-remote-server/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/providcc/dsh-remote-server/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/providcc/dsh-remote-server/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/providcc/dsh-remote-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/providcc/dsh-remote-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/providcc/dsh-remote-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/providcc/dsh-remote-server/releases/tag/v1.0.0
