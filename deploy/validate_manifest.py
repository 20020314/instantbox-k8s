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
# 注意：api.deserialize 会把 spec.selector 转成 V1LabelSelector 对象，
# 不能直接和 dict 比，要取 .match_labels
ext = [d for d in docs if d['kind'] == 'Service'
       and d['metadata']['name'] == 'instantbox'][0]
ext_obj = api.deserialize(json.dumps(ext), V1Service, 'application/json')
assert ext_obj.spec.selector == {'app': 'instantbox-gateway'}, \
    '对外入口 selector 必须指向 gateway，实际 {}'.format(ext_obj.spec.selector)
assert ext_obj.spec.ports[0].node_port == 30888
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


# ---------------------------------------------------------------- Caddyfile 路由
#
# 中转页能不能用，完全取决于 Caddy 的**匹配顺序**。这里做静态检查：
# 这类问题一旦回归，表现是"点打开就 502"或"跳转自环"，肉眼极难定位。
import io
import os
import re

CADDY = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'Caddyfile')
if os.path.exists(CADDY):
    with io.open(CADDY, encoding='utf-8') as fh:
        caddy = fh.read()

    # 1) 中转页 / 状态查询的 handle 必须排在 /console/* 之前。
    #    Caddy 的 handle 是有序独占匹配，/console/* 会把 /console/<pod>/_wait 吃掉，
    #    而那时 Pod 还没起来 —— 中转页自己就 502 了。
    pos_wait = caddy.find('handle /console/*/_wait')
    pos_state = caddy.find('handle /console/*/_state/*')
    pos_console = caddy.find('handle /console/* {')
    assert pos_state != -1, 'Caddyfile 缺少 /console/*/_state/* 路由'
    assert pos_wait != -1, 'Caddyfile 缺少 /console/*/_wait 路由'
    assert pos_console != -1, 'Caddyfile 缺少 /console/* 路由'
    assert pos_state < pos_console, '/console/*/_state/* 必须排在 /console/* 之前'
    assert pos_wait < pos_console, '/console/*/_wait 必须排在 /console/* 之前'
    print('[ok] Caddyfile: 中转页路由排在 /console/* 之前')

    # 2) 真终端走 /_console 子路径，裸路径就地 serve 中转页（避免自环）
    assert '_console(?:/(.*))?' in caddy, 'Caddyfile 缺少 /console/<pod>/_console 分支'
    assert re.search(r'rewrite \* /_wait/\{re\.entry\.1\}', caddy), \
        'Caddyfile 裸路径必须 rewrite 到 /_wait/<pod>'
    print('[ok] Caddyfile: 裸路径 -> 中转页，终端独立在 /_console')

    # 2b) ★ 禁止用 redir。
    #     caddy 2.11.7 实测把 `redir /x/{re.e.1} 302` 适配成
    #       {"handler":"static_response","headers":{"Location":["302"]},"status_code":302}
    #     目标路径丢失、Location 变成字面量 "302"；单参数写法直接报
    #     "wrong argument count"。运行时表现是空 200 白屏，比 502 更难查。
    #     本地没装 caddy，adapt 只能在集群里跑，所以只能靠静态断言拦。
    assert not re.search(r'^\s*redir\s', caddy, re.M), \
        'Caddyfile 不要用 redir（caddy 2.11.7 适配后 Location 会变成 "302"），改用 rewrite + reverse_proxy'
    print('[ok] Caddyfile: 未使用 redir')

    # 3) 占位符捕获组序号别写错：只有一个捕获组时 .2 会拿到空串
    for bad in ('{re.entry.2}', '{re.wt.2}'):
        assert bad not in caddy, 'Caddyfile 占位符 {} 引用了不存在的捕获组'.format(bad)
    print('[ok] Caddyfile: 占位符捕获组序号正确')
else:
    print('[skip] 未找到 {}，跳过 Caddyfile 检查'.format(CADDY))

print('ALL OK')
