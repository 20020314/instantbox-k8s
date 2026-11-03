/**
 * SandboxManager 单测：用假 k8s 客户端，不连集群。
 * 对齐原 Python 版 test_manager.py 的覆盖点：
 *   名字生成 / OS 白名单 / 资源校验 / Pod spec 关键字段 / 删除保护 / TTL 回收
 */

import { describe, expect, test, beforeEach } from 'bun:test'

import { SandboxManager, TIMEOUT_LABEL, LASTSEEN_LABEL } from '../src/sandbox'
import type { K8s } from '../src/k8s'

interface Call {
  method: string
  args: unknown[]
}

/** 假客户端：记录调用，按需返回/抛错 */
class FakeK8s {
  calls: Call[] = []
  pods = new Map<string, any>()
  services = new Map<string, any>()
  createPodError: Error | null = null
  createServiceError: Error | null = null
  listError: Error | null = null

  private rec(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
  }

  async createPod(ns: string, pod: any) {
    this.rec('createPod', ns, pod)
    if (this.createPodError) throw this.createPodError
    this.pods.set(pod.metadata.name, pod)
    return pod
  }

  async getPod(_ns: string, name: string) {
    this.rec('getPod', name)
    const p = this.pods.get(name)
    if (!p) throw new Error('not found')
    return p
  }

  async deletePod(_ns: string, name: string) {
    this.rec('deletePod', name)
    if (!this.pods.has(name)) throw Object.assign(new Error('404'), { status: 404 })
    this.pods.delete(name)
    return {}
  }

  async listPods(_ns: string, selector: string) {
    this.rec('listPods', selector)
    if (this.listError) throw this.listError
    return { items: [...this.pods.values()] }
  }

  async patchPodLabels(_ns: string, name: string, labels: Record<string, string>) {
    this.rec('patchPodLabels', name, labels)
    return {}
  }

  async createService(_ns: string, svc: any) {
    this.rec('createService', svc)
    if (this.createServiceError) throw this.createServiceError
    this.services.set(svc.metadata.name, svc)
    return svc
  }

  async deleteService(_ns: string, name: string) {
    this.rec('deleteService', name)
    this.services.delete(name)
    return {}
  }
}

function mgr(fake: FakeK8s): SandboxManager {
  return new SandboxManager(fake as unknown as K8s)
}

const GOOD_OS = 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest'
const future = () => Date.now() / 1000 + 3600

describe('名字生成', () => {
  test('带前缀且符合 k8s 命名规则', () => {
    const m = mgr(new FakeK8s())
    for (let i = 0; i < 50; i++) {
      const n = m.generateContainerName()
      expect(n.startsWith('instantbox-managed-')).toBe(true)
      expect(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(n)).toBe(true)
      // 前缀 19 字符 + 12 位随机
      expect(n.length).toBe(31)
    }
  })

  test('基本不重复', () => {
    const m = mgr(new FakeK8s())
    const names = new Set(Array.from({ length: 500 }, () => m.generateContainerName()))
    expect(names.size).toBe(500)
  })
})

describe('OS 白名单', () => {
  const m = mgr(new FakeK8s())

  test('manifest 里的都在白名单', () => {
    expect(m.isOsAvailable(GOOD_OS)).toBe(true)
  })

  test('不认识的拒绝', () => {
    expect(m.isOsAvailable('evil:latest')).toBe(false)
    expect(m.isOsAvailable('')).toBe(false)
    expect(m.isOsAvailable(null)).toBe(false)
  })
})

describe('资源校验', () => {
  let fake: FakeK8s
  beforeEach(() => {
    fake = new FakeK8s()
  })

  test('内存过小 / 过大 直接失败', async () => {
    const m = mgr(fake)
    expect(await m.create({ mem: '8', cpu: '1', osName: GOOD_OS, expireAt: future() })).toBeNull()
    expect(await m.create({ mem: '999999', cpu: '1', osName: GOOD_OS, expireAt: future() })).toBeNull()
    expect(fake.calls.filter((c) => c.method === 'createPod').length).toBe(0)
  })

  test('CPU 为 0 或超上限 失败', async () => {
    const m = mgr(fake)
    expect(await m.create({ mem: '512', cpu: '0', osName: GOOD_OS, expireAt: future() })).toBeNull()
    expect(await m.create({ mem: '512', cpu: '99', osName: GOOD_OS, expireAt: future() })).toBeNull()
  })

  test('非数字失败', async () => {
    const m = mgr(fake)
    expect(await m.create({ mem: 'abc', cpu: '1', osName: GOOD_OS, expireAt: future() })).toBeNull()
    expect(await m.create({ mem: '512', cpu: 'x', osName: GOOD_OS, expireAt: future() })).toBeNull()
  })

  test('合法参数成功', async () => {
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    expect(name).toBeTruthy()
    expect(name!.startsWith('instantbox-managed-')).toBe(true)
  })
})

