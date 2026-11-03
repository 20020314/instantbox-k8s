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
        self.created_bodies = []
        self.deleted = []

    def create_namespaced_pod(self, body, namespace):
        name = body.metadata.name
        if name in self.pods:
            raise ApiException(status=409)
        self.created_bodies.append(body)
        self.pods[name] = FakePod(name, body.metadata.labels)
        return body

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
    assert 'instantbox/ubuntu:20.04' in mgr.AVAILABLE_OS_LIST
    assert mgr.is_os_available('instantbox/alpine:latest')
    assert not mgr.is_os_available('instantbox/nope:1')


def test_create_pod_shape(mgr):
    name = mgr.is_create_container(512, 1, 'instantbox/ubuntu:20.04', time.time() + 3600)
    assert name and name.startswith(im.InstantboxManager.CONTAINER_PREFIX)
    body = mgr.core.created_bodies[0]
    spec = body.spec
    # 沙箱 Pod 不能用 service account token
    assert spec.automount_service_account_token is False
    assert spec.enable_service_links is False
    assert spec.restart_policy == 'Never'
    container = spec.containers[0]
    assert container.image == 'instantbox/ubuntu:20.04'
    assert container.ports[0].container_port == 1588
    assert container.resources.limits == {'cpu': '1000m', 'memory': '512Mi'}
    assert im.InstantboxManager.TIMEOUT_LABEL in body.metadata.labels


def test_create_rejects_bad_input(mgr):
    assert mgr.is_create_container(0, 1, 'instantbox/ubuntu:20.04', time.time()) is None
    assert mgr.is_create_container(99999, 1, 'instantbox/ubuntu:20.04', time.time()) is None
    assert mgr.is_create_container(512, 0, 'instantbox/ubuntu:20.04', time.time()) is None


def test_no_port_option_anywhere(mgr, monkeypatch):
    """端口选项已移除：getOS 返回的 openPort 恒为 null。"""
    import inspire
    # inspire.get_manager() 是懒加载的，注入假实例即可，不会去连集群
    monkeypatch.setattr(inspire, '_manager', mgr)
    client = inspire.app.test_client()
    res = client.get('/v2/superinspire/getOS?os=instantbox/ubuntu:20.04&port=8080')
    data = res.get_json()
    assert data['statusCode'] == 1
    assert data['openPort'] is None
    assert data['shareUrl'].endswith('/' + data['containerId'])
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
        '/v2/superinspire/getOS?os=instantbox/alpine:latest&timeout=1000000000')
    assert res.get_json()['statusCode'] == 0
    assert mgr.core.created_bodies == []


def test_getOS_rejects_unknown_os(mgr, monkeypatch):
    import inspire
    monkeypatch.setattr(inspire, '_manager', mgr)
    res = inspire.app.test_client().get('/v2/superinspire/getOS?os=evil/image:latest')
    assert res.get_json()['statusCode'] == 0
    assert mgr.core.created_bodies == []


def test_share_url(mgr):
    name = mgr.is_create_container(512, 1, 'instantbox/alpine:latest', time.time() + 60)
    assert mgr.share_url(name) == 'http://{}.box.example.com'.format(name)


def test_rm_container(mgr):
    name = mgr.is_create_container(512, 1, 'instantbox/alpine:latest', time.time() + 60)
    assert mgr.is_rm_container(name) is True
    assert name in mgr.core.deleted
    # 再删一次（幂等）
    assert mgr.is_rm_container(name) is True


def test_rm_rejects_foreign_name(mgr):
    """只允许删除自己前缀的 Pod，防止越权删别的资源。"""
    assert mgr.is_rm_container('kube-system-coredns') is True
    assert mgr.core.deleted == []


def test_prune_expired(mgr):
    expired = mgr.is_create_container(128, 1, 'instantbox/alpine:latest', time.time() - 1)
    alive = mgr.is_create_container(128, 1, 'instantbox/alpine:latest', time.time() + 3600)
    removed = mgr.remove_timeout_containers()
    assert removed == 1
    assert expired in mgr.core.deleted
    assert alive not in mgr.core.deleted


def test_cleanup_finished(mgr):
    """Exited / Failed 的 Pod 也要回收，否则占着配额。"""
    running = mgr.is_create_container(128, 1, 'instantbox/alpine:latest', time.time() + 3600)
    done = mgr.is_create_container(128, 1, 'instantbox/alpine:latest', time.time() + 3600)
    mgr.core.pods[done].status.phase = 'Failed'
    assert mgr.cleanup_finished_pods() == 1
    assert done in mgr.core.deleted
    assert running not in mgr.core.deleted


def test_configmap_env(mgr):
    """shareUrl 走环境变量，可通过 ConfigMap 改。"""
    assert mgr.share_url('instantbox-managed-abc').endswith('box.example.com')


def test_image_prefix_override(mgr, monkeypatch):
    monkeypatch.setattr(im.cfg, 'IMAGE_REGISTRY_PREFIX', 'harbor.local/proxy/')
    mgr.is_create_container(128, 1, 'instantbox/ubuntu:20.04', time.time() + 60)
    assert mgr.core.created_bodies[0].spec.containers[0].image == \
        'harbor.local/proxy/instantbox/ubuntu:20.04'


def test_share_url_without_domain(monkeypatch):
    """INSTANTBOX_CONSOLE_DOMAIN 留空时用同域相对路径，不依赖泛域名。"""
    monkeypatch.setattr(im.cfg, 'CONSOLE_DOMAIN', '')
    monkeypatch.setattr(im.cfg, 'CONSOLE_PORT', '')
    monkeypatch.setattr(im.cfg, 'SCHEME', 'http')
    m = im.InstantboxManager.__new__(im.InstantboxManager)
    assert m.share_url('instantbox-managed-abc') == 'http://instantbox-managed-abc'


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
