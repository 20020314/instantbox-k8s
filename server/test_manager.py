"""用假 CoreV1Api 跑通 InstantboxManager + Flask 路由，验证不需要真集群。

pytest -q test_manager.py
"""
import json
import os
import sys
import time

import pytest
from kubernetes.client.rest import ApiException

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('INSTANTBOX_MANIFEST', 'manifest.json')
os.environ.setdefault('INSTANTBOX_POD_NAMESPACE', 'instantbox')
os.environ.setdefault('INSTANTBOX_CONSOLE_DOMAIN', 'box.example.com')

from api import instantboxManager as im  # noqa: E402


class FakePod:
    def __init__(self, name, labels):
        self.metadata = type('M', (), {'name': name, 'labels': labels})()
        self.status = type('S', (), {'phase': 'Running', 'pod_ip': '10.0.0.9'})()


class FakeResp:
    def __init__(self, items):
        self.items = items


class FakeCore:
    def __init__(self):
        self.pods = {}
        self.services = {}
        self.created_bodies = []
        self.deleted = []

    def create_namespaced_pod(self, body, namespace):
        name = body.metadata.name
        if name in self.pods:
            raise ApiException(status=409)
        self.created_bodies.append(body)
        self.pods[name] = FakePod(name, body.metadata.labels)
        return body

    def create_namespaced_service(self, body, namespace):
        name = body.metadata.name
        if name in self.services:
            raise ApiException(status=409)
        self.services[name] = body
        return body

    def delete_namespaced_service(self, name, namespace):
        if name not in self.services:
            raise ApiException(status=404)
        self.services.pop(name)

    def list_namespaced_pod(self, namespace, label_selector=None):
        return FakeResp(list(self.pods.values()))

    def read_namespaced_pod(self, name, namespace):
        if name not in self.pods:
            raise ApiException(status=404)
        return self.pods[name]

    def delete_namespaced_pod(self, name, namespace, body=None):
        if name not in self.pods:
            raise ApiException(status=404)
        self.pods.pop(name)
        self.deleted.append(name)

    def patch_namespaced_pod(self, name, namespace, body):
        if name not in self.pods:
            raise ApiException(status=404)
        self.pods[name].metadata.labels.update(body['metadata']['labels'])
        return self.pods[name]


def test_sandbox_gets_headless_service(mgr):
    """每个沙箱要有同名 headless Service，否则 nginx 解析不到 Pod 名。

    K8s 默认不给裸 Pod 建 A 记录（Docker compose 才会），这是迁移时最隐蔽的坑之一。
    """
    name = mgr.is_create_container(512, 1, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest',
                                   time.time() + 3600)
    assert name in mgr.core.services
    svc = mgr.core.services[name]
    assert svc.spec.cluster_ip == 'None'
    assert svc.spec.selector == {'app': name}
    assert svc.spec.ports[0].port == 1588
    # Pod 上要有能被 selector 选中的 label
    assert mgr.core.pods[name].metadata.labels['app'] == name
    # 删 Pod 要连 Service 一起删
    mgr._delete([name])
    assert name not in mgr.core.services


@pytest.fixture()
def mgr(monkeypatch):
    m = im.InstantboxManager.__new__(im.InstantboxManager)
    m.core = FakeCore()
    m.namespace = 'instantbox'
    with open(os.environ['INSTANTBOX_MANIFEST'], encoding='utf-8') as fh:
        m.OS_LIST = json.load(fh)
    m.AVAILABLE_OS_LIST = [v['osCode'] for o in m.OS_LIST for v in o['subList']]
    return m


def test_manifest_loaded(mgr):
    assert 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest' in mgr.AVAILABLE_OS_LIST
    assert mgr.is_os_available('ghcr.io/20020314/sandbox-alpine-3.20:latest')
    assert not mgr.is_os_available('instantbox/nope:1')


