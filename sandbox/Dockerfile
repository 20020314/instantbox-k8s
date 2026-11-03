# syntax=docker/dockerfile:1
# 沙箱镜像：把 amd64-only 的 instantbox/* 换成多架构官方镜像 + ttyd。
#
# 为什么要自建：Docker Hub 上的 instantbox/* 只有 amd64，在 arm64 节点上直接
# ErrImagePull: no match for platform。
#
# 与上游保持一致的约定（控制面和反代依赖这些）：
#   * ttyd 监听 1588
#   * 入口是 bash，容器内是 root
#   * 工作目录 /home
#
# 构建：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg BASE=ubuntu:22.04 sandbox -t instantbox-sandbox:ubuntu-22.04
ARG BASE=ubuntu:22.04
FROM ${BASE}

ARG TTYD_VERSION=1.7.7
ARG TZ=Asia/Shanghai
ARG APT_MIRROR=
ARG APT_EXTRA_PKGS=
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    TERM=xterm-256color \
    TZ=${TZ}

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      arm)   arch=armhf ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache bash ca-certificates curl tzdata vim less procps iproute2; \
    else \
      echo 'Acquire::Retries "3";' > /etc/apt/apt.conf.d/80-retries; \
      if [ -n "${APT_MIRROR}" ]; then \
        for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
          [ -f "$f" ] && sed -i \
            -e "s|http://archive.ubuntu.com/ubuntu|${APT_MIRROR}|g" \
            -e "s|http://security.ubuntu.com/ubuntu|${APT_MIRROR}|g" \
            -e "s|http://deb.debian.org/debian|${APT_MIRROR}|g" "$f" || true; \
        done; \
      fi; \
      apt-get update; \
      apt-get install -y --no-install-recommends \
          bash ca-certificates curl tzdata vim-tiny less procps iproute2; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    curl -fL --retry 3 --retry-delay 2 --max-time 180 -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${arch}"; \
    chmod +x /usr/local/bin/ttyd; \
    ttyd --version

EXPOSE 1588
WORKDIR /home
CMD ["ttyd", "-p", "1588", "bash"]
