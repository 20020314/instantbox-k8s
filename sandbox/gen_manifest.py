"""生成 server/manifest.json —— 只列 CI 真正构建过的多架构沙箱镜像。

用法：python sandbox/gen_manifest.py   （在仓库根执行）
"""
import json
import os

OWNER = os.environ.get('SANDBOX_OWNER', 'ghcr.io/20020314')

UBUNTU_LOGO = 'https://cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/ubuntu.png'
DEBIAN_LOGO = 'https://cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/debian.png'
ALPINE_LOGO = 'https://cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/alpine.png'

# 与 .github/workflows/build-images.yml 的 build-sandbox matrix 一一对应
GROUPS = [
    {
        'label': 'Ubuntu', 'value': 'ubuntu', 'logoUrl': UBUNTU_LOGO,
        'subList': [
            ('20.04', 'sandbox-ubuntu-20.04'),
            ('22.04', 'sandbox-ubuntu-22.04'),
            ('24.04', 'sandbox-ubuntu-24.04'),
        ],
    },
    {
        'label': 'Debian', 'value': 'debian', 'logoUrl': DEBIAN_LOGO,
        'subList': [('12', 'sandbox-debian-12')],
    },
    {
        'label': 'Alpine', 'value': 'alpine', 'logoUrl': ALPINE_LOGO,
        'subList': [('3.20', 'sandbox-alpine-3.20')],
    },
]

out = []
for g in GROUPS:
    out.append({
        'label': g['label'],
        'value': g['value'],
        'logoUrl': g['logoUrl'],
        'subList': [
            {'label': label, 'osCode': '{}/{}:latest'.format(OWNER, repo)}
            for label, repo in g['subList']
        ],
    })

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'manifest.json')
path = os.path.normpath(path)
with open(path, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('wrote', path)
for g in out:
    for s in g['subList']:
        print('  ', g['label'], s['label'], '->', s['osCode'])
