# 沙箱镜像（自建）

## 为什么不是直接用 `instantbox/*`

Docker Hub 上的 `instantbox/ubuntu`、`instantbox/centos` 等**只有 amd64**。
在 arm64 节点上拉取会直接失败：

```
no match for platform in manifest: not found
```

就算拉下来了也起不来，因为镜像里的入口是 `ttyd_linux.x86_64`。

## 做法

`Dockerfile` 用多架构官方基础镜像 + 官方 ttyd 二进制重建，保持与上游同样的约定：

| 约定 | 值 |
|---|---|
| 监听端口 | `1588` |
| 入口 | `ttyd -p 1588 -W bash`（`-W` 不能省，见主 README §6.2） |
| 用户 | root（沙箱是一次性的，靠 TTL 回收） |
| 工作目录 | `/home` |

所以控制面的 `INSTANTBOX_TTYD_PORT`、nginx 的 `/console/` 反代都不用改。

## 构建

CI（`.github/workflows/build-images.yml` 的 `build-sandbox` job）矩阵构建，
推到 `ghcr.io/<owner>/sandbox-<distro>-<version>:latest`，同时出 amd64 与 arm64。

本地调试某个版本：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg BASE=ubuntu:22.04 \
  --build-arg APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/ubuntu \
  sandbox -t my/sandbox-ubuntu-22.04:test
```

## 加新版本

1. 在 workflow 的 `build-sandbox.matrix.include` 加一行
2. 改 `sandbox/gen_manifest.py` 的 `GROUPS`，跑一次 `python sandbox/gen_manifest.py`
3. 提交 —— `server/manifest.json` 变了会触发重建
