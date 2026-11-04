#!/bin/python
"""instantbox on Kubernetes 控制面。

与原版的区别：
  * 不再挂载 /var/run/docker.sock，改为用 Pod 自带的 ServiceAccount 调 k8s API 建 Pod
  * 去掉了「开放端口(port)」选项：沙箱内部只跑 ttyd，对外统一由 worker 反代
"""

import json
import time

from flask import Flask, Response, request
from flask_cors import CORS
from kubernetes.client.rest import ApiException

import config as cfg
import console_page
from api.instantboxManager import InstantboxManager

app = Flask(__name__)
CORS(app, resources=r'/*')

# 延迟初始化：模块被 import（例如单测）时不去连集群，首次请求才建 client。
# 连不上集群由 /readyz 暴露，Pod 会停在 NotReady 而不是直接 CrashLoop。
_manager = None


def get_manager():
    global _manager
    if _manager is None:
        _manager = InstantboxManager()
    return _manager

MAX_TIMEOUT_AHEAD = 3600 * 24   # 最长 24 小时


def json_response(payload, status=200):
    response = Response(json.dumps(payload), mimetype='application/json', status=status)
    response.headers.add('Server', 'python flask')
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST'
    response.headers['Access-Control-Allow-Headers'] = 'x-requested-with'
    return response


@app.route('/v2/superinspire')
def hello():
    return 'instantbox-k8s'


@app.route('/v2/superinspire/getOSList')
def returnList():
    return json_response(get_manager().OS_LIST)


@app.route('/v2/superinspire/getOS')
def getOS():
    os_name = request.args.get('os')
    if not get_manager().is_os_available(os_name):
        return json_response({
            'message': 'The image is not supported at this time ERROR',
            'statusCode': 0,
        })

    os_mem = request.args.get('mem') or 512
    os_cpu = request.args.get('cpu') or 1
    os_timeout = request.args.get('timeout')

    max_timeout = MAX_TIMEOUT_AHEAD + time.time()
    if os_timeout is None:
        os_timeout = max_timeout
    else:
        try:
            os_timeout = min(float(os_timeout), max_timeout)
        except ValueError:
            return json_response({'message': 'Arguments ERROR', 'statusCode': 0})
        if os_timeout <= time.time():
            return json_response({'message': 'Arguments ERROR', 'statusCode': 0})

    # 兼容老客户端：即使传了 port 也直接忽略
    container_name = get_manager().is_create_container(
        mem=os_mem,
        cpu=os_cpu,
        os_name=os_name,
        os_timeout=os_timeout,
    )
    if container_name is None:
        return json_response({
            'message': 'RUN pod ERROR',
            'shareUrl': '',
            'statusCode': 0,
        })

    return json_response({
        'message': 'SUCCESS',
        'shareUrl': get_manager().share_url(container_name),
        'containerId': container_name,
        # 字段保留但恒为 null：K8s 下没有「临时对外开放端口」这回事
        'openPort': None,
        'statusCode': 1,
    })


@app.route('/v2/superinspire/rmOS')
def rmOS():
    container_id = request.args.get('containerId')
    if not container_id:
        return json_response({
            'message': 'Arguments ERROR',
            'shareUrl': '',
            'statusCode': 0,
        })
    if not get_manager().is_rm_container(container_id):
        return json_response({
            'message': 'RM pod ERROR',
            'shareUrl': '',
            'statusCode': 0,
        })
    return json_response({
        'message': 'SUCCESS',
        'statusCode': 1,
        'containerId': container_id,
    })


@app.route('/v2/superinspire/prune')
def prune():
    """由 CronJob 每分钟调用：TTL 到期 + 空闲超时 + 已退出的 Pod 一并回收。"""
    try:
        removed = get_manager().remove_timeout_containers()
        removed += get_manager().cleanup_finished_pods()
    except Exception as exc:                                  # noqa: BLE001
        return json_response({'message': 'ERROR: {}'.format(exc), 'statusCode': 0})
    return json_response({'message': 'Success', 'statusCode': 1, 'removed': removed})


@app.route('/healthz')
def healthz():
    """存活探针：只看进程是否还活着，不做任何 I/O。"""
    return 'ok'


# --------------------------------------------------------------- 等待就绪中转页
#
# 官方前端拿到 shareUrl 就直接 window.open，Pod 还没起好时 Caddy 反代到
# <pod>.<ns>.svc:1588 只能返回 502。这两个接口把「打开」拆成
# 「先看状态页 -> 就绪后自动进终端」。

@app.route('/_state/<container_name>')
def sandbox_state(container_name):
    """中转页轮询的状态接口。只读、幂等。

    不加鉴权：沙箱名是 12 位随机串，且能连到 NodePort 的人本来就能开终端。
    """
    try:
        state, detail = get_manager().get_sandbox_state(container_name)
    except Exception as exc:                                  # noqa: BLE001
        return json_response({'state': 'forbidden', 'detail': str(exc)[:200]})
    return json_response({'state': state, 'detail': detail})


@app.route('/_wait/<container_name>')
def sandbox_wait_page(container_name):
    """中转页 HTML 本身。

    放在 server 而不是网关静态目录里，是因为页面里的轮询地址和跳转地址
    都要按当前部署形态拼（同域相对路径 vs 独立域名），这套规则已经在
    config.console_base_url() 里，放两处迟早会不一致。
    """
    prefix = cfg.CONTAINER_PREFIX
    if not container_name.startswith(prefix):
        return Response('unknown sandbox', status=404, mimetype='text/plain')

    base = _console_base(container_name)
    html = console_page.render(
        container_name=container_name,
        # 相对路径：中转页和网关的 /console/ 前缀同域，浏览器自己补 host
        target='/console/{}/_console?main=1'.format(container_name),
        state_url='/_state/{}'.format(container_name),
        go_url=base + '/_console?main=1',
    )
    resp = Response(html, mimetype='text/html')
    # ★ 绝对不能缓存：否则第二次打开会是上次"已就绪"的残影，直接闪进 502
    resp.headers['Cache-Control'] = 'no-store, must-revalidate'
    resp.headers['X-Robots-Tag'] = 'noindex'
    return resp


def _console_base(container_name):
    """终端入口前缀，和 share_url 用同一套规则（相对路径 / 独立域名）。"""
    scheme, domain, port = cfg.console_base_url()
    if not domain:
        return '/console/{}'.format(container_name)
    host = '{}.{}'.format(container_name, domain)
    if port and port not in ('80', '443'):
        host = '{}:{}'.format(host, port)
    return '{}://{}'.format(scheme, host)


@app.route('/readyz')
def readyz():
    """就绪探针：真正探一次 k8s API（list 一个 pod 名的 get），
    免得 SA 权限配错 / 集群不可达时 Pod 还显示 Ready，实际建不了沙箱。"""
    try:
        m = get_manager()
        m.core.read_namespaced_pod('__readiness_probe__', m.namespace)
    except ApiException as exc:
        # 404 = 连上了 apiserver 且鉴权通过，只是 pod 不存在，这就是健康
        if exc.status in (403, 404):
            return 'ok'
        return Response('k8s api error: {}'.format(exc.status), status=503)
    except Exception as exc:                                  # noqa: BLE001
        return Response('k8s api unreachable: {}'.format(exc), status=503)
    return 'ok'


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(cfg.SERVER_PORT), debug=False)
