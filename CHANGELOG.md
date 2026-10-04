# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

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

[未发布]: https://github.com/providcc/dsh-remote-server/compare/v1.0.0...HEAD
[1.0.1]: https://github.com/providcc/dsh-remote-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/providcc/dsh-remote-server/releases/tag/v1.0.0