describe('Pod spec', () => {
  test('关键字段齐全：restartPolicy / sa token / 资源 / 端口', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '2', osName: GOOD_OS, expireAt: future() })

    const pod = fake.pods.get(name!)!
    expect(pod.spec.restartPolicy).toBe('Never')
    // 沙箱不需要任何集群权限，绝对不能挂 SA token
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(pod.spec.enableServiceLinks).toBe(false)

    const c = pod.spec.containers[0]
    expect(c.image).toBe(GOOD_OS)
    expect(c.ports[0].containerPort).toBe(1588)
    expect(c.resources.requests.cpu).toBe('2000m')
    expect(c.resources.limits.memory).toBe('512Mi')
    // 镜像都是 :latest，必须 Always，否则节点用缓存永不更新
    expect(c.imagePullPolicy).toBe('Always')
  })

  test('labels：app=<name> 供 Service 选中，instantbox.sandbox=managed 供清理器选中', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    const pod = fake.pods.get(name!)!

    // 这是原 Python 版的 bug：两个 label 都叫 app，后者覆盖前者，
    // 导致清理器的 label_selector 选不到任何 Pod。这里必须分开。
    expect(pod.metadata.labels.app).toBe(name!)
    expect(pod.metadata.labels['instantbox.sandbox']).toBe('managed')
    expect(pod.metadata.labels[TIMEOUT_LABEL]).toBeTruthy()
    expect(pod.metadata.labels[LASTSEEN_LABEL]).toBeTruthy()
  })

  test('headless Service 的 selector 指向本 Pod', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    const svc = fake.services.get(name!)!
    expect(svc.spec.clusterIP).toBe('None')
    expect(svc.spec.selector).toEqual({ app: name! })
    expect(svc.spec.ports[0].port).toBe(1588)
  })
})

describe('失败回滚', () => {
  test('Service 建不出来时要把 Pod 删掉', async () => {
    const fake = new FakeK8s()
    fake.createServiceError = new Error('boom')
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    expect(name).toBeNull()
    expect(fake.pods.size).toBe(0)
  })

  test('Pod 建不出来时返回 null', async () => {
    const fake = new FakeK8s()
    fake.createPodError = Object.assign(new Error('nope'), { status: 500 })
    const m = mgr(fake)
    expect(await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })).toBeNull()
  })
})

describe('删除保护', () => {
  test('不删前缀不符的名字（防误删）', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    expect(await m.delete(['server', 'frontend-abc', 'default'])).toBe(0)
    expect(fake.calls.filter((c) => c.method === 'deletePod').length).toBe(0)
  })

  test('正常名字能删，且连带删 Service', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    await m.rm(name!)
    expect(fake.pods.has(name!)).toBe(false)
    expect(fake.services.has(name!)).toBe(false)
  })
})

describe('TTL 回收', () => {
  test('已过期的被选中', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({
      mem: '512',
      cpu: '1',
      osName: GOOD_OS,
      expireAt: Date.now() / 1000 - 10, // 已过期
    })
    const expired = await m.expiredPods(0)
    expect(expired).toContain(name!)
  })

  test('未过期的不动', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    const expired = await m.expiredPods(0)
    expect(expired).not.toContain(name!)
  })

  test('idleTimeout>0 时按 lastSeen 回收', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({ mem: '512', cpu: '1', osName: GOOD_OS, expireAt: future() })
    // 把 lastSeen 改成很久以前
    const pod = fake.pods.get(name!)!
    pod.metadata.labels[LASTSEEN_LABEL] = String(Math.floor(Date.now() / 1000) - 99999)

    expect(await m.expiredPods(60)).toContain(name!)
    // idleTimeout=0 时不该按空闲算
    expect(await m.expiredPods(0)).not.toContain(name!)
  })

  test('prune 会把过期 Pod 删掉', async () => {
    const fake = new FakeK8s()
    const m = mgr(fake)
    const name = await m.create({
      mem: '512',
      cpu: '1',
      osName: GOOD_OS,
      expireAt: Date.now() / 1000 - 10,
    })
    const n = await m.prune()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(fake.pods.has(name!)).toBe(false)
  })

  test('strict 模式把 API 错误抛出（探针要用）', async () => {
    const fake = new FakeK8s()
    fake.listError = new Error('apiserver down')
    const m = mgr(fake)
    expect(await m.expiredPods(0, false)).toEqual([])
    await expect(m.expiredPods(0, true)).rejects.toThrow('apiserver down')
  })
})

describe('shareUrl', () => {
  test('没配 CONSOLE_DOMAIN 时返回相对路径（这正是之前跳错地址的 bug）', () => {
    const m = mgr(new FakeK8s())
    const url = m.shareUrl('instantbox-managed-abcdef123456')
    expect(url).toBe('/console/instantbox-managed-abcdef123456')
    expect(url.startsWith('http://')).toBe(false)
  })
})
