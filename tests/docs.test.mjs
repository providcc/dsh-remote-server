/**
 * docs.test — 文档与实现的对齐判据（1.0.6 的卖点就是"文档说的就是实现做的"）。
 *
 * 为什么这些也要有判据：这一轮审计里文档侧的每一条错都不是"文笔问题"，而是
 * 运维照着它做会做错的那类错——配置表漏了两个已实现的变量、慢消费者窗口写成
 * 一刀切的 10 秒、"清扫每轮给所有 socket 发 ping"与分桶实现相反、
 * `droppedFrames` 的定义与计数点不符、以及一条客户端根本不消费的重放被写成机制。
 * 光靠"下次记得改"是挡不住它们的，所以这里用跨文件的机械判据钉住：
 * 代码里的常量/配置项/`health()` 字段 → 文档里必须有一致的表述。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRelay } from '../dist/src/server.js'
import { loadConfig } from '../dist/src/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8')

const CONFIG = read('src/config.ts')
const LIMITS = read('src/limits.ts')
const SERVER = read('src/server.ts')
const STATE = read('src/state.ts')
const DOC = read('docs/SELF-HOSTING.md')
const README = read('README.md')

/** 配置表里的一行（`| \`NAME\` | …`）。 */
const tableRow = (text, name) => new RegExp(`^\\|\\s*\`${name}\`\\s*\\|`, 'm').test(text)

test('文档配置表覆盖 config.ts 读的每一个 DRC_* 变量（漏一个，运维就不知道它能调）', () => {
  const names = [...new Set([...CONFIG.matchAll(/env\.(DRC_[A-Z0-9_]+)/g)].map((m) => m[1]))].sort()
  assert.ok(names.length > 20, `从 config.ts 里没抽到几个变量名，判据自己坏了：${names.length}`)
  const missing = names.filter((name) => !DOC.includes(`\`${name}\``))
  assert.deepEqual(missing, [], `docs/SELF-HOSTING.md 里没有这些配置项：${missing.join(', ')}`)
  const notInTable = names.filter((name) => !tableRow(DOC, name))
  assert.deepEqual(notInTable, [], `这些变量没进配置表（只在正文里提过）：${notInTable.join(', ')}`)
})

test('慢消费者：文档写的是"按角色给窗口"，且秒数与 limits.ts 的常量一致', () => {
  const seconds = (name) => {
    const raw = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(LIMITS)
    assert.ok(raw, `limits.ts 里找不到 ${name}`)
    return Number(raw[1].replace(/_/g, '')) / 1000
  }
  const host = seconds('HOST_SLOW_CONSUMER_MS')
  const client = seconds('CLIENT_SLOW_CONSUMER_MS')
  assert.notEqual(host, client, '两个窗口本来就该不同：主机 10s / 客户端 45s')

  for (const [name, value] of [
    ['DRC_SLOW_CONSUMER_HOST_MS', host],
    ['DRC_SLOW_CONSUMER_CLIENT_MS', client],
  ]) {
    const row = new RegExp(`^\\|\\s*\`${name}\`.*$`, 'm').exec(DOC)?.[0] ?? ''
    assert.match(row, new RegExp(`${value} 秒`), `${name} 那一行没写清窗口是 ${value} 秒：${row}`)
    assert.ok(tableRow(README, name), `README 的常用配置表也漏了 ${name}`)
  }

  // 旧的"一刀切 10 秒"措辞必须消失：那条只对主机成立。
  const bufferedRow = /^\|\s*`DRC_MAX_BUFFERED_BYTES`.*$/m.exec(DOC)?.[0] ?? ''
  assert.ok(
    !/持续超限 \*\*10 秒\*\*/.test(bufferedRow),
    `DRC_MAX_BUFFERED_BYTES 又写成了一刀切的 10 秒：${bufferedRow}`,
  )
  assert.match(bufferedRow, /DRC_SLOW_CONSUMER_HOST_MS/, '阈值行必须指向按角色给的窗口')
  assert.match(bufferedRow, /DRC_SLOW_CONSUMER_CLIENT_MS/)
})

