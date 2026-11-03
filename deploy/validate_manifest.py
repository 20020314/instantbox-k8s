"""离线校验 deploy/instantbox-k8s.yaml。

用 k8s python 客户端反序列化成模型 —— 字段名写错会直接报错。
再断言几条「换架构时最容易忘」的约束。
"""
import json
import sys

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

MANIFEST = sys.argv[1] if len(sys.argv) > 1 else 'instantbox-k8s.yaml'

api = ApiClient()
docs = [d for d in yaml.safe_load_all(open(MANIFEST, encoding='utf-8')) if d]
for d in docs:
    kind = d['kind']
    obj = api.deserialize(json.dumps(d), KIND_MAP[kind], 'application/json')
    print('{:<15} {:<22} -> {}'.format(kind, d['metadata']['name'], type(obj).__name__))


def get_dep(name):
    found = [d for d in docs if d['kind'] == 'Deployment'
             and d['metadata']['name'] == name]
    assert found, 'Deployment {} 不存在'.format(name)
    return found[0]


# ---- 只应有一个应用 Deployment（Bun 一体化：前端+控制面+网关+回收器）
deps = [d for d in docs if d['kind'] == 'Deployment']
assert len(deps) == 1, '现在只应有一个 Deployment，实际 {}: {}'.format(
    len(deps), [d['metadata']['name'] for d in deps])
print('[ok] 只有一个 Deployment（Bun 一体化）')

app = get_dep('instantbox')
spec = app['spec']['template']['spec']

# ---- 控制面需要的权限上下文
assert spec['serviceAccountName'] == 'instantbox-server'
assert spec['automountServiceAccountToken'] is True
assert 'volumes' not in spec, '不应挂载 docker.sock 之类的卷'
print('[ok] instantbox: 用 SA 令牌，无卷挂载')

# ---- 镜像与端口
c = spec['containers'][0]
assert c['image'].endswith('instantbox-server:latest'), \
    '应该用 instantbox-server 镜像，实际 {}'.format(c['image'])
assert c['imagePullPolicy'] == 'Always', \
    'tag 是 :latest，必须 Always，否则节点缓存导致永不更新'
assert c['ports'][0]['containerPort'] == 65501
print('[ok] 镜像 {} / port 65501 / pullPolicy Always'.format(c['image']))

# ---- 探针：readiness 要真的探 apiserver，liveness 只探进程
assert c['readinessProbe']['httpGet']['path'] == '/readyz'
assert c['livenessProbe']['httpGet']['path'] == '/healthz'
print('[ok] 探针 readiness=/readyz liveness=/healthz')

# ---- 安全上下文
assert spec['securityContext']['runAsNonRoot'] is True
assert c['securityContext']['readOnlyRootFilesystem'] is True
assert c['securityContext']['allowPrivilegeEscalation'] is False
print('[ok] 非 root + 只读根文件系统 + 禁止提权')

# ---- 对外入口
# 注意：api.deserialize 会把 spec.selector 转成 V1LabelSelector 对象，
# 不能直接和 dict 比
ext = [d for d in docs if d['kind'] == 'Service'
       and d['metadata']['name'] == 'instantbox'][0]
ext_obj = api.deserialize(json.dumps(ext), V1Service, 'application/json')
assert ext_obj.spec.selector == {'app': 'instantbox'}, \
    '对外入口 selector 必须指向 instantbox，实际 {}'.format(ext_obj.spec.selector)
assert ext_obj.spec.ports[0].node_port == 30888
assert ext_obj.spec.ports[0].target_port == 65501
assert ext_obj.spec.type == 'NodePort'
print('[ok] 对外入口 NodePort 30888 -> 65501 (instantbox)')

# ---- RBAC
role = [d for d in docs if d['kind'] == 'Role'][0]
rules = {tuple(r['resources']): r['verbs'] for r in role['rules']}
pod_verbs = rules[('pods',)]
assert {'create', 'delete', 'get', 'list', 'patch'} <= set(pod_verbs)
# 每个沙箱要配同名 headless Service
svc_verbs = rules[('services',)]
assert {'create', 'delete', 'get', 'list'} <= set(svc_verbs)
print('[ok] Role pods={} services={}'.format(pod_verbs, svc_verbs))

# ---- ConfigMap 关键项
cm = [d for d in docs if d['kind'] == 'ConfigMap'][0]['data']
assert cm['INSTANTBOX_POD_NAMESPACE'] == 'instantbox'
assert cm['INSTANTBOX_SERVER_PORT'] == '65501'
assert cm['INSTANTBOX_TTYD_PORT'] == '1588'
# 留空 = 同域相对路径，不需要 DNS 泛解析
assert cm['INSTANTBOX_CONSOLE_DOMAIN'] == ''
# 进程内回收：不再是 CronJob
assert int(cm['INSTANTBOX_SWEEP_INTERVAL']) > 0
print('[ok] ConfigMap {} 项，进程内回收 {}s'.format(
    len(cm), cm['INSTANTBOX_SWEEP_INTERVAL']))

# ---- 已经删掉的东西不该复活
assert not [d for d in docs if d['kind'] == 'CronJob'], '回收已并入进程，不该再有 CronJob'
assert not [d for d in docs if d['kind'] == 'Service'
            and d['metadata']['name'] in ('gateway', 'frontend', 'server')], \
    '旧的 gateway/frontend/server Service 都该删掉'
print('[ok] 无 CronJob / 无遗留 gateway-frontend-server Service')

# ---- 不允许出现任何 hostPath（尤其 docker.sock）
for dep_doc in deps:
    for v in dep_doc['spec']['template']['spec'].get('volumes', []):
        assert 'hostPath' not in v, 'Deployment {} 不允许 hostPath'.format(
            dep_doc['metadata']['name'])
print('[ok] 所有 Deployment 无 hostPath')

print('ALL OK')
