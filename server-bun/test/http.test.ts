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
  test('首页 HTML，带表单和系统列表', async () => {
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-store')
    const html = await r.text()
    expect(html).toContain('<html lang="zh">')
    expect(html).toContain('action="/create"')
    expect(html).toContain('name="mem"')
    // 中文页面的标题文案
    expect(html).toContain('选择系统配置')
    expect(html).toContain('Ubuntu')
  })

  test('?lang=en 切英文', async () => {
    const html = await (await fetch(`${base}/?lang=en`)).text()
    expect(html).toContain('Choose OS')
    expect(html).toContain('Choose resources')
    expect(html).toContain('CPU cores')
    expect(html).toContain('<html lang="en">')
  })

  test('?lang=zh_tw 切繁体', async () => {
    const html = await (await fetch(`${base}/?lang=zh_tw`)).text()
    expect(html).toContain('選擇系統設定')
    expect(html).toContain('記憶體')
    expect(html).toContain('<html lang="zh-tw">')
  })

  test('Accept-Language 生效', async () => {
    const r = await fetch(`${base}/`, { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' } })
    expect(await r.text()).toContain('Choisir OS')
  })

  test('?os= 换系统会换版本列表', async () => {
    const list = (await (await fetch(`${base}/api/v2/superinspire/getOSList`)).json()) as any[]
    const debian = list.find((o) => o.value === 'debian' || o.label === 'Debian')
    if (!debian) return // 没有 debian 就跳过
    const code = debian.subList[0].osCode
    const html = await (await fetch(`${base}/?os=${encodeURIComponent(code)}`)).text()
    expect(html).toContain('checked')
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

  test('CPU 超范围 -> 400 + 错误文案', async () => {
    const r = await post({
      os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
      cpu: '99',
      mem: '512',
      ttl: '1',
      lang: 'zh',
    })
    expect(r.status).toBe(400)
    expect(await r.text()).toContain('CPU')
  })

  test('内存超范围 -> 400', async () => {
    const r = await post({
      os: 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
      cpu: '1',
      mem: '999999',
      ttl: '1',
      lang: 'zh',
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
    })
    expect(r.status).toBe(400)
  })

  test('不存在的 OS -> 400（不是 500）', async () => {
    const r = await post({ os: 'evil:latest', cpu: '1', mem: '512', ttl: '1', lang: 'zh' })
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
