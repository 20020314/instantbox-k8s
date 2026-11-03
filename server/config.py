"""集中配置：全部来自环境变量，便于用 ConfigMap / Secret 注入。"""
import os


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _bool(name, default=False):
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ('1', 'true', 'yes', 'on')


# 沙箱 Pod 所在的命名空间（与 server 自身可以不同）
POD_NAMESPACE = os.environ.get('INSTANTBOX_POD_NAMESPACE', 'instantbox')

# Pod 名/标签统一前缀，替换掉原来的 instantbox_managed_
CONTAINER_PREFIX = os.environ.get('INSTANTBOX_PREFIX', 'instantbox-managed-')

# 前端访问的后缀域名，例如 https://box.example.com 的 box.example.com
# worker 会按 <podname>.<DOMAIN> 反代，shareUrl 用同一后缀拼出来
CONSOLE_DOMAIN = os.environ.get('INSTANTBOX_CONSOLE_DOMAIN', '')

# worker 对外暴露的端口，前端拼 shareUrl 时带上（80/443 时省略）
CONSOLE_PORT = os.environ.get('INSTANTBOX_CONSOLE_PORT', '')
SCHEME = os.environ.get('INSTANTBOX_SCHEME', 'http')

# server 自身监听端口
SERVER_PORT = _int('INSTANTBOX_SERVER_PORT', 65501)

# 沙箱 Pod 里 ttyd 监听的端口（官方 instantbox-* 镜像固定 1588）
TTYD_PORT = _int('INSTANTBOX_TTYD_PORT', 1588)

# 显式下发给沙箱容器的启动命令。留空 = 用镜像自带的 CMD。
# 兜底用：万一用了上游那种没带 -W 的旧镜像，ttyd 会退化成「客户端只读」，
# 浏览器里能出提示符但打不了字。设成 "ttyd -p 1588 -W bash" 可以强行纠正。
SANDBOX_COMMAND = os.environ.get('INSTANTBOX_SANDBOX_COMMAND', '').strip()

# 沙箱镜像仓库前缀覆盖，例如内网 harbor：harbor.local/instantbox/ ->
# 配合 manifest.json 的 osCode（instantbox/ubuntu:20.04）拼接
IMAGE_REGISTRY_PREFIX = os.environ.get('INSTANTBOX_IMAGE_PREFIX', '')

# 拉不了镜像时不要卡在 ImagePullBackOff
# 默认 Always：manifest 里的 osCode 都是 :latest，配 IfNotPresent 时节点有缓存就不更新
IMAGE_PULL_POLICY = os.environ.get('INSTANTBOX_IMAGE_PULL_POLICY', 'Always')

# 清理器：pod 上留 lastSeen 时间戳，超过多少秒没被访问就回收（0 = 关闭）
IDLE_TIMEOUT = _int('INSTANTBOX_IDLE_TIMEOUT', 0)

# 资源上限（防止 Pod 打爆节点）
MAX_CPU_MILLI = _int('INSTANTBOX_MAX_CPU_MILLI', 4000)
MAX_MEM_MB = _int('INSTANTBOX_MAX_MEM_MB', 4096)

# 可选：指定沙箱 Pod 的 nodeSelector / runtimeClass（例如 gvisor / kata）
NODE_SELECTOR = os.environ.get('INSTANTBOX_NODE_SELECTOR', '')      # k=v,k2=v2
RUNTIME_CLASS = os.environ.get('INSTANTBOX_RUNTIME_CLASS', '')

# 允许的 OS 清单文件
MANIFEST_PATH = os.environ.get('INSTANTBOX_MANIFEST', 'manifest.json')


def node_selector():
    result = {}
    for pair in NODE_SELECTOR.split(','):
        pair = pair.strip()
        if not pair or '=' not in pair:
            continue
        k, v = pair.split('=', 1)
        result[k.strip()] = v.strip()
    return result


def console_base_url():
    """返回 (scheme, host_suffix, port)，供 shareUrl 拼接。"""
    return SCHEME, CONSOLE_DOMAIN, CONSOLE_PORT
