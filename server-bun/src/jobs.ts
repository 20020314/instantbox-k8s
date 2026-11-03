/**
 * 异步创建任务：点「确定」立刻返回进度页，不等 Pod。
 *
 * 为什么不在请求里等：
 *   拉镜像 + 起 ttyd 实测 20~90 秒，首次甚至更久。之前是在 POST /create 里
 *   阻塞等待，浏览器转圈几十秒，网关还可能超时断连——用户看到的是「点了没反应」。
 *
 * 现在的做法：
 *   1. POST /create 建完 Pod 立刻 303 到 /creating?id=<name>
 *   2. 这个 job 在后台继续等，直到 ttyd 真的应答
 *   3. /creating 页面每 1.5 秒查一次 /api/job/<name>，状态变了就更新文案，
 *      就绪了自动跳 /created，失败了显示原因
 *
 * 状态只放内存：沙箱本身就在集群里，进程重启后正在等的任务丢了也没关系——
 * /creating 查不到 job 时会退回去用 Pod 实际状态判断，不会卡死。
 */

import type { SandboxManager } from './sandbox'

export type JobPhase = 'pending' | 'ready' | 'timeout' | 'failed'

export interface CreateJob {
  name: string
  phase: JobPhase
  /** Pod 的 k8s phase（Pending / Running …），用来给用户看「在拉镜像还是在起容器」 */
  podPhase: string
  /** 由 SandboxManager.waitUntilShellReady 产出；已经能开 shell 就是 true */
  shellReady: boolean
  createdAt: number
  finishedAt?: number
  /** 失败原因（err-creation / err-timeout 的 i18n key） */
  errorKey?: string
  params: {
    locale: string
    osName: string
    cpu: string
    mem: string
    ttl: string
    shareUrl: string
  }
}

const jobs = new Map<string, CreateJob>()

/** 任务保留多久（给前端足够时间取走最终状态） */
const JOB_TTL_MS = 10 * 60_000

function sweep(): void {
  const now = Date.now()
  for (const [k, j] of jobs) {
    const t = j.finishedAt ?? j.createdAt
    if (now - t > JOB_TTL_MS) jobs.delete(k)
  }
}

export function getJob(name: string): CreateJob | undefined {
  return jobs.get(name)
}

/**
 * 登记一个新任务并后台等待它变可用。
 *
 * 立即返回（不 await 等待过程），调用方可以直接 303 到进度页。
 */
export function startCreateJob(
  mgr: SandboxManager,
  opts: {
    name: string
    locale: string
    osName: string
    cpu: string
    mem: string
    ttl: string
    timeoutMs: number
    pollMs: number
  },
): CreateJob {
  sweep()

  const job: CreateJob = {
    name: opts.name,
    phase: 'pending',
    podPhase: 'Pending',
    shellReady: false,
    createdAt: Date.now(),
    params: {
      locale: opts.locale,
      osName: opts.osName,
      cpu: opts.cpu,
      mem: opts.mem,
      ttl: opts.ttl,
      shareUrl: mgr.shareUrl(opts.name),
    },
  }
  jobs.set(opts.name, job)

  // 不 await：这个 promise 在后台跑完，进度通过 job 对象暴露
  void (async () => {
    try {
      const result = await mgr.waitUntilShellReady(opts.name, {
        timeoutMs: opts.timeoutMs,
        pollMs: opts.pollMs,
        onPhase: (p) => {
          job.podPhase = p
        },
      })

      if (result === 'ready') {
        job.phase = 'ready'
        job.shellReady = true
        console.log(`[job] ${opts.name} ready`)
      } else if (result === 'timeout') {
        // Pod 还在（多半在拉镜像）：不算失败，页面上改成「还在启动」并给按钮
        job.phase = 'timeout'
        job.errorKey = 'err-timeout'
        console.log(`[job] ${opts.name} timeout (pod=${job.podPhase})`)
      } else {
        job.phase = 'failed'
        job.errorKey = 'err-creation'
        await mgr.rm(opts.name).catch(() => {})
        console.log(`[job] ${opts.name} failed (pod=${job.podPhase})`)
      }
    } catch (err) {
      job.phase = 'failed'
      job.errorKey = 'err-creation'
      console.error(`[job] ${opts.name} threw`, err)
    } finally {
      job.finishedAt = Date.now()
    }
  })()

  return job
}

/**
 * 查任务状态。进程重启 / 任务过期后 jobs 里没有，回退到 Pod 实际状态。
 *
 * 这样刷新进度页也不会卡在「启动中」——Pod 已经是 Running 且 ttyd 应答，
 * 就直接告诉前端可以跳了。
 */
export async function resolveJob(
  mgr: SandboxManager,
  name: string,
): Promise<CreateJob | undefined> {
  const known = jobs.get(name)
  if (known) return known

  const st = await mgr.status(name)
  if (!st) return undefined

  // 没登记过（进程重启）：现场判一次
  if (st.phase === 'Running' && (await mgr.shellReady(name))) {
    const job: CreateJob = {
      name,
      phase: 'ready',
      podPhase: st.phase,
      shellReady: true,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      params: { locale: '', osName: '', cpu: '', mem: '', ttl: '', shareUrl: mgr.shareUrl(name) },
    }
    jobs.set(name, job)
    return job
  }

  const job: CreateJob = {
    name,
    phase: 'pending',
    podPhase: st.phase,
    shellReady: false,
    createdAt: Date.now(),
    params: { locale: '', osName: '', cpu: '', mem: '', ttl: '', shareUrl: mgr.shareUrl(name) },
  }
  jobs.set(name, job)
  return job
}
