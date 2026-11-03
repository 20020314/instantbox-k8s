# syntax=docker/dockerfile:1
# instantbox 控制面（Flask + kubernetes python client）
FROM python:3.12-alpine

WORKDIR /app

# 国内构建可加：--build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_INDEX_URL=https://pypi.org/simple/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY config.py inspire.py ./
COPY api/ ./api/
# 镜像清单随镜像一起发布，避免运行时还要联网
COPY manifest.json ./

LABEL \
  org.label-schema.name="instantbox-server" \
  org.label-schema.vcs-url="https://github.com/instantbox/instantbox"

EXPOSE 65501

# 群集内用 ServiceAccount（自动挂载 token），不要放 kubeconfig 进镜像
CMD ["python3", "inspire.py"]
