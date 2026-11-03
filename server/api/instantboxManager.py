import os
import re
import time
import json
import random
import string

from kubernetes import client, config
from kubernetes.client.rest import ApiException

import config as cfg


LABEL_PREFIX = 'org.instantbox'
TIMEOUT_LABEL = LABEL_PREFIX + '.variables.EXPIRATION_TIMESTAMP'
LASTSEEN_LABEL = LABEL_PREFIX + '.variables.LAST_SEEN_TIMESTAMP'
APP_LABEL_KEY = 'app'
APP_LABEL_VALUE = 'instantbox-sandbox'

POD_NAME_RE = re.compile(r'^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')


class InstantboxManager(object):
    CONTAINER_PREFIX = cfg.CONTAINER_PREFIX
    TIMEOUT_LABEL = TIMEOUT_LABEL
    OS_LIST = None

    def __init__(self):
        self._load_kube()
        self.core = client.CoreV1Api()
        self.namespace = cfg.POD_NAMESPACE

        with open(cfg.MANIFEST_PATH, 'r') as os_manifest:
            self.OS_LIST = json.load(os_manifest)

        self.AVAILABLE_OS_LIST = []
        for os_item in self.OS_LIST:
            for ver in os_item['subList']:
                self.AVAILABLE_OS_LIST.append(ver['osCode'])

    # ---------------------------------------------------------------- cluster
    @staticmethod
    def _load_kube():
        """集群内用 ServiceAccount（自动挂载的 token），本地调试读 kubeconfig。"""
        if os.environ.get('KUBERNETES_SERVICE_HOST'):
            config.load_incluster_config()
        else:
            config.load_kube_config()

    def is_os_available(self, osCode=None) -> bool:
        return osCode is not None and osCode in self.AVAILABLE_OS_LIST

    # ---------------------------------------------------------------- create
    def _image_for(self, os_name):
        if cfg.IMAGE_REGISTRY_PREFIX:
            return cfg.IMAGE_REGISTRY_PREFIX.rstrip('/') + '/' + os_name.lstrip('/')
        return os_name

    def is_create_container(self, mem, cpu, os_name, os_timeout):
        """创建沙箱 Pod。已去掉「开放端口」参数，端口/反代统一由 worker 处理。"""
        try:
            mem_mb = int(float(mem))
            cpu_cores = float(cpu)
        except (TypeError, ValueError):
            return None
        if mem_mb < 16 or mem_mb > cfg.MAX_MEM_MB:
            return None
        if cpu_cores <= 0 or cpu_cores * 1000 > cfg.MAX_CPU_MILLI:
            return None
        if os_timeout is None:
            os_timeout = time.time() + 86400

        container_name = None
        for _attempt in range(3):
            container_name = self.generateContainerName()
            labels = {
                APP_LABEL_KEY: APP_LABEL_VALUE,
                # 同名 headless Service 的 selector 靠这个 label 选中本 Pod
                'app': container_name,
                TIMEOUT_LABEL: str.format('{:.0f}', os_timeout),
                LASTSEEN_LABEL: str.format('{:.0f}', time.time()),
            }
            pod = client.V1Pod(
                metadata=client.V1ObjectMeta(
                    name=container_name,
                    namespace=self.namespace,
                    labels=labels,
                ),
                spec=client.V1PodSpec(
                    # 沙箱镜像的 ENTRYPOINT/CMD（ttyd）保持原样，不注入进程包装，
                    # 容器内照常可以 ps / kill。过期回收由 server 的回收器负责。
                    restart_policy='Never',
                    automount_service_account_token=False,
                    enable_service_links=False,
                    node_selector=cfg.node_selector() or None,
                    runtime_class_name=cfg.RUNTIME_CLASS or None,
                    containers=[
                        client.V1Container(
                            name='box',
                            image=self._image_for(os_name),
                            image_pull_policy=cfg.IMAGE_PULL_POLICY,
                            ports=[client.V1ContainerPort(
                                name='ttyd',
                                container_port=cfg.TTYD_PORT,
                            )],
                            tty=True,
                            stdin=True,
                            resources=client.V1ResourceRequirements(
                                requests={
                                    'cpu': '{}m'.format(int(cpu_cores * 1000)),
                                    'memory': '{}Mi'.format(mem_mb),
                                },
                                limits={
                                    'cpu': '{}m'.format(int(cpu_cores * 1000)),
                                    'memory': '{}Mi'.format(mem_mb),
                                },
                            ),
                        )
                    ],
                ),
            )
            try:
                self.core.create_namespaced_pod(body=pod, namespace=self.namespace)
            except ApiException as exc:
                # 409 = 名字撞了，换一个重试；其他错误直接失败
                if exc.status != 409:
                    return None
                continue
            # K8s 默认不为裸 Pod 建 A 记录（Docker 的 compose 会），
            # nginx 反代需要按名字解析，所以补一个同名 headless Service。
            try:
                self._create_pod_service(container_name)
            except ApiException:
                # Service 建不出来就回收掉 Pod，别留一个访问不到的沙箱
                self._delete([container_name])
                return None
            return container_name
        return None

    def _create_pod_service(self, container_name):
        """为沙箱 Pod 建同名 headless Service，让 <pod>.<ns>.svc 能解析。"""
        svc = client.V1Service(
            metadata=client.V1ObjectMeta(
                name=container_name,
                namespace=self.namespace,
                labels={APP_LABEL_KEY: APP_LABEL_VALUE},
            ),
            spec=client.V1ServiceSpec(
                cluster_ip='None',          # headless：解析直接返回 Pod IP
                selector={'app': container_name},
                ports=[client.V1ServicePort(
                    name='ttyd',
                    port=cfg.TTYD_PORT,
                    target_port=cfg.TTYD_PORT,
                )],
            ),
        )
        self.core.create_namespaced_service(body=svc, namespace=self.namespace)

    # ---------------------------------------------------------------- query
    def get_container_ports(self, container_name):
        """兼容老接口。K8s 没有宿主端口映射，流量全部走 worker 反代。"""
        try:
            self.core.read_namespaced_pod(container_name, self.namespace)
        except ApiException:
            return None
        return {'{}/tcp'.format(cfg.TTYD_PORT): None}

    def get_container_status(self, container_name):
        try:
            pod = self.core.read_namespaced_pod(container_name, self.namespace)
        except ApiException:
            return None
        status = pod.status
        return {
            'phase': status.phase if status else 'Unknown',
            'podIP': status.pod_ip if status else None,
        }

    def touch(self, container_name):
        """记录最后一次访问时间，供空闲回收使用。失败静默。"""
        if cfg.IDLE_TIMEOUT <= 0:
            return
        try:
            self.core.patch_namespaced_pod(
                container_name, self.namespace,
                {'metadata': {'labels': {
                    LASTSEEN_LABEL: str.format('{:.0f}', time.time())
                }}},
            )
        except ApiException:
            pass

    # ---------------------------------------------------------------- delete
    def is_rm_container(self, container_id) -> bool:
        # 原版此处引用了未定义的 container_name（网络删除那一行），删除路径其实是坏的
        return self._delete([container_id]) >= 0

    def _delete(self, names, grace_seconds=0):
        deleted = 0
        for name in names:
            if not name or not name.startswith(self.CONTAINER_PREFIX):
                continue
            if not POD_NAME_RE.match(name):
                continue
            try:
                self.core.delete_namespaced_pod(
                    name, self.namespace,
                    body=client.V1DeleteOptions(grace_period_seconds=grace_seconds),
                )
                deleted += 1
            except ApiException as exc:
                if exc.status in (404, 410):
                    deleted += 1
            # 配套的 headless Service 一起删，否则会一直留着占名字
            try:
                self.core.delete_namespaced_service(name, self.namespace)
            except ApiException:
                pass
        return deleted

    def expired_pods(self, idle_timeout=None):
        """找出应当回收的 Pod：TTL 到期 或 空闲超时。"""
        if idle_timeout is None:
            idle_timeout = cfg.IDLE_TIMEOUT
        try:
            resp = self.core.list_namespaced_pod(
                self.namespace,
                label_selector='{}={}'.format(APP_LABEL_KEY, APP_LABEL_VALUE),
            )
        except ApiException:
            return []

        now = time.time()
        victims = []
        for pod in resp.items:
            name = pod.metadata.name if pod.metadata else None
            labels = (pod.metadata.labels if pod.metadata else None) or {}
            if not name or not name.startswith(self.CONTAINER_PREFIX):
                continue

            try:
                expire_at = float(labels.get(TIMEOUT_LABEL) or 0)
            except ValueError:
                expire_at = 0
            if expire_at and expire_at < now:
                victims.append(name)
                continue

            if idle_timeout > 0:
                try:
                    last_seen = float(labels.get(LASTSEEN_LABEL) or 0)
                except ValueError:
                    last_seen = 0
                if last_seen and now - last_seen > idle_timeout:
                    victims.append(name)
        return victims

    def remove_timeout_containers(self):
        """兼容老入口：执行一次回收，返回删除数量。"""
        return self._delete(self.expired_pods())

    def cleanup_finished_pods(self):
        """顺手清理 Exited / Failed 的沙箱 Pod，避免占着名字和配额。"""
        try:
            pods = self.core.list_namespaced_pod(
                self.namespace,
                label_selector='{}={}'.format(APP_LABEL_KEY, APP_LABEL_VALUE),
            ).items
        except ApiException:
            return 0
        finished = []
        for pod in pods:
            phase = pod.status.phase if pod.status else None
            name = pod.metadata.name if pod.metadata else None
            if name and name.startswith(self.CONTAINER_PREFIX) and phase in ('Succeeded', 'Failed'):
                finished.append(name)
        return self._delete(finished)

    # ---------------------------------------------------------------- helpers
    def generateContainerName(self) -> str:
        # k8s 资源名只允许小写字母/数字/'-'，且以字母数字开头结尾
        suffix = ''.join(random.sample(string.ascii_lowercase + string.digits, 12))
        return self.CONTAINER_PREFIX + suffix

    def share_url(self, container_name):
        """沙箱控制台地址。

        没配 CONSOLE_DOMAIN 时返回**相对路径** `/console/<pod>`：控制台由同一个 nginx
        在 /console/ 下反代，同域访问，前端直接 window.open 即可。
        （上游返回的是 'http://:<port>' 这种缺主机的地址，前端靠 .replace('http://:', ...)
          打补丁——在 NodePort/Ingress 场景下会拼出错误的主机名。）
        """
        scheme, domain, port = cfg.console_base_url()
        if not domain:
            # 相对路径：浏览器自动用当前页面的协议/主机/端口
            return '/console/{}'.format(container_name)
        host = '{}.{}'.format(container_name, domain)
        if port and port not in ('80', '443'):
            host = '{}:{}'.format(host, port)
        return '{}://{}'.format(scheme, host)
