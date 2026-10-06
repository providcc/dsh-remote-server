/**
 * config.test — `loadConfig` 的取值与诊断清单（纯函数，不起 socket、不读文件）。
 *
 * 为什么单独一个文件：`loadConfig` 返回 `{config, problems}` 而不是直接
 * `process.exit`，为的就是让这些诊断能被断言——而"启动时会不会把运维做错的那件事说出来"
 * 正是一条行为，不是一个文档承诺。这份清单里每一条 warn 都对应一个**曾经真的会坏**的
 * 配置错误（HANDOFF §0.1 的 EROFS、§0.7 的附件发不出去都是同一类：功能看着正常，
 * 其实某一步根本没生效）。
 *
 * 这里只钉"诊断"这一面；取值本身由 `relay.test.mjs` / `persist.test.mjs` 顺带覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../dist/src/config.js'
import { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES } from 'dsh-remote-wire/frames'

const TOKEN = 'config-test-token-0123456789abcdef'
const load = (env = {}) => loadConfig({ DRC_HOST_TOKEN: TOKEN, ...env }, 'test')
const problemsOf = (env) =>
  load(env)
    .problems.filter((p) => p.level === 'warn')
    .map((p) => p.message)

test('默认帧预算与协议层的 MAX_RELAY_MESSAGE_BYTES 同源（两边不同源就是"附件发不出去"那条事故）', () => {
  const { config, problems } = load()
  assert.equal(
    config.maxMessageBytes,
    MAX_RELAY_MESSAGE_BYTES,
    '默认值必须与协议层同源，否则合法大帧会被自家 schema 与自家 ws 互相打架',
  )
  assert.deepEqual(problems, [], '默认配置必须一条告警都没有：默认路径是绝大多数人跑的那条，它不该先学会喊叫')
  // 结构性保证：协议层声明的最大密文 + 信封余量必须装得进中继的 ws.maxPayload。
  assert.ok(
    MAX_CIPHERTEXT_BYTES < MAX_RELAY_MESSAGE_BYTES,
    'MAX_CIPHERTEXT_BYTES 必须留出信封余量，否则"合法帧必然过得了中继"这句就只是估算',
  )
})

test('把帧预算调到协议上限之下时必须告警：那会让合法密文帧被 ws 以 1009 关掉整条连接', () => {
  // 旧实现的默认值就是 256 KiB——这正是"流式输出说到一半就重连"那次事故的配置值。
  const messages = problemsOf({ DRC_MAX_MSG_BYTES: String(256 * 1024) })
  assert.equal(messages.length, 1, `调小帧预算必须被说破，实际 problems：${JSON.stringify(messages)}`)
  assert.match(messages[0], /DRC_MAX_MSG_BYTES/, '告警文案必须点名是哪一个环境变量')
  assert.match(messages[0], /1009/, '告警文案要说清后果是连接被关掉，而不是"帧被拒"')
  assert.match(
    messages[0],
    new RegExp(String(MAX_RELAY_MESSAGE_BYTES)),
    '告警文案要给出建议值，否则运维不知道该改成多少',
  )
})

test('帧预算调大只字不提：协议层仍按自己的上限收，多出来的余量没有坏处', () => {
  assert.deepEqual(
    problemsOf({ DRC_MAX_MSG_BYTES: String(4 * 1024 * 1024) }),
    [],
    '调大是无害的，不该误报——否则这条告警很快就被当成噪音关掉',
  )
})

test('缺 token 是 error、短 token 是 warn：两种诊断不许串味', () => {
  const missing = loadConfig({}, 'test')
  assert.ok(
    missing.problems.some((p) => p.level === 'error' && /DRC_HOST_TOKEN is required/.test(p.message)),
    '缺 token 必须挡启动（CI 里有一条断言这条）',
  )
  assert.equal(
    load({ DRC_HOST_TOKEN: 'short' }).problems.some((p) => p.level === 'error'),
    false,
    '短 token 不该拦启动',
  )
  assert.ok(
    problemsOf({ DRC_HOST_TOKEN: 'short' }).some((m) => /shorter than 24/.test(m)),
    '短 token 必须告警',
  )
})

test('非法的数值/日志级别是 error，且把收到的原值写进消息（照着改才有意义）', () => {
  const bad = loadConfig({ DRC_HOST_TOKEN: TOKEN, DRC_PORT: '70000', DRC_LOG_LEVEL: 'verbose' }, 'test')
  for (const name of ['DRC_PORT', 'DRC_LOG_LEVEL']) {
    assert.ok(
      bad.problems.some((p) => p.level === 'error' && p.message.includes(name)),
      `${name} 的非法取值必须报错并点名`,
    )
  }
  // 端口 0 合法（让系统分配），不能被"正整数"那条误伤。
  assert.equal(load({ DRC_PORT: '0' }).config.port, 0, 'DRC_PORT=0 是"让系统分配"的官方用法')
  assert.equal(load({ DRC_PORT: '' }).config.port, 8787, '空串等于没设，必须走默认值而不是报错')
})
