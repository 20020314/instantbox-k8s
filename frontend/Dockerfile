# syntax=docker/dockerfile:1
# instantbox 前端 + 反代 worker（一个 nginx）
#
# 上游是 CRA 2.1.5 + node-sass 4.11，在 Node >= 16 和 Alpine(musl) 上装不了。
# 处理方式：
#   1. node-sass 降到 optionalDependencies（Alpine 侧根本装不上，失败不影响）
#   2. 用 dart-sass (sass) 代替
#   3. 修 sass-loader@7.1.0 不吃 options.implementation、硬 require("node-sass") 的问题
# 详见 ../README.md 的「坑 #10」
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


FROM nginx:1.27-alpine

LABEL \
  org.label-schema.name="instantbox-frontend" \
  org.label-schema.vcs-url="https://github.com/instantbox/instantbox"

COPY --from=builder /app/build/ /usr/share/nginx/html/
COPY nginx-main.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf

# 让 nginx 以非 root 运行（pod securityContext 里 drop ALL 时需要）
RUN touch /var/run/nginx.pid /var/cache/nginx/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
