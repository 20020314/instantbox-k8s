/**
 * instantbox on Kubernetes —— 一个 Bun 进程同时充当控制面 + 网关
 *
 * 路由：
 *   /api/v2/superinspire/*   控制面（建/删/回收沙箱 Pod）
 *   /console/<pod>/ws        ttyd WebSocket 反代（双向桥接）
 *   /console/<pod>/*         ttyd HTTP 反代
 *   /healthz  /readyz        探针
 *   /*                       前端静态资源 + SPA 兜底
 *
 * ---------------------------------------------------------------------------
 * WebSocket 子协议：实测出来的三条硬结论（很反直觉，踩过才知道）
 *
 *   Bun 1.2.23 的 WebSocket 实现有几处和 RFC 直觉相悖的地方，全部在集群里
 *   用最小复现验证过（见 README「WebSocket 子协议实测」）：
 *
 *   1) 浏览器侧：Bun.serve 会自动把客户端声明的 Sec-WebSocket-Protocol
 *      原样回显到 101 响应里。**不要手工再写一遍**——手工加会得到两个同名
 *      响应头，客户端直接 `1002 Mismatch client protocol` 断连。
 *
 *   2) 上游侧：Bun 的 WebSocket 客户端连 ttyd **必须**声明 ['tty']。
 *      不带子协议时 ttyd 不报错、也不输出任何字节（静默黑洞，排查极难）。
 *
 *   3) 但 2) 有一个副作用：如果对端是 Bun.serve 且自动回显了协议，
 *      Bun 客户端仍会 `1002 Mismatch`。所以只能对真正的 ttyd 用。
 *
 *   净结果：server.upgrade 时只加无害的自定义头；连上游时带 ['tty']。
 * ---------------------------------------------------------------------------
 * 为什么用 Bun.serve 而不是 Elysia：
 *   网关需要精确控制 101 响应、需要把 Bun 的 ws 和上游 ws 双向桥接、
 *   还要在同进程里读本地静态文件。这些用 Bun.serve 直接写反而更短更可控，
 *   而 Elysia 的抽象层在这个场景下没有收益（它是为 HTTP 路由设计的）。
 * ---------------------------------------------------------------------------
 * 为什么不用 @kubernetes/client-node：
 *   它把证书挂在 Node 的 https.Agent 上，Bun 的 fetch 会忽略 Agent，
 *   导致 apiserver TLS 认证失败。见 k8s.ts 顶部说明。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cfg } from './config'
import { getManager } from './sandbox'
import { DEFAULT_LOCALE, fromAcceptLanguage, pickLocale, strings } from './frontend/i18n'
import { renderToString } from './frontend/jsx-runtime'
import { renderPage, type PageState } from './frontend/page'

const MAX_TIMEOUT_AHEAD = 3600 * 24

/**
 * 建完 Pod 后等多久才算「创建成功」。
 *
 * 为什么必须等：createPod 只是把 spec 交给 apiserver，Pod 此刻还是 Pending
 * （调度 + 拉镜像 + 起容器，实测首次拉镜像要 20~90s）。原来不管 phase 直接
 * 返回成功，用户点「打开系统」立刻 502，看起来像创建失败——而实际上 Pod
 * 好好地建出来了，只是没就绪。这就是「显示创建失败但其实建了」的根因。
 */
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000

const PUBLIC_DIR =
  process.env.INSTANTBOX_PUBLIC_DIR || join(import.meta.dir, '..', 'public')

/** 沙箱名白名单：不能带点、斜杠、@，否则拼进 upstream 就是 SSRF */
const POD_RE = /^instantbox-managed-[a-z0-9]{4,40}$/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i).toLowerCase()
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 和原版 flask-cors 保持一致
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Headers': 'x-requested-with',
    },
  })
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** 沙箱 upstream。★ 必须 FQDN：Bun 的 DNS 不做 /etc/resolv.conf 的 search 补全 */
function sandboxHost(pod: string): string {
  return `${pod}.${cfg.POD_NAMESPACE}.svc.cluster.local:${cfg.TTYD_PORT}`
}

