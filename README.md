# instantbox on Kubernetes

把 [instantbox/instantbox](https://github.com/instantbox/instantbox)（浏览器里"秒开一台临时 Linux + webshell"）移植到 Kubernetes。

上游项目 2019 年之后基本停更，架构是 **docker-compose + 挂载 `/var/run/docker.sock` 的 Docker SDK**，
在 K8s 上不可用。这里做了三件事：

| 改动 | 上游做法 | 本项目做法 |
|---|---|---|
| **创建"容器"** | 挂 `docker.sock`，用 `docker-py` `containers.run()` | **用 Pod 自带的 ServiceAccount 调 k8s API 建 Pod**（RBAC 最小权限） |
| **"开放端口"选项** | 前端填内部端口，`ports={...}` 映射到宿主随机端口，`GET /getOS` 返回 `openPort` | **整个选项删除**：沙箱固定跑 ttyd:1588，对外只经 worker 反代，`openPort` 恒为 `null` |
| **转发 webshell** | 前端 nginx 用 docker 内嵌 DNS `127.0.0.11` 解析容器名 | worker 用**集群 DNS 解析 Pod 名**（Pod 名即主机名） |

---

## 架构

```
                     ┌──────────────────────────────────────────────┐
  浏览器 ───────────► │ gateway (Caddy Deployment, 2 副本)            │
   :30888             │  /              → /srv/www 静态页             │
                     │  /api/*         → http://server:65501        │
                     │  /console/<pod> → http://<pod>:1588  (WS)    │
                     └───────┬──────────────────────┬───────────────┘
                             │                      │
                    ┌────────▼────────┐   ┌─────────▼──────────────┐
                    │ server (flask)  │   │ 沙箱 Pod                │
                    │ SA: instantbox- │   │ instantbox-managed-xxx  │
                    │     server      │   │ image: sandbox-*        │
                    │ ↓ k8s API       │   │ cmd: ttyd -p 1588 -W bash│
                    │ create/delete   │   └────────────────────────┘
                    │ Pod             │
                    └────────┬────────┘
                             │
              ┌──────────────▼───────────────┐
              │ CronJob 每分钟 /prune         │
              │ 删掉 TTL 到期 / 空闲超时的 Pod │
              └──────────────────────────────┘
```

- **server** 只做控制面：建 Pod、删 Pod、回收过期 Pod。不碰任何转发流量，因此可以随便重启。
- **gateway**（Caddy）是对外唯一入口，三件事：发静态页、反代 `/api`、反代 `/console/<pod>`（含 WebSocket）。
  这是 K8s 下替代 docker DNS 的关键——用正则把 `/console/<pod 名>` 还原成
  `<pod>.<ns>.svc.cluster.local:1588` 再转发。
- **frontend-web**（nginx）是**纯静态**镜像，不含任何反代逻辑。默认不挂在对外入口上，
  留给「Ingress / CDN 直接分流静态资源」或「静态资源想单独扩缩容」的场景。
  两个镜像由同一个 `frontend/Dockerfile` 的两个 target 产出，共用构建缓存。
- **CronJob** 替代上游的 cron 容器（wget /prune）。

---

## 目录

```
instantbox-k8s/
├── server/                     # Flask 控制面（Docker -> K8s 的改造点主要在这）
│   ├── config.py               # 全部配置走环境变量
│   ├── inspire.py              # 路由；getOS 已去掉 port 参数
│   ├── api/instantboxManager.py# k8s client 建 Pod / 删 Pod / 回收
│   ├── manifest.json           # OS 镜像清单（已内嵌，不再运行时下载）
│   ├── test_manager.py         # 18 个单测，用假 client，不连集群
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/                   # React (antd 3 / CRA 2)，一个 Dockerfile 出两个镜像
│   ├── src/...                 # 已移除端口表单、校验、i18n 文案
│   ├── Caddyfile               # gateway target：静态 + /api + /console（含 WS）
│   ├── nginx-web.conf          # web target：纯静态 server 块，无任何反代
│   ├── patch-sass-loader.js    # 构建期补丁：sass-loader@7 -> dart-sass（见坑 #10）
│   └── Dockerfile              # multi-stage, target=web / target=gateway
├── deploy/
│   ├── instantbox-k8s.yaml     # Namespace/SA/Role/RoleBinding/CM/Deployments/Services/CronJob
│   └── validate_manifest.py    # 离线校验清单字段
├── .github/workflows/
│   └── build-images.yml        # 测试 + 前端构建 + buildx 推 ghcr.io
└── README.md
```

---

## 部署

### 0. 前置

- K8s ≥ 1.24（用到了 `automount_service_account_token`、`seccompProfile`）
- 集群能拉到 `instantbox/*` 沙箱镜像（国内建议配 harbor 代理或 containerd 镜像加速，见下文"坑"）

### 1. 构建两个镜像（交给 CI）

推代码到 GitHub，`.github/workflows/build-images.yml` 会自动：

1. `server-test` —— 跑后端单测（假 client，不连集群）+ 离线校验 k8s 清单
2. `frontend-build` —— `npm ci` → 打 sass-loader 补丁 → babel 语法检查 → **真实 `npm run build`**
3. `build-server` / `build-frontend-web` / `build-gateway` / `build-sandbox` —— 依赖前两个 job
   通过后，用 buildx 构建并推到 **ghcr.io**

镜像地址（构建产物固定打三个 tag：`main` / `latest` / `sha-<7位commit>`，**同时支持 amd64 与 arm64**）：

```
ghcr.io/20020314/instantbox-server:latest      # Flask 控制面
ghcr.io/20020314/instantbox-gateway:latest     # Caddy 边缘反代（对外入口，含静态页）
ghcr.io/20020314/instantbox-frontend:latest    # 纯静态前端（无任何反代）
```

> `instantbox-gateway` 和 `instantbox-frontend` **来自同一个 Dockerfile 的两个 target**
> （`gateway` / `web`），共用 `frontend-build` 的构建产物的缓存。
> 日常部署只需要 gateway；frontend 是给「Ingress 或 CDN 直接分流静态资源」准备的。

> arm64 是必需的：目标集群是 NVIDIA Spark（GB10, arm64）。单架构镜像在 arm64 节点上会
> `ErrImagePull: no match for platform in manifest`。

这几个 package 的可见性已是 **public**，集群无需 imagePullSecret 即可直拉；
换成自己的 fork 时，确认 package 是 public，否则给 `instantbox` namespace 配 imagePullSecret。

本地手工构建（**可选**；CI 已经全包，本机不需要装 node / python / docker）：

```bash
docker build -t instantbox-server:latest ./server \
  --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

# 两个 target 各自构建
docker build --target web     -t instantbox-frontend:latest ./frontend \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker build --target gateway -t instantbox-gateway:latest ./frontend \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

### 2. 改配置

`deploy/instantbox-k8s.yaml` 的 ConfigMap：

| key | 说明 |
|---|---|
| `INSTANTBOX_POD_NAMESPACE` | 沙箱 Pod 的 namespace（默认与 server 相同；不同则 Role 要建在目标 namespace） |
| `INSTANTBOX_PREFIX` | Pod 名前缀，默认 `instantbox-managed-` |
| `INSTANTBOX_TTYD_PORT` | 沙箱内 ttyd 端口，官方镜像是 **1588** |
| `INSTANTBOX_SANDBOX_COMMAND` | 覆盖沙箱容器启动命令，留空用镜像 `CMD`。用不带 `-W` 的旧镜像时填 `ttyd -p 1588 -W bash`（见 §6.2） |
| `INSTANTBOX_CONSOLE_DOMAIN` | 留空则前端走同域 `/console/<pod>`（推荐：不用配泛域名） |
| `INSTANTBOX_IMAGE_PREFIX` | 内网仓库代理前缀，如 `harbor.local/dockerhub/` |
| `INSTANTBOX_MAX_CPU_MILLI` / `MAX_MEM_MB` | 单沙箱上限 |
| `INSTANTBOX_IDLE_TIMEOUT` | 闲置多少秒回收，`0`=只按 TTL |
| `INSTANTBOX_RUNTIME_CLASS` | 有 gvisor/kata 就填，沙箱隔离会好很多 |

### 3. 应用

在能访问集群 API 的机器上（集群节点本身最省事）：

```bash
# 方式 A：一键脚本（apply + 等就绪 + 打印入口 + 冒烟测试）
KUBECONFIG=/root/.kube/config bash deploy/deploy.sh
# k3s 就是 KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 方式 B：手工
kubectl apply -f deploy/instantbox-k8s.yaml
kubectl -n instantbox get pod,svc,cronjob
```

`kubectl apply` 之后看什么：

- `kubectl -n instantbox get pod` —— server 应该 `1/1 Running`。readiness 探的是 `/readyz`，
  它会真打一次 apiserver，所以 **Ready 就等于"SA 权限配对了"**
- 一直 `0/1 Running` → `kubectl -n instantbox logs deploy/server` 看是不是 403（Role 权限）
  或 namespace 不匹配（ConfigMap 的 `INSTANTBOX_POD_NAMESPACE` vs Role 所在 namespace）
- 页面能打开但建沙箱失败 → 看 server 日志里的 `create_namespaced_pod` 报错，多半是配额或镜像拉取

入口：集群任意节点 `http://<node-ip>:30888`（或把 Service `instantbox` 改成 LoadBalancer / 挂 Ingress）

### 4. 冒烟测试

```bash
NS=instantbox
IP=$(kubectl -n $NS get node -o jsonpath='{.items[0].status.addresses[0].address}')  # 或集群入口 IP
BASE=http://$IP:30888

curl -s $BASE/api/v2/superinspire/getOSList | head -c 200; echo

# 建一台（注意 timeout 是"到期的绝对时间戳"，不是时长）
TS=$(( $(date +%s) + 3600 ))
ID=$(curl -s "$BASE/api/v2/superinspire/getOS?os=instantbox/alpine:latest&cpu=1&mem=128&timeout=$TS" \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["containerId"])')
echo "pod=$ID"

kubectl -n $NS get pod "$ID" -w    # 等 Running
curl -sI "$BASE/console/$ID"       # 200 + HTML

curl -s "$BASE/api/v2/superinspire/rmOS?containerId=$ID"   # 立即删除
kubectl -n $NS get pod "$ID"       # NotFound
```

> `/console/<pod>` 的目标是 **Pod IP**，反代发生在集群内部，所以从节点 IP 访问完全没问题。
> 本地调试也可以 `kubectl port-forward svc/instantbox 8888:80`。

---

## 关键改造点

### 1. 去掉 docker.sock，改用 ServiceAccount（这是需求里点名要的）

`server/api/instantboxManager.py`：

```python
if os.environ.get('KUBERNETES_SERVICE_HOST'):
    config.load_incluster_config()      # 集群内：用挂进来的 SA token
else:
    config.load_kube_config()           # 本地调试：用 ~/.kube/config
```

yaml 里 `deployment/server`：

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

改法：**整体删掉**。ttyd 固定 1588，唯一对外入口是 worker 的 `/console/<pod>` 反代。

改到的文件：

| 文件 | 改动 |
|---|---|
| `frontend/src/components/SelectSystemConfig/SelectForm.js` | 删端口输入框与校验规则；内存下限 1 → **64MB**（K8s 给不出 1MB 的 Pod） |
| `frontend/src/components/SelectSystemConfig/SelectSystemConfig.js` | state 删 `port`，`handlePortChange`/步骤 1 端口校验删除，`getOSUrl` 不再传 port，成功判定去掉 `res.openPort` |
| `frontend/src/components/SystemConfiguration/SystemConfiguration.js` | 删 `innerPort`/`externalPort`/`showInnerPort`/`showExternalPort` |
| `frontend/src/App.js` | 删 `port`/`externalPort` state 与对应 props |
| `frontend/src/util/api.js` | `getOSUrl(osCode, timeout, cpu, mem)`，默认 mem 修正为 512（原来 0.5 会被 K8s 拒绝） |
| `frontend/src/i18n/locale/*.json` | 删 `port`/`internal-port`/`external-port`/`enter-port`/`eg-port`/`err-port`/`msg-port` |
| `server/inspire.py` | 不再读 `request.args.get('port')`；响应 `openPort: null`（字段保留，兼容旧客户端） |
| `server/api/instantboxManager.py` | `is_create_container()` 签名去掉 `open_port`；Pod 只暴露 1588 |

> 老客户端即使还传 `?port=8080` 也只会被忽略，不会报错。

### 3. 转发：docker DNS → 集群 DNS

上游用 nginx + `resolver 127.0.0.11`（docker 内嵌 DNS）+ `proxy_pass http://$1:1588`。
本项目换成 **Caddy**，核心是同一个思路：把 `/console/<pod>` 里的 pod 名取出来，
拼成 FQDN 再转发。pod 名限制得死死的（防 SSRF，避免有人拿 `/console/kubernetes` 打 apiserver）：

```caddyfile
handle /console/* {
    @console path_regexp console ^/console/(instantbox-managed-[a-z0-9]{4,40})(?:/(.*))?$

    handle @console {
        # 有剩余路径：剥掉 /console/<pod> 前缀，原样透传给 ttyd
        @has_rest vars {re.console.2} != ""
        handle @has_rest {
            uri strip_prefix /console/{re.console.1}
            reverse_proxy {re.console.1}.{$POD_NAMESPACE::instantbox}.svc.cluster.local:{$TTYD_PORT::1588} {
                import console_proxy
            }
        }
        # 无尾斜杠：上游就是 "/"
        handle {
            rewrite * /
            reverse_proxy {re.console.1}.{$POD_NAMESPACE::instantbox}.svc.cluster.local:{$TTYD_PORT::1588} {
                import console_proxy
            }
        }
    }

    # 名字不合规：明确 404，绝不漏到静态兜底
    handle {
        respond "unknown console target" 404
    }
}
```

- 正则写死 `instantbox-managed-` 前缀，且只允许 `[a-z0-9]`，**`.` `/` `:` `@` 全被排除**，SSRF 面收窄。
  前缀如果要改，`INSTANTBOX_PREFIX` 和这里必须同步改。
- **upstream 必须写 FQDN** `<pod>.<ns>.svc.cluster.local`，见坑 #12（Go 的 resolver 和 nginx 一样不做 search 补全）。
- 裸 Pod 没有 A 记录，名字能解析是靠 server 端给每个沙箱建的**同名 headless Service**，见坑 #14。
- Caddy 的 `reverse_proxy` 目标**支持占位符**，但要求「地址不带 scheme 且必须带端口」
  （端口这里是静态后缀 `:{$TTYD_PORT::1588}`）——官方文档 Upstream addresses 一节有说明。
- **不要手写 `X-Forwarded-For/-Proto/-Host`**：Caddy 自动处理，写了 `caddy validate` 会警告
  `Unnecessary header_up`。只需要补 `Host` 和 `X-Real-IP`。

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
标签 `org.instantbox.variables.EXPIRATION_TIMESTAMP` 打在 Pod 上，CronJob 每分钟扫一次。
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

### 7. 前端路由的历史包袱

上游前端的"打开系统"按钮做了个骚操作：

```js
containerInfo.shareUrl.replace('http://:', `http://${window.location.hostname}:`)
```

因为后端返回的 `shareUrl` 是 `/console/<name>`，它靠字符串替换拼出宿主地址。本项目让
`INSTANTBOX_CONSOLE_DOMAIN` 留空、`shareUrl` 直接返回**同域相对路径** `/console/<pod>`，
浏览器打开即走当前域名，天然支持 https 和 Ingress。这段 replace 代码留着也不会坏事
（匹配不到 `http://:` 就不替换），但建议后续删掉。

### 8. 为什么用 Caddy 而不是 nginx（`/console/<pod>` 500 的真凶）

原方案是 nginx。前端 `shareUrl` 返回的是 `/console/<pod>`——**不带尾部斜杠**。
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

### 10. 前端构建：node-sass@4 装不上，sass-loader@7 又不认 dart-sass

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

### 13. nginx 的 `resolver` 地址不能用集群域名（仅 nginx）

顺手写 `resolver kube-dns.kube-system.svc.cluster.local` 看着很优雅，但那是**要解析的域名**，
而 resolver 本身就是用来做解析的——鸡生蛋。实测直接解析失败，必须给 IP：

```nginx
resolver 10.43.0.10 valid=10s ipv6=off;     # k3s 默认；kubeadm 一般 10.96.0.10
```

Caddy 不需要这行：它读 `/etc/resolv.conf`（Pod 里就是 CoreDNS 的 ClusterIP），没有任何配置项要填。
这也是换 Caddy 之后少掉的一个坑。

### 14. 裸 Pod 没有 A 记录，要配同名 headless Service

docker-compose 时代容器名直接可解析，K8s 不是：**Pod 本身不产生 DNS 记录**（哪怕它和访问方同
namespace）。想让 `<pod>.<ns>.svc.cluster.local` 解析到 Pod IP，必须有个 Service 选它。
所以 `is_create_container()` 建完 Pod 会紧接着建一个同名 headless Service：

```python
client.V1ServiceSpec(cluster_ip='None', selector={'app': container_name}, ports=[...1588])
```

配套：Pod label 里加 `app: <pod名>` 供 selector 选中；删 Pod 时把 Service 一起删（`_delete()` 已处理），
否则名字会被占着，同名沙箱重建时 409。
Role 也要放 `services` 的 `get/list/create/delete`，见 `deploy/instantbox-k8s.yaml`。

---

## 待完善（有意留的口子）

1. **`touch()` 没接到流量路径上**：`INSTANTBOX_IDLE_TIMEOUT > 0` 时需要一个"访问即续命"的信号。
   最干净的做法是在 nginx `default.conf` 的 `/console` 里加 `access_by_lua` 或
   `log_by_lua` 去调 `PATCH /api/...`（要装 OpenResty），或用 nginx 的 `mirror` 指令打一个
   sidecar。本项目默认 `IDLE_TIMEOUT=0`，此功能关闭，因此不影响使用。
2. **`status.phase` 没有回传给前端**：Pod 是 `Pending`（镜像还在拉）还是 `Running`，
   前端目前不知道，只能靠"点进去 502 就再点一次"。要做得体面，`getOS` 应该等
   `Running`（加个 readiness probe 轮询，最长 ~30s）再返回 `shareUrl`。
3. **没有并发配额**：谁都能刷 `getOS` 建 Pod，只靠 nginx 的 `limit_req 5r/m`。
   生产环境建议加 `ResourceQuota`：

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
   apiserver 会直接拒绝超额的 `create`，server 那边会返回 `statusCode: 0`。
4. **没用 Ingress 做泛域名**：`INSTANTBOX_CONSOLE_DOMAIN` 留空是刻意选择——同域路径
   `/console/<pod>` 不需要通配 DNS/证书。如果你们要 `xxx.box.example.com`，
   worker 得改成按 `Host` 头选 upstream，Ingress 侧加 `*.box.example.com` 的 wildcard 证书。

---

## 测试

本地（已验证通过）：

```bash
cd server
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt pytest pyyaml
.venv/Scripts/python -m pytest test_manager.py -q          # 18 passed，不连真集群

cd ../deploy
../server/.venv/Scripts/python validate_manifest.py        # 用 k8s 客户端模型反序列化校验 yaml
```

CI（`.github/workflows/build-images.yml`）：上面两项 + 前端 `npm ci` → 打补丁 → babel 语法检查
→ `npm run build`，全绿才会构建推镜像。

`test_manager.py` 里的 `FakeCore` 实现了 `create/list/read/delete/patch_namespaced_pod`，
覆盖：建 Pod 的 spec（资源配额、`automount_service_account_token=False`、端口 1588、TTL 标签）、
非法参数拒绝（0MB / 超上限 CPU）、删除幂等、只允许删自己前缀的 Pod（防越权）、
TTL 过期回收、镜像仓库前缀覆盖、`getOS` 返回 `openPort: null` 且忽略客户端传的 `port`。

`validate_manifest.py` 会把每个 YAML 文档反序列化成 k8s 模型对象——字段名拼错（比如
`runtime_class_name` 写成 `runtimeClass`）会当场报错，不用等真集群。
