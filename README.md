# instantbox on Kubernetes

把 [instantbox/instantbox](https://github.com/instantbox/instantbox)（浏览器里"秒开一台临时 Linux + webshell"）移植到 Kubernetes。

上游项目 2019 年之后基本停更，架构是 **docker-compose + 挂载 `/var/run/docker.sock` 的 Docker SDK**，  
在 K8s 上不可用。这里做了三件事：

| 改动              | 上游做法                                                       | 本项目做法                                                          |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| **创建"容器"**      | 挂 `docker.sock`，用 `docker-py` `containers.run()`           | **用 Pod 自带的 ServiceAccount 调 k8s API 建 Pod**（RBAC 最小权限）        |
| **"开放端口"选项**    | 前端填内部端口，`ports={...}` 映射到宿主随机端口，`GET /getOS` 返回 `openPort` | **整个选项删除**：沙箱固定跑 ttyd:1588，对外只经 worker 反代，`openPort` 恒为 `null` |
| **转发 webshell** | 前端 nginx 用 docker 内嵌 DNS `127.0.0.11` 解析容器名                | 同一个进程里用**集群 DNS 解析 Pod 名**（Pod 名即主机名）                          |

---



## 架构

整条链路是**一个 Bun 进程**（`server-bun`）。四件事都在里面：JSON API、SSR 页面、  
`/console/<pod>` 的 HTTP 反代、以及同路径的 ttyd WebSocket 桥接。  
没有 Caddy、没有 nginx、没有 Flask、没有 React 构建产物、没有 CronJob。

```
                      ┌────────────────────────────────────────────────┐
  浏览器 ────────────► │ Deployment instantbox  (Bun + Bun.serve)       │
   :30888             │                                                │
   NodePort           │  GET  /                  → JSX SSR 首页         │
                      │  POST /create            → 建沙箱（表单提交）    │
                      │  GET  /created?...       → 结果页               │
                      │  GET  /api/v2/...        → 兼容上游的 JSON API   │
                      │  ANY  /console/<pod>/**  → fetch 反代 ttyd HTTP │
                      │  WS   /console/<pod>/ws  → WebSocket 帧中继      │
                      │  POST /purge             → 立刻回收过期 Pod     │
                      └───────┬──────────────────────────┬─────────────┘
                              │ SA: instantbox-server     │ ws://<pod>:1588/ws
                              │ ↓ k8s REST API (fetch)    │
                     ┌────────▼─────────┐       ┌────────▼───────────────┐
                     │ create / delete  │       │ 沙箱 Pod                │
                     │ list / watch     │       │ instantbox-managed-xxx │
                     │ + 同名 headless  │       │ ttyd -p 1588 -W bash    │
                     │   Service        │       └────────────────────────┘
                     └────────┬─────────┘
                              │
                  进程内 setInterval 每 60s sweep
                  （替代原来的 CronJob，见 §坑 #9）
```

- **单进程 = 少一跳**。原来的 `gateway → server` 是两次跨 Pod 网络调用，现在 API 处理直接在自己  
  进程里结束；`/console` 也只剩「浏览器 → 本进程 → 沙箱」这一段。
- **静态页是 SSR 出来的**，不是构建产物。见 `src/frontend/page.tsx`，用自写的 40 行 JSX  
  运行时（`jsx-runtime.ts`）直出 HTML，**零客户端框架、零 `npm install`、零构建步骤**。  
  交互只有两处：选系统 `onchange="this.form.requestSubmit()"`、提交走原生 `<form>`。
- **反代仍然是「按 Pod 名拼 FQDN」**，这是 K8s 下替代 docker DNS 的核心。Pod 名被正则锁死  
  （`instantbox-managed-[a-z0-9]{4,40}`），防止拿 `/console/kubernetes` 打 apiserver。
- **回收不靠 CronJob**，改为进程内 `setInterval`（`INSTANTBOX_SWEEP_INTERVAL`，默认 60s）。  
  多副本下每个副本都会扫，但因为都是「delete 已过期的」，重复执行天然幂等。
- **探针真打 apiserver**：`/readyz` 会真实 list 一次沙箱 Pod。权限配错时 403 会被判成不健康，  
  不会像「查一个不存在的 Pod」那样把 404 和 403 混在一起误判成健康（见 §坑 #15）。

> 关于「为什么最后不是 Elysia」：`Bun.serve` 的原生路由 + `srv.upgrade()` 已经够用，  
> 少一层抽象就少一处和 WebSocket 子协议打架的地方（§坑 #17 就是这个坑的地狱版）。  
> Elysia 的 `ws()` 也走 Bun 底层，但它多包了一层 `upgrade` 时机控制，反而更难调。

---


## 目录

```
instantbox-k8s/
├── server-bun/                 # 唯一的应用（Bun，无构建）
│   ├── src/
│   │   ├── index.ts            # 入口：路由 + SSR + /console 反代 + WS 桥接 + sweep
│   │   ├── config.ts           # 全部配置走环境变量，带默认值
│   │   ├── k8s.ts              # 极简 k8s REST 客户端（Bun.fetch + tls.ca）
│   │   ├── sandbox.ts          # 建/删/列 Pod + 同名 headless Service + TTL 回收
│   │   └── frontend/
│   │       ├── page.tsx        # 真 JSX 页面（首页 + 结果页 + 错误页）
│   │       ├── jsx-runtime.ts  # 40 行 JSX 运行时：jsx() / renderToString() / esc()
│   │       ├── jsx.d.ts        # 全局 JSX 命名空间声明
│   │       ├── i18n.ts         # zh / zh_tw / en / fr 四语全量文案
│   │       └── icons.ts        # 内联 SVG 系统图标（不依赖 CDN）
│   ├── test/                   # 66 个用例：sandbox / jsx / page / http
│   ├── manifest.json           # OS 镜像清单（已内嵌，不再运行时下载）
│   ├── Dockerfile              # oven/bun:1.2-alpine，无 build 阶段
│   └── tsconfig.json           # jsx: react-jsx + jsxImportSource: "#jsx"
├── sandbox/                    # 沙箱镜像（ttyd + 各发行版 base）
├── deploy/
│   ├── instantbox-k8s.yaml     # 7 个对象，只有 1 个 Deployment
│   └── validate_manifest.py    # 离线校验清单（CI 里真跑）
├── .github/workflows/
│   └── build-images.yml        # bun test + tsc + 清单校验 → buildx 推 ghcr.io
└── README.md
```

---

## 部署

### 0. 前置

- K8s ≥ 1.24（用到了 `automount_service_account_token`、`seccompProfile`）
- 集群能拉到 `instantbox/*` 沙箱镜像（国内建议配 harbor 代理或 containerd 镜像加速，见下文"坑"）

### 1. 构建镜像（交给 CI，本机零安装）

推代码到 GitHub，`.github/workflows/build-images.yml` 会自动：

1. `test` —— `bun install` → `bun test`（66 个用例）→ `bun x tsc --noEmit` → Python 校验 k8s 清单
2. `build-server` / `build-sandbox` —— 测试过了才 buildx 构建并推 **ghcr.io**

镜像地址（固定打三个 tag：`main` / `latest` / `sha-<7位commit>`，**同时 amd64 与 arm64**）：

```
ghcr.io/20020314/instantbox-server:latest      # Bun 单进程（API + SSR + 反代 + WS）
ghcr.io/20020314/instantbox-sandbox-*:latest   # 沙箱（ttyd + 各发行版）
```

> `server-bun/Dockerfile` 里**没有 build 阶段**：源码直接 `COPY` 进去，  
> `CMD ["bun", "run", "src/index.ts"]`。改一行 TS 不用等打包。

> arm64 是必需的：目标集群是 NVIDIA Spark（GB10, arm64）。单架构镜像在 arm64 节点上会  
> `ErrImagePull: no match for platform in manifest`。

这几个 package 的可见性已是 **public**，集群无需 imagePullSecret 即可直拉；  
换成自己的 fork 时，确认 package 是 public，否则给 `instantbox` namespace 配 imagePullSecret。

本地手工构建（**可选**；CI 已经全包，本机不需要装 bun / node / python / docker）：

```bash
docker build -t instantbox-server:latest ./server-bun
```

### 2. 改配置

`deploy/instantbox-k8s.yaml` 的 ConfigMap：

| key                                       | 说明                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `INSTANTBOX_POD_NAMESPACE`                | 沙箱 Pod 的 namespace（默认与 server 相同；不同则 Role 要建在目标 namespace）            |
| `INSTANTBOX_PREFIX`                       | Pod 名前缀，默认 `instantbox-managed-`                                      |
| `INSTANTBOX_TTYD_PORT`                    | 沙箱内 ttyd 端口，官方镜像是 **1588**                                            |
| `INSTANTBOX_SANDBOX_COMMAND`              | 覆盖沙箱容器启动命令，留空用镜像 `CMD`。用不带 `-W` 的旧镜像时填 `ttyd -p 1588 -W bash`（见 §6.2） |
| `INSTANTBOX_CONSOLE_DOMAIN`               | 留空则前端走同域 `/console/<pod>`（推荐：不用配泛域名）                                  |
| `INSTANTBOX_IMAGE_PREFIX`                 | 内网仓库代理前缀，如 `harbor.local/dockerhub/`                                  |
| `INSTANTBOX_MAX_CPU_MILLI` / `MAX_MEM_MB` | 单沙箱上限                                                                 |
| `INSTANTBOX_IDLE_TIMEOUT`                 | 闲置多少秒回收，`0`=只按 TTL                                                    |
| `INSTANTBOX_RUNTIME_CLASS`                | 有 gvisor/kata 就填，沙箱隔离会好很多                                             |
| `INSTANTBOX_SWEEP_INTERVAL`               | 进程内回收扫描间隔（秒），默认 `60`；`0`=关闭（见 §坑 #9）                                  |

> 端口统一在 `src/config.ts` 里读，全部带默认值。命名规则是 `INSTANTBOX_` + 大写字段名，  
> 想加一个配置项只需要在 `config.ts` 加一行 `int('INSTANTBOX_XXX', 默认值)`。


### 3. 应用

在能访问集群 API 的机器上（集群节点本身最省事）：

```bash
kubectl apply -f deploy/instantbox-k8s.yaml --wait=true --timeout=120s
kubectl -n instantbox get pod,svc
```

> `--wait=true --timeout=120s` 不是可选项。删改 Deployment 时旧 Pod 可能还在 `Terminating`，  
> 直接 apply 会撞上 `pod updates may not change fields`。加 `--wait` 让它等旧 Pod 走完。

`kubectl apply` 之后看什么：

- `kubectl -n instantbox get pod` —— 2 个副本都应该 `1/1 Running`。readiness 探的是 `/readyz`，  
  它会真 list 一次沙箱 Pod，所以 **Ready 就等于"SA 权限配对了"**
- 一直 `0/1 Running` → `kubectl -n instantbox logs deploy/instantbox` 看是不是 403（Role 权限）  
  或 namespace 不匹配（ConfigMap 的 `INSTANTBOX_POD_NAMESPACE` vs Role 所在 namespace）
- 页面能打开但建沙箱失败 → 看日志里的建 Pod 报错，多半是配额或镜像拉取

> 从旧架构（`server` / `frontend` / `gateway` 三个 Deployment + CronJob）升级过来的话，  
> 这些对象不在新清单里，`apply` **不会**帮你删。要手工清：
>
> ```bash
> kubectl -n instantbox delete deploy server frontend gateway --ignore-not-found
> kubectl -n instantbox delete cronjob instantbox-prune --ignore-not-found
> kubectl -n instantbox delete svc gateway frontend server --ignore-not-found
> ```

入口：集群任意节点 `http://<node-ip>:30888`（或把 Service `instantbox` 改成 LoadBalancer / 挂 Ingress）


### 4. 冒烟测试

```bash
NS=instantbox
IP=$(kubectl -n $NS get node -o jsonpath='{.items[0].status.addresses[0].address}')  # 或集群入口 IP
BASE=http://$IP:30888

curl -s $BASE/healthz; echo      # 进程活着
curl -s $BASE/readyz;  echo      # apiserver 可达 + SA 鉴权通过

curl -s $BASE/api/v2/superinspire/getOSList | head -c 200; echo

# 建一台（注意 timeout 是"到期的绝对时间戳"，不是时长）
TS=$(( $(date +%s) + 3600 ))
ID=$(curl -s "$BASE/api/v2/superinspire/getOS?os=instantbox/alpine:latest&cpu=1&mem=128&timeout=$TS" \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["containerId"])')
echo "pod=$ID"

kubectl -n $NS get pod "$ID" -w    # 等 Running
curl -sI "$BASE/console/$ID"       # 200 + HTML
curl -s "$BASE/console/$ID/" | head -c 80   # 带尾斜杠也必须是 200（见 §坑 #8）

curl -s "$BASE/api/v2/superinspire/rmOS?containerId=$ID"   # 立即删除
kubectl -n $NS get pod "$ID"       # NotFound
```

**WebSocket 单独验一遍**（这是整条链路里最容易静默失败的一段）：

```bash
# 需要 bun。关键：客户端必须声明子协议 'tty'，否则 ttyd 一个字节都不吐
bun -e '
const pod = process.argv[1]
const ws = new WebSocket(`ws://127.0.0.1:30888/console/${pod}/ws`, ["tty"])
ws.binaryType = "arraybuffer"
ws.onopen = () => ws.send(new TextEncoder().encode(JSON.stringify({
  AuthToken: "", columns: 80, rows: 24 })))
ws.onmessage = (e) => console.log("recv", new Uint8Array(e.data).length, "bytes")
setTimeout(() => process.exit(0), 3000)
' "$ID"
```

能看到 `recv` 且字节数 > 0 就说明桥接通了。零字节 = 上游没带子协议（见 §坑 #17）。

> `/console/<pod>` 的目标是 **Pod IP**，反代发生在集群内部，所以从节点 IP 访问完全没问题。  
> 本地调试也可以 `kubectl port-forward svc/instantbox 8888:65501`（注意是 **65501**，不是 80）。

---

## 关键改造点


### 1. 去掉 docker.sock，改用 ServiceAccount（这是需求里点名要的）

`server-bun/src/k8s.ts` —— 没用 `@kubernetes/client-node`，那个库在 Bun 下会挂在  
Node 的 `https.Agent` 上（证书塞不进去）。直接用 `fetch` 打 REST，四十行就够：

```ts
this.conf = {
  baseUrl: `https://${host}:${port}`,
  token: readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
  tls: { ca: readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt') },
}

const res = await fetch(this.conf.baseUrl + path, {
  method, headers,
  body: body === undefined ? undefined : JSON.stringify(body),
  // ★ 关键：Bun 的 fetch 认这个 tls 字段，Node 的 https.Agent 在这里没用
  ...(this.conf.tls ? { tls: this.conf.tls as any } : {}),
})
```

> `tls: { ca }` 是 Bun 的专有扩展。不带它只会得到  
> `self signed certificate in certificate chain`——而 K8s 的 apiserver 证书**天生**是集群内自签的。

yaml 里 `deployment/instantbox`：

```yaml
spec:
  serviceAccountName: instantbox-server
  automountServiceAccountToken: true    # 只要这个 SA 的 token
  # 没有任何 hostPath /var/run/docker.sock
```

RBAC 是**最小集**，且只限本 namespace：

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "create", "delete", "patch"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "create", "delete"]     # 给沙箱建同名 headless Service
```

> 为什么不给 ClusterRole：沙箱 Pod 只需要在本 namespace 建删。  
> 如果 `INSTANTBOX_POD_NAMESPACE` 改成别的 namespace，**Role/RoleBinding 要建到那个 namespace 去**。

**沙箱 Pod 自己也禁止挂 token**：`automountServiceAccountToken: false` + `enableServiceLinks: false`。  
沙箱是给陌生人用的 shell，绝不能让它拿着 token 去调 apiserver。同样没配 `serviceAccountName`，  
默认 SA 也没权限。

### 2. 删掉「开放端口」选项

上游这个功能是：前端填个内部端口（默认 80），`containers.run(ports={'80/tcp': None})` 让 docker 分配  
一个宿主随机端口，然后把宿主端口吐给前端（`openPort`）。在 K8s 里没有"宿主随机端口"这回事  
（NodePort 是静态的、要预分配，Service 是 1:1 的，都不适合每次动态开一台沙箱）。

改法：**整体删掉**。ttyd 固定 1588，唯一对外入口是进程内的 `/console/<pod>` 反代。

改到的地方：

| 文件                              | 改动                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/frontend/page.tsx`         | 表单只有系统 / 版本 / CPU / 内存 / TTL；内存下限 **64MB**（K8s 给不出 1MB 的 Pod）                                           |
| `src/frontend/i18n.ts`          | 四语文案里删掉 `port` / `internal-port` / `external-port` / `enter-port` / `eg-port` / `err-port` / `msg-port` |
| `src/index.ts` `handleCreate()` | 不读 `port` 参数；响应里 `openPort: null`（字段保留，兼容旧客户端）                                                          |
| `src/sandbox.ts` `create()`     | 签名不含 `openPort`；Pod 只暴露 1588                                                                            |
| `src/sandbox.ts` `shareUrl()`   | 返回**相对路径** `/console/<pod>/`，不再拼 `http://<pod>/`（见 §坑 #7）                                               |

> 老客户端即使还传 `?port=8080` 也只会被忽略，不会报错。


### 3. 转发：docker DNS → 集群 DNS

上游用 nginx + `resolver 127.0.0.11`（docker 内嵌 DNS）+ `proxy_pass http://$1:1588`。  
现在换成一个 `if` 分支：把 `/console/<pod>` 里的 pod 名取出来，拼 FQDN 再转发。  
pod 名限制得死死的（防 SSRF，避免有人拿 `/console/kubernetes` 打 apiserver）：

```ts
const POD_RE = /^instantbox-managed-[a-z0-9]{4,40}$/

// ① WebSocket：必须在 Bun.serve 的 fetch 里 upgrade，不能走 HTTP 分支
const wsMatch = pathname.match(/^\/console\/([^/]+)\/ws$/)
if (wsMatch) {
  const pod = wsMatch[1]
  if (!POD_RE.test(pod)) return text('unknown console target', 404)
  // ★ 不要写 Sec-WebSocket-Protocol，Bun 会自动回显（见 §坑 #17）
  const ok = srv.upgrade(req, {
    headers: { 'Cache-Control': 'no-store' },
    data: { ready: false, queue: [], pod },
  })
  return ok ? undefined : text('upgrade failed', 500)
}

// ② 普通 HTTP：剥掉 /console/<pod> 前缀，反代给 ttyd
const consoleMatch = pathname.match(/^\/console\/([^/]+)(\/.*)?$/)
if (consoleMatch) {
  const pod = consoleMatch[1]
  if (!POD_RE.test(pod)) return text('unknown console target', 404)
  const rest = consoleMatch[2] || '/'          // 无尾斜杠 → 上游就是 "/"
  return proxyHttp(req, `http://${sandboxHost(pod)}${rest}`)
}
```

- 正则写死 `instantbox-managed-` 前缀，且只允许 `[a-z0-9]`，**`.` `/` `:` `@` 全被排除**，SSRF 面收窄。  
  前缀如果要改，`INSTANTBOX_PREFIX` 和 `POD_RE` 必须同步改。
- **upstream 必须写 FQDN** `<pod>.<ns>.svc.cluster.local`，见坑 #12。
- 裸 Pod 没有 A 记录，名字能解析是靠 server 端给每个沙箱建的**同名 headless Service**，见坑 #14。
- **`rest` 为空时补 `/`** 这条逻辑，是 Caddy 版 `uri strip_prefix` 的等价物。它天然安全：  
  空串补 `/`，不会像 nginx 捕获组那样拿到空串后把整条路径扔给静态兜底（见 §坑 #8）。
- 转发请求头时**不能用 `Object.fromEntries(req.headers)`**——Bun 的 `Headers` 没有同步迭代器。  
  而且必须剔掉 hop-by-hop 头，否则上游会以为这是条 keep-alive 长连接：

```ts
const fwd = new Headers()
req.headers.forEach((v, k) => {
  const lk = k.toLowerCase()
  if (lk === 'host' || lk === 'connection' || lk === 'upgrade' || lk === 'keep-alive') return
  fwd.set(k, v)
})
fwd.set('host', pod)     // ttyd 的 Origin 校验看 Host
```

---

## 坑（都是实测踩到的）

### 1. 上游删除接口其实是坏的

`is_rm_container()` 里：

```python
container_network = self.client.networks.get(network_id=container_name + '_net')
```

`container_name` **在这个函数里未定义**（引用的是别处局部变量），一旦走到删除分支就抛  
`NameError`，被外层 `except docker.errors.NotFound` 漏掉 → 500。所以上游"删除系统"基本不生效，  
只能靠 cron 过期回收。本项目重写为 `_delete()`，**幂等**（404 当成功）。

### 2. K8s 下 1MB 内存的 Pod 建不出来

前端内存校验原本是 `1 ~ 3584`，`mem=1` 时 Docker 还能跑，K8s 里 Pod 有最低开销（pause 沙箱、  
cgroup 里 memory.min 等），1024Ki 基本直接 `OOMKilled`/调度失败。已把下限提到 64。  
后端也做了二次校验，越界直接返回 `statusCode: 0` 而不是让 apiserver 报一大堆错。

### 3. `cpu_quota` 的语义要对齐

Docker 的 `cpu_quota=100000` + `cpu_period=100000` = 1 核。K8s 里换成 `requests/limits.cpu = "<n>000m"`。  
注意 K8s 的 CPU **是可压缩资源**，超限只被 throttled，不会 OOM——这点比 Docker 温和，但也意味着  
"限制 1 核"不等于"只能跑 1 核"那么硬。

### 4. TTL 不再靠 `--rm` 和运行时自杀

Docker 版有 `restart_policy: always` + 标签 + cron 扫容器。K8s 里同理：  
标签 `org.instantbox.variables.EXPIRATION_TIMESTAMP` 打在 Pod 上，
**进程内 `setInterval` 每 60s 扫一次**（`INSTANTBOX_SWEEP_INTERVAL`，替代 CronJob，见 §坑 #9）。  
额外加了 `org.instantbox.variables.LAST_SEEN_TIMESTAMP`（`INSTANTBOX_IDLE_TIMEOUT>0` 时生效）。

**不要**在容器里包一层 `sh -c "ttyd ... & sleep $TTL; kill 1"` —— 那样进程树里多了 shell，  
`ps` 看得见，还容易把 ttyd 的退出码吃掉。真要硬清理，用 K8s 的  
`activeDeadlineSeconds`：

```yaml
spec:
  activeDeadlineSeconds: 3600   # 1 小时后 kubelet 直接 SIGTERM
```

想用就在 `_create_pod` 的 `V1PodSpec` 里加一行，本项目默认没加（TTL 由用户输入，逐 Pod 不同，  
而 `activeDeadlineSeconds` 只能在 spec 里写死，需要动态算 —— 其实也能算，顺手加即可）。

### 5. 沙箱隔离：默认是**无隔离**的

`instantbox/ubuntu` 这类镜像的 `CMD` 是 `ttyd -p 1588 -W bash`（本项目的沙箱镜像；上游原版没有 `-W`，见 §6.2），容器内是 **root**、且默认  
`securityContext` 全是开放的。给不信任的人用，务必二选一：

```yaml
# 方案 A：gvisor（推荐，k3s 可装 gvisor addon 或 runsc RuntimeClass）
runtime_class_name: "gvisor"     # = INSTANTBOX_RUNTIME_CLASS=gvisor

# 方案 B：至少加 pod 级 securityContext（但裸容器里 root 还是能干不少事）
```

另外 `automount_service_account_token=False` 已经做了——这一条很重要，否则沙箱里的人  
`cat /var/run/secrets/kubernetes.io/serviceaccount/token` 就能拿到 token（虽然默认 SA 没权限，  
但如果集群装了宽松的 ClusterRoleBinding 就麻烦了）。


### 6. 镜像拉取

`instantbox/*` 镜像都在 Docker Hub，6 个发行版 × 多个版本，单个 Pod 首次拉取可能 100MB+。
国内集群建议：

```yaml
# ConfigMap
INSTANTBOX_IMAGE_PREFIX: "harbor.local/dockerhub/"    # harbor 的 dockerhub 代理项目
```

镜像清单 `server/manifest.json` 里 `osCode` 就是完整镜像名，所以前缀是纯字符串拼接。

> 已实测 `instantbox/ubuntu` 在 Docker Hub 公开可用（manifest 200）；`instantbox/alpine` 没有
> `18.04` 这个 tag 是正常的，它只有 `3.x`。若某个 tag 404，先照 manifest 里的名字去 Hub 核一遍。

`INSTANTBOX_IMAGE_PULL_POLICY` **默认 `Always`**，三个地方（server / frontend / 沙箱）统一。

原因：`server/manifest.json` 里的 `osCode` 全是 `:latest`，配 `IfNotPresent` 时节点上有旧缓存就
**永远不会重新拉**。这个坑在本项目实际发生过两次：

1. server/frontend 改了代码、CI 出了新镜像，`kubectl apply` 后看着一切正常，跑的却是旧版本
2. 沙箱镜像加了 `-W`（见 §6.2）、CI 也重建了，但新建的沙箱 `ps` 里还是 `ttyd -p 1588 bash` ——
   Pod 状态 `Running`、镜像名也对，**只有 `ps` 能看出真相**，白排查了好久

判断某次 Pod 到底用的哪个镜像，看 digest 而不是 tag：

```bash
kubectl -n instantbox get pod <pod> \
  -o jsonpath='{.status.containerStatuses[0].imageID}{"\n"}'
# ghcr.io/20020314/sandbox-ubuntu-22.04@sha256:4f87c089...
```

`Always` 的代价是每次建沙箱都去 check 一次 manifest（层没变不会重下）。真要省这部分，
就把 manifest 的 `osCode` 换成不可变 tag（`:sha-xxxxxxx` 或按日期 `:20261103`），再回到 `IfNotPresent`。

### 6.1 沙箱镜像得自己构建（上游只有 amd64）

上游 `instantbox/ubuntu` 的 `ENTRYPOINT` 是 `ttyd_linux.x86_64`，且 manifest 里只有 amd64。
在 arm64 节点上是 `exec format error`。所以 `sandbox/` 里自己做了多架构镜像
（`ttyd` 按 `TARGETARCH` 下 x86_64 / aarch64）并推到 ghcr，`server/manifest.json` 只列 CI 真构建过的 5 个。
加新发行版 = 改 `sandbox/gen_manifest.py` 的 `GROUPS` + workflow 的 `matrix`，两处要一致。


### 6.2 ttyd 必须加 `-W`，否则「终端能打开、打不了字」

这是整个移植过程中最费时间的一个坑，现象很有迷惑性：

- `/console/<pod>/` 返回 **200**，ttyd 页面正常加载
- WebSocket 握手 **101**，`Sec-WebSocket-Protocol: tty` 协商成功
- 终端里能刷出 `1bash (pod-name)`、窗口标题、以及 `root@pod:/home# ` 提示符
- **但敲任何键都没有反应**，前端根本不回显

实测各种可能原因（同镜像、同一段裸 WebSocket 脚本逐个对照）：

| 变量 | 结果 |
|---|---|
| `ttyd -p 1588 bash` | 输入无回显 ❌ |
| `ttyd -p 1588 -d 7 bash` | 输入无回显 ❌ |
| **`ttyd -p 1588 -W bash`** | **回显 `WORLD_OK` ✅** |
| 容器 `tty: true` / `stdin: true` | 无关 |
| ttyd 是 PID 1 / 通过 `sh -c` / `exec` / `setsid` | 无关 |
| 直连 Pod IP vs 经 nginx 反代 | **完全一致**，与反代无关 |

根因就一句 `ttyd --help` 里的说明：

```
-W, --writable          Allow clients to write to the TTY (readonly by default)
```

ttyd **默认客户端只读**——它照样把服务端输出推给你，但客户端发过来的 `'0'+keys` 帧会被丢弃。
所以「能看不能打」不是 bug，是默认配置。

本项目 `sandbox/Dockerfile` 的 `CMD` 已经是 `["ttyd", "-p", "1588", "-W", "bash"]`。
如果换成上游 `instantbox/*` 镜像（同样是 `ttyd -p 1588 bash`，同样没有 `-W`），
要么改镜像，要么设一个环境变量强制覆盖容器启动命令：

```yaml
env:
  - { name: INSTANTBOX_SANDBOX_COMMAND, value: "ttyd -p 1588 -W bash" }
```

> 排查建议：别急着怀疑 nginx / Service / 网络。先用裸 WebSocket（`Sec-WebSocket-Protocol: tty`）
> 直连 Pod IP，发一帧 `'0' + 'echo X\r'`，看有没有回显——有回显说明链路全通，没回显就是 ttyd 侧的事。

### 7. 前端路由的历史包袱（已彻底解决）

上游前端的"打开系统"按钮做了个骚操作：

```js
containerInfo.shareUrl.replace('http://:', `http://${window.location.hostname}:`)
```

因为后端返回的 `shareUrl` 是 `/console/<name>`，它靠字符串替换拼出宿主地址。
**这就是 bug #1 的根因**：一旦后端返回的不是那个畸形前缀（比如返回 `http://<pod>/`），
这段替换就匹配不上，原样输出 `http://instantbox-managed-xxx/`，浏览器拿去解析就成了
「跳到 `http://instantbox-managed-x7109o6gp3vj/`，没有前缀」。

现在是 SSR 直出，压根没有这段客户端代码。`sandbox.ts` 的 `shareUrl()` 返回
**相对路径** `/console/<pod>/`，`<a href>` 直接用，浏览器按当前 origin 解析——
天然支持 https、NodePort、Ingress 任意前缀。

> 注意尾部那个 `/`。不带斜杠 ttyd 会 404（它是按路径匹配静态资源的），
> 而这个 404 会伪装成「反代没生效」，实测排查了很久。`shareUrl()` 里统一补齐。


### 8. `/console/<pod>` 500 的真凶：nginx 捕获组拿到空串

> 这一节是历史记录（bug #2）。当前实现已经不用 nginx 了，但**下面那个「空捕获组」的陷阱
> 在我换成 Bun 之后依然要防**，所以留档。

原方案是 nginx。`shareUrl` 返回 `/console/<pod>`——**不带尾部斜杠**。
nginx 里那段反代写的是：

```nginx
rewrite "^/console/[^/]+(/.*)?$" $1 break;
```

对 `/console/instantbox-managed-xxx` 这条路径，捕获组 `$1` 是**空串**，nginx 直接判定：

```
[error] the rewritten URI has a zero length
```

→ **500**。而 `/console/<pod>/`（带斜杠）就正常，`/console/<pod>/ws` 也正常——
所以只要测试时手滑带了斜杠，就永远发现不了这个问题。

三个选择：
1. 后端把 `shareUrl` 改成带尾斜杠 —— 治标，用户手输或第三方拼出来的 URL 还是会 500
2. nginx 里加 `if ($1 = "") { rewrite ... / break; }` —— `if` 在 nginx location 里是恶魔
3. **换 Caddy** —— `uri strip_prefix` 对空串天然安全，剩空即 `/`

选了 3，顺带解决另外两件事：

- **`handle` 是有序独占匹配**，谁匹配谁负责，不会像 nginx 的 regex location 那样跟
  `try_files ... /index.html` 互相穿透（静态资源被 SPA 兜底吃掉是 nginx 的经典坑）
- **WebSocket 原生支持**，不用手写 `Upgrade` / `Connection` 那套 map
- 配置能用 `caddy validate` / `caddy adapt` 离线校验，改之前就知道错在哪

Caddyfile 写完之后**先在集群里跑一遍 `caddy validate` 再提交**（省一轮 CI）：

```bash
kubectl -n instantbox create cm caddy-t --from-file=Caddyfile=frontend/Caddyfile
kubectl -n instantbox run caddy-validate --restart=Never --image=caddy:2-alpine \
  --overrides='{"spec":{"containers":[{"name":"v","image":"caddy:2-alpine",
    "command":["caddy","validate","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"],
    "volumeMounts":[{"name":"cf","mountPath":"/etc/caddy"}]}],
    "volumes":[{"name":"cf","configMap":{"name":"caddy-t"}}]}}'
kubectl -n instantbox logs caddy-validate
```

Caddyfile 有两个容易踩的解析顺序问题：

| 现象 | 原因 |
|---|---|
| `File to import not found: console_proxy` | snippet **必须定义在第一次被 `import` 之前**，放文件尾部不行 |
| `unrecognized directive: -Server` | `-Server` 是 `header` 指令的参数，不能裸写在 site 块里；写 `header -Server` |
| `Unnecessary header_up X-Forwarded-For` | Caddy 自动处理这三个头，手写只会刷警告 |

### 9. 关于"删除即回收"与"TTL 兜底"

本例保留了 TTL（用户选 1~24 小时），但**用户点删除时会立即删 Pod**（`grace_period_seconds=0`）。
两者不冲突：TTL 是兜底，防止用户关掉页面不管。如果你们希望"打开 webshell 才算活着、关掉就删"，
把 `INSTANTBOX_IDLE_TIMEOUT` 设成 60~300 即可（目前 `touch()` 还没接到流量路径，见"待完善"）。


### 10. 前端构建：node-sass@4 装不上，sass-loader@7 又不认 dart-sass（历史）

> **整节已作废** —— 前端不再有构建步骤，React/CRA/webpack/sass-loader 全部删除。
> 留在这里只因为「老 webpack 4 在 OpenSSL 3 下的 md4 崩溃」这类问题在别的项目里还会遇到。

这是移植时**实际卡住**的地方，值得单独记一笔：

| 环节 | 现象 | 原因 |
|---|---|---|
| `npm i` | `node-gyp` 编译 node-sass 失败 | node-sass@4.11 的二进制只到 Node 12，Node 16+ 要现场编译；Alpine musl 上更没戏 |
| 换 `sass` | `To import Sass files, you first need to install node-sass` | sass-loader@7.1.0 里写的是 `options.implementation \|\| require("node-sass")`，**它是 `require` 之后再判断**，没装就直接抛错 |
| 加 `implementation: require('sass')` | 仍然报上面的错 | 7.1.0 里 `options.implementation` **根本没被传进** `getRenderFuncFromSassImpl()`——这是个假开关（7.2 才修） |
| Node 17+ 构建 | `ERR_OSSL_EVP_UNSUPPORTED` | 老 webpack 4 用 md4，OpenSSL 3 默认禁用 |

所以做了三件事：

1. `package.json`：`sass@^1.77.8` 进 dependencies，`node-sass` 降级到 **optionalDependencies**（装不上不影响）
2. `frontend/patch-sass-loader.js`：把
   `options.implementation || require("node-sass")` 改成
   `options.implementation || (node-sass ?: sass)`，Dockerfile 和 CI 里都跑一次
3. 构建时 `NODE_OPTIONS=--openssl-legacy-provider`

> 没动 `package.json` 的 scripts，也没用 patch-package —— 因为 `npm ci` 会校验 `package-lock.json`，
> 改 `package.json` 会直接失败。补丁只在构建层生效，最省事。

顺带：`sass-loader@7` 用的是 legacy API，dart-sass 1.8x 会打一堆 `legacy-js-api` 弃用警告，
不影响构建。想彻底干净就升 `react-scripts@5`（会牵动一堆依赖，这里没做）。

### 11. `manifest.json` 不再运行时下载

上游 Dockerfile 里是 `ADD https://raw.githubusercontent.com/.../manifest.json .`，
国内弱网下 `ADD` 会卡到超时（我在本机实测 `curl` 25s 拿不到）。现在把清单**放进仓库**
`server/manifest.json` 一起 COPY 进镜像，构建和运行都不依赖外网。

### 12. 反向代理的 resolver 不做 search 域补全（`/console` 502 的真凶）

现象：沙箱 Pod `Running`、headless Service 也建好了，容器里 `nslookup <pod>`、`wget http://<pod>:1588`
全都通，但反代一直报：

```
nginx: [error] instantbox-managed-xxx could not be resolved (3: Host not found)
caddy: dial tcp: lookup instantbox-managed-xxx on 10.43.0.10:53: no such host
```

原因是 **nginx 的 `resolver` / Go 的 `net.Resolver` 都是纯 DNS 客户端，把主机名原样（带尾点）发给
DNS 服务器**，不会像 glibc / musl 的 `getaddrinfo` 那样按 `/etc/resolv.conf` 的 `search` 域逐个补全。
所以 `nslookup` 能通（libc 帮你补了 `instantbox.svc.cluster.local`），反代不通。

> 排查时特别容易误判：`getent hosts <短名>` 成功并不代表反代能解析，两者走的是完全不同的代码路径。
> **换到 Caddy 之后这个坑依然存在**，因为 Go 的 resolver 行为一模一样。

正确写法：upstream 给**全名**。

```caddyfile
reverse_proxy {re.console.1}.instantbox.svc.cluster.local:1588
```

### 13. nginx 的 `resolver` 地址不能用集群域名（历史，仅 nginx）

顺手写 `resolver kube-dns.kube-system.svc.cluster.local` 看着很优雅，但那是**要解析的域名**，
而 resolver 本身就是用来做解析的——鸡生蛋。实测直接解析失败，必须给 IP：

```nginx
resolver 10.43.0.10 valid=10s ipv6=off;     # k3s 默认；kubeadm 一般 10.96.0.10
```

nginx 和 Caddy 都要手工配 resolver。**Bun 不用**：`fetch` / `dns.lookup` 走 libc 的
`getaddrinfo`，直接读 `/etc/resolv.conf`（Pod 里就是 CoreDNS 的 ClusterIP），而且**自带 search 域补全**。
顺带把 §12 那个 FQDN 的坑也一并消掉了——Bun 传 `instantbox-managed-xxx` 也能解析，
写 FQDN 只是为了不依赖补全。

### 14. 裸 Pod 没有 A 记录，要配同名 headless Service

docker-compose 时代容器名直接可解析，K8s 不是：**Pod 本身不产生 DNS 记录**（哪怕它和访问方同
namespace）。想让 `<pod>.<ns>.svc.cluster.local` 解析到 Pod IP，必须有个 Service 选它。
所以 `create()` 建完 Pod 会紧接着建一个同名 headless Service：

```ts
await this.post(`/api/v1/namespaces/${ns}/services`, {
  metadata: { name: pod, labels: { 'instantbox.sandbox': 'managed' } },
  spec: { clusterIP: 'None', selector: { app: pod }, ports: [{ port: 1588, name: 'ttyd' }] },
})
```

配套：Pod label 里加 `app: <pod名>` 供 selector 选中；删 Pod 时把 Service 一起删（`_delete()` 已处理），
否则名字会被占着，同名沙箱重建时 409。
Role 也要放 `services` 的 `get/list/create/delete`，见 `deploy/instantbox-k8s.yaml`。

### 15. `/readyz` 别用「查一个不存在的 Pod」来判断（403 会被误判成健康）

第一版是这么写的：查一个必然不存在的 Pod，抛异常 = 不健康，返回 404 = 健康。

问题在于 **403 和 404 长得一样**——两者都走 catch 分支。权限配错、token 没挂进去、
namespace 写错，全都返回 404，探针就一路绿灯，Pod 显示 Ready，然后用户点建沙箱才发现
`403 Forbidden`。这个 bug 在生产里能藏很久。

现在改成「**必须成功 list 出沙箱 Pod** 才算健康」：

```ts
if (pathname === '/readyz') {
  try {
    // 列一次沙箱 Pod：能列出来 = apiserver 可达 + SA 鉴权通过。
    await getManager().expiredPods(cfg.IDLE_TIMEOUT, true)   // strict = 抛异常
    return text('ok')
  } catch (err) {
    return text(`k8s api unreachable: ${(err as Error).message}`, 503)
  }
}
```

`expiredPods(idle, strict)` 里 `strict=true` 表示不吞异常。默认 `false` 是给 sweep 用的
（扫失败不该让进程崩，下一轮再试）。

### 16. Bun 的 `fetch` 认 `tls` 字段，`@kubernetes/client-node` 在 Bun 下是废的

第一反应是用官方 SDK，结果每建一个 Pod 都爆
`self signed certificate in certificate chain`。原因是 SDK 把 CA 挂到 Node 的 `https.Agent` 上，
而 **Bun 的 `fetch` 不走 Node 的 `https.Agent`**，那个 CA 根本没被用上。

Bun 的正确姿势是请求级传 TLS 配置：

```ts
await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(podSpec),
  tls: { ca },        // ★ Bun 专有扩展
})
```

代价是得自己拼 URL、自己处理 404，但换来的是**零依赖**（不用 `@kubernetes/client-node`
那一坨 40MB 的 transitive deps）和四十行的可读代码。

验证方式：`create → get → list → get 不存在`，四条全过才算通（实测 201 / 200 / 200 / 404）。

> 踩坑记录：验 `dryRun` 时忘了带 `?dryRun=All`，**真的建了一个 Pod 出来**。
> 现在验证脚本一律先 `kubectl delete pod <name> --ignore-not-found` 收尾。


### 17. ★ WebSocket 子协议：三条反直觉的实测结论

这是整个重写里**踩得最深**的坑，也是最能说明「别信直觉、去抓包」的一节。
现象：代理链路全部打通，HTTP 反代 200，但 WebSocket 一连接就 `1002 Mismatch client protocol`，
或者连上了但**一个字节都不回**。

三个独立变量，测出来的三条硬结论：

| # | 侧 | 结论 | 错误做法的症状 |
|---|---|---|---|
| 1 | 浏览器 ↔ Bun | **不要手工回写 `Sec-WebSocket-Protocol`**，Bun 已自动回显 | 101 响应里出现两个同名头 → `1002 Mismatch client protocol` |
| 2 | Bun → ttyd | **必须** `new WebSocket(url, ['tty'])` | ttyd **静默 0 字节**，不报错、不断连，最难查 |
| 3 | Bun → Bun | 连接对端若是 `Bun.serve` 且自动回显，客户端仍会 `1002` | 所以 `['tty']` 只能对真正的 ttyd 用 |

**第 1 条是怎么确认的**：先怀疑「客户端不接受无回显」，写了个最小 `Bun.serve` 验证——
客户端能连上。再怀疑「`headers` 参数不生效」，写了个 `/deny` 路由抓**原始 101 字节流**，
发现 `/deny` 的响应里**已经带着** `Sec-WebSocket-Protocol: tty`——而 `/deny` 明确不写这个头。
结论：Bun 内部替你写了。

```ts
// ✅ 正确
srv.upgrade(req, { headers: { 'Cache-Control': 'no-store' }, data: {...} })

// ❌ 错误：Bun 会再加一个，头重复
srv.upgrade(req, { headers: { 'Sec-WebSocket-Protocol': 'tty' }, data: {...} })
```

**第 2 条是怎么确认的**：链路正常但 0 字节。逐步收窄——
先确认帧格式没问题（文本帧、二进制帧都试了，都 0 字节），再确认 auth 帧没问题
（照 ttyd 前端的格式发的），最后做**矩阵对照**：

```
with-proto  → 289 bytes   ✅
no-proto    → 0 bytes     ❌
```

同一份代码、同一个 Pod、只差一个子协议参数。

```ts
// ✅ 必须带 ['tty']
open(ws) {
  const upstream = new WebSocket(`ws://${sandboxHost(ws.data.pod)}/ws`, ['tty'])
  upstream.binaryType = 'arraybuffer'
  ...
}
```

**帧中继的细节**（都写在 `src/index.ts` 里了）：

- 客户端还没连上上游时发来的输入，必须**先缓存**，等 `upstream.onopen` 后按序补发
  （`data.queue`），否则用户第一次敲的字会丢
- 上游消息是 `ArrayBuffer`，要**原样** `ws.send()` 给浏览器，不要转成文本
- `Sec-WebSocket-Protocol` 的三条结论写成注释放在 `index.ts` 文件头，改代码前先看一眼

**怎么快速定位是哪一侧的问题**：先在 Pod 里裸连 ttyd（`bun -e` 带 `['tty']`），
能收到字节就说明 ttyd 没问题，坑在代理侧；收不到就是 ttyd 侧（多半是少了 `-W`，见 §6.2）。

---


## 待完善（有意留的口子）

1. **`touch()` 没接到流量路径上**：`INSTANTBOX_IDLE_TIMEOUT > 0` 时需要一个"访问即续命"的信号。
   现在反代和 WS 都在自己进程里，**接起来只需要一行**——在 `proxyHttp` 和 `onopen` 里
   打一次 `PATCH` 改 `LASTSEEN_LABEL` 即可，不用再装 OpenResty 或加 sidecar
   （这是单进程方案意外赚到的好处）。默认 `IDLE_TIMEOUT=0`，此功能关闭。
2. **`status.phase` 没有回传给前端**：Pod 是 `Pending`（镜像还在拉）还是 `Running`，
   前端目前不知道，只能靠"点进去 502 就再点一次"。要做得体面，`getOS` 应该等
   `Running`（加个 readiness probe 轮询，最长 ~30s）再返回 `shareUrl`。
   第一次拉镜像可能要 1~2 分钟，这个体验问题会很明显。
3. **没有并发配额**：谁都能刷 `getOS` 建 Pod。原来的 `limit_req` 随 nginx 一起没了，
   现在**完全没有限流**。两条路：集群侧加 `ResourceQuota`，或进程内加个简单计数器。

   ```yaml
   apiVersion: v1
   kind: ResourceQuota
   metadata: {name: sandbox-quota, namespace: instantbox}
   spec:
     hard:
       pods: "50"
       requests.cpu: "40"
       requests.memory: 80Gi
   ```
   apiserver 会直接拒绝超额的 create，`handleCreate()` 会把错误渲染成错误页。
4. **没用 Ingress 做泛域名**：`INSTANTBOX_CONSOLE_DOMAIN` 留空是刻意选择——同域路径
   `/console/<pod>` 不需要通配 DNS/证书。如果你们要 `xxx.box.example.com`，
   进程得改成按 `Host` 头选 upstream，Ingress 侧加 `*.box.example.com` 的 wildcard 证书。
5. **多副本的 sweep 会重复扫**：2 个副本各扫各的。删同一个过期 Pod 是幂等的（第二次 404），
   所以不影响正确性，只是多打两次 apiserver。真要省，可以给 sweep 加个
   `if (podOrdinal % replicas !== myOrdinal) continue`。**没有做 leader election**——
   为了一个每分钟几十字节的 list 请求不值得。

---

## 测试

**66 个用例，零集群依赖**（`FakeK8s` 记录调用，断言 Pod spec）：

```bash
cd server-bun
bun install
bun test              # 66 pass
bun x tsc --noEmit    # 0 error
```

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/sandbox.test.ts` | 21 | 名字生成、OS 白名单、资源上下限校验、Pod spec 关键字段（`automountServiceAccountToken=false`、端口 1588、TTL 标签、双 label）、创建失败回滚、删除保护（只删自己前缀）、TTL 回收、`strict` 模式、`shareUrl` 是相对路径且带尾斜杠 |
| `test/jsx.test.tsx` | 16 | 5 个字符的转义（含 JSX 子节点与属性值）、嵌套/数组/null/`className`/`style`/布尔属性/void 元素/`dangerouslySetInnerHTML`、语言判定、四语 key 结构一致性 |
| `test/page.test.tsx` | 13 | 首页骨架、表单端点、系统列表、版本联动、四种语言、默认参数、结果页、错误页、XSS 防护 |
| `test/http.test.ts` | 15 | 真起 `Bun.serve` 打路由：`/healthz` `/readyz`、JSON API、页面渲染、语言切换、`Accept-Language`、表单校验 400、SSRF（`/console/../x`）、目录穿越（`%2e%2e`） |

> `jsx.test.tsx` 里那条「四语 key 结构一致性」测试很值：它把 `src/frontend/i18n.ts` 四个语言
> 包递归比对 key 集合，少一个 key 就红。原版 `zh_tw.json` 的 `locale` 字段写成 `"zh"` 这个 bug
> 就是这么被发现的。

CI（`.github/workflows/build-images.yml`）：`bun install` → `bun test` → `bun x tsc --noEmit`
→ `python validate_manifest.py`，全绿才会 buildx 构建推镜像。

`validate_manifest.py` 除了反序列化校验字段名，还断言了**架构约束**：
「只能有 1 个 Deployment」「不能有 CronJob」「不能有 gateway / frontend / server 这几个旧 Service」
「NodePort 必须是 30888」「`SWEEP_INTERVAL > 0`」。这样以后谁不小心把旧架构的 yaml 加回来，
CI 会当场拦下。

> 写 CI 断言时的坑：`python validate_manifest.py` 的失败信息在 **stderr**，
> 一定要用 `2>&1` 才能让 CI 日志里有可读的原因，否则只看到个 `exit code 1`。
