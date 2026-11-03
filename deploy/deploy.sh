#!/bin/bash
# 一键部署 instantbox-k8s —— 在能访问集群 API 的机器上跑（含集群节点本身）
#
# 用法：
#   bash deploy/deploy.sh                        # 用默认 kubeconfig 位置
#   KUBECONFIG=/root/.kube/config bash deploy/deploy.sh
#   KUBECONFIG=/etc/rancher/k3s/k3s.yaml bash deploy/deploy.sh
#
# 做的事：apply 清单 → 等 server/frontend ready → 打印入口地址 → 冒烟测试
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/instantbox-k8s.yaml"
NS=instantbox

die() { echo "[FAIL] $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

[[ -f "$MANIFEST" ]] || die "找不到 $MANIFEST"
command -v kubectl >/dev/null 2>&1 || die "没有 kubectl"

step "0. 集群连通性"
kubectl version -o json 2>/dev/null | head -c 0 || die "kubectl 连不上 apiserver（检查 KUBECONFIG）"
kubectl get --raw='/readyz' >/dev/null 2>&1 || echo "[WARN] /readyz 不通，继续尝试"

step "1. apply 清单"
kubectl apply -f "$MANIFEST"

step "2. 等 server / frontend 就绪（最多 300s）"
kubectl -n "$NS" rollout status deploy/server   --timeout=300s || \
  die "server 没起来：kubectl -n $NS describe pod -l app=instantbox-server"
kubectl -n "$NS" rollout status deploy/frontend --timeout=300s || \
  die "frontend 没起来：kubectl -n $NS describe pod -l app=instantbox-frontend"

step "3. 资源概览"
kubectl -n "$NS" get pod,svc,cronjob,sa,role,rolebinding

step "4. 入口地址"
NODE_PORT=$(kubectl -n "$NS" get svc instantbox -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || echo 30888)
NODES=$(kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)
[[ -z "$NODES" ]] && NODES=$(kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null || true)
echo "NodePort = $NODE_PORT"
for ip in $NODES; do
  echo "  http://$ip:$NODE_PORT/"
done

step "5. 冒烟测试（集群内 curl 前端）"
kubectl -n "$NS" run smoke-$RANDOM --rm -i --restart=Never --image=curlimages/curl:8.10.1 \
  --command -- curl -sS -o /dev/null -w 'frontend http=%{http_code}\n' http://frontend:8080/ 2>&1 | tail -3 || \
  echo "[WARN] 冒烟测试失败，请手工 curl 上面的地址"

echo
echo "[OK] 部署完成。首次在页面上建沙箱时，Pod 要拉 instantbox/* 镜像，会慢一两分钟。"
