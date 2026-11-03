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
  浏览器 ───────────► │ frontend (nginx Deployment, 2 副本)           │
                     │  /            → React 静态页                  │
                     │  /api/*       → http://server:65501          │
                     │  /console/<pod> → http://<pod>:1588  (WS)    │
                     └───────┬──────────────────────┬───────────────┘
                             │                      │
                    ┌────────▼────────┐   ┌─────────▼──────────────┐
                    │ server (flask)  │   │ 沙箱 Pod                │
                    │ SA: instantbox- │   │ instantbox-managed-xxx  │
                    │     server      │   │ image: instantbox/ubuntu│
                    │ ↓ k8s API       │   │ cmd:   ttyd -p 1588 bash│
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
- **frontend** 一身两职：静态页 + 反代（下文也叫 worker）。这是 K8s 下替代 docker DNS 的关键——
  nginx 用 `resolver` + 变量式 `proxy_pass`，把 `/console/<pod 名>` 动态解析到同 namespace 的 Pod IP。
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
├── frontend/                   # React (antd 3 / CRA 2) + nginx 反代
│   ├── src/...                 # 已移除端口表单、校验、i18n 文案
│   ├── nginx-main.conf         # http 级配置（限速、WS upgrade map）
│   ├── default.conf            # server 级配置（/api、/console 反代）
│   ├── patch-sass-loader.js    # 构建期补丁：sass-loader@7 -> dart-sass（见坑 #10）
│   └── Dockerfile
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
3. `build-server` / `build-frontend` —— 依赖上面两个 job 通过后，用 buildx 构建并推到 **ghcr.io**

镜像地址（构建产物固定打三个 tag：`main` / `latest` / `sha-<7位commit>`，**同时支持 amd64 与 arm64**）：

```
ghcr.io/20020314/instantbox-server:latest    # 或 :main / :sha-xxxxxxx
ghcr.io/20020314/instantbox-frontend:latest
```

> arm64 是必需的：目标集群是 NVIDIA Spark（GB10, arm64）。单架构镜像在 arm64 节点上会
> `ErrImagePull: no match for platform in manifest`。

两个 package 的可见性已是 **public**，集群无需 imagePullSecret 即可直拉；
换成自己的 fork 时，确认 package 是 public，否则给 `instantbox` namespace 配 imagePullSecret。

本地手工构建（**可选**；CI 已经全包，本机不需要装 node / python / docker）：

```bash
docker build -t instantbox-server:latest ./server \
  --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

docker build -t instantbox-frontend:latest ./frontend \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

### 2. 改配置

`deploy/instantbox-k8s.yaml` 的 ConfigMap：

| key | 说明 |
|---|---|
| `INSTANTBOX_POD_NAMESPACE` | 沙箱 Pod 的 namespace（默认与 server 相同；不同则 Role 要建在目标 namespace） |
| `INSTANTBOX_PREFIX` | Pod 名前缀，默认 `instantbox-managed-` |
| `INSTANTBOX_TTYD_PORT` | 沙箱内 ttyd 端口，官方镜像是 **1588** |
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

上游 nginx：`resolver 127.0.0.11`（docker 内嵌 DNS），`proxy_pass http://$1:1588`。
K8s 里改成集群 DNS，并且把 pod 名限制得死死的（防 SSRF，避免有人拿 `/console/kubernetes` 打 apiserver）：

```nginx
location ~ ^/console/(instantbox-managed-[a-z0-9]{4,40})(/.*)?$ {
    set $pod_name $1;
    set $console_upstream http://$pod_name:1588;
    resolver kube-dns.kube-system.svc.cluster.local valid=10s ipv6=off;
    rewrite ^/console/[^/]+(/.*)?$ $1 break;
    proxy_pass $console_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
}
```

- 正则直接写死 `instantbox-managed-` 前缀，且只允许 `[a-z0-9]`，**`. / :` 全被排除**，SSRF 面收窄。
- 前缀如果要改，`INSTANTBOX_PREFIX` 和这里必须同步改。
- 换了 coredns 名字（比如 k3s 的 `kube-dns` 仍然是 `kube-dns.kube-system.svc.cluster.local`）才需要动 resolver。

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

`instantbox/ubuntu` 这类镜像的 `CMD` 是 `ttyd -p 1588 bash`，容器内是 **root**、且默认
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

`IMAGE_PULL_POLICY` 默认 `IfNotPresent`，别用 `Always`——每次建 Pod 都去 check manifest 会拖慢。

### 7. 前端路由的历史包袱

上游前端的"打开系统"按钮做了个骚操作：

```js
containerInfo.shareUrl.replace('http://:', `http://${window.location.hostname}:`)
```

因为后端返回的 `shareUrl` 是 `/console/<name>`，它靠字符串替换拼出宿主地址。本项目让
`INSTANTBOX_CONSOLE_DOMAIN` 留空、`shareUrl` 直接返回**同域相对路径** `/console/<pod>`，
浏览器打开即走当前域名，天然支持 https 和 Ingress。这段 replace 代码留着也不会坏事
（匹配不到 `http://:` 就不替换），但建议后续删掉。

### 8. nginx 里 `proxy_pass` 带变量必须自己拼 URI

`proxy_pass $console_upstream;` 这种变量形式，nginx **不会**自动把 location 匹配掉的
路径段拼回去，必须显式 `rewrite ... break`。上游那版写的是
`rewrite ^/console/([a-z0-9_]+)/?(.*) /$2 break;`，注意它是把 `$2` 当路径——
对 `/console/abc` 而言 `$2` 是空串，会变成 `/`，ttyd 能对付；但对 ttyd 的
`/ws` 之类子路径（`/console/abc/ws`）也是 ok 的。本项目用 `rewrite ^/console/[^/]+(/.*)?$ $1 break;`
等价且更短。

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