/** 每个 WS 连接的状态 */
interface WsState {
  upstream?: WebSocket
  ready: boolean
  queue: Array<string | Uint8Array | ArrayBuffer>
  pod: string
}

// ---------------------------------------------------------------- 前端页面
function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 页面里有当前选中的系统/语言，必须每次重算
      'Cache-Control': 'no-store',
    },
  })
}

function localeOf(url: URL, req: Request): PageState['locale'] {
  const q = url.searchParams.get('lang')
  if (q) return pickLocale(q)
  return fromAcceptLanguage(req.headers.get('accept-language')) ?? DEFAULT_LOCALE
}

/** GET / 渲染页面；query 里可以带 os/cpu/mem/ttl/lang */
function renderHome(url: URL, req: Request, extra: Partial<PageState> = {}): Response {
  const locale = extra.locale ?? localeOf(url, req)
  const osList = getManager().osList
  const wanted = extra.selectedOs ?? url.searchParams.get('os') ?? ''
  const selected = getManager().isOsAvailable(wanted)
    ? wanted
    : (osList[0]?.subList[0]?.osCode ?? '')

  return html(
    renderToString(
      renderPage({
        locale,
        osList,
        selectedOs: selected,
        cpu: url.searchParams.get('cpu') ?? undefined,
        mem: url.searchParams.get('mem') ?? undefined,
        ttl: url.searchParams.get('ttl') ?? undefined,
        ...extra,
      }),
    ),
  )
}

/** 校验表单参数，返回错误文案（null = 通过） */
function validateForm(cpu: string, mem: string, ttl: string, osName: string): string | null {
  if (!getManager().isOsAvailable(osName)) return 'ERR_OS'
  const c = Number(cpu)
  if (!Number.isFinite(c) || c < 1 || c > 4) return 'ERR_CPU'
  const m = Number(mem)
  if (!Number.isFinite(m) || m < 64 || m > cfg.MAX_MEM_MB) return 'ERR_MEM'
  const h = Number(ttl)
  if (!Number.isFinite(h) || h < 1 || h > 24) return 'ERR_TTL'
  return null
}

/**
 * 轮询直到 Pod 进入 Running（或超时/失败）。
 *
 * 返回 'running' | 'timeout' | 'failed'。
 *   * timeout：调度或拉镜像太慢。Pod 还在，调用方应该告诉用户「稍等一下再点」
 *     而不是「创建失败」——这是两个完全不同的处置。
 *   * failed ：Pod 进入 Failed / 被驱逐，确实是失败。
 */
async function waitUntilRunning(name: string): Promise<'running' | 'timeout' | 'failed'> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const st = await getManager().status(name)
    // status 返回 null = 查不到（已被回收/删除），当作失败
    if (!st) return 'failed'
    if (st.phase === 'Running') return 'running'
    if (st.phase === 'Failed' || st.phase === 'Succeeded') return 'failed'
    await Bun.sleep(READY_POLL_MS)
  }
  return 'timeout'
}

