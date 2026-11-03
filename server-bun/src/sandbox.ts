/**
 * 沙箱生命周期管理：建 Pod / 删 Pod / TTL 与空闲回收。
 * 行为与原 Python 版 InstantboxManager 逐条对齐，差异只在实现方式。
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { cfg, nodeSelector, shareUrl } from './config'
import { K8s, K8sError } from './k8s'

const LABEL_PREFIX = 'org.instantbox'
export const TIMEOUT_LABEL = `${LABEL_PREFIX}.variables.EXPIRATION_TIMESTAMP`
export const LASTSEEN_LABEL = `${LABEL_PREFIX}.variables.LAST_SEEN_TIMESTAMP`
export const APP_LABEL_KEY = 'app'
export const APP_LABEL_VALUE = 'instantbox-sandbox'

/** k8s 资源名：小写字母数字与 '-'，首尾必须是字母数字 */
const POD_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface OsItem {
  label: string
  value: string
  logoUrl: string
  subList: { label: string; osCode: string }[]
}

export interface PodStatus {
  phase: string
  podIP: string | null
  /** containerStatuses 里有 ready=true（即 readinessProbe 通过） */
  ready: boolean
}

export class SandboxManager {
  readonly namespace = cfg.POD_NAMESPACE
  readonly osList: OsItem[]
  readonly availableOs: Set<string>

  private k8s: K8s | null = null

  /**
   * @param client 可注入假的 k8s 客户端（单测用）；不传则懒加载真实客户端
   */
  constructor(client?: K8s) {
    const raw = readFileSync(cfg.MANIFEST_PATH, 'utf8')
    this.osList = JSON.parse(raw) as OsItem[]
    this.availableOs = new Set(
      this.osList.flatMap((o) => o.subList.map((s) => s.osCode)),
    )
    if (client) this.k8s = client
  }

  /** 延迟连接集群：模块加载（例如单测）时不去碰 apiserver */
  private get client(): K8s {
    if (!this.k8s) this.k8s = new K8s()
    return this.k8s
  }

  get prefix(): string {
    return cfg.CONTAINER_PREFIX
  }

  isOsAvailable(osCode: string | null | undefined): boolean {
    return !!osCode && this.availableOs.has(osCode)
  }

  private imageFor(osName: string): string {
    if (!cfg.IMAGE_REGISTRY_PREFIX) return osName
    return `${cfg.IMAGE_REGISTRY_PREFIX.replace(/\/$/, '')}/${osName.replace(/^\//, '')}`
  }

  generateContainerName(): string {
    // crypto 随机比 Math.random 更适合生成资源名
    const bytes = randomBytes(12)
    let out = ''
    for (const b of bytes) out += NAME_ALPHABET[b % NAME_ALPHABET.length]
    return this.prefix + out
  }

