# syntax=docker/dockerfile:1
# instantbox-k8s —— 一个 Bun 进程同时是控制面 + 网关 + 前端
#
# 没有前端构建步骤：页面是 JSX，Bun 运行时直接编译。
# 所以不需要 node/npm/webpack，也不需要 nginx/caddy。
#
# 基础镜像 oven/bun 是官方多架构镜像（含 arm64），在本项目的
# NVIDIA Spark / GB10 节点上直接可用。
ARG BUN_VERSION=1.2

FROM oven/bun:${BUN_VERSION}-alpine

WORKDIR /app

ENV NODE_ENV=production \
    INSTANTBOX_SERVER_PORT=65501

# 运行时零依赖：package.json 里只有 devDependencies（typecheck 用）
COPY package.json ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY manifest.json ./manifest.json

# public/ 是可选的静态资源目录（放 logo 之类），没有也能跑
COPY public/ ./public/

# 镜像自带非 root 用户 bun；65501 不需要特权端口
USER bun
EXPOSE 65501

# 注意：oven/bun:alpine 是 musl，没有 wget 之外的 curl，这里用 wget 探活
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:65501/healthz || exit 1

CMD ["bun", "run", "src/index.ts"]