// ---------------------------------------------------------------- 控制面
async function handleApi(pathname: string, url: URL): Promise<Response> {
  const p = pathname.replace(/^\/api/, '')
  const API = '/v2/superinspire'

  if (p === API) return text('instantbox-k8s')

  if (p === `${API}/getOSList`) {
    return json(getManager().osList)
  }

  if (p === `${API}/getOS`) {
    const mgr = getManager()
    const osName = url.searchParams.get('os')

    if (!mgr.isOsAvailable(osName)) {
      return json({ message: 'The image is not supported at this time ERROR', statusCode: 0 })
    }

    const mem = url.searchParams.get('mem') || '512'
    const cpu = url.searchParams.get('cpu') || '1'

    const maxTimeout = MAX_TIMEOUT_AHEAD + Date.now() / 1000
    let expireAt = maxTimeout
    const rawTimeout = url.searchParams.get('timeout')
    if (rawTimeout !== null) {
      const parsed = Number.parseFloat(rawTimeout)
      if (!Number.isFinite(parsed)) {
        return json({ message: 'Arguments ERROR', statusCode: 0 })
      }
      expireAt = Math.min(parsed, maxTimeout)
      if (expireAt <= Date.now() / 1000) {
        return json({ message: 'Arguments ERROR', statusCode: 0 })
      }
    }

    const name = await mgr.create({ mem, cpu, osName: osName!, expireAt })
    if (!name) {
      return json({ message: 'RUN pod ERROR', shareUrl: '', statusCode: 0 })
    }

    // 等就绪再回 shareUrl：调用方拿到地址就能直接连，不会先吃一个 502
    const ready = await waitUntilRunning(name)
    if (ready === 'failed') {
      await mgr.rm(name).catch(() => {})
      return json({ message: 'RUN pod ERROR', shareUrl: '', statusCode: 0 })
    }
    if (ready === 'timeout') {
      // Pod 还在拉镜像：不算失败，把地址给出去，让调用方自己决定重试
      return json({
        message: 'PENDING',
        shareUrl: mgr.shareUrl(name),
        containerId: name,
        openPort: null,
        statusCode: 1,
      })
    }

    return json({
      message: 'SUCCESS',
      shareUrl: mgr.shareUrl(name),
      containerId: name,
      // 恒为 null：K8s 下没有「临时对外开放端口」这回事
      openPort: null,
      statusCode: 1,
    })
  }

  if (p === `${API}/rmOS`) {
    const id = url.searchParams.get('containerId')
    if (!id) return json({ message: 'Arguments ERROR', shareUrl: '', statusCode: 0 })
    if (!(await getManager().rm(id))) {
      return json({ message: 'RM pod ERROR', shareUrl: '', statusCode: 0 })
    }
    return json({ message: 'SUCCESS', statusCode: 1, containerId: id })
  }

  if (p === `${API}/prune`) {
    try {
      const removed = await getManager().prune()
      return json({ message: 'Success', statusCode: 1, removed })
    } catch (err) {
      return json({ message: `ERROR: ${(err as Error).message}`, statusCode: 0 })
    }
  }

  return text('not found', 404)
}

// ---------------------------------------------------------------- 静态资源
/** public/ 下如果有同名文件就发文件（留给以后放 logo 之类的静态资源） */
function serveStatic(pathname: string): Response | null {
  if (pathname.includes('..')) return text('bad path', 400)
  const file = join(PUBLIC_DIR, pathname)
  if (!existsSync(file)) return null

  const ext = extOf(file)
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  }
  try {
    return new Response(readFileSync(file), { headers })
  } catch {
    return null
  }
}

/** 表单校验失败时，按错误码取本地化文案 */
function formErrorText(code: string, locale: PageState['locale']): string {
  const t = strings[locale]
  switch (code) {
    case 'ERR_OS':
      return t.sentence['err-empty-os']
    case 'ERR_CPU':
      return `${t.sentence['err-cpu-core-count']}（${t.sentence['msg-cpu-core-count']}）`
    case 'ERR_MEM':
      return `${t.sentence['err-memory-in-mb']}（${t.sentence['msg-memory-in-mb']}）`
    case 'ERR_TTL':
      return `${t.sentence['err-ttl-in-hours']}（${t.sentence['msg-ttl-in-hours']}）`
    default:
      return code
  }
}

/**
 * 从表单里捞出向导的四个字段。
 *
 * 表单在各步之间来回提交，不管当前显示哪一步，cpu/mem/ttl 都可能还没渲染出来
 * （第一步只有系统卡片）。所以缺省值在这里补齐，不能让空串流进 validateForm。
 */
interface WizardFields {
  locale: PageState['locale']
  osName: string
  cpu: string
  mem: string
  ttl: string
}

function wizardFields(form: FormData): WizardFields {
  return {
    locale: pickLocale(String(form.get('lang') ?? '') || null),
    osName: String(form.get('os') ?? ''),
    cpu: String(form.get('cpu') ?? '') || '1',
    mem: String(form.get('mem') ?? '') || '512',
    ttl: String(form.get('ttl') ?? '') || '24',
  }
}