def test_create_pod_shape(mgr):
    name = mgr.is_create_container(512, 1, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', time.time() + 3600)
    assert name and name.startswith(im.InstantboxManager.CONTAINER_PREFIX)
    body = mgr.core.created_bodies[0]
    spec = body.spec
    # 沙箱 Pod 不能用 service account token
    assert spec.automount_service_account_token is False
    assert spec.enable_service_links is False
    assert spec.restart_policy == 'Never'
    container = spec.containers[0]
    assert container.image == 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest'
    assert container.ports[0].container_port == 1588
    assert container.resources.limits == {'cpu': '1000m', 'memory': '512Mi'}
    assert im.InstantboxManager.TIMEOUT_LABEL in body.metadata.labels


def test_create_rejects_bad_input(mgr):
    assert mgr.is_create_container(0, 1, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', time.time()) is None
    assert mgr.is_create_container(99999, 1, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', time.time()) is None
    assert mgr.is_create_container(512, 0, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', time.time()) is None


def test_no_port_option_anywhere(mgr, monkeypatch):
    """端口选项已移除：getOS 返回的 openPort 恒为 null。"""
    import inspire
    # inspire.get_manager() 是懒加载的，注入假实例即可，不会去连集群
    monkeypatch.setattr(inspire, '_manager', mgr)
    client = inspire.app.test_client()
    res = client.get('/v2/superinspire/getOS'
                     '?os=ghcr.io%2F20020314%2Fsandbox-ubuntu-22.04%3Alatest&port=8080')
    data = res.get_json()
    assert data['statusCode'] == 1
    assert data['openPort'] is None
    # 本模块设了 INSTANTBOX_CONSOLE_DOMAIN=box.example.com，shareUrl 是完整域名
    assert data['containerId'] in data['shareUrl']
    # 即使客户端传了 port，也不会写进 Pod
    body = mgr.core.created_bodies[0]
    assert body.spec.containers[0].ports[0].container_port == 1588
    assert body.spec.containers[0].ports[0].host_port is None


def test_readyz_ok_when_cluster_reachable(mgr, monkeypatch):
    """readyz 靠 read_namespaced_pod 探活：404 = 连上了且鉴权通过。"""
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    res = inspire.app.test_client().get('/readyz')
    assert res.status_code == 200


def test_readyz_fails_when_api_broken(monkeypatch):
    """apiserver 挂了要返回 503，Pod 必须从 Endpoints 摘掉。"""
    import inspire

    class BrokenCore:
        def read_namespaced_pod(self, name, namespace):
            raise ApiException(status=500, reason='boom')

    broken = type('M', (), {'core': BrokenCore(), 'namespace': 'instantbox'})()
    monkeypatch.setattr(inspire, '_manager', broken)
    res = inspire.app.test_client().get('/readyz')
    assert res.status_code == 503


def test_getOS_rejects_expired_timeout(mgr, monkeypatch):
    """timeout 是绝对时间戳，已经过期要直接拒绝。"""
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    res = inspire.app.test_client().get(
        '/v2/superinspire/getOS'
        '?os=ghcr.io%2F20020314%2Fsandbox-alpine-3.20%3Alatest&timeout=1000000000')
    assert res.get_json()['statusCode'] == 0
    assert mgr.core.created_bodies == []


def test_getOS_rejects_unknown_os(mgr, monkeypatch):
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    res = inspire.app.test_client().get('/v2/superinspire/getOS?os=evil/image:latest')
    assert res.get_json()['statusCode'] == 0
    assert mgr.core.created_bodies == []


def test_share_url(mgr):
    name = mgr.is_create_container(512, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() + 60)
    assert mgr.share_url(name) == 'http://{}.box.example.com'.format(name)


def test_rm_container(mgr):
    name = mgr.is_create_container(512, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() + 60)
    assert mgr.is_rm_container(name) is True
    assert name in mgr.core.deleted
    # 再删一次（幂等）
    assert mgr.is_rm_container(name) is True


def test_rm_rejects_foreign_name(mgr):
    """只允许删除自己前缀的 Pod，防止越权删别的资源。"""
    assert mgr.is_rm_container('kube-system-coredns') is True
    assert mgr.core.deleted == []


def test_prune_expired(mgr):
    expired = mgr.is_create_container(128, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() - 1)
    alive = mgr.is_create_container(128, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() + 3600)
    removed = mgr.remove_timeout_containers()
    assert removed == 1
    assert expired in mgr.core.deleted
    assert alive not in mgr.core.deleted


def test_cleanup_finished(mgr):
    """Exited / Failed 的 Pod 也要回收，否则占着配额。"""
    running = mgr.is_create_container(128, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() + 3600)
    done = mgr.is_create_container(128, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest', time.time() + 3600)
    mgr.core.pods[done].status.phase = 'Failed'
    assert mgr.cleanup_finished_pods() == 1
    assert done in mgr.core.deleted
    assert running not in mgr.core.deleted


def test_configmap_env(mgr):
    """shareUrl 走环境变量，可通过 ConfigMap 改。"""
    assert mgr.share_url('instantbox-managed-abc').endswith('box.example.com')


def test_image_prefix_override(mgr, monkeypatch):
    monkeypatch.setattr(im.cfg, 'IMAGE_REGISTRY_PREFIX', 'harbor.local/proxy/')
    mgr.is_create_container(128, 1, 'ghcr.io/20020314/sandbox-ubuntu-22.04:latest', time.time() + 60)
    assert mgr.core.created_bodies[0].spec.containers[0].image == \
        'harbor.local/proxy/ghcr.io/20020314/sandbox-ubuntu-22.04:latest'


def test_share_url_without_domain(monkeypatch):
    """INSTANTBOX_CONSOLE_DOMAIN 留空时用同域相对路径，不依赖泛域名。

    返回 '/console/<pod>'：由同一个 nginx 在 /console/ 下反代到 Pod 的 1588，
    浏览器用当前页面的协议/主机/端口，NodePort、Ingress、端口转发都不用改配置。
    """
    monkeypatch.setattr(im.cfg, 'CONSOLE_DOMAIN', '')
    monkeypatch.setattr(im.cfg, 'CONSOLE_PORT', '')
    monkeypatch.setattr(im.cfg, 'SCHEME', 'http')
    m = im.InstantboxManager.__new__(im.InstantboxManager)
    assert m.share_url('instantbox-managed-abc') == '/console/instantbox-managed-abc'


def test_share_url_custom_port(monkeypatch):
    """非 80/443 端口要拼进 host。"""
    monkeypatch.setattr(im.cfg, 'CONSOLE_DOMAIN', 'box.example.com')
    monkeypatch.setattr(im.cfg, 'CONSOLE_PORT', '8443')
    monkeypatch.setattr(im.cfg, 'SCHEME', 'https')
    m = im.InstantboxManager.__new__(im.InstantboxManager)
    assert m.share_url('instantbox-managed-abc') == \
        'https://instantbox-managed-abc.box.example.com:8443'


def test_pod_name_is_dns1123(mgr):
    """k8s 资源名必须小写字母数字和 '-'，以字母数字开头结尾。"""
    for _ in range(20):
        name = mgr.generateContainerName()
        assert im.POD_NAME_RE.match(name), name
        assert len(name) <= 63                        # k8s 名字上限
        assert name.startswith(im.InstantboxManager.CONTAINER_PREFIX)


# --------------------------------------------------------------- 等待就绪中转页
#
# 背景：Pod 刚创建时 /console/<pod> 会 502（Service 没建好或 ttyd 还没监听）。
# 现在裸路径统一进中转页，页面轮询 /_state/<pod>，ready 了再跳 /_console。

class FakeCS:
    """container_statuses 的最小替身。ready=False 时带上 waiting.reason。"""

    def __init__(self, ready, reason=None, message=''):
        self.ready = ready
        self.state = type('State', (), {
            'waiting': type('W', (), {'reason': reason, 'message': message})() if reason else None,
            'terminated': None,
        })()


def _pod(name, phase='Pending', ready=False, reason=None, deletion_ts=None):
    p = FakePod(name, {'app': name})
    p.metadata.deletion_timestamp = deletion_ts
    p.status = type('S', (), {
        'phase': phase,
        'pod_ip': None,
        'reason': reason,
        'container_statuses': [FakeCS(ready, reason)],
    })()
    return p


def test_state_gone_when_pod_missing(mgr):
    assert mgr.get_sandbox_state('instantbox-managed-nothere1234')[0] == 'gone'


def test_state_rejects_bad_names(mgr):
    """名字来自 URL，必须挡住路径穿越 / 前后缀不符。"""
    assert mgr.get_sandbox_state('../../etc/passwd')[0] == 'gone'
    assert mgr.get_sandbox_state('instantbox_managed_abc')[0] == 'gone'
    assert mgr.get_sandbox_state('')[0] == 'gone'


def test_state_pending_while_container_not_ready(mgr):
    """★ 核心断言：phase=Running 但容器没 Ready，仍然是 pending。

    这就是原来会 502 的窗口：Pod 已经 Running，Service 也有了，
    但 ttyd 还没开始监听，Caddy 反代过去就是 502。
    """
    name = 'instantbox-managed-pendingabc12'
    mgr.core.pods[name] = _pod(name, phase='Running', ready=False,
                               reason='ContainerCreating')
    state, detail = mgr.get_sandbox_state(name)
    assert state == 'pending'
    assert 'ContainerCreating' in detail


def test_state_ready_only_when_all_containers_ready(mgr):
    name = 'instantbox-managed-readyabc1234'
    mgr.core.pods[name] = _pod(name, phase='Running', ready=True)
    assert mgr.get_sandbox_state(name) == ('ready', 'ok')


def test_state_terminating(mgr):
    name = 'instantbox-managed-dyingabc1234'
    mgr.core.pods[name] = _pod(name, phase='Running', ready=True,
                               deletion_ts='2026-01-01T00:00:00Z')
    assert mgr.get_sandbox_state(name)[0] == 'terminating'


def test_state_failed_when_phase_terminal(mgr):
    name = 'instantbox-managed-failedabc123'
    mgr.core.pods[name] = _pod(name, phase='Failed', ready=False)
    assert mgr.get_sandbox_state(name)[0] == 'failed'


def test_state_forbidden_is_not_gone(mgr):
    """API 出错要报 forbidden，不能当成 gone —— 否则页面会说"沙箱已过期"误导用户。"""

    class DeniedCore(FakeCore):
        def read_namespaced_pod(self, name, namespace):
            raise ApiException(status=403)

    mgr.core = DeniedCore()
    assert mgr.get_sandbox_state('instantbox-managed-whatever123')[0] == 'forbidden'


def test_wait_page_renders_and_is_uncacheable(mgr, monkeypatch):
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    name = 'instantbox-managed-pageabc1234'
    res = inspire.app.test_client().get('/_wait/{}'.format(name))
    assert res.status_code == 200
    assert res.mimetype == 'text/html'
    # ★ 不能缓存：否则第二次打开会闪进上次"已就绪"的状态
    assert 'no-store' in res.headers['Cache-Control']
    body = res.get_data(as_text=True)
    # 页面里三个关键地址都要被正确注入
    assert '/_state/{}'.format(name) in body
    assert '/console/{}/_console'.format(name) in body
    assert name in body
    # 不能有裸的 __CFG__ 残留（模板没被替换会直接白屏）
    assert '__CFG__' not in body


def test_state_endpoint_contract(mgr, monkeypatch):
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    name = 'instantbox-managed-stateabc123'
    mgr.core.pods[name] = _pod(name, phase='Running', ready=False, reason='PodInitializing')
    data = inspire.app.test_client().get('/_state/{}'.format(name)).get_json()
    assert data['state'] == 'pending'
    assert 'PodInitializing' in data['detail']

    mgr.core.pods[name] = _pod(name, phase='Running', ready=True)
    data = inspire.app.test_client().get('/_state/{}'.format(name)).get_json()
    assert data['state'] == 'ready'


def test_share_url_unchanged_by_wait_page(mgr):
    """shareUrl 仍然指向裸路径 —— 中转页是靠网关 302 进来的，不要改前端契约。"""
    name = mgr.is_create_container(512, 1, 'ghcr.io/20020314/sandbox-alpine-3.20:latest',
                                   time.time() + 60)
    url = mgr.share_url(name)
    assert url.endswith('/' + name)
    assert '_wait' not in url and '_console' not in url
