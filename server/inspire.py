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