/**
 * 向导中途的重渲染（不建任何东西）。
 *
 * 复刻原版 SelectSystemConfig 的交互语义：
 *   * 第一步选系统 / 换版本 —— 原版是 setState，这里等于一次表单重提
 *   * Next / Back           —— 切 step
 *   * 第二步点 Create       —— 原版弹 Modal（modalVisible=true），确认才调 API
 *
 * 状态全部走 POST body 往返，服务端无 session：刷新页面就回到第一步，
 * 这是有意的（避免「换个浏览器还记着上次没确认的配置」）。
 */
function renderWizard(
  f: WizardFields,
  step: 0 | 1,
  confirm: boolean,
  error?: string,
): Response {
  const extra: Partial<PageState> = {
    locale: f.locale,
    selectedOs: f.osName,
    cpu: f.cpu,
    mem: f.mem,
    ttl: f.ttl,
    step,
    confirm,
    error,
  }
  return html(
    renderToString(
      renderPage({
        locale: f.locale,
        osList: getManager().osList,
        selectedOs: f.osName,
        ...extra,
      }),
    ),
    error && step === 1 ? 400 : 200,
  )
}

/**
 * POST /wizard —— 向导所有「不建东西」的动作入口。
 *
 * 从 <select onchange="this.form.requestSubmit()"> 提交过来时没有 action 字段，
 * 这种就是「只是换了个系统版本」，原地重渲染当前步即可。
 */
async function handleWizard(req: Request): Promise<Response> {
  const form = await req.formData()
  const f = wizardFields(form)
  const action = String(form.get('action') ?? '')
  const cur = form.get('step') === '1' ? 1 : 0

  if (action === 'next') return renderWizard(f, 1, false)
  if (action === 'back') return renderWizard(f, 0, false)
  // noop / 无 action（换版本 / 换语言）：留在当前步
  return renderWizard(f, cur, false)
}

/** POST /create —— 第二步 Create 的入口：先弹确认框，确认后才真建 */
async function handleCreate(req: Request): Promise<Response> {
  const form = await req.formData()
  const f = wizardFields(form)
  const { locale, osName, cpu, mem, ttl } = f
  const action = String(form.get('action') ?? '')
  const confirm = form.get('confirm') === '1'

  // 第一步的 Create 是禁用的，正常到不了这里；万一绕过了就退回第一步
  if (action === 'next') return renderWizard(f, 1, false)
  if (action === 'back') return renderWizard(f, 0, false)
  if (action === 'noop') return renderWizard(f, 0, false)

  // ★ 关键分流：还没确认 → 只弹 Modal，不建 Pod。
  //   原版也是「点 Create 只 setState(modalVisible=true)」，
  //   Modal 里点 OK 才真正调 API。之前少了这一层，
  //   选版本时的一次 requestSubmit() 就把 Pod 建出来了。
  if (!confirm) return renderWizard(f, 1, true)

  const bad = validateForm(cpu, mem, ttl, osName)
  if (bad) return renderWizard(f, 1, false, formErrorText(bad, locale))

  const mgr = getManager()
  const maxTimeout = MAX_TIMEOUT_AHEAD + Date.now() / 1000
  const expireAt = Math.min(Date.now() / 1000 + Number(ttl) * 3600, maxTimeout)

  const name = await mgr.create({ mem, cpu, osName, expireAt })
  if (!name) {
    return renderWizard(f, 1, false, strings[locale].sentence['err-creation'])
  }

  // 等 Pod 真的 Running 再去结果页。否则用户点「打开系统」会吃到 502，
  // 误以为创建失败（实际是还在拉镜像）。
  const ready = await waitUntilRunning(name)
  if (ready === 'failed') {
    // 确实是失败：把半成品删掉，别留垃圾 Pod
    await mgr.rm(name).catch(() => {})
    return renderWizard(f, 1, false, strings[locale].sentence['err-creation'])
  }

  // 用 303 跳转，避免刷新页面重复建沙箱；同时让 URL 干净
  const qs = new URLSearchParams({
    lang: locale,
    os: osName,
    cpu,
    mem,
    ttl,
    id: name,
    url: mgr.shareUrl(name),
  })
  // 超时就带上 pending=1，结果页据此把「创建成功」换成「还在启动」的措辞
  if (ready === 'timeout') qs.set('pending', '1')
  return new Response(null, { status: 303, headers: { Location: `/created?${qs}` } })
}

