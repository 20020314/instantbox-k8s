# syntax=docker/dockerfile:1
# 前端静态资源镜像（只装构建产物，不含任何反代逻辑）
#
# 上游是 CRA 2.1.5 + node-sass 4.11，在 Node >= 16 和 Alpine(musl) 上装不了。
# 处理方式：
#   1. node-sass 降到 optionalDependencies（Alpine 侧根本装不上，失败不影响）
#   2. 用 dart-sass (sass) 代替
#   3. 修 sass-loader@7.1.0 不吃 options.implementation、硬 require("node-sass") 的问题
# 详见 ../README.md 的「坑 #10」
#
# 产物是两个镜像共用的：
#   frontend-web   nginx:alpine + /usr/share/nginx/html   （本文件 target=web）
#   gateway        caddy:alpine + /srv/www                 （本文件 target=gateway）

FROM node:20-alpine AS builder

# 老 CRA 的 webpack 4 用 md4，OpenSSL 3 里默认禁用
ENV NODE_OPTIONS=--openssl-legacy-provider \
    CI=false

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com
# node-sass 是 optional 的，装不上就算了，别让 npm ci 整体失败
ENV npm_config_registry=${NPM_REGISTRY}

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# 修 sass-loader：没有 node-sass 时回落到 dart-sass。
# 单独写个脚本，避免一堆续行符出错
COPY patch-sass-loader.js /app/patch-sass-loader.js
RUN node /app/patch-sass-loader.js

COPY ./src/ /app/src/
COPY ./public/ /app/public/
RUN npm run build && test -d build


# ===========================================================================
# 镜像 A：纯静态前端（nginx）
#   用途：给 Ingress / CDN / 单独扩缩容用。不含任何 /api、/console 反代。
# ===========================================================================
FROM nginx:1.27-alpine AS web

LABEL \
  org.label-schema.name="instantbox-frontend" \
  org.label-schema.vcs-url="https://github.com/instantbox/instantbox"

COPY --from=builder /app/build/ /usr/share/nginx/html/
COPY nginx-web.conf /etc/nginx/conf.d/default.conf

RUN touch /var/run/nginx.pid /var/cache/nginx/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1


# ===========================================================================
# 镜像 B：边缘反代网关（Caddy）
#   用途：一个容器同时服务静态资源 + 反代 /api + 反代 /console（含 WebSocket）
#   配置见 Caddyfile，路径 /srv/www 与镜像 A 的内容完全一致
# ===========================================================================
FROM caddy:2-alpine AS gateway

LABEL \
  org.label-schema.name="instantbox-gateway" \
  org.label-schema.vcs-url="https://github.com/instantbox/instantbox"

COPY --from=builder /app/build/ /srv/www/
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
