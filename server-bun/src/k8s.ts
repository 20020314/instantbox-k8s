/**
 * 极简 Kubernetes 客户端（REST over fetch）
 *
 * 为什么不用 @kubernetes/client-node：
 *   它把认证挂在 Node 的 https.Agent 上，而 Bun 的 fetch 会忽略 Agent，
 *   结果就是证书/CA 丢失 -> 连 apiserver 直接 401 或 TLS 握手失败。
 *   （参见 oven-sh/bun 的 node:https Agent 实现限制）
 *
 *   这里直接读 in-cluster 的 ServiceAccount 文件（或 kubeconfig），
 *   把 cert/key/ca 通过 Bun fetch 的 tls 选项传下去。代码更少，行为更可控。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

export class K8sError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`k8s ${method} ${path} -> ${status}: ${body.slice(0, 300)}`)
    this.name = 'K8sError'
  }
}

interface ClusterConf {
  baseUrl: string
  token?: string
  /** PEM 内容，交给 fetch 的 tls 选项 */
  tls?: { cert?: string; key?: string; ca?: string }
}

let cached: ClusterConf | null = null

function loadConf(): ClusterConf {
  if (cached) return cached

  // ---- 1. 集群内：ServiceAccount（kubelet 自动挂载）
  const saToken = join(SA_DIR, 'token')
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT || '443'
  if (host) {
    try {
      const conf: ClusterConf = {
        baseUrl: `https://${host}:${port}`,
        token: readFileSync(saToken, 'utf8').trim(),
        tls: { ca: readFileSync(join(SA_DIR, 'ca.crt'), 'utf8') },
      }
      cached = conf
      return conf
    } catch (err) {
      // 挂载没就绪就继续往下试 kubeconfig（本地跑单测的场景）
    }
  }

  // ---- 2. 本地：kubeconfig（只支持单文件、单 context 的常见写法）
  const kubeconfig =
    process.env.KUBECONFIG || join(homedir(), '.kube', 'config')
  try {
    const raw = readFileSync(kubeconfig, 'utf8')
    const parsed = parseKubeconfig(raw)
    cached = parsed
    return parsed
  } catch {
    throw new Error(
      '既没有 KUBERNETES_SERVICE_HOST（in-cluster），也读不到 kubeconfig。' +
        ' 集群外调试请设置 KUBECONFIG 环境变量。',
    )
  }
}

/**
 * 解析 kubeconfig（只认 `kubectl config view --minify` 那种标准结构）。
 * 故意不引 yaml 库：这里只需要 4 个字段，正则足够，还省一个依赖。
 */
function parseKubeconfig(raw: string): ClusterConf {
  const pick = (re: RegExp) => raw.match(re)?.[1]?.trim()

  const server = pick(/^\s*server:\s*(\S+)\s*$/m)
  if (!server) throw new Error('kubeconfig 里没有 server 字段')

  // token 优先；否则用证书（client-certificate-data / key-data，base64）
  const token = pick(/^\s*token:\s*(\S+)\s*$/m)
  const certB64 = pick(/^\s*client-certificate-data:\s*(\S+)\s*$/m)
  const keyB64 = pick(/^\s*client-key-data:\s*(\S+)\s*$/m)
  const caB64 = pick(/^\s*certificate-authority-data:\s*(\S+)\s*$/m)
  const insecure = /^\s*insecure-skip-tls-verify:\s*true\s*$/m.test(raw)

  const tls: ClusterConf['tls'] = {}
  if (caB64) tls.ca = Buffer.from(caB64, 'base64').toString('utf8')
  if (certB64) tls.cert = Buffer.from(certB64, 'base64').toString('utf8')
  if (keyB64) tls.key = Buffer.from(keyB64, 'base64').toString('utf8')

  return {
    baseUrl: server.replace(/\/$/, ''),
    token,
    tls: Object.keys(tls).length || insecure ? { ...tls, ...(insecure ? { rejectUnauthorized: false } : {}) } : undefined,
  }
}

type Json = Record<string, any>

export class K8s {
  private conf = loadConf()

  private async req(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<Json> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.conf.token) headers.Authorization = `Bearer ${this.conf.token}`
    if (body !== undefined) headers['Content-Type'] = contentType

    const res = await fetch(this.conf.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // ★ 关键：Bun 的 fetch 认这个 tls 字段，Node 的 https.Agent 在这里没用
      ...(this.conf.tls ? { tls: this.conf.tls as any } : {}),
    } as RequestInit)

    const text = await res.text()
    if (!res.ok) throw new K8sError(res.status, text, method, path)
    return text ? (JSON.parse(text) as Json) : {}
  }

  // ---------------------------------------------------------------- Pod
  createPod(namespace: string, pod: Json) {
    return this.req('POST', `/api/v1/namespaces/${namespace}/pods`, pod)
  }

  getPod(namespace: string, name: string) {
    return this.req('GET', `/api/v1/namespaces/${namespace}/pods/${name}`)
  }

  deletePod(namespace: string, name: string, gracePeriodSeconds = 0) {
    return this.req(
      'DELETE',
      `/api/v1/namespaces/${namespace}/pods/${name}`,
      { gracePeriodSeconds, propagationPolicy: 'Background' },
    )
  }

  listPods(namespace: string, labelSelector: string) {
    const qs = new URLSearchParams({ labelSelector }).toString()
    return this.req('GET', `/api/v1/namespaces/${namespace}/pods?${qs}`)
  }

  patchPodLabels(namespace: string, name: string, labels: Record<string, string>) {
    return this.req(
      'PATCH',
      `/api/v1/namespaces/${namespace}/pods/${name}`,
      { metadata: { labels } },
      'application/merge-patch+json',
    )
  }

  // ---------------------------------------------------------------- Service
  createService(namespace: string, svc: Json) {
    return this.req('POST', `/api/v1/namespaces/${namespace}/services`, svc)
  }

  deleteService(namespace: string, name: string) {
    return this.req('DELETE', `/api/v1/namespaces/${namespace}/services/${name}`)
  }
}
