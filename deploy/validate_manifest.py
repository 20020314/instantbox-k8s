"""离线校验 deploy/instantbox-k8s.yaml：用 k8s python 客户端反序列化成模型，字段名写错会直接报错。"""
import sys

import json

import yaml
from kubernetes.client import ApiClient
from kubernetes.client.models import (
    V1Namespace, V1ServiceAccount, V1Role, V1RoleBinding, V1ConfigMap,
    V1Deployment, V1Service, V1CronJob,
)

KIND_MAP = {
    'Namespace': V1Namespace, 'ServiceAccount': V1ServiceAccount,
    'Role': V1Role, 'RoleBinding': V1RoleBinding, 'ConfigMap': V1ConfigMap,
    'Deployment': V1Deployment, 'Service': V1Service, 'CronJob': V1CronJob,
}

MANIFEST = sys.argv[1] if len(sys.argv) > 1 else '../deploy/instantbox-k8s.yaml'

api = ApiClient()
docs = [d for d in yaml.safe_load_all(open(MANIFEST, encoding='utf-8')) if d]
for d in docs:
    kind = d['kind']
    obj = api.deserialize(json.dumps(d), KIND_MAP[kind], 'application/json')
    print('{:<15} {:<22} -> {}'.format(kind, d['metadata']['name'], type(obj).__name__))

dep = [d for d in docs if d['kind'] == 'Deployment' and d['metadata']['name'] == 'server'][0]
spec = dep['spec']['template']['spec']
assert spec['serviceAccountName'] == 'instantbox-server'
assert spec['automountServiceAccountToken'] is True
assert 'volumes' not in spec, 'server 不应挂载 docker.sock'
assert not any('docker.sock' in str(v) for v in spec.get('volumes', []))
print('[ok] server: 用 SA 令牌，无 docker.sock 挂载')

def get_dep(name):
    found = [d for d in docs if d['kind'] == 'Deployment'
             and d['metadata']['name'] == name]
    assert found, 'Deployment {} 不存在'.format(name)
    return found[0]


# 对外入口必须是 gateway（Caddy），不是纯静态的 frontend-web
gw = get_dep('gateway')
gw_spec = gw['spec']['template']['spec']
assert gw_spec['automountServiceAccountToken'] is False
assert gw_spec['containers'][0]['image'].endswith('instantbox-gateway:latest'), \
    'gateway 必须用 instantbox-gateway 镜像'
print('[ok] gateway: Caddy 反代，不挂 SA token')

fe = get_dep('frontend-web')
assert fe['spec']['template']['spec']['automountServiceAccountToken'] is False
print('[ok] frontend-web: 纯静态，不挂 SA token')

# 对外 NodePort Service 必须指向 gateway
ext = [d for d in docs if d['kind'] == 'Service'
       and d['metadata']['name'] == 'instantbox'][0]
assert ext['spec']['selector'] == {'app': 'instantbox-gateway'}, \
    '对外入口 selector 必须指向 gateway'
assert ext['spec']['ports'][0]['nodePort'] == 30888
print('[ok] 对外入口 NodePort 30888 -> gateway')

role = [d for d in docs if d['kind'] == 'Role'][0]
rules = {tuple(r['resources']): r['verbs'] for r in role['rules']}
pod_verbs = rules[('pods',)]
assert {'create', 'delete', 'get', 'list', 'patch'} <= set(pod_verbs)
# 每个沙箱要配同名 headless Service，反代才能按 Pod 名解析
svc_verbs = rules[('services',)]
assert {'create', 'delete', 'get', 'list'} <= set(svc_verbs)
print('[ok] Role pods={} services={}'.format(pod_verbs, svc_verbs))

cm = [d for d in docs if d['kind'] == 'ConfigMap'][0]['data']
assert cm['INSTANTBOX_POD_NAMESPACE'] == 'instantbox'
print('[ok] ConfigMap {} 项'.format(len(cm)))

# 探针：readiness 要真的探 apiserver，liveness 只探进程
c = spec['containers'][0]
assert c['readinessProbe']['httpGet']['path'] == '/readyz'
assert c['livenessProbe']['httpGet']['path'] == '/healthz'
print('[ok] server 探针 readiness=/readyz liveness=/healthz')

# 沙箱模板不允许出现任何 hostPath（尤其 docker.sock）
for dep_doc in [d for d in docs if d['kind'] == 'Deployment']:
    vs = dep_doc['spec']['template']['spec'].get('volumes', [])
    for v in vs:
        assert 'hostPath' not in v, 'Deployment {} 不允许 hostPath'.format(
            dep_doc['metadata']['name'])
print('[ok] 所有 Deployment 无 hostPath')

print('ALL OK')