/** GET /created —— 创建成功后的结果页（可刷新、可分享） */
function handleCreated(url: URL, req: Request): Response {
  const id = url.searchParams.get('id') ?? ''
  const shareUrl = url.searchParams.get('url') ?? (id ? `/console/${id}` : '')
  return renderHome(url, req, {
    created: true,
    containerId: id,
    shareUrl,
    pending: url.searchParams.get('pending') === '1',
  })
}

/** POST /purge —— 删除沙箱 */
async function handlePurge(req: Request): Promise<Response> {
  const form = await req.formData()
  const locale = pickLocale(String(form.get('lang') ?? '') || null)
  const id = String(form.get('containerId') ?? '')
  if (id) await getManager().rm(id)
  return new Response(null, {
    status: 303,
    headers: { Location: `/?lang=${locale}` },
  })
}

// ---------------------------------------------------------------- 服务
// 只要一个类型参数（WS data）；第二个是 fetch 的额外属性，留空即可
const server = Bun.serve<WsState>({
  port: cfg.SERVER_PORT,
  hostname: '0.0.0.0',

  async fetch(req, srv) {
    const url = new URL(req.url)
    const pathname = decodeURIComponent(url.pathname)

    // ---- 探针
    if (pathname === '/healthz') return text('ok')
    if (pathname === '/readyz') {
      try {
        // 列一次沙箱 Pod：能列出来 = apiserver 可达 + SA 鉴权通过。
        // （不能用「查一个不存在的 Pod」来判断：404 和 403 长得像，
        //   权限配错时会误判成健康。实测记录的 403 就是这样。）
        await getManager().expiredPods(cfg.IDLE_TIMEOUT, true)
        return text('ok')
      } catch (err) {
        return text(`k8s api unreachable: ${(err as Error).message}`, 503)
      }
    }

    // ---- CORS 预检
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST',
          'Access-Control-Allow-Headers':
            req.headers.get('access-control-request-headers') || '*',
        },
      })
    }

    // ---- 控制面（JSON API，给 curl / 外部集成用）
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return handleApi(pathname, url)
    }

    // ---- 前端表单（浏览器）
    if (pathname === '/wizard' && req.method === 'POST') return handleWizard(req)
    if (pathname === '/create' && req.method === 'POST') return handleCreate(req)
    if (pathname === '/purge' && req.method === 'POST') return handlePurge(req)
    if (pathname === '/created') return handleCreated(url, req)

    // ---- 沙箱 WebSocket：/console/<pod>/ws
    const wsMatch = pathname.match(/^\/console\/([^/]+)\/ws$/)
    if (wsMatch) {
      const pod = wsMatch[1]
      if (!POD_RE.test(pod)) return text('unknown console target', 404)

      // ★ 关键：不要写 Sec-WebSocket-Protocol。
      //   Bun.serve 会自动把客户端声明的协议回显到 101 响应；
      //   手工再写一遍 = 两个同名头 = 客户端 1002 断连。
      //   （实测记录见文件头注释第 1 条）
      const ok = srv.upgrade(req, {
        headers: { 'Cache-Control': 'no-store' },
        data: { ready: false, queue: [], pod },
      })
      return ok ? undefined : text('upgrade failed', 500)
    }

    // ---- 沙箱 HTTP 反代：/console/<pod>[/rest]
    const consoleMatch = pathname.match(/^\/console\/([^/]+)(\/.*)?$/)
    if (consoleMatch) {
      const pod = consoleMatch[1]
      if (!POD_RE.test(pod)) return text('unknown console target', 404)

      const rest = consoleMatch[2] || '/'
      const target = `http://${sandboxHost(pod)}${rest}${url.search}`

      // 记一次访问，给空闲回收用（不阻塞响应）
      getManager().touch(pod).catch(() => {})

      try {
        // 转发时逐个拷贝请求头：Headers 对象不能直接 Object.fromEntries
        // （它没有同步迭代器），而且必须去掉 hop-by-hop 头
        const fwd = new Headers()
        req.headers.forEach((v, k) => {
          const lk = k.toLowerCase()
          if (lk === 'host' || lk === 'connection' || lk === 'upgrade' || lk === 'keep-alive') return
          fwd.set(k, v)
        })
        fwd.set('host', pod)

        const upstream = await fetch(target, {
          method: req.method,
          headers: fwd,
          redirect: 'manual',
        })
        // 去掉 hop-by-hop 头再转发
        const headers = new Headers(upstream.headers)
        headers.delete('content-encoding')
        headers.delete('transfer-encoding')
        headers.delete('content-length')
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch (err) {
        return text(`sandbox unreachable: ${(err as Error).message}`, 502)
      }
    }

    // ---- 静态资源（public/ 下有就发文件）
    const asset = serveStatic(pathname)
    if (asset) return asset

    // ---- 首页 / SPA 兜底：直接 SSR 渲染
    if (req.method === 'GET' || req.method === 'HEAD') {
      return renderHome(url, req)
    }

    return text('not found', 404)
  },

  websocket: {
    // ttyd 的会话可能长时间没输出，不要让 idle 把它掐掉
    idleTimeout: 0,
    maxPayloadLength: 16 * 1024 * 1024,
    perMessageDeflate: false,

    open(ws) {
      const state = ws.data
      const upstreamUrl = `ws://${sandboxHost(state.pod)}/ws`
      // ★ 必须带 ['tty']：不带时 ttyd 静默不输出任何字节（实测）
      const upstream = new WebSocket(upstreamUrl, ['tty'])
      upstream.binaryType = 'arraybuffer'
      state.upstream = upstream

      upstream.addEventListener('open', () => {
        state.ready = true
        // 上游连上后把排队帧补发（ttyd 的首帧 auth 就在里面）
        for (const msg of state.queue) {
          try {
            upstream.send(msg as any)
          } catch {
            /* ignore */
          }
        }
        state.queue.length = 0
      })

      upstream.addEventListener('message', (ev) => {
        try {
          ws.send(ev.data as any)
        } catch {
          /* 浏览器已走 */
        }
      })

      upstream.addEventListener('close', (ev) => {
        try {
          ws.close(ev.code === 1005 || !ev.code ? 1000 : ev.code, ev.reason || '')
        } catch {
          /* ignore */
        }
      })

      upstream.addEventListener('error', () => {
        try {
          ws.close(1011, 'upstream error')
        } catch {
          /* ignore */
        }
      })
    },

    message(ws, message) {
      const state = ws.data
      const up = state.upstream
      if (!up) return
      if (!state.ready) {
        state.queue.push(message as any)
        return
      }
      try {
        up.send(message as any)
      } catch {
        /* ignore */
      }
    },

    close(ws) {
      try {
        ws.data.upstream?.close()
      } catch {
        /* ignore */
      }
    },

    error(_err, ws) {
      try {
        ws.data.upstream?.close()
      } catch {
        /* ignore */
      }
    },
  },
})

