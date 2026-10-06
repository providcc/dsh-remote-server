/**
 * persist — 会话表落盘（HANDOFF §1.1 方案 A），**默认关闭**。
 *
 * ## 为什么落（2026-10-06 取证，不是猜的）
 *
 * 线上那晚逐行可查：
 *
 * ```
 * 07:09:01  client disconnected  clientId: muqu1ibj-…
 * 07:09:59  shutting down  SIGTERM
 * 07:10:01  host online                 ← 主机 1 秒内回来
 * 07:11:05  conversations: 0            ← 会话没回来
 * ```
 *
 * 配对关系只存在内存里，中继一重启就全丢，手机必须回到电脑前重新扫码。
 * 这不是某次改坏的，是一直如此——以前没暴露，只因为线上那个进程连着跑了 29.7 小时。
 * 顺带它还卡住了 §1.2「手机切后台再回来不许要求重新扫码」的验收：那条本来就过不了，
 * 中继一重启配对就没了，手机连上来先撞 `unknown_session`。
 *
 * ## 落什么 / 不落什么
 *
 * **落**：conversationId / hostId / clients / seqHost / lastActivityAt / emptySince。
 * **不落**：
 * - `pendingPairs`——本来就短命（TTL 120 s），而且带一次性语义。落盘等于给一张
 *   已经用过的码留一份可回滚的副本，反倒扩大了"同一张码能被认领两次"的窗口。
 * - `hostOfflineSince`——**刻意不落**，见 `restoreState` 里的注释。
 * - 任何秘密：中继是结构性零知识的，它从来不持有 PSK。会话 id 与 client id 本来就
 *   明文出现在每一帧里，落盘不扩大暴露面（`tests/persist.test.mjs` 有判据钉住这一点）。
 *
 * ## 三条写盘纪律
 *
 * 1. **原子写**：先写同目录临时文件再 `rename`。半截状态文件把中继起挂掉，
 *    比没有文件更糟——`rename` 在同一文件系统内是原子的。
 * 2. **损坏按空启动，绝不拒绝启动**：起不来的中继等于整个产品停摆，而坏文件的唯一
 *    后果是"所有人重新扫一次码"。所以解析失败只记日志（`state file ignored`）。
 * 3. **回收要同步删盘**：内存里删掉的会话若留在盘上，重启就会把已经死掉的会话复活。
 *    调用方在结构性变更（建/删）时立刻落盘，见 `server.ts` 的 `markStateChanged`。
 *
 * 本文件不 import `ws`、不 import `server.ts`，可以纯内存单测。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONVERSATION_ID_PREFIX } from 'dsh-remote-wire/ids'
import type { Log } from './log.js'
import type { Conversation, RelayState } from './state.js'

/** 落盘格式版本。**不认识就整份按空处理**（而不是尽力解析）——猜错字段的读法会把
 * 一份好状态读成坏状态，那种"看起来起来了、其实是空表"的故障比直接报错难查得多。 */
export const STATE_FILE_VERSION = 1

export interface PersistedConversation {
  conversationId: string
  hostId: string
  /** 数组而非 Set：JSON 里没有 Set。顺序不影响语义（成员校验是逐个查）。 */
  clients: string[]
  seqHost: number
  lastActivityAt: number
  emptySince?: number
}

export interface PersistedState {
  version: number
  savedAt: number
  conversations: PersistedConversation[]
}

/** 路由凭证的形状由 `newConversationId()` 定死（`c_` + 12 位 hex）。读进来先按它筛一遍。 */
const CONVERSATION_ID_RE = new RegExp(`^${CONVERSATION_ID_PREFIX}[0-9a-f]{12}$`)

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 逐条筛会话。
 *
 * **刻意不是"一条坏就整份作废"**：一份 10 MB 的状态里坏掉 1 行，代价不该是全部手机
 * 重新扫码。逐条丢弃并报出条数，运维一眼能看出是"文件被截断"还是"手改坏了某一行"。
 * 而 `version` / JSON 语法 / 顶层形状这三处是整份作废——它们坏掉意味着我们对这份
 * 文件的理解本身就不成立。
 */
function sanitize(raw: unknown): { conversations: PersistedConversation[]; dropped: number } {
  if (!Array.isArray(raw)) return { conversations: [], dropped: 0 }
  const conversations: PersistedConversation[] = []
  let dropped = 0
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      dropped += 1
      continue
    }
    const entry = item as Record<string, unknown>
    if (
      !isNonEmptyString(entry.conversationId) ||
      !CONVERSATION_ID_RE.test(entry.conversationId) ||
      !isNonEmptyString(entry.hostId) ||
      !Array.isArray(entry.clients) ||
      !entry.clients.every(isNonEmptyString) ||
      !isTimestamp(entry.seqHost) ||
      !Number.isInteger(entry.seqHost) ||
      entry.seqHost < 0 ||
      !isTimestamp(entry.lastActivityAt)
    ) {
      dropped += 1
      continue
    }
    const conversation: PersistedConversation = {
      conversationId: entry.conversationId,
      hostId: entry.hostId,
      clients: [...new Set(entry.clients as string[])],
      seqHost: entry.seqHost,
      lastActivityAt: entry.lastActivityAt,
    }
    // emptySince 可选：缺失的会话按"此刻起算"处理（见 restoreState 的注释）。
    if (isTimestamp(entry.emptySince)) conversation.emptySince = entry.emptySince
    conversations.push(conversation)
  }
  return { conversations, dropped }
}

/**
 * 读回状态文件。
 *
 * 返回 `undefined` = 没有可用状态（文件不存在 / 读不了 / 语法坏 / 版本不认识），
 * 调用方按空表启动。**任何一种失败都不抛**——理由见文件头纪律第 2 条。
 */
