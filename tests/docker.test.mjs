/**
 * docker.test — 容器产物的判据。
 *
 * ## 为什么容器文件也要有判据
 *
 * deploy/docker/ 里的三个文件**不在 tsc 的编译面里，也不在任何一次启动路径上**：
 * 它们只在"有人真的要部署"时才被读到。所以它们的失效形态与其他代码不同 ——
 * 不是抛异常，而是**部署出来的东西不对，而没人发现**：
 *
 * - HEALTHCHECK 被删 → 容器永远 healthy，停机中的实例照样被派发流量；
 * - USER 被删 → 容器以 root 跑，而加固项（read_only / cap_drop）看起来还在；
 * - DRC_BIND 被删 → 容器起来、端口也发布了，**外面连不上**（代码默认绑 127.0.0.1）；
 * - 端口发布从回环改成 0.0.0.0 → 8787 直接暴露公网，绕过 nginx 的按 IP 限流；
 * - DRC_STATE_FILE 与卷配错一边 → 状态写在容器可写层，`docker compose down` 即丢。
 *
 * 这五条里前四条是"照抄时容易丢的一行"，第五条是"配错了没人提醒"。判据因此逐条钉住
 * **文本事实**（这份文件里必须写着什么），而不是"跑一次容器看看" —— 后者在没装 Docker
 * 的机器上直接不可用，而这正是最需要这道闸的场景。
 *
 * 有两条判据在装了 docker 的机器上会**额外**做真事（跳过而不是假装通过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const DOCKERFILE = read('deploy/docker/Dockerfile')
const COMPOSE = read('deploy/docker/compose.yaml')
const IGNORE = read('.dockerignore')

test('Dockerfile：两条 FROM 指向同一个镜像（ARG 版本在 legacy builder 上构建失败）', () => {
  const froms = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  assert.equal(froms.length, 2, `应当正好两个阶段，实际 ${JSON.stringify(froms)}`)
  assert.equal(froms[0], froms[1], `两个阶段的 base image 必须一致：${JSON.stringify(froms)}`)
  assert.match(froms[0], /node:22/, 'Node 22 与 CI、与 HANDOFF 的工具链口径一致')
  // 这条是踩过的：ARG NODE_IMAGE + FROM ${NODE_IMAGE} 在只有 legacy builder 的机器上
  // 直接构建失败（NotFound: content digest），所以刻意不用 ARG。
  assert.doesNotMatch(DOCKERFILE, /^ARG NODE_IMAGE/m, 'ARG 版的 FROM 在 legacy builder 上构建不了')
})

test('Dockerfile：运行阶段以非 root 身份跑', () => {
  assert.match(DOCKERFILE, /^USER 10001:10001$/m, '必须是非 root，且 uid/gid 写死（与 systemd 形态取同一组数字）')
  assert.match(DOCKERFILE, /adduser -u 10001/, '镜像里要有这个用户，否则 USER 指向一个不存在的账号')
})

test('Dockerfile：HEALTHCHECK 在，且判的是 ok 字段而不是 HTTP 200', () => {
  const line = /^HEALTHCHECK .*$/m.exec(DOCKERFILE)?.[0] ?? ''
  assert.ok(line, '没有 HEALTHCHECK：容器状态会永远是 healthy，停机中的实例照样被派发流量')
  assert.match(line, /j\.ok===true/, '要判 /healthz 的 ok 字段：停机中它明确回 503 + ok:false')
  assert.doesNotMatch(line, /curl|wget/, '运行阶段本来就只有 node，不为一个探针多装二进制')
})

test('Dockerfile：运行时零依赖（runtime 阶段只有那一个产物文件）', () => {
  const runtime = DOCKERFILE.split('AS runtime')[1] ?? ''
  assert.match(runtime, /COPY --from=build .*dist\/bundle\/main\.js/, 'runtime 必须只从 build 阶段取那一个产物')
  assert.doesNotMatch(runtime, /^RUN (npm|pnpm) (install|ci)/m, 'runtime 阶段不许有依赖安装：这条是本镜像存在的理由')
  assert.doesNotMatch(DOCKERFILE, /^COPY .*node_modules/m, '不许把 node_modules 拷进任何阶段')
})

test('Dockerfile：产物级断言在构建里（离线搬运时 CI 并不在场）', () => {
  // 镜像是"在别处构建、再 docker load 过去"的，所以断言不能只住在 tests/ 里。
  assert.match(DOCKERFILE, /head -1 dist\/bundle\/main\.js/, 'shebang 断言')
  assert.match(DOCKERFILE, /产物里没有包版本/, '版本号断言：否则 /healthz 的 version 会是 0.0.0 而没人发现')
})

test('Dockerfile：DRC_BIND 被显式设成 0.0.0.0（容器自己就是边缘）', () => {
  // 代码默认绑 127.0.0.1。容器里那样绑 = `-p` 发布成功但外面连不上。
  // 这条在 SELF-HOSTING.md 里被单独警告过一次，是最容易在复制粘贴中丢掉的一行。
  const env = /^ENV .*$/m.exec(DOCKERFILE)?.[0] ?? ''
  assert.match(env, /DRC_BIND=0\.0\.0\.0/, `ENV 行里必须有 DRC_BIND=0.0.0.0，实际：${env}`)
  assert.doesNotMatch(env, /DRC_STATE_FILE/, '镜像里**故意不设** DRC_STATE_FILE：落盘路径属于部署形态，与卷由 compose 配')
})

test('Dockerfile：STOPSIGNAL 与 ENTRYPOINT 的形状', () => {
  assert.match(DOCKERFILE, /^STOPSIGNAL SIGTERM$/m, '必须是 SIGTERM：main.ts 靠它走优雅停机')
  assert.match(
    DOCKERFILE,
    /^ENTRYPOINT \["node", "\/app\/relay\.mjs"\]$/m,
    'ENTRYPOINT 固定、参数透传，docker run … --version 才能问出镜像里是哪一版',
  )
})

test('compose：端口只发布到宿主机回环（nginx 一行都不用改的前提）', () => {
  assert.match(
    COMPOSE,
    /- "127\.0\.0\.1:\$\{DRC_PORT(?::-\d+)?\}:\$\{DRC_PORT(?::-\d+)?\}"/,
    '必须是 127.0.0.1:PORT:PORT：绑 0.0.0.0 会把 8787 直接暴露公网、绕过 nginx 的按 IP 限流',
  )
  assert.doesNotMatch(COMPOSE, /- "0\.0\.0\.0:/, '不许发布到 0.0.0.0')
  assert.match(COMPOSE, /DRC_BIND: "0\.0\.0\.0"/, '容器内必须绑 0.0.0.0，否则发布了没人监听')
})

test('compose：落盘路径与卷是一对，且默认用具名卷', () => {
  const stateFile = /^\s*DRC_STATE_FILE:.*$/m.exec(COMPOSE)?.[0] ?? ''
  const volume = /^\s*- \$\{DRC_DATA_DIR(?::-[^}]+)?\}:\/data$/m.exec(COMPOSE)?.[0] ?? ''
  assert.match(stateFile, /\/data\/state\.json/, `DRC_STATE_FILE 要落在挂载点上，实际：${stateFile}`)
  assert.ok(volume, '必须挂 /data')
  assert.match(COMPOSE, /^volumes:\n\s+relay-data:/m, '要有具名卷 relay-data：Docker 用镜像里 /data 的属主初始化它，开箱即用')
  assert.match(volume, /:-relay-data\}/, 'DRC_DATA_DIR 的默认值必须是那个具名卷，而不是 ./data（后者属主由宿主机决定）')
})

test('compose：加固项与 systemd 单元取同一个口径', () => {
  for (const [pattern, why] of [
    [/^\s*read_only: true$/m, '只读根文件系统：中继只写 /data'],
    [/^\s*cap_drop:/m, '它不需要任何 capability'],
    [/no-new-privileges:true/, '不需要提权'],
    [/^\s*mem_limit: 512m$/m, '与单元里的 MemoryMax=512M 同一个数'],
    [/^\s*stop_grace_period: 15s$/m, '必须大于程序内部 5 秒兜底，否则 compose 先 SIGKILL，最后一次补写被砍掉'],
    [/max-size: "10m"/, '日志行数无界，不轮转会把磁盘吃满'],
  ]) {
    assert.match(COMPOSE, pattern, `compose 缺 ${pattern} —— ${why}`)
  }
  assert.match(COMPOSE, /restart: unless-stopped/, '崩溃即拉起；但**不是** always：优雅停机 exit 0 之后 always 会把它再拉起来')
  assert.doesNotMatch(COMPOSE, /restart: always/, 'always 是错的（"停机之后进程自己回来了"）')
})

test('compose：缺 token 时在启动前就报错', () => {
  assert.match(COMPOSE, /DRC_HOST_TOKEN: \$\{DRC_HOST_TOKEN:\?/, '用 :? 让 compose 自己拒绝，而不是让容器起来再拒绝（那时报错在 logs 里）')
})

test('.dockerignore：裁掉该裁的，留住构建要用的', () => {
  for (const entry of ['node_modules', 'dist', 'data', '.git', 'tests', 'docs']) {
    assert.match(IGNORE, new RegExp('^' + entry.replace('.', '\\.') + '$', 'm'), `.dockerignore 少了 ${entry}`)
  }
  // 这两个漏了就会构建失败或把构建搞慢，所以要在判据里点名。
  assert.doesNotMatch(IGNORE, /^scripts$/m, 'scripts/ 要留着：打包那一步在里面')
  assert.doesNotMatch(IGNORE, /^src$/m, 'src/ 要留着')
  assert.doesNotMatch(IGNORE, /^deploy$/m, 'deploy/ 不走 context（Dockerfile 用 -f 指定），裁掉它是可以的，但别在这里裁')
})

test('docker compose config 在装了 compose 的机器上真的成立（没装就跳过，不假装通过）', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('这台机器上没有 docker compose')
    return
  }
  const res = spawnSync('docker', ['compose', '-f', 'deploy/docker/compose.yaml', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRC_HOST_TOKEN: 'docker-test-dummy-token-0123456789' },
  })
  assert.equal(res.status, 0, `compose config 失败：${res.stderr}`)
  // 反过来：不给 token 必须失败，且错误信息要指名去哪里设。
  const missing = spawnSync('docker', ['compose', '-f', 'deploy/docker/compose.yaml', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRC_HOST_TOKEN: '' },
  })
  assert.notEqual(missing.status, 0, '缺 DRC_HOST_TOKEN 时 compose config 就该失败')
  assert.match(missing.stderr + missing.stdout, /DRC_HOST_TOKEN/, '失败信息要指名是哪个变量')
})