console.log(
  `[instantbox-bun] listening on :${server.port}  ns=${cfg.POD_NAMESPACE} ` +
    `prefix=${cfg.CONTAINER_PREFIX}`,
)

// 端口是 0（随机）时，Bun 会把真实端口填进 server.port。
// 测试脚本靠这个变量拿到实际地址。
process.env.__INSTANTBOX_ACTUAL_PORT = String(server.port)

// ---------------------------------------------------------------- 后台回收
// 原来是独立的 prune CronJob；现在进程内扫就够了（还省一个镜像）。
// 想要「redis 式」外部调度就把 SWEEP_INTERVAL=0，改用 CronJob 打 /api/.../prune。
if (cfg.SWEEP_INTERVAL > 0) {
  let sweeping = false
  setInterval(async () => {
    if (sweeping) return // 上一轮还没跑完，跳过
    sweeping = true
    try {
      const n = await getManager().prune()
      if (n > 0) console.log(`[sweep] reclaimed ${n} sandbox pod(s)`)
    } catch (err) {
      console.error('[sweep] failed:', (err as Error).message)
    } finally {
      sweeping = false
    }
  }, cfg.SWEEP_INTERVAL * 1000)
  console.log(`[sweep] every ${cfg.SWEEP_INTERVAL}s (idle=${cfg.IDLE_TIMEOUT}s)`)
}
