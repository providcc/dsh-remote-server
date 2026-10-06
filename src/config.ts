/**
 * config — 中继的环境变量。
 *
 * 默认值全部继承自旧实现的**实测配置**（语义继承，不是抄代码；对照表见
 * `docs/legacy-spec/relay-and-wireformat.md` §5.3）。这几条不是口味问题：
 *
 * - `MAX_MSG_BYTES` 低于 256 KiB 会把大 delta 硬切断（ws 以 1009 关连接），
 *   表现是"流式输出说到一半就重连"；
 * - `PAIR_TTL_MS` 是配对码的服务端权威寿命，主机必须按 `pair-ready.ttlMs` 改写本地过期
 *   ——这是旧实现的第一起线上事故；
 * - `PAIR_STATUS_ENABLED` 默认关：开等于给 6 位码空间装了个免认证的判定 oracle。
 *
 * 新增的两条服务于跨断连续用（D3/D6），默认值保守：
 * - `CONV_IDLE_TTL_MS` 会话在无活动多久后回收（默认 7 天）；
 * - `HOST_GRACE_MS` 主机 socket 断开后多久才通知客户端"主机已离开"（默认 120 秒）。
 *   没有这个宽限期，一次网络抖动就会让手机丢掉配对、必须回到电脑前重新扫码。
 *
 * 慢消费者窗口的一对（`SLOW_CONSUMER_HOST_MS` / `SLOW_CONSUMER_CLIENT_MS`）默认值来自
 * `limits.ts` 的常量，两者**默认不同**是刻意的：客户端窗口是由对端（小程序）自己的
 * 重连周期推导出来的不变量，不是性能偏好。把它调到 42.5s 以下就等于把那台
 * "被踢→秒回→再被踢"的 ~11s 循环发动机装回去（DESIGN-REVIEW 第 11 条，
 * `tests/limits.test.mjs` 直接读 mp 源码的常量来锁这条）。可调只是为了测试能缩短等待。
 *
 * 会话表落盘（`DRC_STATE_FILE`，HANDOFF §1.1）**默认关闭**：本地随手起的中继不该
 * 多出一个状态文件，而"配对随中继重启全丢"只发生在长期运行的那一个实例上。
 */

import { CLIENT_SLOW_CONSUMER_MS, HOST_SLOW_CONSUMER_MS } from './limits.js'

