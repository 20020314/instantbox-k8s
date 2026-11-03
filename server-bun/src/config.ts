/**
 * 集中配置：全部来自环境变量，便于用 ConfigMap / Secret 注入。
 * 与旧 Python 版 config.py 一一对应，变量名保持完全一致（清单不用改）。
 */

function int(name: string, def: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) ? v : def
}

function str(name: string, def = ''): string {
  return process.env[name] ?? def
}

export const cfg = {
  /** 沙箱 Pod 所在的命名空间（与 server 自身可以不同） */
  POD_NAMESPACE: str('INSTANTBOX_POD_NAMESPACE', 'instantbox'),

  /** Pod 名/标签统一前缀 */
  CONTAINER_PREFIX: str('INSTANTBOX_PREFIX', 'instantbox-managed-'),

  /** 前端访问的后缀域名。留空 = 用同域相对路径 /console/<pod> */
  CONSOLE_DOMAIN: str('INSTANTBOX_CONSOLE_DOMAIN'),
  CONSOLE_PORT: str('INSTANTBOX_CONSOLE_PORT'),
  SCHEME: str('INSTANTBOX_SCHEME', 'http'),

  /** server 监听端口 */
  SERVER_PORT: int('INSTANTBOX_SERVER_PORT', 65501),

  /** 沙箱内 ttyd 端口 */
  TTYD_PORT: int('INSTANTBOX_TTYD_PORT', 1588),

  /** 覆盖沙箱容器启动命令，留空用镜像 CMD */
  SANDBOX_COMMAND: str('INSTANTBOX_SANDBOX_COMMAND').trim(),

  /** 沙箱镜像仓库前缀 */
  IMAGE_REGISTRY_PREFIX: str('INSTANTBOX_IMAGE_PREFIX'),

  /** 默认 Always：manifest 里都是 :latest，IfNotPresent 会一直用缓存 */
  IMAGE_PULL_POLICY: str('INSTANTBOX_IMAGE_PULL_POLICY', 'Always'),

  /** 空闲多少秒回收，0 = 只按 TTL */
  IDLE_TIMEOUT: int('INSTANTBOX_IDLE_TIMEOUT', 0),

  /** 后台回收扫描间隔（秒）。0 = 关闭（改用外部 CronJob 调 /api/.../prune） */
  SWEEP_INTERVAL: int('INSTANTBOX_SWEEP_INTERVAL', 60),

  MAX_CPU_MILLI: int('INSTANTBOX_MAX_CPU_MILLI', 4000),
  MAX_MEM_MB: int('INSTANTBOX_MAX_MEM_MB', 4096),

  /** k=v,k2=v2 */
  NODE_SELECTOR: str('INSTANTBOX_NODE_SELECTOR'),
  RUNTIME_CLASS: str('INSTANTBOX_RUNTIME_CLASS'),

  MANIFEST_PATH: str('INSTANTBOX_MANIFEST', 'manifest.json'),
}

export function nodeSelector(): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const pair of cfg.NODE_SELECTOR.split(',')) {
    const p = pair.trim()
    if (!p || !p.includes('=')) continue
    const idx = p.indexOf('=')
    out[p.slice(0, idx).trim()] = p.slice(idx + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 沙箱控制台地址。
 *
 * ★ 相对路径分支必须带尾部斜杠。
 *   `/console/<pod>` 少了那个 `/`，浏览器会把页面里的相对路径（ttyd 用
 *   `ws` / `token` 这类相对地址去建 WebSocket）解析成 `/console/ws`，
 *   于是网关按「pod 名 = ws」处理 → 404，终端永远连不上。
 *   带斜杠后 `/console/<pod>/` + `ws` = `/console/<pod>/ws`，正好落在反代路由上。
 */
export function shareUrl(containerName: string): string {
  if (!cfg.CONSOLE_DOMAIN) return `/console/${containerName}/`
  const host =
    cfg.CONSOLE_PORT && cfg.CONSOLE_PORT !== '80' && cfg.CONSOLE_PORT !== '443'
      ? `${containerName}.${cfg.CONSOLE_DOMAIN}:${cfg.CONSOLE_PORT}`
      : `${containerName}.${cfg.CONSOLE_DOMAIN}`
  return `${cfg.SCHEME}://${host}`
}