test('保活 ping：判死代价写的是 2×pingInterval，且清扫清单包含慢消费者判定', () => {
  const ops = DOC.slice(DOC.indexOf('### 6.1'))
  assert.match(ops, /2×`DRC_PING_INTERVAL_MS`/, '半开对端的判死代价必须写成 2×DRC_PING_INTERVAL_MS（默认约 121 秒）')
  assert.ok(!/2×5 秒判死/.test(ops), '旧说法"默认最坏约 2×5 秒判死"与分桶实现矛盾，不能回来')
  // 清扫那一条必须同时说到：ping 不在清扫上、慢消费者判定在清扫上。
  const sweepBullet = /- \*\*每个清扫周期[\s\S]*?(?=\n- )/.exec(ops)?.[0] ?? ''
  assert.match(sweepBullet, /慢消费者判定/, '清扫清单漏了挂在它上面的慢消费者判定')
  assert.ok(!/给所有 socket 发 WS 层 ping/.test(sweepBullet), '清扫不再"给所有 socket 发 ping"：那是分桶之前的实现')
  assert.match(ops, /DRC_PING_TICK_MS/, 'ping 的独立节奏（tick + 桶轮转）要写明')
})

test('droppedFrames 的定义与计数点一致：收下但没有收件人（不是"缓冲区超限被丢"）', () => {
  const row = /^\|\s*`droppedFrames`.*$/m.exec(DOC)?.[0] ?? ''
  assert.ok(row, 'healthz 字段表里没有 droppedFrames')
  assert.ok(!/缓冲区超限/.test(row), `droppedFrames 又写成了慢消费者那一类：${row}`)
  assert.match(row, /收件人/, '定义必须是"收下但没有收件人的帧"')
  assert.match(row, /slowConsumers/, '要指向真正管慢消费者的那个字段，别让两件事混在一个数里')
})

test('peer-joined 重放已删除：文档写的是 hello-ok → cmd.list_sessions 这条路', () => {
  const ops = DOC.slice(DOC.indexOf('### 6.1'))
  assert.ok(!/重放给已连接的客户端/.test(ops), '文档仍在描述已删除的 peer-joined 重放')
  assert.match(ops, /cmd\.list_sessions/, '要说清客户端续用旧 convId 的真正路径')
  // 代码侧同步钉一下：handleHello 里不许再出现 peer-joined（防"文档改了代码没改"的反向漂移）。
  // 先剥掉注释——解释"为什么删掉它"的注释里当然会提到这个名字。
  const handleHello = (/function handleHello[\s\S]*?\n  }\n/.exec(SERVER)?.[0] ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(handleHello.length > 100, '从 server.ts 里抽不出 handleHello，判据自己坏了')
  assert.ok(!/peer-joined/.test(handleHello), 'handleHello 里又出现了 peer-joined 重放')
})

test('state.ts 的文件头注释与落盘实现一致（不再宣称"不持久化是有意设计"）', () => {
  const header = STATE.slice(0, STATE.indexOf('*/'))
  assert.ok(!/不持久化是有意设计/.test(header), '文件头仍写着"不持久化是有意设计"，与 1.0.6 的落盘实现矛盾')
  assert.ok(!/\*\*全在内存\*\*/.test(header), '文件头仍把"全在内存"当作无条件的结论')
  assert.match(header, /DRC_STATE_FILE/, '要说清哪张表在什么条件下落盘')
  assert.match(header, /pendingPairs/, '要说清另外三张表为什么永远只在内存里')
})

test('/healthz 的每一个字段都在文档的表里（新增字段不许只活在代码里）', () => {
  const { config } = loadConfig({ DRC_HOST_TOKEN: 'docs-alignment-token-0123456789' }, 'test')
  const relay = createRelay(config)
  const keys = Object.keys(relay.health())
  assert.ok(keys.includes('shutdownForced'), 'health() 少了兜底停机计数')
  const missing = keys.filter((key) => !tableRow(DOC, key))
  assert.deepEqual(missing, [], `docs/SELF-HOSTING.md 的 /healthz 字段表缺：${missing.join(', ')}`)
  for (const key of keys) {
    assert.ok(README.includes(key), `README 的端点表没提到 ${key}`)
  }
})
