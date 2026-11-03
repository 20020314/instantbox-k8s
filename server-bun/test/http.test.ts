/**
 * 本地 HTTP 冒烟：真的起 Bun.serve，用 fetch 打各种路由。
 *
 * 不连集群（k8s 客户端会被假 client 替换），只验路由分发、
 * 页面渲染、表单校验、WebSocket 升级前的 404 保护。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// 这些必须在 import index.ts 之前设好
process.env.INSTANTBOX_SERVER_PORT = '0' // 随机端口，避免和别的进程撞
process.env.INSTANTBOX_SWEEP_INTERVAL = '0' // 关掉后台扫描

let base = ''
let close = () => {}

beforeAll(async () => {
  // 动态 import：此时环境变量已就位
  await import('../src/index.ts')
  // index.ts 启动后把端口写进 process.env（下面这段在 index.ts 里做）
  const port = process.env.__INSTANTBOX_ACTUAL_PORT
  if (!port) throw new Error('server did not start')
  base = `http://127.0.0.1:${port}`
})

afterAll(() => close())

describe('探针', () => {
  test('/healthz 返回 ok', async () => {
    const r = await fetch(`${base}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })
})

describe('JSON API', () => {
  test('/api/v2/superinspire 有标识', async () => {
    const r = await fetch(`${base}/api/v2/superinspire`)
    expect(await r.text()).toBe('instantbox-k8s')
  })

  test('/api/v2/superinspire/getOSList 返回数组', async () => {
    const r = await fetch(`${base}/api/v2/superinspire/getOSList`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    const list = (await r.json()) as any[]
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    expect(list[0].subList[0].osCode).toBeTruthy()
  })

  test('未知的 api 路径 404', async () => {
    const r = await fetch(`${base}/api/v2/superinspire/nope`)
    expect(r.status).toBe(404)
  })
})

describe('页面', () => {
  test('首页 HTML，带向导和系统卡片', async () => {
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-store')
    const html = await r.text()
    expect(html).toContain('<html lang="zh">')
    // 复刻原版的结构锚点
    expect(html).toContain('class="app__title"')
    expect(html).toContain('class="app__text-editor-wrap"')
    expect(html).toContain('class="ant-steps"')
    expect(html).toContain('class="os-card')
    // 中文页面的标题文案
    expect(html).toContain('选择系统配置')
    expect(html).toContain('Ubuntu')
  })

  test('?lang=en 切英文', async () => {
    const html = await (await fetch(`${base}/?lang=en`)).text()
    expect(html).toContain('Choose OS')
    expect(html).toContain('Choose resources')
    expect(html).toContain('<html lang="en">')
    // 资源字段文案只在第二步出现，这里验 i18n 包本身
    const step2 = await fetch(`${base}/wizard`, {
      method: 'POST',
      body: new URLSearchParams({ os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', step: '1', lang: 'en' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).then((r) => r.text())
    expect(step2).toContain('CPU cores')
  })

  test('?lang=zh_tw 切繁体', async () => {
    const html = await (await fetch(`${base}/?lang=zh_tw`)).text()
    expect(html).toContain('選擇系統設定')
    expect(html).toContain('作業系統')
    expect(html).toContain('<html lang="zh-tw">')
  })

  test('Accept-Language 生效', async () => {
    const r = await fetch(`${base}/`, { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' } })
    expect(await r.text()).toContain('Choisir OS')
  })

  test('?os= 换系统会换选中的卡片', async () => {
    const list = (await (await fetch(`${base}/api/v2/superinspire/getOSList`)).json()) as any[]
    const debian = list.find((o) => o.value === 'debian' || o.label === 'Debian')
    if (!debian) return // 没有 debian 就跳过
    const code = debian.subList[0].osCode
    const html = await (await fetch(`${base}/?os=${encodeURIComponent(code)}`)).text()

    // 选中的那一项 selected
    expect(html).toMatch(new RegExp(`<option value="${code}" selected>`))

    // 而且 is-selected 必须落在 Debian 那张卡上，不能落在 Ubuntu 上
    expect(html).toContain('<div class="os-card is-selected"><div class="os-card-name">Debian</div>')
  })
})

// ---------------------------------------------------------------- 向导流程
// 这几条钉的是「还没点创建就建成功了」那个 bug：
// 第一步换版本 / 点下一步 / 点上一步，一律不许打到建 Pod 的路径上。
describe('向导流程（不碰 k8s）', () => {
  const UBUNTU = 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest'

  async function post(path: string, fields: Record<string, string>) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    })
  }

  test('第一步换系统版本：/wizard 原地重渲染，不跳 /created', async () => {
    const r = await post('/wizard', { os: UBUNTU, step: '0', lang: 'zh' })
    expect(r.status).toBe(200)
    expect(r.headers.get('location')).toBeNull()
    const html = await r.text()
    expect(html).toContain('class="os-cards"')
    expect(html).not.toContain('class="result-card"')
  })

  test('点下一步：进入第二步，仍然不建 Pod', async () => {
    const r = await post('/wizard', {
      os: UBUNTU,
      step: '0',
      lang: 'zh',
      action: 'next',
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('location')).toBeNull()
    const html = await r.text()
    expect(html).toContain('class="res-form"')
    expect(html).toContain('id="cpu"')
    expect(html).not.toContain('class="result-card"')
  })

  test('点上一步：回到第一步，带着之前选的系统', async () => {
    const r = await post('/wizard', {
      os: UBUNTU,
      step: '1',
      lang: 'zh',
      cpu: '2',
      mem: '1024',
      ttl: '4',
      action: 'back',
    })
    const html = await r.text()
    expect(html).toContain('class="os-cards"')
    expect(html).toMatch(new RegExp(`<option value="${UBUNTU}" selected>`))
  })

  test('★ 第二步点创建：只弹确认 Modal，不建 Pod', async () => {
    const r = await post('/create', {
      os: UBUNTU,
      cpu: '1',
      mem: '512',
      ttl: '1',
      lang: 'zh',
    })
    expect(r.status).toBe(200)
    // 关键：不能是 303 跳到 /created（那就是建成功了）
    expect(r.headers.get('location')).toBeNull()
    const html = await r.text()
    expect(html).toContain('class="mask"')
    expect(html).toContain('class="cfg-form"')
    // 确认按钮才带 confirm=1
    expect(html).toContain('name="confirm" value="1"')
  })

  test('Modal 里点取消：回到第二步，不建 Pod', async () => {
    const r = await post('/wizard', {
      os: UBUNTU,
      cpu: '1',
      mem: '512',
      ttl: '1',
      lang: 'zh',
      step: '1',
    })
    const html = await r.text()
    expect(html).not.toContain('class="mask"')
    expect(html).toContain('class="res-form"')
  })
})

describe('表单校验（不碰 k8s）', () => {
  async function post(fields: Record<string, string>) {
    const body = new URLSearchParams(fields)
    return fetch(`${base}/create`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    })
  }

  // 校验只在「已确认」之后才跑，所以每条都带 confirm=1
  test('CPU 超范围 -> 400 + 错误文案', async () => {
    const r = await post({
      os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
      cpu: '99',
      mem: '512',
      ttl: '1',
      lang: 'zh',
      confirm: '1',
    })
    expect(r.status).toBe(400)
    const html = await r.text()
    expect(html).toContain('CPU')
    expect(html).toContain('class="err-banner"')
  })

  test('内存超范围 -> 400', async () => {
    const r = await post({
      os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
      cpu: '1',
      mem: '999999',
      ttl: '1',
      lang: 'zh',
      confirm: '1',
    })
    expect(r.status).toBe(400)
  })

  test('时长超范围 -> 400', async () => {
    const r = await post({
      os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
      cpu: '1',
      mem: '512',
      ttl: '999',
      lang: 'zh',
      confirm: '1',
    })
    expect(r.status).toBe(400)
  })

  test('不存在的 OS -> 400（不是 500）', async () => {
    const r = await post({
      os: 'evil:latest',
      cpu: '1',
      mem: '512',
      ttl: '1',
      lang: 'zh',
      confirm: '1',
    })
    expect(r.status).toBe(400)
  })
})

describe('安全', () => {
  test('非沙箱名的 console 路径被拒（防 SSRF）', async () => {
    for (const bad of ['server', 'kube-dns', 'instantbox', '../../etc']) {
      const r = await fetch(`${base}/console/${encodeURIComponent(bad)}`)
      expect(r.status).toBe(404)
    }
  })

  test('★ /console/<pod> 不带斜杠时 301 补斜杠（否则 ttyd 的 ws 会丢前缀）', async () => {
    // 不跟随重定向，直接看响应头
    const r = await fetch(`${base}/console/instantbox-managed-abc123`, { redirect: 'manual' })
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/console/instantbox-managed-abc123/')
  })

  test('静态资源目录穿越被拒', async () => {
    // fetch 会把 ../ 规范化掉，所以用百分号编码和反斜杠两种绕过手法
    for (const p of ['/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fmanifest.json']) {
      const r = await fetch(`${base}${p}`)
      // 关键断言：不能把 package.json / manifest.json 的内容吐出来
      const body = await r.text()
      expect(body).not.toContain('"devDependencies"')
      expect(body).not.toContain('"osCode"')
    }
  })

  test('真正的 public/ 路径不存在时走页面渲染而不是 500', async () => {
    const r = await fetch(`${base}/favicon.ico`)
    // public/ 里只有 .gitkeep；找不到文件时回落到首页
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
  })
})

// ---------------------------------------------------------------- 结果页状态
describe('/created 的待启动标记', () => {
  const q = 'lang=zh&os=ghcr.io/20020314/sandbox-alpine-3.20:latest&cpu=1&mem=128&ttl=1'

  test('就绪：显示「您已创建系统」，没有启动中提示', async () => {
    const r = await fetch(`${base}/created?id=instantbox-managed-abc123&url=/console/instantbox-managed-abc123/&${q}`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('您已创建系统')
    expect(html).toContain('class="result-card"')
    expect(html).not.toContain('class="spin-text"')
  })

  test('未就绪：显示「系统正在启动」，并且仍给打开按钮', async () => {
    const r = await fetch(
      `${base}/created?pending=1&id=instantbox-managed-abc123&url=/console/instantbox-managed-abc123/&${q}`,
    )
    const html = await r.text()
    expect(r.status).toBe(200)
    // spin-text 里的长句就是「镜像还在拉取，系统启动中…」
    expect(html).toContain('class="spin-text"')
    expect(html).toContain('系统启动中')
    // 关键：不能被当成失败（bug 就是这个：Pod 建好了但显示失败）
    expect(html).not.toContain('class="err-banner"')
    expect(html).toContain('/console/instantbox-managed-abc123/')
  })
})

// ---------------------------------------------------------------- 异步创建
describe('异步创建：点确定立刻返回进度页', () => {
  test('/creating 是进度页：有转圈、有轮询脚本、没有建 Pod 的表单', async () => {
    const r = await fetch(`${base}/creating?lang=zh&id=instantbox-managed-abc123&os=x&cpu=1&mem=512&ttl=1`)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('class="spinner"')
    expect(html).toContain('class="creating-title"')
    // 轮询脚本必须指向 /api/job/
    expect(html).toContain('/api/job/')
    // 进度页不该再出现「创建」按钮（否则用户会重复点）
    expect(html).not.toContain('name="confirm" value="1"')
  })

  test('进度页不会渲染向导（避免用户以为还能改配置）', async () => {
    const r = await fetch(`${base}/creating?lang=zh&id=instantbox-managed-abc123`)
    const html = await r.text()
    expect(html).not.toContain('class="ant-steps"')
    expect(html).not.toContain('class="os-card')
  })

  test('/api/job/<id> 拒绝非法 id（防 SSRF / 越权查别的 Pod）', async () => {
    // 注意：不能直接写 `../../etc/passwd` —— fetch 会在发请求前把路径规范化掉，
    // 变成 /api/etc/passwd，压根到不了 job 路由。用编码形式才是真实攻击面。
    const bad = await fetch(`${base}/api/job/${encodeURIComponent('../../etc/passwd')}`)
    expect(bad.status).toBe(400)

    const bad2 = await fetch(`${base}/api/job/some-other-pod`)
    expect(bad2.status).toBe(400)

    // 带点 / 斜杠 / 空格的名字也得挡住
    for (const evil of ['a.b', 'a/b', 'a b']) {
      const r = await fetch(`${base}/api/job/${encodeURIComponent(evil)}`)
      expect(r.status).toBe(400)
    }
  })

  test('/api/job/<id> 对不存在的 Pod 返回 failed，而不是 500', async () => {
    const r = await fetch(`${base}/api/job/instantbox-managed-notexist`)
    const j = (await r.json()) as any
    expect(r.status).toBe(200)
    expect(j.phase).toBe('failed')
    // 必须带 query，前端才能跳 /created
    expect(typeof j.query).toBe('string')
    expect(j.query).toContain('id=instantbox-managed-notexist')
  })
})