  private buildPodSpec(name: string, osName: string, memMb: number, cpuCores: number, expireAt: number) {
    const resources = {
      requests: { cpu: `${Math.round(cpuCores * 1000)}m`, memory: `${memMb}Mi` },
      limits: { cpu: `${Math.round(cpuCores * 1000)}m`, memory: `${memMb}Mi` },
    }

    const container: Record<string, unknown> = {
      name: 'box',
      image: this.imageFor(osName),
      imagePullPolicy: cfg.IMAGE_PULL_POLICY,
      ports: [{ name: 'ttyd', containerPort: cfg.TTYD_PORT }],
      tty: true,
      stdin: true,
      resources,
    }
    if (cfg.SANDBOX_COMMAND) container.command = cfg.SANDBOX_COMMAND.split(/\s+/)

    const spec: Record<string, unknown> = {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [container],
      // 同名 headless Service 的 selector 靠 app=<name> 选中本 Pod
      // 注意：下面的 labels 里 app 会同时被覆盖成本身名字
    }
    const ns = nodeSelector()
    if (ns) spec.nodeSelector = ns
    if (cfg.RUNTIME_CLASS) spec.runtimeClassName = cfg.RUNTIME_CLASS

    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          // 这里原本是个 bug：Python 版先写 app=instantbox-sandbox 再写 app=<name>，
          // 后者覆盖前者，所以清理器的 label_selector 其实是选不到 Pod 的。
          // 新版本改成分两个 label：沙箱归属用 instantbox.sandbox=managed，
          // 单个 Pod 的名字仍用 app=<name> 给 Service selector 用。
          'instantbox.sandbox': 'managed',
          [APP_LABEL_KEY]: name,
          [TIMEOUT_LABEL]: `${Math.floor(expireAt)}`,
          [LASTSEEN_LABEL]: `${Math.floor(Date.now() / 1000)}`,
        },
      },
      spec,
    }
  }

  private buildService(name: string) {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { 'instantbox.sandbox': 'managed' },
      },
      spec: {
        clusterIP: 'None', // headless：DNS 直接返回 Pod IP
        selector: { [APP_LABEL_KEY]: name },
        ports: [{ name: 'ttyd', port: cfg.TTYD_PORT, targetPort: cfg.TTYD_PORT }],
      },
    }
  }

  /**
   * 创建沙箱 Pod（+ 同名 headless Service）。
   * 返回 Pod 名；任何一步失败返回 null。
   */
  async create(opts: {
    mem: number | string
    cpu: number | string
    osName: string
    expireAt: number
  }): Promise<string | null> {
    const memMb = Math.round(Number(opts.mem))
    const cpuCores = Number(opts.cpu)

    if (!Number.isFinite(memMb) || memMb < 16 || memMb > cfg.MAX_MEM_MB) return null
    if (!Number.isFinite(cpuCores) || cpuCores <= 0 || cpuCores * 1000 > cfg.MAX_CPU_MILLI) return null

    for (let attempt = 0; attempt < 3; attempt++) {
      const name = this.generateContainerName()
      try {
        await this.client.createPod(
          this.namespace,
          this.buildPodSpec(name, opts.osName, memMb, cpuCores, opts.expireAt),
        )
      } catch (err) {
        // 409 = 名字撞了，换一个重试；其他错误直接失败
        if (err instanceof K8sError && err.status === 409) continue
        return null
      }

      try {
        await this.client.createService(this.namespace, this.buildService(name))
      } catch {
        // Service 建不出来就回收 Pod，别留一个访问不到的沙箱
        await this.delete([name])
        return null
      }
      return name
    }
    return null
  }

  async status(name: string): Promise<PodStatus | null> {
    try {
      const pod = await this.client.getPod(this.namespace, name)
      const status = pod.status ?? {}
      // containerStatuses 里如果有 ready=true，说明 readinessProbe 也通过了
      const ready = (status.containerStatuses ?? []).some(
        (c: { ready?: boolean }) => c.ready === true,
      )
      return {
        phase: status.phase ?? 'Unknown',
        podIP: status.podIP ?? null,
        ready,
      }
    } catch {
      return null
    }
  }

  /**
   * 沙箱内 ttyd 的访问地址。
   *
   * 用 headless Service 的 DNS 而不是 Pod IP：Service 一建好域名就解析得动，
   * Pod IP 要等容器网络就绪；而且 IP 变了域名不用跟着改。
   */
  shellUrl(name: string): string {
    return `http://${name}.${this.namespace}.svc.cluster.local:${cfg.TTYD_PORT}/`
  }

  /**
   * 探测 shell 到底能不能用 —— **不是 Pod Running 就算数**。
   *
   * Running 只说明容器起来了；ttyd 还要几百毫秒到几秒才开始 listen。
   * 这时候把「打开系统」的按钮放出去，用户点开是个白页 / 502，
   * 看起来就像创建失败。
   *
   * ttyd 的根路径返回一个 HTML 页面（200），所以能拿到 HTTP 响应
   * 且状态码 < 500 就认为它在服务了。
   */
  async shellReady(name: string): Promise<boolean> {
    try {
      const res = await fetch(this.shellUrl(name), {
        // /token 不依赖 WebSocket，轻量且必定实现（ttyd 1.x 都有）
        signal: AbortSignal.timeout(2000),
        headers: { accept: 'text/html' },
      })
      return res.status < 500
    } catch {
      return false
    }
  }

  /**
   * 一直等到「能开 shell」，返回三态，语义与 index.ts 里的处理一一对应：
   *   ready   —— 可以放心把地址给用户
   *   timeout —— Pod 还在（多半在拉镜像），不算失败
   *   failed  —— Pod 进 Failed / 被删掉了
   *
   * @param onPhase 每次状态变化回调一次（给日志用，可选）
   */
  async waitUntilShellReady(
    name: string,
    opts: { timeoutMs?: number; pollMs?: number; onPhase?: (p: string) => void } = {},
  ): Promise<'ready' | 'timeout' | 'failed'> {
    const timeoutMs = opts.timeoutMs ?? 180_000
    const pollMs = opts.pollMs ?? 1_000
    const deadline = Date.now() + timeoutMs
    let lastPhase = ''

    while (Date.now() < deadline) {
      const st = await this.status(name)
      if (!st) return 'failed'
      if (st.phase === 'Failed' || st.phase === 'Succeeded') return 'failed'

      if (st.phase !== lastPhase) {
        lastPhase = st.phase
        opts.onPhase?.(st.phase)
      }

      // 容器 Running 且 ttyd 已经在应答 → 真的可以开 shell 了
      if (st.phase === 'Running' && (await this.shellReady(name))) return 'ready'

      await Bun.sleep(pollMs)
    }
    return 'timeout'
  }

  /** 记录最后一次访问时间，供空闲回收使用。失败静默。 */
  async touch(name: string): Promise<void> {
    if (cfg.IDLE_TIMEOUT <= 0) return
    try {
      await this.client.patchPodLabels(this.namespace, name, {
        [LASTSEEN_LABEL]: `${Math.floor(Date.now() / 1000)}`,
      })
    } catch {
      /* 静默 */
    }
  }

  /** 删除一批 Pod（连同 Service）。返回删除成功数。 */
  async delete(names: string[], graceSeconds = 0): Promise<number> {
    let deleted = 0
    for (const name of names) {
      if (!name || !name.startsWith(this.prefix)) continue
      if (!POD_NAME_RE.test(name)) continue
      try {
        await this.client.deletePod(this.namespace, name, graceSeconds)
        deleted++
      } catch (err) {
        // 404/410 视为已删除，计入成功
        if (err instanceof K8sError && (err.status === 404 || err.status === 410)) deleted++
      }
      // 配套 Service 一起删，否则名字一直被占着
      try {
        await this.client.deleteService(this.namespace, name)
      } catch {
        /* 忽略 */
      }
    }
    return deleted
  }

  async rm(name: string): Promise<boolean> {
    return (await this.delete([name])) >= 0
  }

  /**
   * 找出应当回收的 Pod：TTL 到期 或 空闲超时。
   *
   * @param idleTimeout  空闲秒数，0 = 只看 TTL
   * @param strict       true 时把 apiserver 的错误抛出去（探针要用）。
   *                     默认 false：回收任务不该因为一次 API 抖动就整体崩。
   */
  async expiredPods(idleTimeout = cfg.IDLE_TIMEOUT, strict = false): Promise<string[]> {
    let resp: Record<string, any>
    try {
      resp = await this.client.listPods(this.namespace, 'instantbox.sandbox=managed')
    } catch (err) {
      if (strict) throw err
      return []
    }

    const now = Date.now() / 1000
    const victims: string[] = []
    for (const pod of resp.items ?? []) {
      const name: string | undefined = pod.metadata?.name
      const labels: Record<string, string> = pod.metadata?.labels ?? {}
      if (!name || !name.startsWith(this.prefix)) continue

      const expireAt = Number.parseFloat(labels[TIMEOUT_LABEL] ?? '0') || 0
      if (expireAt && expireAt < now) {
        victims.push(name)
        continue
      }
      if (idleTimeout > 0) {
        const lastSeen = Number.parseFloat(labels[LASTSEEN_LABEL] ?? '0') || 0
        if (lastSeen && now - lastSeen > idleTimeout) victims.push(name)
      }
    }
    return victims
  }

  /** 顺手清理 Succeeded / Failed 的沙箱 Pod */
  async cleanupFinishedPods(): Promise<number> {
    let resp: Record<string, any>
    try {
      resp = await this.client.listPods(this.namespace, 'instantbox.sandbox=managed')
    } catch {
      return 0
    }
    const finished = (resp.items ?? [])
      .filter(
        (p: Record<string, any>) =>
          p.metadata?.name?.startsWith(this.prefix) &&
          (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed'),
      )
      .map((p: Record<string, any>) => p.metadata.name as string)
    return this.delete(finished)
  }

  /** 执行一次完整回收，返回删除数量 */
  async prune(): Promise<number> {
    const expired = await this.expiredPods()
    return (await this.delete(expired)) + (await this.cleanupFinishedPods())
  }

  shareUrl(name: string): string {
    return shareUrl(name)
  }
}

// ---------------------------------------------------------------- 单例
let instance: SandboxManager | null = null

export function getManager(): SandboxManager {
  if (!instance) instance = new SandboxManager()
  return instance
}