export interface RelayConfig {
  hostToken: string
  port: number
  bind: string
  publicUrl: string
  pairTtlMs: number
  maxMessageBytes: number
  maxConnections: number
  maxFramesPerSec: number
  maxHostAuthAttempts: number
  maxPairAttemptsPerConn: number
  pairGlobalBudgetPerSec: number
  maxPendingPairs: number
  conversationIdleTtlMs: number
  /** 空会话（成员表一个客户端都不剩）回收时限：最后一个客户端离开起算。 */
  conversationEmptyTtlMs: number
  hostGraceMs: number
  /** 清扫与保活周期。调小它可以让"宽限期到期"这类事件更快被观察到（测试需要）。 */
  sweepMs: number
  /**
   * 把计数器快照写进日志的周期。
   *
   * 为什么单独一条：`droppedFrames` / `slowConsumers` / `rejectedPairs` 是**自启动累计**，
   * 只在当前进程的 `/healthz` 里有值，进程一换就归零，而中继本来不为每一次丢帧写日志
   * （那是刷屏）。于是"昨天那段时间丢了多少"这种问题以前根本没法问。
   * 这一条就是把 `/healthz` 的那组数按周期抄进日志，让它进 journalctl 成为历史。
   */
  countersLogMs: number
  /**
   * 一条连接两次被 ping 之间的目标间隔。心跳**突发**的规模由它和 sweepMs 的关系决定，
   * 但它**不影响**表清扫的粒度（那仍是 sweepMs）——见 server.ts 的 sweep/sweepPingBucket。
   */
  pingIntervalMs: number
  /** ping 轮转的步长：每 tick 只 ping `pingIntervalMs / pingTickMs` 分之一的那一桶。 */
  pingTickMs: number
  maxBufferedBytes: number
  /** 慢消费者（发送缓冲持续超限）的判定窗口，按角色分：见 limits.ts 的推导。 */
  slowConsumerHostMs: number
  slowConsumerClientMs: number
  logLevel: LogLevel
  pairStatusEnabled: boolean
  /**
   * 会话表落盘路径。**空串 = 关闭**（默认）。
   *
   * 默认关是刻意的：本地起一个中继（开发、测试、临时演示）不该凭空多出一个状态文件，
   * 而"配对会丢"这件事恰恰只发生在**长期运行**的那一个实例上。
   * 开了之后启动会先读它、之后按结构性变更写它，见 `persist.ts`。
   */
  stateFile: string
  /**
   * 周期性补写状态文件的间隔（默认 60 s）。结构性变更（建会话/删会话）本来是立刻落盘的，
   * 这一条只负责**刷新 `lastActivityAt`**——它在每一帧转发时都被更新，却从来不触发写盘
   *（否则每帧一次 fsync）。
   *
   * 不补写会怎样：一条天天在用的会话，`lastActivityAt` 可能停在文件里很久以前；
   * 哪天中继重启，它一读回来就已经过了 7 天空闲 TTL，`sweepIdle` 立刻把它剪掉，
   * 手机被迫重新扫码——正是 §1.1 要消灭的那种故障，只是换了个触发条件。
   * 60 s 的粒度相对 7 天的 TTL 相当于无穷小。
   */
  stateSaveMs: number
  version: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
export const levelWeight = (level: LogLevel): number => LOG_LEVELS[level]

function integer(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * 端口是唯一的例外：**0 合法**，含义是"让系统分配一个空闲端口"。
 * 测试与容器发布端口都靠它，所以不能用上面那条 `> 0` 的规则一刀切。
 */
function portNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new Error(`${name} 必须是 0-65535 的整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

export interface ConfigProblem {
  level: 'error' | 'warn'
  message: string
}

/**
 * 解析环境。返回配置与问题清单——**不**在这里 `process.exit`，
 * 好让调用方（含测试）能决定怎么落地这些诊断。
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  version: string,
): { config: RelayConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = []
  const hostToken = env.DRC_HOST_TOKEN ?? ''
  if (!hostToken) {
    problems.push({
      level: 'error',
      message: 'DRC_HOST_TOKEN is required (long random string, e.g. `openssl rand -hex 24`)',
    })
  } else if (hostToken.length < 24) {
    problems.push({ level: 'warn', message: 'DRC_HOST_TOKEN is shorter than 24 chars — use `openssl rand -hex 24`' })
  }

  const level = (env.DRC_LOG_LEVEL ?? 'info') as LogLevel
  if (!(level in LOG_LEVELS)) {
    problems.push({ level: 'error', message: `DRC_LOG_LEVEL 不认识的取值：${JSON.stringify(env.DRC_LOG_LEVEL)}` })
  }

  const config: RelayConfig = {
    hostToken,
    port: portNumber(env.DRC_PORT, 8787, 'DRC_PORT'),
    // 默认只绑回环：TLS 由反代终止，中继没理由出现在局域网里。
    // 只有自己就是边缘（容器直接发布端口）时才设 DRC_BIND=0.0.0.0。
    bind: env.DRC_BIND || '127.0.0.1',
    publicUrl: env.DRC_PUBLIC_URL ?? '',
    pairTtlMs: integer(env.DRC_PAIR_TTL_MS, 120_000, 'DRC_PAIR_TTL_MS'),
    // 2026-10-04 从 256KB 抬到 1MB：cmd.send_prompt 开始带图片附件（wire 1.3.0）。
    // 一张 q0.6/最长边 1600 的 jpeg 约 80-250KB，base64 后 +33%，256KB 连一张都紧巴。
    // 1MB 给到 4 张（协议层上限）的余量，同时仍远小于 maxBufferedBytes 的上游量级，
    // 而且零知识的规矩不变：中继照样只当密文转发，看不懂也改不了。
    maxMessageBytes: integer(env.DRC_MAX_MSG_BYTES, 1024 * 1024, 'DRC_MAX_MSG_BYTES'),
    maxConnections: integer(env.DRC_MAX_CONNS, 200, 'DRC_MAX_CONNS'),
    maxFramesPerSec: integer(env.DRC_MAX_FRAMES_PER_SEC, 500, 'DRC_MAX_FRAMES_PER_SEC'),
    maxHostAuthAttempts: integer(env.DRC_HOST_AUTH_MAX_ATTEMPTS, 5, 'DRC_HOST_AUTH_MAX_ATTEMPTS'),
    maxPairAttemptsPerConn: integer(env.DRC_PAIR_ATTEMPTS_PER_CONN, 5, 'DRC_PAIR_ATTEMPTS_PER_CONN'),
    pairGlobalBudgetPerSec: integer(env.DRC_PAIR_GLOBAL_PER_SEC, 20, 'DRC_PAIR_GLOBAL_PER_SEC'),
    maxPendingPairs: integer(env.DRC_MAX_PENDING_PAIRS, 1000, 'DRC_MAX_PENDING_PAIRS'),
    conversationIdleTtlMs: integer(env.DRC_CONV_IDLE_TTL_MS, 7 * 24 * 3600 * 1000, 'DRC_CONV_IDLE_TTL_MS'),
    // P2-⑤（2026-10-04 用户拍板 30 分钟）：远小于 7 天的空闲 TTL。
    // 删的代价是手机再扫一次码；不删的代价是 conversations 计数虚高、排障对不上。
    // socket 断开不打点（D3 免扫码），这条只管"只剩主机"的真空会话。
    conversationEmptyTtlMs: integer(env.DRC_CONV_EMPTY_TTL_MS, 30 * 60 * 1000, 'DRC_CONV_EMPTY_TTL_MS'),
    hostGraceMs: integer(env.DRC_HOST_GRACE_MS, 120_000, 'DRC_HOST_GRACE_MS'),
    sweepMs: integer(env.DRC_SWEEP_MS, 5_000, 'DRC_SWEEP_MS'),
    countersLogMs: integer(env.DRC_COUNTERS_LOG_MS, 60_000, 'DRC_COUNTERS_LOG_MS'),
    pingIntervalMs: integer(env.DRC_PING_INTERVAL_MS, 60_000, 'DRC_PING_INTERVAL_MS'),
    pingTickMs: integer(env.DRC_PING_TICK_MS, 1_000, 'DRC_PING_TICK_MS'),
    maxBufferedBytes: integer(env.DRC_MAX_BUFFERED_BYTES, 1024 * 1024, 'DRC_MAX_BUFFERED_BYTES'),
    slowConsumerHostMs: integer(env.DRC_SLOW_CONSUMER_HOST_MS, HOST_SLOW_CONSUMER_MS, 'DRC_SLOW_CONSUMER_HOST_MS'),
    slowConsumerClientMs: integer(
      env.DRC_SLOW_CONSUMER_CLIENT_MS,
      CLIENT_SLOW_CONSUMER_MS,
      'DRC_SLOW_CONSUMER_CLIENT_MS',
    ),
    logLevel: level,
    pairStatusEnabled: env.DRC_PAIR_STATUS === '1' || env.DRC_PAIR_STATUS === 'true',
    // 空串显式当作"关闭"：DRC_STATE_FILE= 也要能关掉，而不是被 ?? 还原成默认路径。
    stateFile: env.DRC_STATE_FILE ?? '',
    stateSaveMs: integer(env.DRC_STATE_SAVE_MS, 60_000, 'DRC_STATE_SAVE_MS'),
    version,
  }
  return { config, problems }
}