export function readStateFile(path: string, log: Log): PersistedState | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return undefined
    // 读不了（权限、路径是目录……）按空处理，但要留痕——否则"配对总丢"会查无实据。
    log.warn('state file unreadable, starting empty', { path, code: String(code ?? e) })
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log.warn('state file corrupt (json), starting empty', { path, bytes: text.length })
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('state file corrupt (shape), starting empty', { path })
    return undefined
  }
  const file = parsed as Record<string, unknown>
  if (file.version !== STATE_FILE_VERSION) {
    // 往前兼容不了、往后兼容也不猜：只在文件是我们自己写的那个版本时才读。
    log.warn('state file version mismatch, starting empty', { path, found: String(file.version) })
    return undefined
  }

  const { conversations, dropped } = sanitize(file.conversations)
  if (dropped > 0) log.warn('state file entries dropped', { path, dropped, kept: conversations.length })
  log.info('state file loaded', { path, conversations: conversations.length, dropped })
  return { version: STATE_FILE_VERSION, savedAt: isTimestamp(file.savedAt) ? file.savedAt : 0, conversations }
}

/** 把内存表摊平成落盘形状。**只取白名单字段**（见 PersistedConversation）。 */
export function snapshotState(state: RelayState, now: number): PersistedState {
  const conversations: PersistedConversation[] = []
  for (const [conversationId, conv] of state.conversations) {
    const conversation: PersistedConversation = {
      conversationId,
      hostId: conv.hostId,
      clients: [...conv.clients],
      seqHost: conv.seqHost,
      lastActivityAt: conv.lastActivityAt,
    }
    if (conv.emptySince !== undefined) conversation.emptySince = conv.emptySince
    conversations.push(conversation)
  }
  return { version: STATE_FILE_VERSION, savedAt: now, conversations }
}

/**
 * 把状态文件读回内存表。返回恢复的会话条数（0 = 没有状态文件 / 读坏了）。
 *
 * ## 为什么 `hostOfflineSince` 刻意**不**恢复（这是本函数最容易写错的一处）
 *
 * 落盘的六个字段里唯独它被丢掉，而这不是遗漏，是**必须**：
 *
 * `hostOfflineSince` 是"主机 socket 掉了，从那一刻起算 `hostGraceMs` 宽限期"的计时基线。
 * 读盘的那一刻进程刚起来，**没有任何主机连着**——`hosts` 表必然是空的。
 * 若把盘上的 `hostOfflineSince` 照搬过来，等于宣称"这台主机从上次落盘那一刻就已经离线"，
 * 于是 `expireOfflineHosts` 会**从进程启动那刻**开始判死：一次 130 秒的停机维护
 * （`systemctl stop` → `start`）就能让宽限期当场到期，会话被回收，手机重新扫码——
 * **比不做落盘还糟**，它把一次可预期的重启变成了确定性掉线。
 *
 * 所以恢复出来的会话一律是"主机在场、只是还没连上"。宽限期的计时**只**从
 * `hostGone` 打点的那一刻起算，也就是必须有一个真实的主机 socket 先掉过。
 * 主机随后连上来发 `resync()` 声明它仍持有的会话，那条路上本来就会清掉
 * 主机已经忘记的会话（复核 R1）——所以"读回来但主机不认"这条垃圾路径
 * 有它自己的收敛机制，不需要靠 `hostOfflineSince` 去兜。
 *
 * ## `emptySince` 的两种恢复
 *
 * - 盘上有值：照搬。空会话的回收计时跨重启延续，符合"回收要在内存与盘上同步"的纪律。
 * - 盘上没值但**成员表确实是空的**：`sanitize` 允许 `emptySince` 缺失（它是可选字段），
 *   这时按**此刻**起算——会话已经空了却没人打点的话，它会一直挂到 7 天的空闲 TTL，
 *   正好落在 `sweepIdle` 与 `sweepEmpty` 之间那个没人管的缝里。
 * - 盘上有成员：清掉计时（与 `markEmpty` 的"只要还有成员就撤销"同一条规则）。
 */
export function restoreState(path: string, state: RelayState, log: Log, now: number): number {
  const file = readStateFile(path, log)
  if (!file) return 0
  for (const entry of file.conversations) {
    const conv: Conversation = {
      hostId: entry.hostId,
      clients: new Set(entry.clients),
      seqHost: entry.seqHost,
      lastActivityAt: entry.lastActivityAt,
    }
    conv.emptySince = conv.clients.size === 0 ? (entry.emptySince ?? now) : undefined
    state.conversations.set(entry.conversationId, conv)
  }
  log.info('state restored', { path, conversations: state.conversations.size })
  return state.conversations.size
}

/**
 * 原子写。
 *
 * 临时文件放在**目标同目录**：`rename` 只在同一文件系统内是原子的，写到 `/tmp`
 * 再搬过来在某些挂载下会退化成 copy（半截文件就此可能）。
 * 返回 false = 写失败（调用方记日志与计数，但**不许**因此让中继退出）。
 */
export function writeStateFile(path: string, snapshot: PersistedState, log: Log): boolean {
  // 同目录的临时名带上 pid：并发两个中继实例指向同一个文件时，后写的临时文件
  // 不会互相踩（踩了也只是丢一次更新，不会读到一个半截文件）。
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch (e) {
    log.warn('state file write failed', { path, message: String((e as Error)?.message ?? e) })
    try {
      // 临时文件不许留在盘上过夜：它是一份没人读的完整状态，运维会以为它才是真相。
      unlinkSync(tmp)
    } catch {
      /* 清理失败不追加日志：它本来就是清理失败，而且抛出去会把整次写盘反转成崩溃 */
    }
    return false
  }
}
